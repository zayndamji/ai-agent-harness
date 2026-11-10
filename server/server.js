'use strict';
// Web UI for one Claude Code session: a password login, a pseudo-terminal
// running `claude`, and a WebSocket that streams it to xterm.js in the browser.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { Session } = require('./session');
const { TranscriptFollower, listSessions } = require('./transcript');
const { readStatus } = require('./screen');
const { FilesApi } = require('./files');

const PORT = Number(process.env.HARNESS_LISTEN_PORT || 8080);
const PASSWORD = process.env.HARNESS_PASSWORD || '';
const WORKDIR = process.env.HARNESS_WORKDIR || '/workspace';
// Only for testing the harness without Claude, for example `bash`.
const CLAUDE_COMMAND = process.env.HARNESS_CLAUDE_COMMAND || 'claude';
const CLAUDE_ARGS = (process.env.HARNESS_CLAUDE_ARGS || '').split(/\s+/).filter(Boolean);
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
  '/favicon.svg': { file: path.join(PUBLIC, 'favicon.svg'), type: 'image/svg+xml', auth: false },
  '/vendor/highlight.mjs': { file: path.join(MODULES, '@highlightjs/cdn-assets/es/highlight.min.js'), type: 'text/javascript', auth: true },
  '/vendor/marked.mjs': { file: path.join(MODULES, 'marked/lib/marked.esm.js'), type: 'text/javascript', auth: true },
  '/vendor/purify.mjs': { file: path.join(MODULES, 'dompurify/dist/purify.es.mjs'), type: 'text/javascript', auth: true },
  '/style.css': { file: path.join(PUBLIC, 'style.css'), type: 'text/css', auth: false },
  '/vendor/xterm.mjs': { file: path.join(XTERM, 'xterm/lib/xterm.mjs'), type: 'text/javascript', auth: true },
  '/vendor/xterm.css': { file: path.join(XTERM, 'xterm/css/xterm.css'), type: 'text/css', auth: true },
  '/vendor/addon-fit.mjs': { file: path.join(XTERM, 'addon-fit/lib/addon-fit.mjs'), type: 'text/javascript', auth: true },
};
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

// POST /api/folders {path, name}: a new folder inside a workspace folder.
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
  if (req.method === 'POST' && pathname === '/login') return void handleLogin(req, res);
  if (req.method === 'POST' && pathname === '/logout') return handleLogout(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, {}, 'Method not allowed');
  if (pathname === '/login') return tokenOf(req) ? send(res, 303, { Location: '/' }) : loginPage(res);
  if (pathname === '/api/status') {
    if (!tokenOf(req)) return send(res, 401, { 'Content-Type': 'application/json' }, '{"loggedIn":false}');
    return send(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({ loggedIn: true, running: session.running }));
  }
  const entry = FILES[pathname];
  if (!entry) return send(res, 404, {}, 'Not found');
  if (entry.auth && !tokenOf(req)) return send(res, 303, { Location: '/login' });
  send(res, 200, { 'Content-Type': entry.type }, req.method === 'HEAD' ? '' : entry.body);
});

// ---- The session and its WebSocket clients

const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
for (const key of Object.keys(env)) if (key.startsWith('HARNESS_')) delete env[key];
const session = new Session({ command: CLAUDE_COMMAND, args: CLAUDE_ARGS, cwd: WORKDIR, env });
const transcript = new TranscriptFollower(WORKDIR);
const files = new FilesApi(WORKDIR);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

// The live status read from the terminal screen (screen.js), sent only
// when it changes. Reading waits a little after output so bursts are read once.
let tuiStatus = null;
let tuiTimer = null;
function scheduleStatus() {
  if (tuiTimer) return;
  tuiTimer = setTimeout(() => {
    tuiTimer = null;
    session.withScreen((mirror) => {
      const next = session.running ? readStatus(mirror) : null;
      if (JSON.stringify(next) === JSON.stringify(tuiStatus)) return;
      tuiStatus = next;
      broadcast({ type: 'tui', status: tuiStatus });
    });
  }, 250);
}
// The spinner's clock ticks every second without other output changing, and
// output can stop while a dialog waits, so also read once a second.
setInterval(() => session.running && scheduleStatus(), 1000).unref();

// The session's folder relative to the workspace ('' is the workspace itself).
let sessionFolder = '';

function state() {
  return {
    type: 'state',
    running: session.running,
    startedAt: session.startedAt,
    folder: sessionFolder,
    sessionId: session.running ? transcript.currentSessionId : null,
  };
}

function broadcast(message) {
  const text = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState !== client.OPEN) continue;
    if (client.live) client.send(text);
    else client.queue.push(text);
  }
}

// A client gets a reset and the current screen first, then live output.
// Output that arrives while the snapshot is taken is queued, not lost.
function attach(client) {
  client.live = false;
  client.queue = [];
  session.snapshot((screen) => {
    if (client.readyState !== client.OPEN) return;
    client.send(JSON.stringify(state()));
    client.send(JSON.stringify({ type: 'reset' }));
    if (screen) client.send(JSON.stringify({ type: 'output', data: screen }));
    client.send(JSON.stringify({ type: 'chat-reset' }));
    if (transcript.entries.length) client.send(JSON.stringify({ type: 'chat', entries: transcript.entries }));
    client.send(JSON.stringify({ type: 'chat-busy', busy: transcript.busy }));
    client.send(JSON.stringify({ type: 'meta', meta: transcript.meta }));
    client.send(JSON.stringify({ type: 'tui', status: tuiStatus }));
    for (const text of client.queue) client.send(text);
    client.queue = [];
    client.live = true;
  });
}

session.on('start', () => {
  broadcast({ type: 'reset' });
  broadcast(state());
});
session.on('output', (data) => {
  broadcast({ type: 'output', data });
  scheduleStatus();
});
transcript.on('reset', () => broadcast({ type: 'chat-reset' }));
transcript.on('entries', (entries) => broadcast({ type: 'chat', entries }));
transcript.on('busy', (busy) => broadcast({ type: 'chat-busy', busy }));
transcript.on('meta', (meta) => broadcast({ type: 'meta', meta }));
// After /clear or /resume inside the session, the session id changes.
transcript.on('file', () => broadcast(state()));

// A start that asked to replace the running session waits here until it exits.
let pendingStart = null;

session.on('exit', ({ exitCode, signal }) => {
  console.log(`claude exited (code ${exitCode}, signal ${signal})`);
  transcript.stop();
  tuiStatus = null;
  broadcast({ type: 'tui', status: null });
  broadcast({ type: 'exit', exitCode, signal, stopped: Boolean(session.stopRequested), replaced: Boolean(pendingStart) });
  session.stopRequested = false;
  broadcast(state());
  if (pendingStart) {
    const { client, msg } = pendingStart;
    pendingStart = null;
    startSession(client, msg);
  }
});

const size = (n) => Number.isInteger(n) && n >= 2 && n <= 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// start {cols, rows, folder?, resume?}: folder is relative to the workspace;
// resume is 'latest', a session id from that folder, or absent for a new
// session. New sessions get an id from the server (--session-id), so the
// Chat tab follows exactly that transcript.
function startSession(client, msg) {
  const fail = (message) => client.send(JSON.stringify({ type: 'error', message }));
  let folder;
  try {
    folder = files.folder(msg.folder || '');
  } catch (err) {
    return fail(err.code === 'ENOENT' ? 'That folder does not exist.' : `Can't start there: ${err.message}`);
  }
  let sessionId = msg.resume;
  if (sessionId === 'latest') sessionId = listSessions(folder.real)[0]?.id;
  if (sessionId && !UUID.test(sessionId)) return fail('That session id is not valid.');
  if (sessionId && !listSessions(folder.real).some((s) => s.id === sessionId)) return fail('That session is not in this folder.');
  const resuming = Boolean(sessionId);
  sessionId ||= crypto.randomUUID();
  const args = [...CLAUDE_ARGS, ...(resuming ? ['--resume', sessionId] : ['--session-id', sessionId])];
  try {
    sessionFolder = folder.rel;
    // A little slack, so a transcript created in the same second still counts.
    transcript.start(Date.now() - 2000, { cwd: folder.real, sessionId });
    session.start(msg.cols, msg.rows, { cwd: folder.real, args });
    console.log(`claude started in /${folder.rel || ''} (${resuming ? `resuming ${sessionId}` : `new ${sessionId}`}, ${msg.cols}x${msg.rows})`);
  } catch (err) {
    transcript.stop();
    console.error('could not start claude:', err.message);
    fail(`Could not start claude: ${err.message}`);
  }
}

function handleMessage(client, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  switch (msg.type) {
    case 'start':
      if (!size(msg.cols) || !size(msg.rows)) return;
      if (session.running) {
        // One session at a time: replacing stops the current one first.
        if (!msg.replace) return;
        pendingStart = { client, msg };
        session.stopRequested = true;
        session.stop();
        return;
      }
      startSession(client, msg);
      return;
    case 'input':
      if (typeof msg.data === 'string') session.write(msg.data);
      return;
    case 'resize':
      if (size(msg.cols) && size(msg.rows)) session.resize(msg.cols, msg.rows);
      return;
    case 'stop':
      session.stopRequested = true;
      session.stop();
      return;
  }
}

server.on('upgrade', (req, socket, head) => {
  const token = tokenOf(req);
  if (req.url !== '/ws' || !token || !sameOrigin(req, { required: true })) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (client) => {
    client.token = token;
    client.alive = true;
    client.on('pong', () => (client.alive = true));
    client.on('message', (raw) => handleMessage(client, raw.toString()));
    attach(client);
  });
});

// Drop connections that stopped answering pings (a sleeping laptop, a lost network).
setInterval(() => {
  for (const client of wss.clients) {
    if (!client.alive) client.terminate();
    client.alive = false;
    client.ping();
  }
}, 30_000).unref();

function shutdown() {
  session.stop();
  server.close();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, () => console.log(`web UI listening on port ${PORT}, claude runs in ${WORKDIR}`));
