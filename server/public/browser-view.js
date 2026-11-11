// The Browser tab: the container's shared Chrome, drawn by noVNC from the
// server's /vnc connection. Clicks and keys go to Chrome, never to Claude
// Code. Connected only while the tab is open.
import RFB from '/vendor/novnc/core/rfb.js';
import { ask, confirmAction, notice } from '/dialog.js';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// X keysyms for Ctrl+V.
const XK_CONTROL_L = 0xffe3;
const XK_V = 0x0076;

export class BrowserView {
  constructor(root) {
    this.root = root;
    this.rfb = null;
    this.visible = false;
    this.retry = null;
    this.available = null;

    const bar = el('div', 'browser-bar');
    this.status = el('span', 'browser-status', 'Not connected');
    this.status.dataset.state = 'off';
    const spacer = el('span', 'browser-spacer');
    this.pasteBtn = el('button', 'ghost small', 'Paste text');
    this.pasteBtn.type = 'button';
    this.pasteBtn.title = "Put text on the browser's clipboard and paste it where the cursor is";
    this.restartBtn = el('button', 'ghost small', 'Restart Chrome');
    this.restartBtn.type = 'button';
    this.restartBtn.title = 'Quit Chrome and start it again';
    bar.append(this.status, spacer, this.pasteBtn, this.restartBtn);

    this.screen = el('div', 'browser-screen');
    this.message = el('div', 'browser-message');
    this.message.hidden = true;
    root.append(bar, this.screen, this.message);

    this.pasteBtn.addEventListener('click', () => this.paste());
    this.restartBtn.addEventListener('click', () => this.restart());
  }

  show() {
    this.visible = true;
    this.connect();
  }

  hide() {
    this.visible = false;
    clearTimeout(this.retry);
    this.rfb?.disconnect();
  }

  async connect() {
    if (!this.visible || this.rfb) return;
    if (this.available === null) {
      try {
        const res = await fetch('/api/browser');
        this.available = res.ok && (await res.json()).available;
      } catch {
        return this.later();
      }
    }
    if (!this.available) {
      this.setStatus('off', 'No browser');
      return this.showMessage('This container has no browser. Rebuild the image with ./start.sh to add it.');
    }
    if (!this.visible || this.rfb) return;
    this.setStatus('connecting', 'Connecting');
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/vnc`;
    const rfb = new RFB(this.screen, url, { shared: true });
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.focusOnClick = true;
    rfb.background = 'transparent';
    rfb.addEventListener('connect', () => {
      this.message.hidden = true;
      this.setStatus('on', 'Connected');
      rfb.focus();
    });
    rfb.addEventListener('disconnect', () => {
      this.rfb = null;
      this.setStatus('off', 'Not connected');
      if (this.visible) {
        this.showMessage('Lost the connection to the browser. Trying again…');
        this.later();
      }
    });
    this.rfb = rfb;
  }

  later() {
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.connect(), 2000);
  }

  setStatus(state, text) {
    this.status.dataset.state = state;
    this.status.textContent = text;
    const on = state === 'on';
    this.pasteBtn.disabled = !on;
  }

  showMessage(text) {
    this.message.textContent = text;
    this.message.hidden = false;
  }

  // A Mac's Cmd+V reaches Linux Chrome as Super+V, which doesn't paste, and
  // the page can't read the clipboard on its own. So the text goes in by
  // hand: set as the browser's clipboard, then Ctrl+V.
  async paste() {
    const text = await ask('Paste into the browser', { placeholder: 'Text to paste', okLabel: 'Paste' });
    if (!text || !this.rfb) return;
    this.rfb.clipboardPasteFrom(text);
    this.rfb.sendKey(XK_CONTROL_L, 'ControlLeft', true);
    this.rfb.sendKey(XK_V, 'KeyV');
    this.rfb.sendKey(XK_CONTROL_L, 'ControlLeft', false);
    this.rfb.focus();
  }

  async restart() {
    const ok = await confirmAction(
      'Restart Chrome?',
      'Chrome quits and starts again with the same profile. Pages Claude has open close, and tasks using the browser lose it until it is back.',
      'Restart',
    );
    if (!ok) return;
    const res = await fetch('/api/browser', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'restart' }),
    }).catch(() => null);
    if (!res?.ok) notice('Chrome did not restart', 'The server did not answer. Try again in a moment.');
  }
}
