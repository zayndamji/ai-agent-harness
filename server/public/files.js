// The Files tab: browse the workspace, preview text and images, download
// a file or a whole folder.
import hljs from '/vendor/highlight.mjs';
import { icon } from '/chat.js';

const TEXT_PREVIEW_MAX = 2 * 1024 * 1024;
const IMAGES = /\.(png|jpe?g|gif|webp)$/i;

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
};

const FOLDER_ICON = '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>';
const DOWNLOAD_ICON = '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>';
const REFRESH_ICON = '<path d="M20 11a8 8 0 0 0-14.9-3M4 5v3h3M4 13a8 8 0 0 0 14.9 3M20 19v-3h-3"/>';
const svg = (paths) => {
  const span = el('span', 'icon');
  span.style.display = 'inline-flex';
  span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
  return span;
};

function size(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
}

function ago(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

const fileUrl = (p, download) => `/api/file?path=${encodeURIComponent(p)}${download ? '&download=1' : ''}`;
const join = (dir, name) => (dir ? `${dir}/${name}` : name);

const PLUS_ICON = '<path d="M12 5v14M5 12h14"/>';
const PLAY_ICON = '<path d="M7 5l12 7-12 7z"/>';
const CHAT_ICON = '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>';
const GIT_ICON = '<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 8v8M18 11c0 4-6 3-10 6"/>';

function button(className, label, iconPaths, title) {
  const node = el('button', className);
  node.type = 'button';
  if (iconPaths) node.append(svg(iconPaths));
  if (label) node.append(el('span', '', label));
  if (title) node.title = title;
  return node;
}

// The Files tab is also the folder browser: any folder can start a session,
// new or resumed, through `onStart({ folder, resume })`.
export class FilesView {
  constructor(root, { onStart, session }) {
    this.root = root;
    this.onStart = onStart;
    this.session = session;
    this.dir = '';
    this.selected = null;
    root.innerHTML = '';
    this.toolbar = el('div', 'files-toolbar');
    this.crumbs = el('nav', 'crumbs');
    const refresh = button('ghost icon-only small', '', REFRESH_ICON, 'Refresh');
    refresh.addEventListener('click', () => this.load(this.dir));
    const mkdir = button('ghost small', 'New folder', PLUS_ICON, 'Make a folder here');
    mkdir.addEventListener('click', () => this.mkdir());
    this.archive = el('a', 'button-link ghost small');
    this.archive.append(svg(DOWNLOAD_ICON), el('span', '', 'Download'));
    this.startHere = button('small', 'Start session here', PLAY_ICON);
    this.startHere.addEventListener('click', () => this.onStart({ folder: this.dir }));
    this.toolbar.append(this.crumbs, refresh, mkdir, this.archive, this.startHere);

    this.body = el('div', 'files-body');
    this.list = el('div', 'files-list');
    this.preview = el('div', 'files-preview');
    this.preview.hidden = true;
    this.body.append(this.list, this.preview);
    root.append(this.toolbar, this.body);
  }

  get label() {
    return this.dir ? `/workspace/${this.dir}` : '/workspace';
  }

  async load(dir = this.dir) {
    let data;
    let sessions = [];
    try {
      const [res, sres] = await Promise.all([
        fetch(`/api/files?path=${encodeURIComponent(dir)}`),
        fetch(`/api/sessions?path=${encodeURIComponent(dir)}`),
      ]);
      data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      if (sres.ok) sessions = (await sres.json()).sessions;
    } catch (err) {
      this.list.replaceChildren(el('p', 'files-empty', `Could not list this folder: ${err.message}`));
      return;
    }
    this.dir = data.path;
    this.renderCrumbs();
    this.archive.href = `/api/archive?path=${encodeURIComponent(this.dir)}`;
    this.archive.title = `Download ${this.label} as .tar.gz`;
    this.renderStartButton();
    const parts = [this.sessionsPanel(sessions)];
    if (data.entries.length) parts.push(...data.entries.map((entry) => this.row(entry)));
    else parts.push(el('p', 'files-empty', 'This folder is empty.'));
    this.list.replaceChildren(...parts.filter(Boolean));
  }

  // "Start session here" says what it will do: start, or switch from the running session.
  renderStartButton() {
    const s = this.session();
    const here = s.running && s.folder === this.dir;
    this.startHere.querySelector('span:not(.icon)').textContent = here ? 'New session here' : s.running ? 'Switch to this folder' : 'Start session here';
    this.startHere.title = s.running ? `Stops the running session in ${s.folder ? `/workspace/${s.folder}` : '/workspace'} first` : `Start Claude Code in ${this.label}`;
  }

  // Earlier conversations in this folder, newest first, each one resumable.
  sessionsPanel(sessions) {
    if (!sessions.length) return null;
    const s = this.session();
    const panel = el('section', 'sessions');
    const head = el('div', 'sessions-head');
    head.append(svg(CHAT_ICON), el('span', '', `Conversations here · ${sessions.length}`));
    const latest = button('ghost small', 'Continue latest');
    latest.addEventListener('click', () => this.onStart({ folder: this.dir, resume: 'latest' }));
    head.append(latest);
    panel.append(head);
    const shown = sessions.slice(0, 8);
    for (const item of shown) {
      const running = s.running && s.sessionId === item.id;
      const row = el('div', 'session-row');
      const text = el('div', 'session-text');
      text.append(el('div', 'session-name', item.title || item.lastPrompt || 'Untitled conversation'));
      if (item.title && item.lastPrompt) text.append(el('div', 'session-prompt', item.lastPrompt));
      const meta = el('span', 'session-time', ago(item.mtime));
      let action;
      if (running) {
        action = el('span', 'session-running', 'Running');
      } else {
        action = button('ghost small', 'Resume');
        action.addEventListener('click', () => this.onStart({ folder: this.dir, resume: item.id }));
      }
      row.append(text, meta, action);
      panel.append(row);
    }
    if (sessions.length > shown.length) panel.append(el('div', 'session-more', `${sessions.length - shown.length} older conversations not shown`));
    return panel;
  }

  async mkdir() {
    const name = prompt(`New folder in ${this.label}:`);
    if (!name) return;
    const res = await fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: this.dir, name }),
    }).catch(() => null);
    const data = await res?.json().catch(() => ({}));
    if (!res?.ok) return alert(data?.error || 'Could not make the folder.');
    this.closePreview();
    this.load(data.path);
  }

  renderCrumbs() {
    const parts = this.dir ? this.dir.split('/') : [];
    const crumbs = [['workspace', '']];
    parts.forEach((part, i) => crumbs.push([part, parts.slice(0, i + 1).join('/')]));
    this.crumbs.replaceChildren(...crumbs.flatMap(([label, path], i) => {
      const button = el('button', i === crumbs.length - 1 ? 'crumb current' : 'crumb', label);
      button.type = 'button';
      button.addEventListener('click', () => {
        this.closePreview();
        this.load(path);
      });
      return i ? [el('span', 'crumb-sep', '/'), button] : [button];
    }));
  }

  row(entry) {
    const path = join(this.dir, entry.name);
    const row = el('button', 'file-row');
    row.type = 'button';
    row.dataset.path = path;
    if (entry.name.startsWith('.')) row.classList.add('dotfile');
    if (path === this.selected) row.classList.add('selected');
    const iconNode = entry.type === 'dir' ? svg(FOLDER_ICON) : icon('file');
    iconNode.classList.add(entry.type === 'dir' ? 'folder-icon' : 'file-icon');
    const name = el('span', 'file-name');
    name.append(el('span', 'file-label', entry.name + (entry.link ? ' →' : '')));
    if (entry.type === 'dir') {
      const s = this.session();
      if (s.running && s.folder === path) name.append(el('span', 'badge live', 'session running'));
      if (entry.git) {
        const git = el('span', 'badge');
        git.append(svg(GIT_ICON), document.createTextNode('git'));
        name.append(git);
      }
      if (entry.claudeMd) name.append(el('span', 'badge', 'CLAUDE.md'));
      if (entry.sessions) name.append(el('span', 'badge', `${entry.sessions} ${entry.sessions === 1 ? 'session' : 'sessions'}`));
    }
    row.append(
      iconNode,
      name,
      el('span', 'file-size', entry.outside ? 'outside' : entry.type === 'dir' ? '' : size(entry.size)),
      el('span', 'file-time', entry.mtime ? ago(entry.mtime) : ''),
    );
    if (entry.outside) {
      row.disabled = true;
      row.title = 'This link points outside the workspace';
    }
    row.addEventListener('click', () => {
      if (entry.type === 'dir') {
        this.closePreview();
        this.load(path);
      } else {
        this.open(path, entry);
      }
    });
    return row;
  }

  closePreview() {
    this.selected = null;
    this.preview.hidden = true;
    this.body.classList.remove('previewing');
    for (const r of this.list.querySelectorAll('.selected')) r.classList.remove('selected');
  }

  async open(path, entry) {
    this.selected = path;
    for (const r of this.list.querySelectorAll('.file-row')) r.classList.toggle('selected', r.dataset.path === path);
    this.body.classList.add('previewing');
    this.preview.hidden = false;

    const head = el('div', 'preview-head');
    const back = el('button', 'ghost small preview-back', 'Back');
    back.type = 'button';
    back.addEventListener('click', () => this.closePreview());
    const download = el('a', 'button-link small');
    download.href = fileUrl(path, true);
    download.append(svg(DOWNLOAD_ICON), el('span', '', 'Download'));
    const title = el('div', 'preview-title');
    title.append(el('strong', '', entry.name), el('span', 'muted', ` · ${size(entry.size)}`));
    head.append(back, title, download);
    const content = el('div', 'preview-content');
    this.preview.replaceChildren(head, content);

    if (IMAGES.test(entry.name)) {
      const img = el('img', 'preview-image');
      img.src = fileUrl(path);
      img.alt = entry.name;
      content.append(img);
      return;
    }
    if (entry.size > TEXT_PREVIEW_MAX) {
      content.append(el('p', 'files-empty', 'This file is too large to preview. Download it instead.'));
      return;
    }
    const res = await fetch(fileUrl(path)).catch(() => null);
    if (!res?.ok) {
      content.append(el('p', 'files-empty', 'Could not open this file.'));
      return;
    }
    const text = await res.text();
    if (text.slice(0, 8000).includes('\u0000')) {
      content.append(el('p', 'files-empty', 'This looks like a binary file. Download it to open it.'));
      return;
    }
    const pre = el('pre', 'preview-code');
    const code = el('code');
    const ext = (entry.name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
    if (text.length < 300_000 && hljs.getLanguage(ext)) code.innerHTML = hljs.highlight(text, { language: ext }).value;
    else code.textContent = text;
    pre.append(code);
    content.append(pre);
  }
}
