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

export class FilesView {
  constructor(root) {
    this.root = root;
    this.dir = '';
    this.selected = null;
    root.innerHTML = '';
    this.toolbar = el('div', 'files-toolbar');
    this.crumbs = el('nav', 'crumbs');
    const refresh = el('button', 'ghost icon-only small');
    refresh.type = 'button';
    refresh.title = 'Refresh';
    refresh.append(svg(REFRESH_ICON));
    refresh.addEventListener('click', () => this.load(this.dir));
    this.archive = el('a', 'button-link ghost small');
    this.archive.append(svg(DOWNLOAD_ICON), el('span', '', 'Download folder'));
    this.toolbar.append(this.crumbs, refresh, this.archive);

    this.body = el('div', 'files-body');
    this.list = el('div', 'files-list');
    this.preview = el('div', 'files-preview');
    this.preview.hidden = true;
    this.body.append(this.list, this.preview);
    root.append(this.toolbar, this.body);
  }

  async load(dir = this.dir) {
    let data;
    try {
      const res = await fetch(`/api/files?path=${encodeURIComponent(dir)}`);
      data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
    } catch (err) {
      this.list.replaceChildren(el('p', 'files-empty', `Could not list this folder: ${err.message}`));
      return;
    }
    this.dir = data.path;
    this.renderCrumbs();
    this.archive.href = `/api/archive?path=${encodeURIComponent(this.dir)}`;
    this.archive.title = `Download ${this.dir || 'the workspace'} as .tar.gz`;
    if (!data.entries.length) {
      this.list.replaceChildren(el('p', 'files-empty', 'This folder is empty.'));
      return;
    }
    const rows = data.entries.map((entry) => this.row(entry));
    this.list.replaceChildren(...rows);
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
    if (entry.name.startsWith('.')) row.classList.add('dotfile');
    if (path === this.selected) row.classList.add('selected');
    const iconNode = entry.type === 'dir' ? svg(FOLDER_ICON) : icon('file');
    iconNode.classList.add(entry.type === 'dir' ? 'folder-icon' : 'file-icon');
    row.append(
      iconNode,
      el('span', 'file-name', entry.name + (entry.link ? ' →' : '')),
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
    for (const r of this.list.querySelectorAll('.file-row')) r.classList.toggle('selected', r.querySelector('.file-name').textContent.replace(' →', '') === entry.name);
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
