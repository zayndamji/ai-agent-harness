// Browser side: draws the session's terminal with xterm.js and sends
// keystrokes, messages and size changes back over the WebSocket.
import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const idle = $('idle');
const idleText = $('idle-text');
const startBtn = $('start');
const stopBtn = $('stop');
const message = $('message');
const sendBtn = $('send');

const term = new Terminal({
  fontFamily: 'Menlo, "SF Mono", Consolas, "DejaVu Sans Mono", monospace',
  fontSize: 13,
  cursorBlink: true,
  scrollback: 5000,
  theme: { background: '#1b1b1a', foreground: '#ecebe7' },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open($('terminal'));
fit.fit();

let ws = null;
let running = false;
let retryDelay = 500;

function sendJson(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function setStatus(state, text) {
  statusEl.dataset.state = state;
  statusEl.textContent = text;
}

function showState(isRunning, exitText) {
  running = isRunning;
  setStatus(isRunning ? 'running' : 'stopped', isRunning ? 'Session running' : 'No session');
  idle.hidden = isRunning;
  stopBtn.hidden = !isRunning;
  message.disabled = !isRunning;
  sendBtn.disabled = !isRunning;
  if (exitText) idleText.textContent = exitText;
  if (isRunning) term.focus();
}

function connect() {
  setStatus('connecting', 'Connecting');
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    retryDelay = 500;
  };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case 'state':
        showState(msg.running);
        if (msg.running) sendJson({ type: 'resize', cols: term.cols, rows: term.rows });
        break;
      case 'reset':
        term.reset();
        break;
      case 'output':
        term.write(msg.data);
        break;
      case 'exit':
        showState(false, msg.stopped ? 'Session stopped.' : `Claude Code exited (code ${msg.exitCode}).`);
        break;
      case 'error':
        idleText.textContent = msg.message;
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

term.onData((data) => sendJson({ type: 'input', data }));
term.onResize(({ cols, rows }) => {
  if (running) sendJson({ type: 'resize', cols, rows });
});
new ResizeObserver(() => fit.fit()).observe($('terminal'));

startBtn.addEventListener('click', () => {
  idleText.textContent = 'Starting...';
  fit.fit();
  sendJson({ type: 'start', cols: term.cols, rows: term.rows });
});

stopBtn.addEventListener('click', () => {
  if (confirm('Stop the session? Claude Code will exit.')) sendJson({ type: 'stop' });
});

// The message box pastes the text into the terminal (as a bracketed paste
// when Claude Code has turned that on), then presses Enter.
function sendMessage() {
  const text = message.value;
  if (!text.trim() || !running) return;
  term.paste(text);
  setTimeout(() => sendJson({ type: 'input', data: '\r' }), 50);
  message.value = '';
  message.style.height = '';
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
message.addEventListener('input', () => {
  message.style.height = '';
  message.style.height = `${message.scrollHeight}px`;
});

connect();
