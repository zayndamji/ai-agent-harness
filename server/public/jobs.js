// The Background panel on the Chat tab: every agent and background command
// in the session, running ones first. Opening one shows its details: an
// agent's task, steps and report, or a command and its live output.
import { markdown } from '/chat.js';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
};

const ICONS = {
  agent: '<rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 3v4M9 13h.01M15 13h.01"/>',
  command: '<path d="M4 17l6-5-6-5M12 19h8"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
};
const svg = (name) => {
  const span = el('span', 'icon');
  span.style.display = 'inline-flex';
  span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
  return span;
};

function duration(job) {
  const start = Date.parse(job.startedAt || '');
  if (!start) return '';
  const end = job.status === 'running' ? Date.now() : Date.parse(job.finishedAt || '') || Date.now();
  const s = Math.max(0, Math.round((end - start) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function statusLine(job) {
  if (job.status === 'running') return `Running · ${duration(job)}`;
  return `${job.status === 'error' ? 'Failed' : 'Finished'}${duration(job) ? ` · ${duration(job)}` : ''}`;
}

export class JobsPanel {
  constructor({ root, toggle, count, chat, sid }) {
    this.root = root;
    // The slot the page is attached to, for fetching a command's output.
    this.sid = sid;
    this.toggle = toggle;
    this.count = count;
    this.chat = chat;
    this.openKey = null;
    this.output = new Map();
    // Steps the reader opened stay open when the view is drawn again.
    this.opened = new Set();
    this.root.innerHTML = '';
    const head = el('div', 'jobs-head');
    this.back = el('button', 'ghost icon-only small jobs-back');
    this.back.type = 'button';
    this.back.title = 'All background work';
    this.back.append(svg('back'));
    this.back.addEventListener('click', () => this.show(null));
    this.title = el('div', 'jobs-title', 'Background');
    const close = el('button', 'ghost icon-only small');
    close.type = 'button';
    close.title = 'Close';
    close.append(svg('close'));
    close.addEventListener('click', () => this.setOpen(false));
    head.append(this.back, this.title, close);
    this.body = el('div', 'jobs-body');
    this.root.append(head, this.body);
    toggle.addEventListener('click', () => this.setOpen(this.root.hidden));
    chat.onJobs = () => this.refresh();
    chat.onOpenJob = (key) => {
      this.setOpen(true);
      this.show(key);
    };
    // Running times tick, and running commands' output is fetched again.
    setInterval(() => {
      if (!this.root.hidden && [...chat.jobs.values()].some((j) => j.status === 'running')) this.render();
    }, 1000);
  }

  setOpen(open) {
    this.root.hidden = !open;
    this.toggle.setAttribute('aria-pressed', String(open));
    document.body.classList.toggle('jobs-open', open);
    if (open) this.render();
  }

  show(key) {
    this.openKey = key;
    this.render();
  }

  refresh() {
    const jobs = [...this.chat.jobs.values()];
    const running = jobs.filter((j) => j.status === 'running').length;
    this.count.textContent = running || jobs.length || '';
    this.count.classList.toggle('live', running > 0);
    this.toggle.title = running ? `${running} running in the background` : 'Background commands and agents';
    if (this.openKey && !this.chat.jobs.has(this.openKey)) this.openKey = null;
    if (!this.root.hidden) this.render();
  }

  render() {
    const job = this.openKey ? this.chat.jobs.get(this.openKey) : null;
    this.back.hidden = !job;
    this.title.textContent = job ? (job.kind === 'agent' ? 'Agent' : 'Background command') : 'Background';
    // Keep the reader's place when the same view is drawn again.
    const scroll = this.body.scrollTop;
    this.body.replaceChildren(job ? this.detail(job) : this.list());
    this.body.scrollTop = scroll;
  }

  list() {
    const jobs = [...this.chat.jobs.values()].sort((a, b) => (a.status === 'running') - (b.status === 'running') || Date.parse(a.startedAt || 0) - Date.parse(b.startedAt || 0)).reverse();
    if (!jobs.length) {
      const empty = el('div', 'jobs-empty');
      empty.append(el('p', 'jobs-empty-title', 'Nothing in the background'), el('p', '', 'Agents Claude starts, and commands it runs in the background, show up here with their steps and output.'));
      return empty;
    }
    const box = el('div', 'jobs-list');
    for (const job of jobs) {
      const row = el('button', 'job-row');
      row.type = 'button';
      row.dataset.state = job.status;
      const mark = el('span', 'job-mark');
      if (job.status === 'running') mark.append(el('span', 'spinner'));
      else mark.append(svg(job.status === 'error' ? 'x' : 'check'));
      const text = el('span', 'job-text');
      const name = el('span', 'job-name');
      name.append(svg(job.kind === 'agent' ? 'agent' : 'command'), el('span', '', job.title));
      const meta = [job.kind === 'agent' ? job.agentType || 'Agent' : 'Bash', job.background ? 'background' : null, statusLine(job)].filter(Boolean).join(' · ');
      text.append(name, el('span', 'job-meta', meta));
      row.append(mark, text);
      row.addEventListener('click', () => this.show(job.key));
      box.append(row);
    }
    return box;
  }

  detail(job) {
    const box = el('div', 'job-detail');
    const head = el('div', 'job-detail-head');
    head.append(el('div', 'job-detail-title', job.title));
    const meta = [job.kind === 'agent' ? job.agentType || 'Agent' : 'Bash', job.background ? 'background' : null, job.model, statusLine(job)].filter(Boolean).join(' · ');
    head.append(el('div', `job-meta ${job.status}`, meta));
    const jump = el('button', 'ghost small', 'Show in chat');
    jump.type = 'button';
    jump.addEventListener('click', () => {
      job.card.details.open = true;
      job.card.node.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (window.matchMedia('(max-width: 999px)').matches) this.setOpen(false);
    });
    head.append(jump);
    box.append(head);

    if (job.kind === 'command') {
      box.append(el('div', 'tool-label', 'Command'), el('pre', 'cmd job-pre', job.command));
      box.append(el('div', 'tool-label', job.status === 'running' ? 'Output so far' : 'Output'));
      const out = el('pre', 'job-pre job-output', this.output.get(job.key)?.text ?? 'Loading…');
      box.append(out);
      this.loadOutput(job, out);
      if (job.summary) box.append(el('div', 'tool-label', 'Finished'), el('p', 'job-summary', job.summary));
      return box;
    }

    if (job.prompt) {
      const task = el('details', 'job-task');
      this.remember(task, `${job.key}:task`);
      task.append(el('summary', '', 'Task'), el('pre', 'job-pre', job.prompt));
      box.append(task);
    }
    box.append(el('div', 'tool-label', `Steps · ${job.steps.filter((s) => s.type === 'tool').length}`));
    const steps = el('div', 'job-steps');
    if (!job.steps.length) steps.append(el('p', 'muted', job.status === 'running' ? 'Starting…' : 'No steps recorded.'));
    job.steps.forEach((step, i) => {
      if (step.type === 'tool') {
        const row = el('details', 'job-step');
        this.remember(row, `${job.key}:${i}`);
        row.dataset.state = step.state;
        const summary = el('summary');
        const mark = el('span', 'step-state');
        if (step.state === 'running') mark.append(el('span', 'spinner'));
        else mark.append(svg(step.state === 'error' ? 'x' : 'check'));
        summary.append(mark, el('span', 'step-name', step.name), el('span', 'step-summary', step.summary));
        row.append(summary);
        if (step.output) row.append(el('pre', 'job-pre', step.output));
        steps.append(row);
      } else {
        steps.append(el('div', step.type === 'error' ? 'job-text-step error' : 'job-text-step', step.text));
      }
    });
    box.append(steps);
    if (job.report) {
      box.append(el('div', 'tool-label', 'Report'));
      const report = markdown(job.report);
      report.classList.add('job-report');
      box.append(report);
    }
    return box;
  }

  remember(details, id) {
    details.open = this.opened.has(id);
    details.addEventListener('toggle', () => (details.open ? this.opened.add(id) : this.opened.delete(id)));
  }

  // A running command's output is fetched each time the view is drawn
  // (about once a second); a finished one once.
  async loadOutput(job, node) {
    const cached = this.output.get(job.key);
    if (cached?.final || !job.taskId) {
      if (!job.taskId) node.textContent = 'Waiting for the command to start…';
      return;
    }
    if (cached?.loading) return;
    this.output.set(job.key, { ...cached, loading: true });
    try {
      const res = await fetch(`/api/task-output?sid=${encodeURIComponent(this.sid() || '')}&task=${encodeURIComponent(job.taskId)}`);
      const data = await res.json();
      const gone = job.status === 'running'
        ? 'No output yet.'
        : 'The output is gone: Claude Code keeps it in a temporary file, which is cleared when the container restarts.';
      const text = res.ok ? (data.truncated ? `[… earlier output cut]\n${data.output}` : data.output) || '(no output)' : gone;
      this.output.set(job.key, { text, final: job.status !== 'running' && res.ok });
      if (node.isConnected) node.textContent = text;
    } catch {
      this.output.set(job.key, { text: 'Output is not available.', final: false });
    }
  }
}
