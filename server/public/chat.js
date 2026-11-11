// The Chat tab: renders the session's transcript entries as a conversation.
// Tool calls show as cards, and each result fills in its card when it arrives.
import { marked } from '/vendor/marked.mjs';
import DOMPurify from '/vendor/purify.mjs';
import hljs from '/vendor/highlight.mjs';

const PREVIEW_CHARS = 4000;
const PREVIEW_LINES = 6;
// A user message longer than this folds.
const FOLD_LINES = 12;
const FOLD_CHARS = 1200;
// Pasted text that arrives wrapped as <pasted_content id="…">…</pasted_content id="…">.
const PASTED = /<pasted_content\b[^>]*>/;
const PASTED_TAGS = /[ \t]*<\/?pasted_content\b[^>]*>[ \t]*\n?/g;

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
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  steps: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
};
const TOOL_ICONS = {
  Bash: 'terminal', BashOutput: 'terminal', KillShell: 'terminal',
  Read: 'file', Write: 'edit', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  Grep: 'search', Glob: 'search', ToolSearch: 'search',
  WebFetch: 'globe', WebSearch: 'globe',
  TodoWrite: 'list', TaskCreate: 'list', TaskUpdate: 'list', TaskList: 'list',
  Task: 'agent', Agent: 'agent',
  AskUserQuestion: 'question',
  SendMessage: 'mail', ListAgents: 'agent',
};

// SendMessage's `to`: a session name, "name [ref]", or the socket of the
// session that wrote ("uds:/tmp/cc-socks/<pid>.sock").
function parseRecipient(to) {
  const text = String(to || '');
  const pid = Number(/cc-socks\/(\d+)\.sock$/.exec(text)?.[1]);
  if (Number.isInteger(pid)) return { pid, name: null };
  return { pid: null, name: text.replace(/\s*\[[0-9a-f]+\]$/, '') || null };
}

// Tool cards (also a result without its call) and thinking: what folds into a group.
const isStep = (node) => node.matches('.tool, .thinking');

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

// "4.2s", "29s", "7m 18s", "1h 3m": the way Claude Code's spinner counts.
const formatDuration = (ms) => {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const total = Math.round(s);
  if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`;
  return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
};

// A strip that scrolls sideways fades at the edge that has more to show.
export function edgeFade(strip) {
  const update = () => {
    const more = strip.scrollWidth - strip.clientWidth > 1;
    const start = more && strip.scrollLeft > 1;
    const end = more && strip.scrollLeft < strip.scrollWidth - strip.clientWidth - 1;
    strip.dataset.fade = start && end ? 'both' : start ? 'start' : end ? 'end' : '';
  };
  strip.addEventListener('scroll', update, { passive: true });
  new ResizeObserver(update).observe(strip);
  return update;
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
    // Plain text stays plain; unlabelled blocks get a best guess.
    if (lang && hljs.getLanguage(lang) && !/^(text|txt|plaintext|plain)$/.test(lang)) hljs.highlightElement(code);
    else if (!lang && code.textContent.length < 20_000) code.innerHTML = hljs.highlightAuto(code.textContent).value;
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

// Paths as a person reads them: relative to /workspace, and a session's
// scratchpad (/tmp/claude-1000/<project>/<session id>/scratchpad/) as "scratchpad/".
const shortPaths = (text) => text
  .replace(/\/tmp\/claude-\d+\/[^/\s]+\/[0-9a-f-]{36}\/scratchpad\b/g, 'scratchpad')
  .replace(/(^|[\s'"`=(])\/workspace\//g, '$1');

// The one line that says what a tool call does, from its most telling input.
// `code` says whether it is a command, path or pattern rather than prose.
function describeTool(name, input = {}) {
  const prose = (text) => ({ text: shortPaths(String(text)).replace(/\s+/g, ' ').slice(0, 160), code: false });
  const code = (text) => ({ text: shortPaths(String(text)).replace(/\s+/g, ' ').slice(0, 160), code: true });
  if (name === 'Bash') return input.description ? prose(input.description) : code(input.command || '');
  if (input.file_path) return code(input.file_path);
  if (typeof input.description === 'string') return prose(input.description);
  for (const key of ['command', 'path', 'pattern', 'url']) if (typeof input[key] === 'string') return code(input[key]);
  for (const key of ['query', 'prompt', 'subject', 'skill']) if (typeof input[key] === 'string') return prose(input[key]);
  return prose(Object.values(input).find((v) => typeof v === 'string') || '');
}
const toolSummary = (name, input) => describeTool(name, input).text;

function summaryNode(name, input) {
  const { text, code } = describeTool(name, input);
  return el('span', code ? 'tool-summary code' : 'tool-summary', text);
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
  // `peers.find({pid, name})` says which running session, if any, is the
  // other side of a message: {sid, name, title}; `peers.open(sid)` opens it.
  constructor({ list, scroll, empty, jump, tasks, background, onTerminal, onTurnEnd, peers }) {
    this.peers = peers;
    // Names of the sessions that messaged this one, by the pid of their
    // socket: a reply is often addressed to the socket, not the name.
    this.peerNames = new Map();
    // Names drawn as plain text because their session wasn't known yet.
    this.unlinked = [];
    this.background = background;
    this.backgroundFade = edgeFade(background);
    this.jobs = new Map();
    this.agentCards = new Map();
    this.waitingSteps = new Map();
    this.list = list;
    this.scroll = scroll;
    this.empty = empty;
    this.jump = jump;
    this.tasks = tasks;
    this.onTerminal = onTerminal;
    this.onTurnEnd = onTurnEnd;
    this.tools = new Map();
    this.groupParts = new WeakMap();
    this.pending = [];
    this.lastAssistant = '';
    scroll.addEventListener('scroll', () => (this.jump.hidden = this.nearBottom()));
    jump.addEventListener('click', () => this.toBottom());
  }

  reset() {
    this.list.replaceChildren(this.empty);
    this.empty.hidden = false;
    this.tools.clear();
    this.peerNames.clear();
    this.unlinked = [];
    this.pending = [];
    this.tasks.hidden = true;
    this.tasks.replaceChildren();
    this.jobs.clear();
    this.agentCards.clear();
    this.waitingSteps.clear();
    this.jobsChanged();
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
    const changed = new Set();
    for (const entry of entries) {
      // One entry the page can't draw must not stop the rest of the batch.
      let node = null;
      try {
        node = this.render(entry, live);
      } catch (err) {
        console.error('Could not draw a chat entry', entry.kind, err);
      }
      // A result or agent step changes a card that may sit in a group.
      for (const card of [this.tools.get(entry.toolUseId), this.tools.get(entry.parentToolUseId), this.agentCards.get(entry.agentId), this.agentCards.get(entry.taskId)]) {
        const owner = card?.node?.closest('.steps');
        if (owner) changed.add(owner);
      }
      if (!node) continue;
      this.empty.hidden = true;
      const group = this.place(node);
      if (group) changed.add(group);
    }
    for (const group of changed) this.refreshGroup(group);
    if (stick) this.toBottom();
    else this.jump.hidden = false;
  }

  // The last thing drawn, above the pending bubbles.
  tail() {
    const firstPending = this.pending[0]?.node;
    const last = firstPending?.parentNode === this.list ? firstPending.previousElementSibling : this.list.lastElementChild;
    return last === this.empty ? null : last;
  }

  // Keep pending bubbles last, below what the transcript has recorded.
  insert(node) {
    const firstPending = this.pending[0]?.node;
    if (firstPending && firstPending.parentNode === this.list) this.list.insertBefore(node, firstPending);
    else this.list.append(node);
  }

  // Tool calls and thinking in a row fold into one group, so Claude's own
  // words stay easy to follow. Text Claude wrote just before a run of steps
  // is a note on the way, drawn quieter than the answer that ends a turn.
  // Returns the group the node went into.
  place(node) {
    const tail = this.tail();
    if (!isStep(node)) {
      this.insert(node);
      return null;
    }
    if (tail?.classList.contains('steps')) {
      this.groupParts.get(tail).body.append(node);
      return tail;
    }
    if (tail && isStep(tail)) {
      const group = this.makeGroup();
      tail.replaceWith(group);
      this.groupParts.get(group).body.append(tail, node);
      return group;
    }
    if (tail?.matches('.msg.assistant')) tail.classList.add('interim');
    this.insert(node);
    return null;
  }

  makeGroup() {
    const node = el('details', 'steps');
    const summary = el('summary');
    const label = el('span', 'steps-label');
    const detail = el('span', 'steps-detail');
    const state = el('span', 'tool-state');
    const chev = icon('chev');
    chev.classList.add('chev');
    const mark = icon('steps');
    mark.classList.add('tool-icon');
    summary.append(mark, label, detail, state, chev);
    const body = el('div', 'steps-body');
    node.append(summary, body);
    this.groupParts.set(node, { label, detail, state, body, mark });
    return node;
  }

  // The group's line: how many calls, which are still running, which failed.
  refreshGroup(group) {
    const parts = this.groupParts.get(group);
    if (!parts) return;
    const cards = [...parts.body.children].filter((c) => c.classList.contains('tool'));
    const isAgent = (c) => c.dataset.tool === 'Agent' || c.dataset.tool === 'Task';
    const agents = cards.length > 0 && cards.every(isAgent);
    const running = cards.filter((c) => c.dataset.state === 'pending' || c.dataset.state === 'running');
    const failed = cards.filter((c) => c.dataset.state === 'error');
    const n = cards.length;
    parts.label.textContent = !n ? 'Thinking' : agents ? `${n} ${n === 1 ? 'agent' : 'agents'}` : `${n} tool ${n === 1 ? 'call' : 'calls'}`;
    if (parts.agents !== agents) {
      const mark = icon(agents ? 'agent' : 'steps');
      mark.classList.add('tool-icon');
      parts.mark.replaceWith(mark);
      Object.assign(parts, { mark, agents });
    }
    if (agents) {
      const done = n - running.length - failed.length;
      parts.detail.textContent = [running.length && `${running.length} running`, done && `${done} done`].filter(Boolean).join(' · ');
    } else if (running.length) {
      const last = running[running.length - 1];
      parts.detail.textContent = `${last.dataset.tool} · ${last.querySelector('.tool-summary')?.textContent || ''}`;
    } else {
      const counts = new Map();
      for (const c of cards) counts.set(c.dataset.tool || 'Tool', (counts.get(c.dataset.tool || 'Tool') || 0) + 1);
      parts.detail.textContent = [...counts].map(([name, k]) => (k > 1 ? `${name} ×${k}` : name)).join(' · ');
    }
    group.dataset.state = running.length ? 'running' : failed.length ? 'error' : 'done';
    if (running.length) parts.state.replaceChildren(el('span', 'spinner'));
    else if (failed.length) parts.state.replaceChildren(icon('x'), el('span', '', `${failed.length} failed`));
    else parts.state.replaceChildren(icon('check'));
  }

  nearBottom() {
    const s = this.scroll;
    return s.scrollHeight - s.scrollTop - s.clientHeight < 120;
  }

  toBottom() {
    this.scroll.scrollTop = this.scroll.scrollHeight;
    this.jump.hidden = true;
  }

  // Long messages (a pasted brief) fold to their first lines with a toggle.
  userBubble(text, at) {
    const node = el('div', 'msg user');
    const pasted = PASTED.test(text);
    const shown = text.replace(PASTED_TAGS, '').replace(/^\s*\n/, '').trimEnd();
    const bubble = el('div', 'bubble');
    if (pasted) bubble.append(el('span', 'bubble-label', 'Pasted text'));
    bubble.append(document.createTextNode(shown));
    if (at) bubble.title = new Date(at).toLocaleString();
    node.append(bubble);
    const lines = shown.split('\n').length;
    if (lines > FOLD_LINES || shown.length > FOLD_CHARS) {
      bubble.classList.add('folded');
      const more = el('button', 'bubble-more', `Show all ${lines} lines`);
      more.type = 'button';
      more.addEventListener('click', () => {
        const folded = bubble.classList.toggle('folded');
        more.textContent = folded ? `Show all ${lines} lines` : 'Show less';
        if (folded) node.scrollIntoView({ block: 'nearest' });
      });
      node.append(more);
    }
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

  // The other session of a message: a link that opens it when it runs here,
  // else its name, which becomes a link once that session is known.
  peerLink({ pid, name, at }) {
    const peer = this.peers?.find({ pid, name, at });
    if (peer?.sid) return this.linkTo(peer, name);
    const node = el('span', 'peer-name', name || peer?.name || 'another session');
    this.unlinked.push({ node, pid, name, at });
    return node;
  }

  linkTo(peer, name) {
    const link = el('button', 'peer-link', peer.name || name || peer.title || 'another session');
    link.type = 'button';
    link.title = peer.title ? `Open “${peer.title}”` : 'Open that session';
    link.addEventListener('click', () => this.peers.open(peer.sid));
    return link;
  }

  // The session list changed: names that now match a running session become links.
  refreshPeers() {
    const waiting = this.unlinked;
    this.unlinked = [];
    for (const item of waiting) {
      if (!item.node.isConnected) continue;
      const peer = this.peers?.find(item);
      if (peer?.sid) item.node.replaceWith(this.linkTo(peer, item.name));
      else this.unlinked.push(item);
    }
  }

  // A message another Claude session sent this one (its SendMessage).
  peerMessage(entry) {
    if (entry.pid && entry.name) this.peerNames.set(entry.pid, entry.name);
    const node = el('div', 'peer-msg');
    if (entry.at) node.title = new Date(entry.at).toLocaleString();
    const head = el('div', 'peer-head');
    head.append(icon('mail'), el('span', '', 'Message from'), this.peerLink({ pid: entry.pid, name: entry.name, at: entry.at }));
    node.append(head, markdown(entry.text || ''));
    return node;
  }

  // This session's SendMessage: who it went to and what it said. The result
  // says whether it reached the other session's inbox.
  messageCard(entry) {
    const input = entry.input || {};
    const node = el('div', 'peer-msg out');
    node.dataset.state = 'pending';
    const head = el('div', 'peer-head');
    const state = el('span', 'tool-state');
    state.append(el('span', 'spinner'));
    const to = parseRecipient(input.to);
    to.name ||= this.peerNames.get(to.pid) || null;
    head.append(icon('mail'), el('span', '', 'Message to'), this.peerLink({ ...to, at: entry.at }), state);
    node.append(head, markdown(input.message || input.content || ''));
    const card = { key: entry.toolUseId, node, state, name: entry.name, input, message: true };
    this.tools.set(entry.toolUseId, card);
    return node;
  }

  toolCard(entry) {
    if (entry.name === 'AskUserQuestion') return this.questionCard(entry);
    if (entry.name === 'SendMessage') return this.messageCard(entry);
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
    const input = entry.input || {};
    const isAgent = entry.name === 'Agent' || entry.name === 'Task';
    summary.append(iconNode, el('span', 'tool-name', entry.name));
    if (isAgent && input.subagent_type) summary.append(el('span', 'badge', input.subagent_type));
    if (entry.background) summary.append(el('span', 'badge bg', 'background'));
    summary.append(summaryNode(entry.name, input), state, chev);
    node.dataset.tool = entry.name;
    const body = el('div', 'tool-body');
    let steps = null;
    let now = null;
    if (isAgent) {
      body.append(el('div', 'tool-label', 'Task'), el('pre', 'agent-prompt', input.prompt || input.description || ''));
      steps = el('div', 'agent-steps');
      body.append(el('div', 'tool-label', 'Steps'), steps);
      // The latest step shows under the header while the card is closed.
      now = el('div', 'agent-now muted', 'Starting…');
    } else if (entry.name === 'Bash' && input.command) {
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
    if (now) node.append(now);
    const card = { key: entry.toolUseId, node, details, body, state, name: entry.name, input, isAgent, steps, now, stepTools: new Map() };
    this.tools.set(entry.toolUseId, card);
    // Agents are jobs from the start; commands only when run in the background.
    if (isAgent) {
      this.job(entry.toolUseId, card, { kind: 'agent', title: input.description || 'Agent', agentType: input.subagent_type || null, prompt: input.prompt || '', startedAt: entry.at, background: Boolean(input.run_in_background) });
    } else if (entry.background) {
      this.job(entry.toolUseId, card, { kind: 'command', title: input.description || input.command || 'Command', command: input.command || '', startedAt: entry.at, background: true });
    }
    for (const step of this.waitingSteps.get(entry.toolUseId) || []) this.addStep(card, step);
    this.waitingSteps.delete(entry.toolUseId);
    return node;
  }

  // ---- Background commands and agents ("jobs")
  //
  // Every agent, and every command run in the background, is a job: what it
  // is, whether it is still running, its steps (agents), its report or
  // summary. The jobs panel and the "Running" strip read `this.jobs`.

  job(key, card, fields) {
    let job = this.jobs.get(key);
    if (!job) {
      job = { key, card, status: 'running', steps: [], stepIndex: new Map(), report: null, summary: null, startedAt: null, finishedAt: null };
      this.jobs.set(key, job);
    }
    Object.assign(job, fields);
    this.jobsChanged();
    return job;
  }

  jobsChanged() {
    if (this.jobsQueued) return;
    this.jobsQueued = true;
    queueMicrotask(() => {
      this.jobsQueued = false;
      this.renderBackground();
      this.onJobs?.();
    });
  }

  finishJob(key, status, fields = {}) {
    const job = this.jobs.get(key);
    if (job) this.job(key, job.card, { status, ...fields });
  }

  renderBackground() {
    const items = [...this.jobs.values()].filter((j) => j.status === 'running');
    this.background.hidden = !items.length;
    if (!items.length) return this.background.replaceChildren();
    const head = el('span', 'bg-head', `Running · ${items.length}`);
    const list = items.map((job) => {
      const item = el('button', 'bg-item');
      item.type = 'button';
      item.append(el('span', 'spinner'), el('span', 'bg-label', `${job.kind === 'agent' ? 'Agent' : 'Bash'} · ${job.title}`));
      item.title = 'Open it in the Background panel';
      item.addEventListener('click', () => this.onOpenJob?.(job.key));
      return item;
    });
    this.background.replaceChildren(head, ...list);
    this.backgroundFade();
  }

  setRunning(card, text) {
    card.node.dataset.state = 'running';
    card.state.replaceChildren(el('span', 'spinner'), el('span', '', text));
  }

  // One step of an agent: a compact tool row, or a line of its text.
  addStep(card, entry) {
    if (entry.kind === 'agent-report') return this.setReport(card, entry.text);
    const step = entry.step;
    const job = this.jobs.get(card.key);
    if (step.kind === 'tool-use') {
      const row = el('div', 'agent-step');
      const mark = el('span', 'step-state');
      mark.append(el('span', 'spinner'));
      row.append(mark, el('span', 'step-name', step.name), el('span', 'step-summary', toolSummary(step.name, step.input)));
      card.steps.append(row);
      card.stepTools.set(step.toolUseId, { row, mark });
      card.now.textContent = `${step.name} · ${toolSummary(step.name, step.input)}`;
      if (job) {
        job.stepIndex.set(step.toolUseId, job.steps.length);
        job.steps.push({ type: 'tool', name: step.name, summary: toolSummary(step.name, step.input), state: 'running', at: entry.at });
      }
    } else if (step.kind === 'tool-result') {
      const tool = card.stepTools.get(step.toolUseId);
      if (tool) {
        tool.row.dataset.state = step.isError ? 'error' : 'done';
        tool.mark.replaceChildren(icon(step.isError ? 'x' : 'check'));
      }
      const i = job?.stepIndex.get(step.toolUseId);
      if (i !== undefined) {
        job.steps[i].state = step.isError ? 'error' : 'done';
        job.steps[i].output = step.text ? step.text.slice(0, 2000) : '';
      }
    } else if (step.kind === 'assistant') {
      card.steps.append(el('div', 'agent-text', step.text.length > 400 ? `${step.text.slice(0, 400)}…` : step.text));
      card.now.textContent = step.text.replace(/\s+/g, ' ').slice(0, 140);
      job?.steps.push({ type: 'text', text: step.text, at: entry.at });
    } else if (step.kind === 'error') {
      card.steps.append(el('div', 'agent-text error', step.text));
      job?.steps.push({ type: 'error', text: step.text, at: entry.at });
    }
    if (job) this.jobsChanged();
  }

  // The agent's own report, from its hand-back.
  setReport(card, text) {
    card.report = text;
    card.resultBox?.remove();
    card.previewBox?.remove();
    card.resultBox = el('div', 'agent-result');
    card.resultBox.append(el('div', 'tool-label', 'Report'), markdown(text));
    card.body.append(card.resultBox);
    card.previewBox = el('div', 'tool-preview', firstLines(text));
    card.node.append(card.previewBox);
    if (card.now) card.now.textContent = 'Reporting back';
    if (this.jobs.has(card.key)) this.job(card.key, card, { report: text });
  }

  // A background command or agent finished: update its card, and say so.
  taskDone(entry) {
    // An agent Claude resumed with SendMessage notifies with that message's
    // tool call; its task id is still the agent's id.
    let card = this.tools.get(entry.toolUseId);
    if (!card?.body) card = this.agentCards.get(entry.taskId) || null;
    const failed = /fail|error|kill/i.test(entry.status);
    if (card) {
      card.node.dataset.state = failed ? 'error' : 'done';
      card.state.replaceChildren(icon(failed ? 'x' : 'check'), el('span', '', entry.status || 'done'));
      if (card.now) card.now.remove();
      // An agent's notice only points at the report, which the card already shows.
      const result = entry.result && !/^This agent's report was delivered/.test(entry.result) ? entry.result : null;
      if (card.report) {
        // Nothing to add.
      } else if (result) {
        card.body.append(el('div', 'tool-label', 'Result'), markdown(result));
        card.node.append(el('div', 'tool-preview', firstLines(result)));
      } else if (entry.summary) {
        card.body.append(el('div', 'tool-label', 'Finished'), el('pre', '', entry.summary));
      }
      const job = this.jobs.get(entry.toolUseId);
      this.finishJob(entry.toolUseId, failed ? 'error' : 'done', {
        summary: entry.summary,
        finishedAt: entry.at,
        taskId: entry.taskId || job?.taskId,
        report: job?.report || result,
        usage: entry.usage,
      });
    }
    const node = el('div', failed ? 'event warn' : 'event');
    node.append(icon(failed ? 'x' : 'check'), el('span', '', entry.summary || `Background task ${entry.status || 'finished'}`));
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
    if (card.message) {
      let result = null;
      try {
        result = JSON.parse(entry.text);
      } catch {
        // Not JSON: an error message.
      }
      const sent = !entry.isError && result?.success;
      card.node.dataset.state = sent ? 'done' : 'error';
      card.state.replaceChildren(icon(sent ? 'check' : 'x'));
      card.state.title = sent ? 'Delivered to its inbox' : '';
      if (!sent) card.node.append(el('div', 'peer-error', result?.message || result?.error || entry.text || 'Not delivered'));
      return;
    }
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
    const { node, details, body, state, name, input } = card;
    const detail = { ...(entry.detail || {}) };
    if (detail.agentId) {
      this.agentCards.set(detail.agentId, card);
      for (const step of this.waitingSteps.get(detail.agentId) || []) this.addStep(card, step);
      this.waitingSteps.delete(detail.agentId);
    }
    if (card.isAgent && detail.isAsync && !entry.isError) {
      // Started in the background; its task notification finishes the card.
      this.setRunning(card, 'background');
      this.job(entry.toolUseId, card, { background: true, agentId: detail.agentId, model: detail.model || null });
      return;
    }
    if (detail.backgroundTaskId && !entry.isError) {
      this.setRunning(card, 'background');
      this.job(entry.toolUseId, card, { kind: 'command', title: input?.description || input?.command || 'Command', command: input?.command || '', taskId: detail.backgroundTaskId, background: true });
      return;
    }
    if (card.isAgent) {
      // A foreground agent returns its answer as the tool result.
      const failed = entry.isError;
      const answer = entry.text && !/^This agent's report was delivered/.test(entry.text) ? entry.text : null;
      this.finishJob(entry.toolUseId, failed ? 'error' : 'done', { finishedAt: entry.at, report: card.report || answer, agentId: detail.agentId, model: detail.model || null });
      node.dataset.state = failed ? 'error' : 'done';
      state.replaceChildren(icon(failed ? 'x' : 'check'));
      if (card.now) card.now.remove();
      if (entry.text && !card.report && !/^This agent's report was delivered/.test(entry.text)) {
        body.append(el('div', 'tool-label', failed ? 'Error' : 'Result'), markdown(entry.text));
        node.append(el('div', 'tool-preview', firstLines(entry.text)));
      }
      return;
    }
    // A Write that creates a file has no diff; show its content as added lines.
    if (!detail.patch?.length && name === 'Write' && typeof input?.content === 'string' && !entry.isError) {
      const lines = input.content.replace(/\n$/, '').split('\n');
      detail.patch = [{ oldStart: 0, newStart: 1, lines: lines.slice(0, 400).map((l) => `+${l}`) }];
      detail.truncated = lines.length > 400;
    }
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
      // A one-line result that only repeats the header ("Launching skill: x") adds nothing.
      const said = toolSummary(name, input);
      const echo = Boolean(said) && !out.trim().includes('\n') && out.includes(said);
      if (!echo || failed) node.append(el('div', 'tool-preview', firstLines(out.trimEnd())));
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
      case 'peer-message':
        return this.peerMessage(entry);
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
      case 'task-done':
        return this.taskDone(entry);
      case 'agent-report': {
        const card = this.tools.get(entry.parentToolUseId) || this.agentCards.get(entry.agentId);
        if (card?.isAgent) this.setReport(card, entry.text);
        else {
          const key = entry.parentToolUseId || entry.agentId;
          if (!this.waitingSteps.has(key)) this.waitingSteps.set(key, []);
          this.waitingSteps.get(key).push(entry);
        }
        return null;
      }
      case 'agent-step': {
        const card = this.tools.get(entry.parentToolUseId) || this.agentCards.get(entry.agentId);
        if (card?.isAgent) this.addStep(card, entry);
        else {
          // The Agent card isn't drawn yet; keep the step for it.
          const key = entry.parentToolUseId || entry.agentId;
          if (!this.waitingSteps.has(key)) this.waitingSteps.set(key, []);
          this.waitingSteps.get(key).push(entry);
        }
        return null;
      }
      case 'shell': {
        // Sent from the message box as "!command".
        this.settlePending(`!${entry.text}`);
        const node = el('div', 'msg user');
        const bubble = el('div', 'bubble shell');
        bubble.append(el('span', 'shell-prompt', '!'), document.createTextNode(` ${entry.text}`));
        if (entry.at) bubble.title = `Shell command · ${new Date(entry.at).toLocaleString()}`;
        node.append(bubble);
        return node;
      }
      case 'shell-output': {
        const node = el('div', 'shell-output');
        if (entry.stdout) node.append(el('pre', '', clipChars(entry.stdout)));
        if (entry.stderr) node.append(el('div', 'tool-label', 'Stderr'), el('pre', 'stderr', clipChars(entry.stderr)));
        if (!entry.stdout && !entry.stderr) node.append(el('div', 'tool-label', 'No output'));
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
        const parts = [`Done in ${formatDuration(entry.durationMs)}`];
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
