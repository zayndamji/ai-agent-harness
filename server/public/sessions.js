// The Sessions tab: every conversation in every workspace folder, newest
// first, with a search box. Each one can be resumed in its own folder.

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
};

const FOLDER_ICON = '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>';
const svg = (paths) => {
  const span = el('span', 'icon');
  span.style.display = 'inline-flex';
  span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
  return span;
};

function when(ms) {
  const d = new Date(ms);
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days < 1 && d.getDate() === new Date().getDate()) return `Today ${time}`;
  if (days < 2) return `Yesterday ${time}`;
  if (days < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

const PLAY_ICON = '<path d="M7 5l12 7-12 7z"/>';

export class SessionsView {
  constructor(root, { onStart, onOpenFolder, session }) {
    this.root = root;
    this.onStart = onStart;
    this.onOpenFolder = onOpenFolder;
    this.session = session;
    this.items = [];
    root.innerHTML = '';
    const bar = el('div', 'files-toolbar sessions-toolbar');
    this.search = el('input', 'search');
    this.search.type = 'search';
    this.search.placeholder = 'Search conversations and folders';
    this.search.addEventListener('input', () => this.render());
    this.count = el('span', 'muted sessions-count');
    bar.append(this.search, this.count);
    this.list = el('div', 'all-sessions');
    root.append(bar, this.list);
  }

  async load() {
    try {
      const res = await fetch('/api/sessions?all=1');
      if (!res.ok) throw new Error(res.statusText);
      this.items = (await res.json()).sessions;
    } catch (err) {
      this.list.replaceChildren(el('p', 'files-empty', `Could not load sessions: ${err.message}`));
      return;
    }
    this.render();
  }

  render() {
    const q = this.search.value.trim().toLowerCase();
    const items = q
      ? this.items.filter((s) => [s.title, s.lastPrompt, s.folder || 'workspace'].some((t) => (t || '').toLowerCase().includes(q)))
      : this.items;
    this.count.textContent = q ? `${items.length} of ${this.items.length}` : `${this.items.length} conversations`;
    if (!items.length) {
      this.list.replaceChildren(el('p', 'files-empty', this.items.length ? 'No conversations match.' : 'No conversations yet. Start a session from the Files tab or the start card.'));
      return;
    }
    // One section per project folder, the most recently active first; inside
    // each, one line per session, newest first (the server sorts by time).
    const groups = new Map();
    for (const item of items) {
      if (!groups.has(item.folder)) groups.set(item.folder, []);
      groups.get(item.folder).push(item);
    }
    this.list.replaceChildren(...[...groups].map(([folder, list]) => this.section(folder, list)));
  }

  section(folder, list) {
    const s = this.session();
    const box = el('section', 'project');
    const head = el('div', 'project-head');
    const name = el('button', 'project-name');
    name.type = 'button';
    name.title = 'Open this folder in the Files tab';
    name.append(svg(FOLDER_ICON), el('span', '', folder ? `workspace/${folder}` : 'workspace'));
    name.addEventListener('click', () => this.onOpenFolder(folder));
    const count = el('span', 'project-count', `${list.length} ${list.length === 1 ? 'session' : 'sessions'}`);
    if (s.runningIn(folder)) count.append(el('span', 'badge live', 'running'));
    const start = el('button', 'ghost small');
    start.type = 'button';
    start.title = `Start a new session in ${folder ? `/workspace/${folder}` : '/workspace'}`;
    start.append(svg(PLAY_ICON), el('span', '', 'New session'));
    start.addEventListener('click', () => this.onStart({ folder }));
    head.append(name, count, start);
    box.append(head);

    for (const item of list) {
      const running = s.isRunning(item.id);
      const row = el('div', running ? 'session-line running' : 'session-line');
      const text = el('div', 'session-line-text');
      text.append(el('span', 'session-name', item.title || item.lastPrompt || 'Untitled conversation'));
      if (item.title && item.lastPrompt) text.append(el('span', 'session-prompt', item.lastPrompt));
      row.title = [item.title, item.lastPrompt].filter(Boolean).join('\n');
      row.append(text, el('span', 'session-time', when(item.mtime)));
      if (running) {
        // Resuming a running conversation opens its session.
        const open = el('button', 'ghost small', 'Open');
        open.type = 'button';
        open.addEventListener('click', () => this.onStart({ folder, resume: item.id }));
        row.append(el('span', 'session-running', 'Running'), open);
      } else {
        const resume = el('button', 'ghost small', 'Resume');
        resume.type = 'button';
        resume.addEventListener('click', () => this.onStart({ folder, resume: item.id }));
        row.append(resume);
      }
      box.append(row);
    }
    return box;
  }
}
