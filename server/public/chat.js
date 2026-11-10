// The Chat tab: renders the session's transcript entries as a conversation.
// Tool calls show as cards, and each result fills in its card when it arrives.
import { marked } from '/vendor/marked.mjs';
import DOMPurify from '/vendor/purify.mjs';
import hljs from '/vendor/highlight.mjs';

const PREVIEW_CHARS = 4000;
const PREVIEW_LINES = 6;

hljs.configure({ ignoreUnescapedHTML: true });
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

// Icon paths are constants, never data from the session.
const ICONS = {
  terminal: '<path d="M4 17l6-5-6-5M12 19h8"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
  agent: '<rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 3v4M9 13h.01M15 13h.01"/>',
  tool: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.7M12 17h.01"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
};
const TOOL_ICONS = {
  Bash: 'terminal', BashOutput: 'terminal', KillShell: 'terminal',
  Read: 'file', Write: 'edit', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  Grep: 'search', Glob: 'search', ToolSearch: 'search',
  WebFetch: 'globe', WebSearch: 'globe',
  TodoWrite: 'list', TaskCreate: 'list', TaskUpdate: 'list', TaskList: 'list',
  Task: 'agent', Agent: 'agent',
  AskUserQuestion: 'question',
};

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
};

export function icon(name) {
  const span = el('span', 'icon');
  span.style.display = 'inline-flex';
  span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.tool}</svg>`;
  return span;
}

const clock = (at) => (at ? new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');
const tokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
const clipChars = (text, max = PREVIEW_CHARS) => (text.length > max ? `${text.slice(0, max)}\n[... ${text.length - max} more characters]` : text);
const firstLines = (text, n = PREVIEW_LINES) => text.split('\n').slice(0, n).join('\n');

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // The clipboard API needs a secure context (https or localhost).
    const area = el('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

// Markdown with highlighted code blocks, each with a language label and a Copy button.
export function markdown(text) {
  const node = el('div', 'markdown');
  node.innerHTML = DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: false }));
  for (const img of node.querySelectorAll('img')) img.addEventListener('error', () => img.remove());
  for (const pre of node.querySelectorAll('pre')) {
    const code = pre.querySelector('code');
    if (!code) continue;
    const lang = [...code.classList].find((c) => c.startsWith('language-'))?.slice(9) || '';
    if (lang && hljs.getLanguage(lang)) hljs.highlightElement(code);
    else if (code.textContent.length < 20_000) code.innerHTML = hljs.highlightAuto(code.textContent).value;
    const box = el('div', 'code');
    const head = el('div', 'code-head');
    const copy = el('button', '', 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      copy.textContent = (await copyText(code.textContent)) ? 'Copied' : 'Copy failed';
      setTimeout(() => (copy.textContent = 'Copy'), 1500);
    });
    head.append(el('span', '', lang || 'text'), copy);
    pre.replaceWith(box);
    box.append(head, pre);
  }
  return node;
}

// The one line that says what a tool call does, from its most telling input.
function toolSummary(name, input = {}) {
  if (name === 'Bash') return input.description || input.command || '';
  if (input.file_path) return input.file_path.replace(/^\/workspace\//, '');
  const pick = input.description || input.command || input.path || input.pattern || input.url || input.query || input.prompt || input.subject;
  const text = typeof pick === 'string' ? pick : Object.values(input).find((v) => typeof v === 'string') || '';
  return text.replace(/\s+/g, ' ').slice(0, 160);
}

function diffView(patch) {
  const box = el('div', 'diff');
  let added = 0;
  let removed = 0;
  for (const hunk of patch) {
    box.append(el('div', 'diff-hunk', `@@ -${hunk.oldStart} +${hunk.newStart} @@`));
    for (const line of hunk.lines) {
      const cls = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : '';
      if (cls === 'add') added++;
      if (cls === 'del') removed++;
      box.append(el('span', `diff-line ${cls}`, line || ' '));
    }
  }
  return { box, added, removed };
}

function todoList(todos) {
  const list = el('ul', 'todo-list');
  for (const todo of todos) {
    const item = el('li');
    item.dataset.status = todo.status || 'pending';
    item.append(el('span', 'todo-box'), el('span', '', todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content));
    list.append(item);
  }
  return list;
}

export class ChatView {
  constructor({ list, scroll, empty, jump, tasks, onTerminal, onTurnEnd }) {
    this.list = list;
    this.scroll = scroll;
    this.empty = empty;
    this.jump = jump;
    this.tasks = tasks;
    this.onTerminal = onTerminal;
    this.onTurnEnd = onTurnEnd;
    this.tools = new Map();
    this.pending = [];
    this.lastAssistant = '';
    scroll.addEventListener('scroll', () => (this.jump.hidden = this.nearBottom()));
    jump.addEventListener('click', () => this.toBottom());
  }

  reset() {
    this.list.replaceChildren(this.empty);
    this.empty.hidden = false;
    this.tools.clear();
    this.pending = [];
    this.tasks.hidden = true;
    this.tasks.replaceChildren();
  }

  // A message sent from this page shows at once, faded, until the transcript
  // records it. If Claude is busy, Claude Code queues it.
  addPending(text, queued) {
    const node = this.userBubble(text, null);
    node.classList.add('pending');
    node.append(el('span', 'pending-label', queued ? 'Queued' : 'Sending'));
    this.empty.hidden = true;
    this.list.append(node);
    this.pending.push({ text: text.trim(), node });
    this.toBottom();
  }

  // Claude Code may store the text slightly differently (line endings, a
  // trimmed paste), so with no exact match the oldest pending one is settled.
  settlePending(text) {
    let i = this.pending.findIndex((p) => p.text === text.trim());
    if (i < 0 && this.pending.length) i = 0;
    if (i < 0) return false;
    this.pending[i].node.remove();
    this.pending.splice(i, 1);
    return true;
  }

  add(entries, { live = true } = {}) {
    const stick = this.nearBottom();
    for (const entry of entries) {
      const node = this.render(entry, live);
      if (!node) continue;
      this.empty.hidden = true;
      // Keep pending bubbles last, below what the transcript has recorded.
      const firstPending = this.pending[0]?.node;
      if (firstPending && firstPending.parentNode === this.list) this.list.insertBefore(node, firstPending);
      else this.list.append(node);
    }
    if (stick) this.toBottom();
    else this.jump.hidden = false;
  }

  nearBottom() {
    const s = this.scroll;
    return s.scrollHeight - s.scrollTop - s.clientHeight < 120;
  }

  toBottom() {
    this.scroll.scrollTop = this.scroll.scrollHeight;
    this.jump.hidden = true;
  }

  userBubble(text, at) {
    const node = el('div', 'msg user');
    const bubble = el('div', 'bubble', text);
    if (at) bubble.title = new Date(at).toLocaleString();
    node.append(bubble);
    return node;
  }

  showTasks(todos) {
    if (!todos?.length) {
      this.tasks.hidden = true;
      return;
    }
    const done = todos.filter((t) => t.status === 'completed').length;
    const current = todos.find((t) => t.status === 'in_progress');
    const wasOpen = this.tasks.querySelector('details')?.open || false;
    const box = el('details');
    box.open = wasOpen;
    const summary = el('summary');
    const bar = el('span', 'tasks-bar');
    const fill = el('span', 'tasks-fill');
    fill.style.width = `${Math.round((done / todos.length) * 100)}%`;
    bar.append(fill);
    summary.append(
      el('span', 'tasks-count', `${done}/${todos.length}`),
      bar,
      el('span', 'tasks-current', current ? current.activeForm || current.content : done === todos.length ? 'All tasks done' : 'Tasks'),
    );
    box.append(summary, todoList(todos));
    this.tasks.replaceChildren(box);
    this.tasks.hidden = false;
  }

  toolCard(entry) {
    if (entry.name === 'AskUserQuestion') return this.questionCard(entry);
    // The card is a box around a <details>, so an output preview can sit
    // below the header while the details are closed.
    const node = el('div', 'tool');
    const details = el('details');
    node.dataset.state = 'pending';
    const summary = el('summary');
    const state = el('span', 'tool-state');
    state.append(el('span', 'spinner'));
    const chev = icon('chev');
    chev.classList.add('chev');
    const iconNode = icon(TOOL_ICONS[entry.name] || 'tool');
    iconNode.classList.add('tool-icon');
    summary.append(iconNode, el('span', 'tool-name', entry.name), el('span', 'tool-summary', toolSummary(entry.name, entry.input)), state, chev);
    const body = el('div', 'tool-body');
    const input = entry.input || {};
    if (entry.name === 'Bash' && input.command) {
      body.append(el('div', 'tool-label', 'Command'), el('pre', 'cmd', input.command));
    } else if (entry.name === 'TodoWrite' && Array.isArray(input.todos)) {
      body.append(todoList(input.todos));
      this.showTasks(input.todos);
    } else if ((entry.name === 'Edit' || entry.name === 'MultiEdit' || entry.name === 'Write') && input.file_path) {
      // The diff arrives with the result; until then the card shows the path.
    } else {
      body.append(el('div', 'tool-label', 'Input'), el('pre', '', JSON.stringify(input, null, 2)));
    }
    details.append(summary, body);
    node.append(details);
    this.tools.set(entry.toolUseId, { node, details, body, state, name: entry.name });
    return node;
  }

  questionCard(entry) {
    const node = el('div', 'question');
    const head = el('div', 'question-head');
    const headText = el('span', '', 'Claude is asking');
    head.append(icon('question'), headText);
    node.append(head);
    for (const q of entry.input?.questions || []) {
      node.append(el('div', 'question-text', q.question));
      const list = el('ol');
      for (const option of q.options || []) {
        const item = el('li', '', option.label);
        if (option.description) item.append(el('span', '', ` · ${option.description}`));
        list.append(item);
      }
      node.append(list);
    }
    const actions = el('div', 'actions');
    const open = el('button', 'small', 'Answer in Terminal');
    open.type = 'button';
    open.addEventListener('click', () => this.onTerminal());
    actions.append(open);
    node.append(actions);
    this.tools.set(entry.toolUseId, { node, question: true, actions, headText });
    return node;
  }

  fillResult(card, entry) {
    if (card.question) {
      // The result reads: User has answered your questions: "Q"="A", "Q2"="A2".
      const answers = [...(entry.text || '').matchAll(/"([^"]*)"="([^"]*)"/g)].map((m) => m[2]);
      const answer = el('div', 'question-answer');
      answer.append(el('span', 'muted', 'Answered: '), document.createTextNode(answers.length ? answers.join(', ') : entry.text));
      card.actions.replaceWith(answer);
      card.headText.textContent = 'Claude asked';
      card.node.classList.add('answered');
      return;
    }
    const { node, details, body, state, name } = card;
    const detail = entry.detail || {};
    const failed = entry.isError || detail.interrupted;
    node.dataset.state = failed ? 'error' : 'done';
    state.replaceChildren(icon(failed ? 'x' : 'check'));
    if (detail.interrupted) state.append(el('span', '', 'interrupted'));

    if (detail.patch?.length) {
      const { box, added, removed } = diffView(detail.patch);
      const stats = el('span', 'diff-stats');
      stats.append(el('span', 'add', `+${added}`), document.createTextNode(' '), el('span', 'del', `−${removed}`));
      state.prepend(stats);
      body.append(box);
      if (detail.truncated) body.append(el('div', 'tool-label', 'Diff shortened'));
      details.open = removed + added <= 12;
      return;
    }
    if (detail.created) {
      state.prepend(el('span', '', `${detail.created} lines`));
    }
    if (name === 'TodoWrite' && detail.todos) {
      this.showTasks(detail.todos);
      return;
    }

    const out = detail.stdout !== undefined ? detail.stdout : entry.text;
    if (out && out.trim()) {
      body.append(el('div', 'tool-label', failed ? 'Error' : 'Output'), el('pre', failed && detail.stdout === undefined ? 'stderr' : '', clipChars(out)));
      node.append(el('div', 'tool-preview', firstLines(out.trimEnd())));
    }
    if (detail.stderr) body.append(el('div', 'tool-label', 'Stderr'), el('pre', 'stderr', clipChars(detail.stderr)));
    if (!out?.trim() && !detail.stderr) body.append(el('div', 'tool-label', 'No output'));
  }

  render(entry, live) {
    switch (entry.kind) {
      case 'user': {
        this.settlePending(entry.text);
        return this.userBubble(entry.text, entry.at);
      }
      case 'queued': {
        if (this.pending.some((p) => p.text === entry.text.trim())) return null;
        const node = this.userBubble(entry.text, entry.at);
        node.classList.add('pending');
        node.append(el('span', 'pending-label', 'Queued'));
        this.pending.push({ text: entry.text.trim(), node });
        return node;
      }
      case 'assistant': {
        this.lastAssistant = entry.text;
        const node = el('div', 'msg assistant');
        if (entry.at) node.title = new Date(entry.at).toLocaleString();
        node.append(markdown(entry.text));
        return node;
      }
      case 'thinking': {
        const node = el('details', 'thinking');
        node.append(el('summary', '', 'Thinking'), el('div', 'thinking-text', entry.text));
        return node;
      }
      case 'tool-use':
        return this.toolCard(entry);
      case 'tool-result': {
        const card = this.tools.get(entry.toolUseId);
        if (card) {
          this.fillResult(card, entry);
          return null;
        }
        const node = el('div', 'tool');
        node.append(el('pre', 'tool-preview', clipChars(entry.text || '(no output)')));
        return node;
      }
      case 'command':
        return el('div', 'command', entry.text);
      case 'command-output': {
        if (!entry.text) return null;
        const node = el('details', 'command-output');
        node.append(el('summary', '', 'Command output'), el('pre', '', clipChars(entry.text)));
        return node;
      }
      case 'interrupt': {
        const node = el('div', 'event');
        node.append(icon('stop'), el('span', '', 'Interrupted'));
        return node;
      }
      case 'error': {
        const node = el('div', 'event error');
        node.append(icon('x'), el('span', '', entry.text));
        return node;
      }
      case 'compact':
        return el('div', 'divider', 'Conversation compacted');
      case 'compact-summary': {
        const node = el('details', 'compact-summary');
        node.append(el('summary', '', 'Summary of the earlier conversation'), markdown(entry.text));
        return node;
      }
      case 'turn-end': {
        const node = el('div', 'turn-end');
        const ok = icon('check');
        ok.classList.add('ok');
        const parts = [`Done in ${(entry.durationMs / 1000).toFixed(1)} s`];
        if (entry.outputTokens) parts.push(`${tokens(entry.outputTokens)} tokens`);
        if (entry.at) parts.push(clock(entry.at));
        node.append(ok, el('span', '', parts.join(' · ')));
        // Old turns replayed on connect are more than a few seconds old.
        if (live && entry.at && Date.now() - Date.parse(entry.at) < 30_000) this.onTurnEnd?.(this.lastAssistant);
        return node;
      }
      default:
        return null;
    }
  }
}

export { tokens };
