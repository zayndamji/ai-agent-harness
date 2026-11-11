'use strict';
// Web UI for Claude Code sessions: a password login, a pseudo-terminal per
// session running `claude` (slots.js), and a WebSocket that streams the one a
// browser is looking at to xterm.js.

const crypto = require('node:crypto');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { Slot, StartError, resolveStart } = require('./slots');
const { FilesApi } = require('./files');
const { UsageReports } = require('./usage');
const { Browser, DISPLAY, VNC_PORT } = require('./browser');

const PORT = Number(process.env.HARNESS_LISTEN_PORT || 8080);
const PASSWORD = process.env.HARNESS_PASSWORD || '';
const WORKDIR = process.env.HARNESS_WORKDIR || '/workspace';
// Only for testing the harness without Claude, for example `bash`.
const CLAUDE_COMMAND = process.env.HARNESS_CLAUDE_COMMAND || 'claude';
const CLAUDE_ARGS = (process.env.HARNESS_CLAUDE_ARGS || '').split(/\s+/).filter(Boolean);
// Each `claude` takes a few hundred MB, so a small machine may want fewer.
const MAX_SESSIONS = Math.max(1, Number.parseInt(process.env.HARNESS_MAX_SESSIONS, 10) || 10);
const COOKIE = 'harness';
const COOKIE_MAX_AGE = 30 * 24 * 3600; // seconds
const MAX_FAILURES_PER_MINUTE = 10;

if (PASSWORD.length < 8) {
  console.error('HARNESS_PASSWORD must be set to 8 characters or more (see .env.example).');
  process.exit(1);
}

// ---- Static files, loaded once. Only these paths are served.

const PUBLIC = path.join(__dirname, 'public');
const MODULES = path.join(__dirname, 'node_modules');
const XTERM = path.join(MODULES, '@xterm');
const FILES = {
  '/': { file: path.join(PUBLIC, 'index.html'), type: 'text/html; charset=utf-8', auth: true },
  '/app.js': { file: path.join(PUBLIC, 'app.js'), type: 'text/javascript', auth: true },
  '/chat.js': { file: path.join(PUBLIC, 'chat.js'), type: 'text/javascript', auth: true },
  '/files.js': { file: path.join(PUBLIC, 'files.js'), type: 'text/javascript', auth: true },
  '/sessions.js': { file: path.join(PUBLIC, 'sessions.js'), type: 'text/javascript', auth: true },
  '/dialog.js': { file: path.join(PUBLIC, 'dialog.js'), type: 'text/javascript', auth: true },
  '/jobs.js': { file: path.join(PUBLIC, 'jobs.js'), type: 'text/javascript', auth: true },
  '/sidebar.js': { file: path.join(PUBLIC, 'sidebar.js'), type: 'text/javascript', auth: true },
  '/usage-view.js': { file: path.join(PUBLIC, 'usage-view.js'), type: 'text/javascript', auth: true },
  '/browser-view.js': { file: path.join(PUBLIC, 'browser-view.js'), type: 'text/javascript', auth: true },
  '/favicon.svg': { file: path.join(PUBLIC, 'favicon.svg'), type: 'image/svg+xml', auth: false },
  '/vendor/highlight.mjs': { file: path.join(MODULES, '@highlightjs/cdn-assets/es/highlight.min.js'), type: 'text/javascript', auth: true },
  '/vendor/marked.mjs': { file: path.join(MODULES, 'marked/lib/marked.esm.js'), type: 'text/javascript', auth: true },
  '/vendor/purify.mjs': { file: path.join(MODULES, 'dompurify/dist/purify.es.mjs'), type: 'text/javascript', auth: true },
  '/style.css': { file: path.join(PUBLIC, 'style.css'), type: 'text/css', auth: false },
  '/vendor/xterm.mjs': { file: path.join(XTERM, 'xterm/lib/xterm.mjs'), type: 'text/javascript', auth: true },
  '/vendor/xterm.css': { file: path.join(XTERM, 'xterm/css/xterm.css'), type: 'text/css', auth: true },
  '/vendor/addon-fit.mjs': { file: path.join(XTERM, 'addon-fit/lib/addon-fit.mjs'), type: 'text/javascript', auth: true },
};
// The noVNC client for the Browser tab: its ES modules, served at the same
// relative paths so their imports resolve.
const NOVNC = path.join(MODULES, '@novnc/novnc');
for (const dir of ['core', 'vendor']) {
  for (const rel of fs.readdirSync(path.join(NOVNC, dir), { recursive: true })) {
    if (!rel.endsWith('.js')) continue;
    const file = path.join(NOVNC, dir, rel);
    FILES[`/vendor/novnc/${dir}/${rel.split(path.sep).join('/')}`] = { file, type: 'text/javascript', auth: true };
  }
}
for (const entry of Object.values(FILES)) entry.body = fs.readFileSync(entry.file);
const LOGIN_PAGE = fs.readFileSync(path.join(PUBLIC, 'login.html'), 'utf8');

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  // Not no-referrer: that makes browsers send `Origin: null` on form posts,
  // which the same-origin check below would reject.
  'Referrer-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

// ---- Login. Tokens live in memory, so restarting the server logs everyone out.

const tokens = new Set();
const failures = [];
const digest = (text) => crypto.createHash('sha256').update(text).digest();
const PASSWORD_DIGEST = digest(PASSWORD);

function passwordMatches(input) {
  return crypto.timingSafeEqual(digest(input), PASSWORD_DIGEST);
}

function tokenOf(req) {
  const match = new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`).exec(req.headers.cookie || '');
  return match && tokens.has(match[1]) ? match[1] : null;
}

// Browsers send Origin on WebSocket upgrades and form posts. A mismatch means
// another site is trying to use the cookie.
function sameOrigin(req, { required }) {
  const origin = req.headers.origin;
  if (!origin) return !required;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function tooManyFailures() {
  const cutoff = Date.now() - 60_000;
  while (failures.length && failures[0] < cutoff) failures.shift();
  return failures.length >= MAX_FAILURES_PER_MINUTE;
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const readForm = async (req) => new URLSearchParams(await readBody(req));

function send(res, status, headers, body = '') {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function loginPage(res, message = '') {
  const notice = message ? `<p class="notice">${message}</p>` : '';
  send(res, 200, { 'Content-Type': 'text/html; charset=utf-8' }, LOGIN_PAGE.replace('<!--notice-->', notice));
}

async function handleLogin(req, res) {
  if (!sameOrigin(req, { required: false })) return send(res, 403, {}, 'Forbidden');
  if (tooManyFailures()) return loginPage(res, 'Too many attempts. Wait a minute and try again.');
  let form;
  try {
    form = await readForm(req);
  } catch {
    return send(res, 413, {}, 'Too large');
  }
  if (!passwordMatches(form.get('password') || '')) {
    failures.push(Date.now());
    await new Promise((r) => setTimeout(r, 1000));
    return loginPage(res, 'Wrong password.');
  }
  const token = crypto.randomBytes(32).toString('hex');
  tokens.add(token);
  send(res, 303, {
    Location: '/',
    'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
  });
}

function handleLogout(req, res) {
  if (!sameOrigin(req, { required: false })) return send(res, 403, {}, 'Forbidden');
  const token = tokenOf(req);
  if (token) {
    tokens.delete(token);
    for (const client of wss.clients) if (client.token === token) client.close(4001, 'logged out');
  }
  send(res, 303, { Location: '/login', 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
}

// ---- HTTP

const FILE_APIS = new Set(['/api/files', '/api/file', '/api/archive', '/api/sessions']);
const json = (res, status, body) => send(res, status, { 'Content-Type': 'application/json' }, JSON.stringify(body));

// GET /api/task-output?sid=<slot>&task=<id>: the live output of a background
// command in a running session. Claude Code writes it to
// <tmp>/claude-<uid>/<project>/<session id>/tasks/<task id>.output; only that
// session's folder is searched.
const TASK_OUTPUT_MAX = 64 * 1024;
const ANSI_CODES = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
function taskOutput(res, sid, taskId) {
  const sessionId = slots.get(sid)?.sessionId;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(taskId || '') || !sessionId) return json(res, 404, { error: 'no such task' });
  const tmp = os.tmpdir();
  let roots = [];
  try {
    roots = fs.readdirSync(tmp).filter((n) => /^claude-\d+$/.test(n));
  } catch {
    // No temp folders yet.
  }
  for (const root of roots) {
    let projects = [];
    try {
      projects = fs.readdirSync(path.join(tmp, root));
    } catch {
      continue;
    }
    for (const project of projects) {
      const file = path.join(tmp, root, project, sessionId, 'tasks', `${taskId}.output`);
      let fd;
      try {
        fd = fs.openSync(file, 'r');
      } catch {
        continue;
      }
      try {
        const { size } = fs.fstatSync(fd);
        const len = Math.min(size, TASK_OUTPUT_MAX);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        return json(res, 200, { output: buf.toString('utf8').replace(ANSI_CODES, ''), size, truncated: size > len });
      } finally {
        fs.closeSync(fd);
      }
    }
  }
  json(res, 404, { error: 'no output yet' });
}

// POST /api/folders {path, name}: a new folder inside a workspace folder.
// GET says whether the container has the browser; POST {action: 'restart'}
// restarts Chrome.
function handleBrowser(req, res) {
  if (!tokenOf(req)) return json(res, 401, { error: 'not logged in' });
  if (req.method === 'GET') return json(res, 200, { available: browser.available });
  if (req.method !== 'POST') return send(res, 405, {}, 'Method not allowed');
  if (!sameOrigin(req, { required: true })) return json(res, 403, { error: 'forbidden' });
  if (!browser.available) return json(res, 503, { error: 'This container has no browser.' });
  browser.restartChrome();
  json(res, 200, { ok: true });
}

async function handleMkdir(req, res) {
  if (!tokenOf(req)) return json(res, 401, { error: 'not logged in' });
  if (!sameOrigin(req, { required: true })) return json(res, 403, { error: 'forbidden' });
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: 'expected JSON' });
  }
  try {
    json(res, 201, files.mkdir(body.path, body.name));
  } catch (err) {
    if (err.code === 'ENOENT') return json(res, 404, { error: 'That folder does not exist.' });
    json(res, err.status || 500, { error: err.message });
  }
}

const server = http.createServer((req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && FILE_APIS.has(pathname)) {
    if (!tokenOf(req)) return json(res, 401, { error: 'not logged in' });
    return files.handle(req, res, pathname, searchParams, send);
  }
  if (req.method === 'POST' && pathname === '/api/folders') return void handleMkdir(req, res);
  if (req.method === 'GET' && pathname === '/api/usage') {
    if (!tokenOf(req)) return json(res, 401, { error: 'not logged in' });
    usage
      .get(searchParams.get('tz'), { refresh: searchParams.get('refresh') === '1' })
      .then((data) => json(res, 200, data))
      .catch((err) => json(res, 500, { error: `ccusage failed: ${err.message}` }));
    return;
  }
  if (req.method === 'GET' && pathname === '/api/task-output') {
    if (!tokenOf(req)) return json(res, 401, { error: 'not logged in' });
    return taskOutput(res, searchParams.get('sid'), searchParams.get('task'));
  }
  if (pathname === '/api/browser') return handleBrowser(req, res);
  if (req.method === 'POST' && pathname === '/login') return void handleLogin(req, res);
  if (req.method === 'POST' && pathname === '/logout') return handleLogout(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, {}, 'Method not allowed');
  if (pathname === '/login') return tokenOf(req) ? send(res, 303, { Location: '/' }) : loginPage(res);
  if (pathname === '/api/status') {
    if (!tokenOf(req)) return send(res, 401, { 'Content-Type': 'application/json' }, '{"loggedIn":false}');
    return send(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({ loggedIn: true, running: anyRunning() }));
  }
  const entry = FILES[pathname];
  if (!entry) return send(res, 404, {}, 'Not found');
  if (entry.auth && !tokenOf(req)) return send(res, 303, { Location: '/login' });
  send(res, 200, { 'Content-Type': entry.type }, req.method === 'HEAD' ? '' : entry.body);
});

// ---- Sessions and their WebSocket clients
//
// Each session lives in a slot (slots.js). A browser attaches to one slot
// and gets its screen, chat and status; every browser gets the list of slots.

const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
for (const key of Object.keys(env)) if (key.startsWith('HARNESS_')) delete env[key];
const browser = new Browser(env);
// Sessions see the shared browser's display, as a terminal on a desktop would.
env.DISPLAY = DISPLAY;
const files = new FilesApi(WORKDIR);
const usage = new UsageReports({ root: WORKDIR, env: process.env });
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

// In start order, oldest first.
const slots = new Map();
const anyRunning = () => [...slots.values()].some((s) => s.running);

// The slot a browser sees when it doesn't ask for one: the newest running
// one, or else the newest.
function defaultSlot() {
  const all = [...slots.values()];
  return all.filter((s) => s.running).pop() || all.pop() || null;
}

function sendTo(client, message) {
  if (client.readyState === client.OPEN) client.send(JSON.stringify(message));
}

// Sends a slot's message to the browsers attached to it. Browsers still
// receiving the slot's snapshot get it queued, so nothing is lost or doubled.
function sendToSlot(sid, message) {
  const text = JSON.stringify({ ...message, sid });
  for (const client of wss.clients) {
    if (client.readyState !== client.OPEN || client.sid !== sid) continue;
    if (client.live) client.send(text);
    else client.queue.push(text);
  }
}

let lastSlots = '';
function slotsMessage() {
  return { type: 'slots', slots: [...slots.values()].map((s) => s.summary()) };
}
function broadcastSlots() {
  const text = JSON.stringify(slotsMessage());
  if (text === lastSlots) return;
  lastSlots = text;
  for (const client of wss.clients) if (client.readyState === client.OPEN) client.send(text);
}

// What a browser attached to no slot gets: an empty, stopped session.
const DETACHED = [
  { type: 'state', running: false, startedAt: null, folder: '', sessionId: null },
  { type: 'reset' },
  { type: 'chat-reset' },
  { type: 'chat-busy', busy: false },
  { type: 'meta', meta: {} },
  { type: 'tui', status: null },
];

// A client gets `attached {sid}`, the slot's snapshot, then its live messages.
// Attaching again before a snapshot arrives drops the older one.
function attach(client, sid) {
  const slot = slots.get(sid) || null;
  const gen = (client.attachGen || 0) + 1;
  client.attachGen = gen;
  client.sid = slot?.sid || null;
  client.live = false;
  client.queue = [];
  sendTo(client, { type: 'attached', sid: client.sid });
  if (!slot) {
    for (const message of DETACHED) sendTo(client, { ...message, sid: null });
    client.live = true;
    return;
  }
  slot.checkFolder();
  slot.driver = client;
  slot.snapshot((messages) => {
    if (client.readyState !== client.OPEN || client.attachGen !== gen) return;
    for (const message of messages) client.send(JSON.stringify({ ...message, sid: slot.sid }));
    for (const text of client.queue) client.send(text);
    client.queue = [];
    client.live = true;
  });
}

// Every session id a slot has started with or followed since the server
// started.
const knownIds = new Set();
// The name each `claude` process goes by for messages between sessions, by
// process id, learned from the messages and ListAgents listings in transcripts.
const peerNames = new Map();

// A slot's transcript follower switches to a newer file in its folder after
// /clear or /resume. With several sessions in one folder, this decides whose
// file it is, so no session takes another's chat:
// - a transcript a running slot follows is that slot's;
// - one an earlier or ended slot had is only taken when it is written after
//   /resume (or /clear) here;
// - a new one goes to the session in that folder that sent /clear or
//   /resume most recently, or else to the one that got input most recently.
function mayFollow(id, mtimeMs, self) {
  const t = self.transcript;
  if (id === t.sessionId || id === t.currentSessionId) return true;
  const others = [...slots.values()].filter((s) => s !== self && s.running);
  if (others.some((s) => s.claims(id))) return false;
  if (knownIds.has(id)) return self.switching && mtimeMs >= self.switchAt;
  const rank = (s) => [s.switching ? s.switchAt : 0, s.lastInputAt];
  const ahead = (a, b) => a[0] - b[0] || a[1] - b[1];
  return others.filter((s) => s.transcript.dir === t.dir).every((s) => ahead(rank(self), rank(s)) > 0);
}

function createSlot() {
  const slot = new Slot({ command: CLAUDE_COMMAND, args: CLAUDE_ARGS, env, workdir: WORKDIR, mayFollow, peerNames });
  slot.on('message', (message) => sendToSlot(slot.sid, message));
  slot.on('changed', () => {
    if (slot.sessionId) knownIds.add(slot.sessionId);
    if (slots.has(slot.sid)) broadcastSlots();
  });
  // Another slot's name may be in this slot's list line.
  slot.on('peer-name', broadcastSlots);
  return slot;
}

// Browsers attached to a removed slot move to another one when they see it
// gone from the list.
function removeSlot(slot) {
  slots.delete(slot.sid);
  slot.dispose();
}

// Ended sessions stay in the list, with their last screen, until a browser
// closes them. Past this many, the oldest ended ones go.
const MAX_SLOTS = MAX_SESSIONS * 2;

// Starts a session in a new slot and attaches the browser that asked for it.
// Resuming a conversation that a slot is already running opens that slot
// instead, so two processes never write one transcript.
function startSlot(client, msg) {
  const fail = (message) => sendTo(client, { type: 'error', message });
  let start;
  try {
    start = resolveStart(files, msg);
  } catch (err) {
    if (!(err instanceof StartError)) throw err;
    return fail(err.message);
  }
  const all = [...slots.values()];
  const already = start.resuming && all.find((s) => s.claims(start.sessionId));
  if (already) return attach(client, already.sid);
  if (all.filter((s) => s.running).length >= MAX_SESSIONS) {
    return fail(`${MAX_SESSIONS} sessions are running, the most allowed. Stop one to start another.`);
  }
  const slot = createSlot();
  if (start.sessionId) knownIds.add(start.sessionId);
  try {
    slot.start(start, msg.cols, msg.rows);
  } catch (err) {
    slot.dispose();
    if (!(err instanceof StartError)) throw err;
    return fail(err.message);
  }
  slots.set(slot.sid, slot);
  for (const old of [...slots.values()].filter((s) => !s.running).slice(0, Math.max(0, slots.size - MAX_SLOTS))) removeSlot(old);
  attach(client, slot.sid);
  broadcastSlots();
}

// The spinner's clock ticks every second without other output changing, and
// output can stop while a dialog waits, so also read once a second.
setInterval(() => {
  for (const slot of slots.values()) if (slot.running) slot.scheduleStatus();
}, 1000).unref();

const size = (n) => Number.isInteger(n) && n >= 2 && n <= 1000;

// A terminal's answers to Claude Code's queries: device attributes
// (CSI ? … c, CSI > … c), mode reports (CSI ? … $ y), keyboard flags
// (CSI ? … u), and DCS or OSC strings (XTVERSION, colours). No key or paste
// sends these shapes (a paste comes wrapped in CSI 200~).
const REPLY = /^(?:\x1b\[[?>][\d;]*c|\x1b\[\?[\d;]*\$y|\x1b\[\?\d*u|\x1bP[^\x1b]*\x1b\\|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))+$/;

// Every browser showing a session runs its own terminal, and each would
// answer Claude Code's queries; one real terminal answers once. So only the
// session's driver answers: the browser that typed into it last, or else
// attached to it last. Keys, pastes and mouse from any of them go through.
function terminalInput(client, slot, data) {
  const reply = REPLY.test(data);
  if (!reply) slot.driver = client;
  else if (slot.driver && slot.driver !== client && slot.driver.readyState === slot.driver.OPEN && slot.driver.sid === slot.sid) return;
  else slot.driver = client;
  slot.input(data, { reply });
}

function handleMessage(client, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.type === 'start') {
    if (size(msg.cols) && size(msg.rows)) startSlot(client, msg);
    return;
  }
  if (msg.type === 'attach') return attach(client, msg.sid);
  // Everything else acts on one slot, named by `sid`.
  const slot = slots.get(msg.sid);
  if (!slot) return;
  switch (msg.type) {
    case 'input':
      if (typeof msg.data === 'string') terminalInput(client, slot, msg.data);
      return;
    case 'resize':
      if (size(msg.cols) && size(msg.rows)) slot.resize(msg.cols, msg.rows);
      return;
    case 'stop':
      slot.stop();
      return;
    case 'close':
      // Only an ended session can be closed; a running one is stopped first.
      if (!slot.running) {
        removeSlot(slot);
        broadcastSlots();
      }
      return;
  }
}

// /ws?sid=<slot>: the browser says which slot it was looking at; without one,
// or if that slot is gone, it gets the default slot.
server.on('upgrade', (req, socket, head) => {
  const token = tokenOf(req);
  const url = new URL(req.url, 'http://localhost');
  if (!['/ws', '/vnc'].includes(url.pathname) || !token || !sameOrigin(req, { required: true })) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  if (url.pathname === '/vnc') return void vncUpgrade(req, socket, head);
  wss.handleUpgrade(req, socket, head, (client) => {
    client.token = token;
    client.alive = true;
    client.on('pong', () => (client.alive = true));
    client.on('message', (raw) => handleMessage(client, raw.toString()));
    sendTo(client, slotsMessage());
    const wanted = url.searchParams.get('sid');
    attach(client, slots.has(wanted) ? wanted : defaultSlot()?.sid);
  });
});

// /vnc: the Browser tab's VNC connection, passed through unchanged to x11vnc
// on localhost. Reading pauses while the page is behind, so a slow network
// doesn't pile up screen updates in memory.
const vncWss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
function vncUpgrade(req, socket, head) {
  if (!browser.available) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  vncWss.handleUpgrade(req, socket, head, (client) => {
    client.alive = true;
    client.on('pong', () => (client.alive = true));
    const vnc = net.connect(VNC_PORT, '127.0.0.1');
    vnc.on('data', (data) => {
      if (client.readyState !== client.OPEN) return;
      client.send(data);
      if (client.bufferedAmount > 4 << 20) {
        vnc.pause();
        const resume = setInterval(() => {
          if (client.readyState !== client.OPEN || client.bufferedAmount < 1 << 20) {
            clearInterval(resume);
            vnc.resume();
          }
        }, 20);
      }
    });
    client.on('message', (data) => vnc.write(data));
    vnc.on('close', () => client.close());
    vnc.on('error', () => client.close());
    client.on('close', () => vnc.destroy());
  });
}

// Drop connections that stopped answering pings (a sleeping laptop, a lost network).
setInterval(() => {
  for (const client of [...wss.clients, ...vncWss.clients]) {
    if (!client.alive) client.terminate();
    client.alive = false;
    client.ping();
  }
}, 30_000).unref();

function shutdown() {
  for (const slot of slots.values()) slot.stop();
  browser.stop();
  server.close();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

browser.start();
server.listen(PORT, () => console.log(`web UI listening on port ${PORT}, claude runs in ${WORKDIR}`));
