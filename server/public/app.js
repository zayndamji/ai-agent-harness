// Browser side: draws the session's terminal with xterm.js and sends what
// it sends (keys, pastes, mouse, its answers to queries) and size changes back
// over the WebSocket, as a terminal does. The Chat tab shows the transcript,
// read only: the Terminal tab is the one way to talk to Claude Code.
import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';
import { ChatView, tokens, edgeFade } from '/chat.js';
import { FilesView } from '/files.js';
import { SessionsView } from '/sessions.js';
import { confirmAction, notice } from '/dialog.js';
import { JobsPanel } from '/jobs.js';
import { UsageView } from '/usage-view.js';
import { BrowserView } from '/browser-view.js';
import { Sidebar } from '/sidebar.js';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const statusText = $('status-text');
const idle = $('idle');
const idleTitle = $('idle-title');
const idleText = $('idle-text');
const startBtn = $('start');
const terminalEl = $('terminal');
const BASE_TITLE = 'Agent Harness';

const term = new Terminal({
  fontFamily: 'ui-monospace, Menlo, "SF Mono", Consolas, "DejaVu Sans Mono", monospace',
  fontSize: 13,
  lineHeight: 1.15,
  cursorBlink: true,
  scrollback: 5000,
  theme: { background: '#1a1918', foreground: '#ecebe7', cursor: '#e0855c', selectionBackground: '#4a3a30' },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(terminalEl);

const chat = new ChatView({
  list: $('chat-list'),
  scroll: $('chat-scroll'),
  empty: $('chat-empty'),
  jump: $('jump'),
  tasks: $('tasks'),
  background: $('background'),
  onTerminal: () => showView('terminal'),
  // The other side of a message between sessions, when it runs here: by the
  // pid of its socket, or by its name.
  peers: {
    // A pid only counts for messages since that session started: an earlier
    // process may have had the same pid.
    find: ({ pid, name, at }) => {
      const since = (s) => !at || Date.parse(at) >= s.startedAt;
      const slot = slots.find((s) => s.running && ((pid && s.pid === pid && since(s)) || (name && s.peerName === name)));
      return slot ? { sid: slot.sid, name: slot.peerName || name, title: slot.title } : null;
    },
    open: (next) => openSlot(next),
  },
  onTurnEnd: (text) => {
    notify('Claude finished', text);
    // Claude may have changed files during the turn.
    if (view === 'files') filesView.load();
  },
});

// The server keeps each session in a slot. This page looks at one of them,
// `sid` (null when there is none); `slots` lists them all. The page's slot
// is in the URL (#s=<sid>), so each browser tab can show a different one.
let sid = /^#s=([0-9a-f]{12})$/.exec(location.hash)?.[1] || null;
let slots = [];
// True from connecting or sending `attach` until the server says which slot
// this page is attached to.
let attaching = true;
// True after New session, while the page shows the start card on purpose:
// it then stays off the other sessions instead of opening one of them.
let pickingNew = false;
// The last `exit` seen, for the start card's title.
let lastExit = null;

// What this page's session is, for the folder chip.
let current = { running: false, folder: '', sessionId: null };
// Which folders and conversations have a running session, for the Files and Sessions tabs.
const sessionInfo = () => ({
  runningIn: (folder) => slots.some((s) => s.running && s.folder === folder),
  isRunning: (id) => slots.some((s) => s.running && s.sessionId === id),
});
const jobsPanel = new JobsPanel({ root: $('jobs-panel'), toggle: $('jobs-toggle'), count: $('jobs-count'), chat, sid: () => sid });
// The header's status counts what still runs in the background.
const refreshPanel = chat.onJobs;
chat.onJobs = () => {
  refreshPanel?.();
  refreshStatus();
};
const filesView = new FilesView($('view-files'), { onStart: (opts) => startSession(opts), session: sessionInfo });
const browserView = new BrowserView($('view-browser'));
const usageView = new UsageView($('view-usage'), { onStart: (opts) => startSession(opts), onOpenFolder: (folder) => openFolder(folder) });
const sessionsView = new SessionsView($('view-sessions'), {
  onStart: (opts) => startSession(opts),
  onOpenFolder: (folder) => openFolder(folder),
  session: sessionInfo,
});

let ws = null;
let running = false;
let busy = false;
let retryDelay = 500;
let view = 'terminal';
let tui = null;
let unseen = 0;

function sendJson(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// Terminal input, resizes and stop go to the slot on this page.
function sendSlot(msg) {
  if (sid) sendJson({ ...msg, sid });
}

function attach(next) {
  attaching = true;
  sendJson({ type: 'attach', sid: next });
}

// Opens a session from the sidebar, in the tab last used for one.
function openSlot(next) {
  pickingNew = false;
  if (next !== sid) attach(next);
  if (!['terminal', 'chat'].includes(view)) showView(store.get('harness-session-view') === 'chat' ? 'chat' : 'terminal');
}

// The slot to look at when this page's one is gone: the newest running one,
// or else the newest.
function defaultSlot() {
  return slots.filter((s) => s.running).pop() || slots[slots.length - 1] || null;
}

// A slot typed into the address bar, or Back and Forward, open that session.
window.addEventListener('hashchange', () => {
  const next = /^#s=([0-9a-f]{12})$/.exec(location.hash)?.[1];
  if (next && next !== sid && slots.some((s) => s.sid === next)) openSlot(next);
});

const runningKey = () => JSON.stringify(slots.filter((s) => s.running).map((s) => [s.folder, s.sessionId]));

function onSlots(list) {
  const before = runningKey();
  slots = list;
  notifyOthers(list);
  sidebar.render(slots, sid);
  chat.refreshPeers();
  // The Files and Sessions tabs mark running sessions, so redraw the open one.
  if (runningKey() !== before) {
    if (view === 'files') filesView.load();
    if (view === 'sessions') sessionsView.load();
  }
  if (attaching || slots.some((s) => s.sid === sid) || (!sid && pickingNew)) return;
  // This page's session is gone (closed, or the server restarted): show another.
  const next = defaultSlot();
  if (next || sid) attach(next?.sid || null);
}

const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Storage can be blocked; the preference just isn't remembered.
    }
  },
};

// Fit only while the terminal is visible: a hidden terminal measures as
// zero and would shrink the session.
function fitTerminal() {
  if (terminalEl.offsetWidth > 0) fit.fit();
}

// ---- Tabs

function showView(next) {
  view = next;
  for (const tab of document.querySelectorAll('.tabs [role="tab"]')) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === next));
    if (tab.dataset.view === next) tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  $('view-terminal').hidden = next !== 'terminal';
  $('view-chat').hidden = next !== 'chat';
  $('view-files').hidden = next !== 'files';
  $('view-sessions').hidden = next !== 'sessions';
  $('view-usage').hidden = next !== 'usage';
  $('view-browser').hidden = next !== 'browser';
  // The Browser, Files, Sessions and Usage tabs work without a session, so
  // the idle card stays off them.
  document.body.classList.toggle('files-open', ['browser', 'files', 'sessions', 'usage'].includes(next));
  document.body.dataset.view = next;
  store.set('harness-view', next);
  if (next === 'terminal' || next === 'chat') store.set('harness-session-view', next);
  if (next === 'terminal') {
    fitTerminal();
    if (running) term.focus();
  } else if (next === 'chat') {
    chat.toBottom();
  } else if (next === 'files') {
    filesView.load();
  } else if (next === 'sessions') {
    sessionsView.load();
  } else if (next === 'usage') {
    usageView.load();
  }
  if (next === 'browser') browserView.show();
  else browserView.hide();
}

function openFolder(folder) {
  filesView.closePreview();
  filesView.dir = folder;
  showView('files');
}

for (const tab of document.querySelectorAll('.tabs [role="tab"]')) {
  tab.addEventListener('click', () => showView(tab.dataset.view));
}
// On a phone the tabs scroll sideways, fading where more of them hide.
edgeFade(document.querySelector('.tabs'));
const sidebar = new Sidebar({
  list: $('slot-list'),
  count: $('slot-count'),
  toggle: $('sidebar-toggle'),
  badge: $('sidebar-badge'),
  backdrop: $('sidebar-backdrop'),
  newButton: $('new-session'),
  store,
  onOpen: (next) => openSlot(next),
  onStop: async (slot) => {
    const ok = await confirmAction(
      'Stop this session?',
      `Claude Code exits in ${folderLabel(slot.folder)}. The conversation is kept and can be resumed from the Sessions tab.`,
      'Stop session',
      true,
    );
    if (ok) sendJson({ type: 'stop', sid: slot.sid });
  },
  onClose: (slot) => sendJson({ type: 'close', sid: slot.sid }),
  onNew: () => {
    pickingNew = true;
    if (sid) attach(null);
    if (!['terminal', 'chat'].includes(view)) showView(store.get('harness-session-view') === 'chat' ? 'chat' : 'terminal');
    renderIdle();
  },
});

const savedView = store.get('harness-view');
showView(['chat', 'browser', 'files', 'sessions', 'usage'].includes(savedView) ? savedView : 'terminal');

// ---- Status, title and notifications

// Whether Claude is working. The screen is the truth while a session runs:
// an interrupt before the first reply writes no end-of-turn line, so the
// transcript alone would say "working" forever. Without a screen reading
// yet, the transcript decides.
function isWorking() {
  if (!running) return false;
  if (tui) return Boolean(tui.spinner || tui.working);
  return busy;
}

function refreshStatus() {
  if (!ws) return;
  if (!running) return setStatus('stopped', 'No session');
  if (isWorking()) return setStatus('working', 'Working');
  // A turn can end with agents and commands still running in the background.
  const jobs = [...chat.jobs.values()].filter((j) => j.status === 'running').length;
  setStatus('running', jobs ? `Ready · ${jobs} in background` : 'Ready');
}

// The header's left side drops the name, then the folder, then the status
// text, until it fits. Its room depends on the window and the sidebar, and
// what it holds changes with the status.
const barLeft = document.querySelector('.bar-left');
const TIGHT = ['no-name', 'no-folder', 'no-status-text'];
function fitHeader() {
  barLeft.classList.remove(...TIGHT);
  for (const cls of TIGHT) {
    if (barLeft.scrollWidth <= barLeft.clientWidth) break;
    barLeft.classList.add(cls);
  }
}
new ResizeObserver(fitHeader).observe(barLeft);

function setStatus(state, text) {
  statusEl.dataset.state = state;
  statusText.textContent = text;
  fitHeader();
  const prefix = unseen ? `(${unseen}) ` : isWorking() ? '● ' : '';
  document.title = prefix + (sessionTitle || BASE_TITLE);
}

let sessionTitle = null;
let notifyOn = store.get('harness-notify') === 'on' && 'Notification' in window && Notification.permission === 'granted';
const notifyBtn = $('notify');
notifyBtn.setAttribute('aria-pressed', String(notifyOn));
if (!('Notification' in window) || !window.isSecureContext) {
  notifyBtn.title = 'Notifications need https or localhost. The tab title still shows when Claude finishes.';
}
notifyBtn.addEventListener('click', async () => {
  if (notifyOn) {
    notifyOn = false;
  } else if ('Notification' in window && window.isSecureContext) {
    notifyOn = (await Notification.requestPermission()) === 'granted';
  }
  store.set('harness-notify', notifyOn ? 'on' : 'off');
  notifyBtn.setAttribute('aria-pressed', String(notifyOn));
});

// `target` is the session it's about when that isn't the one on the page;
// clicking the notification opens it.
function notify(title, body, target = null) {
  if (!document.hidden) return;
  unseen += 1;
  refreshStatus();
  if (notifyOn) {
    const n = new Notification(title, { body: (body || '').replace(/[#*`_>]/g, '').slice(0, 140), icon: '/favicon.svg', tag: `harness-${target || sid || 'page'}` });
    n.onclick = () => {
      window.focus();
      if (target && target !== sid) openSlot(target);
      showView('chat');
      n.close();
    };
  }
}

// The page's own session notifies from its chat and screen. The others only
// reach the page as their line in the slot list, so a change of state there
// notifies: working to ready (a turn ended) or anything to waiting.
let slotStates = null;
function notifyOthers(list) {
  const before = slotStates;
  slotStates = new Map(list.map((s) => [s.sid, s.state]));
  if (!before) return;
  for (const slot of list) {
    if (slot.sid === sid) continue;
    const was = before.get(slot.sid);
    const name = slot.title || `Session in ${folderLabel(slot.folder)}`;
    if (slot.state === 'waiting' && was !== 'waiting') notify('Claude needs your answer', name, slot.sid);
    else if (slot.state === 'ready' && was === 'working') notify('Claude finished', name, slot.sid);
  }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && unseen) {
    unseen = 0;
    refreshStatus();
  }
});

// ---- Session bar: title, model, mode, effort, context size

function prettyModel(id) {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id || '');
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id;
}

let meta = {};
function renderSessionBar() {
  sessionTitle = meta.title || null;
  $('session-title').textContent = meta.title || (running ? 'New session' : 'No session');
  const chips = [];
  if (meta.model) chips.push([prettyModel(meta.model)]);
  const mode = tui?.mode || (meta.permissionMode ? `${meta.permissionMode} mode` : null);
  if (mode) chips.push([mode, /auto|bypass/.test(mode) ? 'accent' : '']);
  if (tui?.effort) chips.push([`${tui.effort} effort`]);
  if (meta.contextTokens) chips.push([`${tokens(meta.contextTokens)} context`]);
  const box = $('session-chips');
  box.replaceChildren(...chips.map(([text, cls]) => {
    const item = document.createElement('span');
    item.className = cls || '';
    item.textContent = text;
    return item;
  }));
  box.hidden = !chips.length;
  refreshStatus();
}

// ---- Live status from the terminal: spinner, tip, dialogs

function renderTui() {
  const working = isWorking();
  const waiting = running && Boolean(tui?.dialog);
  // While a question waits, its banner replaces the working bar.
  $('chat-busy').hidden = !working || !running || waiting;
  $('busy-verb').textContent = tui?.spinner || 'Working…';
  $('busy-detail').textContent = tui?.detail ? `· ${tui.detail}` : '';
  $('busy-tip').hidden = !tui?.tip;
  $('busy-tip').textContent = tui?.tip ? `Tip: ${tui.tip}` : '';
  renderDialog(waiting ? tui.dialog : null);
  renderSessionBar();
}

let lastDialog = null;
function onTui(status) {
  tui = status;
  const question = tui?.dialog?.question || null;
  if (question && question !== lastDialog) notify('Claude needs your answer', question);
  lastDialog = question;
  renderTui();
}

// The question on screen and its choices, to read. It is answered in the
// Terminal tab, like any terminal prompt.
let dialogKey = null;
function renderDialog(dialog) {
  const banner = $('dialog-banner');
  banner.hidden = !dialog;
  if (!dialog) {
    dialogKey = null;
    return;
  }
  const key = JSON.stringify([dialog.question, dialog.options.map((o) => o.label), dialog.selected]);
  if (key === dialogKey) return;
  dialogKey = key;
  $('dialog-text').textContent = dialog.question;
  const box = $('dialog-options');
  box.replaceChildren();
  for (const option of dialog.options) {
    const row = document.createElement('div');
    row.className = 'dialog-option';
    row.classList.toggle('selected', option.n === dialog.selected);
    const num = document.createElement('span');
    num.className = 'dialog-num';
    num.textContent = option.n;
    const text = document.createElement('span');
    text.className = 'dialog-label';
    text.textContent = option.label;
    row.append(num, text);
    if (option.description) {
      const desc = document.createElement('span');
      desc.className = 'dialog-desc';
      desc.textContent = option.description;
      text.append(desc);
    }
    box.append(row);
  }
}

$('dialog-open').addEventListener('click', () => showView('terminal'));

// ---- Session state

// The start card's words: a new session, an ended one, or none at all.
function renderIdle() {
  if (sid) {
    const exit = lastExit?.sid === sid ? lastExit : null;
    idleTitle.textContent = exit ? exit.text : 'This session has ended';
    idleText.textContent = exit?.detail || 'Start a new session, pick a folder, or resume an earlier conversation. Files in the workspace are kept.';
  } else {
    idleTitle.textContent = pickingNew ? 'New session' : 'No session running';
    idleText.textContent = 'Start Claude Code in the workspace, or pick a folder or an earlier conversation. It keeps running when you close this page.';
  }
}

function showState(isRunning) {
  const started = isRunning && !running;
  running = isRunning;
  idle.hidden = isRunning;
  if (!isRunning) renderIdle();
  // Only when a session starts: a state update mid-session (a new title, a
  // switched transcript) must not move the focus.
  if (started && view === 'terminal') term.focus();
  renderTui();
}

function connect() {
  setStatus('connecting', 'Connecting');
  // After a reconnect, ask for the same slot again.
  const query = sid ? `?sid=${encodeURIComponent(sid)}` : '';
  attaching = true;
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${query}`);
  ws.onopen = () => {
    retryDelay = 500;
  };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    // A slot's messages carry its id; drop any for a slot this page left.
    if ('sid' in msg && msg.type !== 'attached' && msg.sid !== sid) return;
    switch (msg.type) {
      case 'slots':
        onSlots(msg.slots);
        break;
      case 'attached':
        sid = msg.sid;
        attaching = false;
        if (sid) pickingNew = false;
        history.replaceState(null, '', sid ? `#s=${sid}` : location.pathname + location.search);
        sidebar.render(slots, sid);
        break;
      case 'state':
        current = { running: msg.running, folder: msg.folder || '', sessionId: msg.sessionId || null };
        showState(msg.running);
        renderFolderChip();
        if (msg.running) sendSlot({ type: 'resize', cols: term.cols, rows: term.rows });
        break;
      case 'reset':
        term.reset();
        break;
      case 'output':
        term.write(msg.data);
        break;
      case 'exit':
        lastExit = msg.reason === 'folder-gone'
          ? { sid, text: 'Its folder is gone', detail: `/${msg.folder || ''} was moved out of the workspace, renamed or removed, so the session ended. Move it back to resume the conversation.` }
          : { sid, text: msg.stopped ? 'Session stopped' : `Claude Code exited (code ${msg.exitCode})` };
        showState(false);
        break;
      case 'error':
        // On the start card when it shows, otherwise in a dialog.
        if (!idle.hidden && ['terminal', 'chat'].includes(view)) {
          idleTitle.textContent = 'Could not start';
          idleText.textContent = msg.message;
        } else {
          notice('Could not start the session', msg.message);
        }
        break;
      case 'chat-reset':
        chat.reset();
        break;
      case 'chat':
        chat.add(msg.entries);
        break;
      case 'chat-busy':
        busy = msg.busy;
        renderTui();
        break;
      case 'meta':
        meta = msg.meta || {};
        renderSessionBar();
        break;
      case 'tui':
        onTui(msg.status);
        break;
    }
  };
  ws.onclose = async (event) => {
    ws = null;
    if (event.code === 4001) return void location.assign('/login');
    // A refused upgrade looks like any other close, so ask whether we are still logged in.
    const res = await fetch('/api/status').catch(() => null);
    if (res?.status === 401) return void location.assign('/login');
    setStatus('connecting', 'Reconnecting');
    setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 10_000);
  };
}

// Everything the terminal sends, as it sends it: keys, pastes (bracketed when
// Claude Code asks), mouse and focus reports, and answers to its queries.
term.onData((data) => sendSlot({ type: 'input', data }));
term.onResize(({ cols, rows }) => {
  if (running) sendSlot({ type: 'resize', cols, rows });
});
new ResizeObserver(fitTerminal).observe(terminalEl);

const folderLabel = (folder) => (folder ? `/workspace/${folder}` : '/workspace');

function renderFolderChip() {
  $('folder-chip').hidden = !current.running;
  $('folder-chip-text').textContent = current.folder || 'workspace';
  $('folder-chip').title = `Session folder: ${folderLabel(current.folder)}. Open it in the Files tab.`;
  fitHeader();
}
$('folder-chip').addEventListener('click', () => openFolder(current.folder));

// Starts a session in a folder: new, the latest conversation ('latest'), or a
// given one. It runs beside the others; resuming one that already runs opens it.
function startSession({ folder = '', resume } = {}) {
  idleTitle.textContent = 'Starting…';
  // Size the terminal before starting, so Claude Code draws at the right width.
  const next = store.get('harness-session-view') === 'chat' ? 'chat' : 'terminal';
  const wasHidden = $('view-terminal').hidden;
  $('view-terminal').hidden = false;
  fitTerminal();
  $('view-terminal').hidden = wasHidden;
  sendJson({ type: 'start', cols: term.cols, rows: term.rows, folder, resume });
  showView(next);
}

startBtn.addEventListener('click', () => startSession({ folder: '' }));
$('choose-folder').addEventListener('click', () => showView('files'));
$('choose-session').addEventListener('click', () => showView('sessions'));

connect();
