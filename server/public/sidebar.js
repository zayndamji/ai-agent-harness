// The sidebar: one row per session the server runs, with its state, title
// and folder. A row opens its session; its button stops a running one or
// closes an ended one. On phones the sidebar slides in over the page.

const STOP_ICON = '<rect x="6" y="6" width="12" height="12" rx="2"/>';
const CLOSE_ICON = '<path d="M6 6l12 12M18 6L6 18"/>';
const STATE_TEXT = { working: 'Working', waiting: 'Waiting for you', ready: 'Ready', exited: 'Ended' };
const PHONE = window.matchMedia('(max-width: 760px)');

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svg(paths) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('aria-hidden', 'true');
  node.innerHTML = paths;
  return node;
}

export const folderName = (folder) => (folder ? folder.split('/').pop() : 'workspace');

export class Sidebar {
  constructor({ list, count, toggle, badge, backdrop, newButton, store, onOpen, onStop, onClose, onNew }) {
    Object.assign(this, { list, count, toggle, badge, store, onOpen, onStop, onClose });
    this.slots = [];
    this.sid = null;
    newButton.addEventListener('click', () => {
      this.closeDrawer();
      onNew();
    });
    toggle.addEventListener('click', () => {
      if (PHONE.matches) document.body.classList.toggle('sidebar-open');
      else {
        const collapsed = document.body.classList.toggle('sidebar-collapsed');
        store.set('harness-sidebar', collapsed ? 'collapsed' : 'open');
      }
      this.renderToggle();
    });
    backdrop.hidden = false;
    backdrop.addEventListener('click', () => this.closeDrawer());
    document.body.classList.toggle('sidebar-collapsed', store.get('harness-sidebar') === 'collapsed');
    PHONE.addEventListener('change', () => {
      this.closeDrawer();
      this.renderToggle();
    });
    this.renderToggle();
  }

  closeDrawer() {
    document.body.classList.remove('sidebar-open');
    this.renderToggle();
  }

  renderToggle() {
    const body = document.body.classList;
    const shown = PHONE.matches ? body.contains('sidebar-open') : !body.contains('sidebar-collapsed');
    this.toggle.setAttribute('aria-expanded', String(shown));
    // A dot on the toggle when a session the page isn't showing waits for an answer.
    const waiting = this.slots.filter((s) => s.state === 'waiting' && s.sid !== this.sid).length;
    this.badge.hidden = !waiting || shown;
    this.toggle.title = waiting ? `${waiting} ${waiting === 1 ? 'session waits' : 'sessions wait'} for your answer` : 'Show or hide the session list';
  }

  render(slots, sid) {
    this.slots = slots;
    this.sid = sid;
    const running = slots.filter((s) => s.running).length;
    this.count.textContent = running ? `${running} running` : '';
    // Newest first, like the Sessions tab.
    const rows = [...slots].reverse().map((slot) => this.row(slot));
    this.list.replaceChildren(...(rows.length ? rows : [el('p', 'slots-empty', 'No sessions yet.')]));
    this.renderToggle();
  }

  row(slot) {
    const row = el('div', 'slot');
    row.dataset.state = slot.state;
    if (slot.sid === this.sid) row.setAttribute('aria-current', 'true');
    const main = el('button', 'slot-main');
    main.type = 'button';
    const where = slot.folder ? `/workspace/${slot.folder}` : '/workspace';
    // The name other sessions message it by, once known; it starts with the folder's name.
    const named = slot.peerName ? `\nOther sessions call it ${slot.peerName}` : '';
    main.title = `${slot.title || 'New session'}\n${where}${named}`;
    const text = el('span', 'slot-text');
    text.append(el('span', 'slot-title', slot.title || 'New session'), el('span', 'slot-sub', `${slot.peerName || folderName(slot.folder)} · ${STATE_TEXT[slot.state] || slot.state}`));
    main.append(el('span', 'slot-dot'), text);
    main.addEventListener('click', () => {
      this.closeDrawer();
      this.onOpen(slot.sid);
    });
    const action = el('button', 'ghost icon-only small slot-action');
    action.type = 'button';
    const label = slot.running ? 'Stop this session' : 'Close this ended session';
    action.title = label;
    action.setAttribute('aria-label', label);
    action.append(svg(slot.running ? STOP_ICON : CLOSE_ICON));
    action.addEventListener('click', () => (slot.running ? this.onStop(slot) : this.onClose(slot)));
    row.append(main, action);
    return row;
  }
}
