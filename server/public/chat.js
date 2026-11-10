// The Chat tab: renders the session's transcript entries as a conversation.
// Tool calls show as cards, and each result fills in its card when it arrives.
import { marked } from '/vendor/marked.mjs';
import DOMPurify from '/vendor/purify.mjs';

const RESULT_PREVIEW = 4000;

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const markdown = (text) => {
  const node = el('div', 'markdown');
  node.innerHTML = DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: false }));
  // The page only loads images from this server, so most Markdown images fail.
  for (const img of node.querySelectorAll('img')) img.addEventListener('error', () => img.remove());
  return node;
};

const preview = (text) => (text.length > RESULT_PREVIEW ? `${text.slice(0, RESULT_PREVIEW)}\n[... ${text.length - RESULT_PREVIEW} more characters]` : text);

// The one line that says what a tool call does, from its most telling input.
function toolSummary(name, input = {}) {
  const pick = input.description || input.command || input.file_path || input.path || input.pattern || input.url || input.query || input.prompt;
  const text = typeof pick === 'string' ? pick : Object.values(input).find((v) => typeof v === 'string') || '';
  return text.replace(/\s+/g, ' ').slice(0, 140);
}

export class ChatView {
  constructor({ list, scroll, empty, busy }) {
    this.list = list;
    this.scroll = scroll;
    this.empty = empty;
    this.busy = busy;
    this.tools = new Map();
  }

  reset() {
    this.list.replaceChildren(this.empty);
    this.empty.hidden = false;
    this.tools.clear();
  }

  setBusy(busy) {
    this.busy.hidden = !busy;
  }

  add(entries) {
    const stick = this.nearBottom();
    for (const entry of entries) {
      const node = this.render(entry);
      if (node) {
        this.empty.hidden = true;
        this.list.append(node);
      }
    }
    if (stick) this.toBottom();
  }

  nearBottom() {
    const s = this.scroll;
    return s.scrollHeight - s.scrollTop - s.clientHeight < 80;
  }

  toBottom() {
    this.scroll.scrollTop = this.scroll.scrollHeight;
  }

  render(entry) {
    switch (entry.kind) {
      case 'user': {
        const node = el('div', 'msg user');
        node.append(el('div', 'bubble', entry.text));
        return node;
      }
      case 'assistant': {
        const node = el('div', 'msg assistant');
        node.append(markdown(entry.text));
        return node;
      }
      case 'thinking': {
        const node = el('details', 'thinking');
        node.append(el('summary', '', 'Thinking'), el('div', 'thinking-text', entry.text));
        return node;
      }
      case 'tool-use': {
        const node = el('details', 'tool');
        node.dataset.state = 'pending';
        const summary = el('summary');
        summary.append(el('span', 'tool-dot'), el('span', 'tool-name', entry.name), el('span', 'tool-summary', toolSummary(entry.name, entry.input)));
        const body = el('div', 'tool-body');
        body.append(el('div', 'tool-label', 'Input'), el('pre', '', JSON.stringify(entry.input, null, 2)));
        node.append(summary, body);
        this.tools.set(entry.toolUseId, { node, body });
        return node;
      }
      case 'tool-result': {
        const card = this.tools.get(entry.toolUseId);
        const label = el('div', 'tool-label', entry.isError ? 'Error' : 'Result');
        const pre = el('pre', '', preview(entry.text || '(no output)'));
        if (!card) {
          const node = el('div', 'tool orphan');
          node.append(label, pre);
          return node;
        }
        card.node.dataset.state = entry.isError ? 'error' : 'done';
        card.body.append(label, pre);
        return null;
      }
      case 'command':
        return el('div', 'command', entry.text);
      case 'command-output': {
        if (!entry.text) return null;
        const node = el('details', 'command-output');
        node.append(el('summary', '', 'Output'), el('pre', '', preview(entry.text)));
        return node;
      }
      case 'turn-end':
        return el('div', 'turn-end', `Done in ${(entry.durationMs / 1000).toFixed(1)} s`);
      default:
        return null;
    }
  }
}
