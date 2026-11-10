// Browser side: draws the session's terminal with xterm.js, shows its
// transcript in the Chat tab, and sends keystrokes, messages and size
// changes back over the WebSocket.
import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';
import { ChatView, tokens } from '/chat.js';
import { FilesView } from '/files.js';
import { SessionsView } from '/sessions.js';
import { confirmAction, notice } from '/dialog.js';
import { JobsPanel } from '/jobs.js';
import { UsageView } from '/usage-view.js';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const statusText = $('status-text');
const idle = $('idle');
const idleTitle = $('idle-title');
const idleText = $('idle-text');
const startBtn = $('start');
const stopBtn = $('stop');
const message = $('message');
const sendBtn = $('send');
const terminalEl = $('terminal');
const BASE_TITLE = 'Claude Harness';

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
  onTurnEnd: (text) => {
    notify('Claude finished', text);
    // Claude may have changed files during the turn.
    if (view === 'files') filesView.load();
  },
});

// The server keeps each session in a slot. This page looks at one of them,
// `sid` (null when there is none); `slots` lists them all.
let sid = null;
let slots = [];
// True from connecting or sending `attach` until the server says which slot
// this page is attached to.
let attaching = true;

// What the browsers know about the running session, for the Files and Sessions tabs.
let current = { running: false, folder: '', sessionId: null };
const sessionInfo = () => current;
const jobsPanel = new JobsPanel({ root: $('jobs-panel'), toggle: $('jobs-toggle'), count: $('jobs-count'), chat, sid: () => sid });
const filesView = new FilesView($('view-files'), { onStart: (opts) => startSession(opts), session: sessionInfo });
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

// Keys, messages, answers, resizes and stop go to the slot on this page.
function sendSlot(msg) {
  if (sid) sendJson({ ...msg, sid });
}

function attach(next) {
  attaching = true;
  sendJson({ type: 'attach', sid: next });
}

// The slot to look at when this page's one is gone: the newest running one,
// or else the newest.
function defaultSlot() {
  return slots.filter((s) => s.running).pop() || slots[slots.length - 1] || null;
}

function onSlots(list) {
  slots = list;
  if (attaching || slots.some((s) => s.sid === sid)) return;
  const next = defaultSlot();
  if (next) attach(next.sid);
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
  }
  $('view-terminal').hidden = next !== 'terminal';
  $('view-chat').hidden = next !== 'chat';
  $('view-files').hidden = next !== 'files';
  $('view-sessions').hidden = next !== 'sessions';
  $('view-usage').hidden = next !== 'usage';
  // The Files, Sessions and Usage tabs work without a session, so the idle
  // card and the message box stay off them.
  document.body.classList.toggle('files-open', ['files', 'sessions', 'usage'].includes(next));
  document.body.dataset.view = next;
  store.set('harness-view', next);
  if (next === 'terminal' || next === 'chat') store.set('harness-session-view', next);
  if (next === 'terminal') {
    fitTerminal();
    if (running) term.focus();
  } else if (next === 'chat') {
    chat.toBottom();
    if (running) message.focus();
  } else if (next === 'files') {
    filesView.load();
  } else if (next === 'sessions') {
    sessionsView.load();
  } else {
    usageView.load();
  }
}

function openFolder(folder) {
  filesView.closePreview();
  filesView.dir = folder;
  showView('files');
}

for (const tab of document.querySelectorAll('.tabs [role="tab"]')) {
  tab.addEventListener('click', () => showView(tab.dataset.view));
}
const savedView = store.get('harness-view');
showView(['chat', 'files', 'sessions', 'usage'].includes(savedView) ? savedView : 'terminal');

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
  setStatus('running', 'Ready');
}

function setStatus(state, text) {
  statusEl.dataset.state = state;
  statusText.textContent = text;
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

function notify(title, body) {
  if (!document.hidden) return;
  unseen += 1;
  refreshStatus();
  if (notifyOn) {
    const n = new Notification(title, { body: (body || '').replace(/[#*`_>]/g, '').slice(0, 140), icon: '/favicon.svg', tag: 'harness' });
    n.onclick = () => {
      window.focus();
      showView('chat');
      n.close();
    };
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

// ---- Live status from the terminal: spinner, tip, suggestion, dialogs

function renderTui() {
  const working = isWorking();
  const waiting = running && Boolean(tui?.dialog);
  // While a question waits, the answer box replaces the working bar.
  $('chat-busy').hidden = !working || !running || waiting;
  $('busy-verb').textContent = tui?.spinner || 'Working…';
  $('busy-detail').textContent = tui?.detail ? `· ${tui.detail}` : '';
  $('busy-tip').hidden = !tui?.tip;
  $('busy-tip').textContent = tui?.tip ? `Tip: ${tui.tip}` : '';
  renderDialog(waiting ? tui.dialog : null);
  const suggestion = running && !working && !message.value && tui?.suggestion;
  $('suggestion').hidden = !suggestion;
  $('suggestion-text').textContent = suggestion || '';
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

// The question on screen, with its choices as buttons. A click sends the
// server the choice; the server moves the highlight there with the arrow keys
// and presses Enter, as a person would in the Terminal tab.
let dialogKey = null;
function renderDialog(dialog) {
  const banner = $('dialog-banner');
  banner.hidden = !dialog;
  if (!dialog) {
    dialogKey = null;
    return;
  }
  const key = JSON.stringify([dialog.question, dialog.options.map((o) => o.label), dialog.answerable]);
  if (key === dialogKey) return;
  dialogKey = key;
  $('dialog-text').textContent = dialog.question;
  $('dialog-error').hidden = true;
  const box = $('dialog-options');
  box.replaceChildren();
  for (const option of dialog.options) {
    const free = option.n === dialog.freeText;
    const row = document.createElement(free ? 'div' : 'button');
    row.className = 'dialog-option';
    if (!free) row.type = 'button';
    const num = document.createElement('span');
    num.className = 'dialog-num';
    num.textContent = option.n;
    const text = document.createElement('span');
    text.className = 'dialog-label';
    text.textContent = free ? 'Your own answer' : option.label;
    row.append(num, text);
    if (option.description) {
      const desc = document.createElement('span');
      desc.className = 'dialog-desc';
      desc.textContent = option.description;
      text.append(desc);
    }
    if (free) {
      const input = document.createElement('input');
      input.className = 'dialog-input';
      input.placeholder = 'Type an answer';
      const send = document.createElement('button');
      send.type = 'button';
      send.className = 'small';
      send.textContent = 'Send';
      const go = () => input.value.trim() && answer(dialog, option, input.value);
      send.addEventListener('click', go);
      input.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), go()));
      input.disabled = send.disabled = !dialog.answerable;
      row.append(input, send);
    } else {
      row.disabled = !dialog.answerable;
      row.addEventListener('click', () => answer(dialog, option));
    }
    box.append(row);
  }
  if (dialog.options.length && !dialog.answerable) showDialogError('This one can only be answered in the Terminal tab.');
}

function answer(dialog, option, text) {
  for (const b of $('dialog-options').querySelectorAll('button, input')) b.disabled = true;
  showDialogError(`Sending “${option.n === dialog.freeText ? text : option.label}”…`, true);
  sendSlot({ type: 'answer', question: dialog.question, option: option.n, text });
}

function showDialogError(text, quiet) {
  const node = $('dialog-error');
  node.hidden = false;
  node.textContent = text;
  node.classList.toggle('quiet', Boolean(quiet));
}

$('suggestion-text').addEventListener('click', () => {
  message.value = tui?.suggestion || '';
  message.dispatchEvent(new Event('input'));
  message.focus();
});
$('dialog-open').addEventListener('click', () => showView('terminal'));

// ---- Session state

function showState(isRunning, exitText) {
  const started = isRunning && !running;
  running = isRunning;
  idle.hidden = isRunning;
  stopBtn.hidden = !isRunning;
  message.disabled = !isRunning;
  sendBtn.disabled = !isRunning;
  message.placeholder = isRunning ? 'Message Claude' : 'Start a session to send messages';
  if (exitText) {
    idleTitle.textContent = exitText;
    idleText.textContent = 'Start a new session, pick a folder, or resume an earlier conversation. Files in the workspace are kept.';
  }
  // Only when a session starts: a state update mid-session (a new title, a
  // switched transcript) must not pull focus out of the message box.
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
        break;
      case 'state': {
        const moved = current.folder !== (msg.folder || '') || current.sessionId !== msg.sessionId;
        current = { running: msg.running, folder: msg.folder || '', sessionId: msg.sessionId || null };
        showState(msg.running);
        renderFolderChip();
        if (msg.running) sendSlot({ type: 'resize', cols: term.cols, rows: term.rows });
        // The lists mark the running session, so redraw the open one.
        if (moved || !msg.running) {
          if (view === 'files') filesView.load();
          if (view === 'sessions') sessionsView.load();
        }
        break;
      }
      case 'reset':
        term.reset();
        break;
      case 'output':
        term.write(msg.data);
        break;
      case 'exit':
        // When switching sessions the next one starts right away; keep the card quiet.
        showState(false, msg.replaced ? 'Switching session…' : msg.stopped ? 'Session stopped' : `Claude Code exited (code ${msg.exitCode})`);
        break;
      case 'error':
        idleTitle.textContent = 'Could not start';
        idleText.textContent = msg.message;
        if (view === 'files' || view === 'sessions') notice('Could not start the session', msg.message);
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
      case 'send-failed':
        // Nothing reached Claude: give the text back and say why.
        chat.settlePending(msg.text);
        if (!message.value) {
          message.value = msg.text;
          message.dispatchEvent(new Event('input'));
        }
        notice('Message not sent', msg.message);
        break;
      case 'answer-failed':
        dialogKey = null;
        renderTui();
        showDialogError(msg.message);
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
}
$('folder-chip').addEventListener('click', () => openFolder(current.folder));

// Starts a session in a folder: new, the latest conversation ('latest'), or a
// given one. One session at a time, so a running one is stopped first.
async function startSession({ folder = '', resume } = {}) {
  if (current.running) {
    const what = resume ? 'resume that conversation' : 'start a new session';
    const ok = await confirmAction(
      'Switch sessions?',
      `This stops the running session in ${folderLabel(current.folder)} and will ${what} in ${folderLabel(folder)}. The stopped conversation is kept and can be resumed.`,
      'Stop and switch',
      true,
    );
    if (!ok) return;
  }
  idleTitle.textContent = 'Starting…';
  // Size the terminal before starting, so Claude Code draws at the right width.
  const next = store.get('harness-session-view') === 'chat' ? 'chat' : 'terminal';
  const wasHidden = $('view-terminal').hidden;
  $('view-terminal').hidden = false;
  fitTerminal();
  $('view-terminal').hidden = wasHidden;
  sendJson({ type: 'start', cols: term.cols, rows: term.rows, folder, resume, replace: current.running });
  showView(next);
}

startBtn.addEventListener('click', () => startSession({ folder: '' }));
$('choose-folder').addEventListener('click', () => showView('files'));
$('choose-session').addEventListener('click', () => showView('sessions'));

stopBtn.addEventListener('click', async () => {
  const ok = await confirmAction('Stop the session?', `Claude Code exits. The conversation is kept and can be resumed from the Sessions tab.`, 'Stop session', true);
  if (ok) sendSlot({ type: 'stop' });
});

// Escape is how Claude Code's terminal interrupts a turn.
$('interrupt').addEventListener('click', () => sendSlot({ type: 'input', data: '\x1b' }));

// ---- Message box, shared by both tabs. Every change goes to the server,
// which types it into Claude Code's input box key by key (server/typist.js);
// Send then presses Enter there, or pastes the message when it couldn't be typed.

function compose(event) {
  if (!running || event?.isComposing) return;
  const paste = ['insertFromPaste', 'insertFromDrop', 'insertFromPasteAsQuotation'].includes(event?.inputType);
  sendSlot({ type: 'compose', text: message.value, caret: message.selectionEnd, paste });
}

function sendMessage() {
  const text = message.value;
  if (!text.trim() || !running) return;
  sendSlot({ type: 'submit', text });
  if (!text.trim().startsWith('/')) chat.addPending(text, busy);
  message.value = '';
  message.style.height = '';
  renderTui();
}

$('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  sendMessage();
});
message.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendMessage();
  }
});
message.addEventListener('input', (event) => {
  compose(event);
  message.style.height = '';
  message.style.height = `${message.scrollHeight}px`;
  // A scroll bar only once the box reaches its tallest.
  message.style.overflowY = message.scrollHeight > 200 ? 'auto' : 'hidden';
  $('suggestion').hidden = Boolean(message.value) || $('suggestion').hidden;
});

// Text from an input method (accents, Chinese, Japanese) counts once it's committed.
message.addEventListener('compositionend', () => compose());

connect();
