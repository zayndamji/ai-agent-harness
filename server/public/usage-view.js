// The Usage tab: Claude Code token usage from ccusage, at three depths.
// First: a range and a measure, four headline tiles and a per-day chart.
// Then: where it went, by project, token type and model, as ranked bars.
// Last, folded away: every session, day and 5-hour block, each opening to
// its own breakdown. Costs are estimates at API prices, from ccusage's
// built-in (offline) price list.

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
};
const SVG = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

const RANGES = [
  ['1', 'Today'],
  ['7', '7 days'],
  ['30', '30 days'],
  ['90', '90 days'],
  ['all', 'All time'],
];
const TOKEN_TYPES = [
  ['cacheReadTokens', 'Cache read', 'Context Claude reused from earlier in the conversation. The cheapest kind.'],
  ['cacheCreationTokens', 'Cache write', 'Context stored for reuse in later turns.'],
  ['outputTokens', 'Output', 'What Claude wrote: replies, code and tool calls.'],
  ['inputTokens', 'Input', 'New input that was not cached.'],
];

// ---- Formatting

function compact(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}K`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}
const full = (n) => Math.round(n).toLocaleString();
function money(n) {
  if (!n) return '$0.00';
  if (n < 0.01) return '<$0.01';
  if (n < 1000) return `$${n.toFixed(2)}`;
  return `$${compact(n)}`;
}
function pct(part, whole) {
  if (!whole || !part) return '0%';
  const r = part / whole;
  if (r < 0.001) return '<0.1%';
  return `${(r * 100).toFixed(r < 0.1 ? 1 : 0)}%`;
}
// Axis labels in dollars: cents below $10 when the step needs them ($1.50), whole dollars above.
function moneyTick(t) {
  if (t === 0) return '$0';
  if (t < 10) return `$${Number.isInteger(t) ? t : t.toFixed(2)}`;
  return `$${compact(t)}`;
}

// Local calendar dates, as ccusage writes them for the viewer's timezone.
const ymd = (d) => d.toLocaleDateString('en-CA');
function daysAgo(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}
const dayLabel = (date, opts = { month: 'short', day: 'numeric' }) => new Date(`${date}T12:00:00`).toLocaleDateString([], opts);
const timeLabel = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function span(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function prettyModel(id) {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id || '');
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id;
}

function sumTokens(rows) {
  const out = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, totalCost: 0 };
  for (const r of rows) for (const k of Object.keys(out)) out[k] += r[k] || 0;
  return out;
}

// Clean axis ticks: 0 and three steps of 1, 2 or 5 × 10^n.
function niceTicks(max) {
  if (max <= 0) return [0, 1];
  const raw = max / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw);
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

export class UsageView {
  constructor(root, { onStart, onOpenFolder }) {
    this.root = root;
    this.onStart = onStart;
    this.onOpenFolder = onOpenFolder;
    this.data = null;
    this.range = '30';
    this.measure = 'cost';
    this.tableView = false;
    this.projectFilter = null;
    this.sessionSort = 'recent';
    this.open = new Set();
    root.innerHTML = '';
    this.page = el('div', 'usage');
    root.append(this.page);
    this.tooltip = el('div', 'viz-tip');
    this.tooltip.hidden = true;
    document.body.append(this.tooltip);
    new ResizeObserver(() => this.data && this.renderChart()).observe(root);
  }

  async load({ refresh = false } = {}) {
    if (!this.data) this.page.replaceChildren(el('p', 'usage-loading', 'Reading usage…'));
    this.page.classList.add('refetching');
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const res = await fetch(`/api/usage?tz=${encodeURIComponent(tz)}${refresh ? '&refresh=1' : ''}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      this.data = data;
      this.render();
    } catch (err) {
      if (!this.data) this.page.replaceChildren(el('p', 'usage-loading', `Could not read usage: ${err.message}`));
    } finally {
      this.page.classList.remove('refetching');
    }
  }

  // ---- The slice the filters choose

  slice() {
    const d = this.data;
    const from = this.range === 'all' ? null : ymd(daysAgo(Number(this.range) - 1));
    const fromTime = from ? daysAgo(Number(this.range) - 1).getTime() : 0;
    const inDays = (date) => !from || date >= from;
    const days = d.daily.filter((x) => inDays(x.date));
    const sessions = d.sessions.filter((s) => Date.parse(s.lastActivity) >= fromTime);
    const blocks = d.blocks.filter((b) => Date.parse(b.startTime) >= fromTime);
    const projects = d.projects
      .map((p) => ({ ...p, ...sumTokens(p.days.filter((x) => inDays(x.date))) }))
      .filter((p) => p.totalTokens > 0);
    const models = new Map();
    for (const day of days) {
      for (const m of day.modelBreakdowns || []) {
        const cur = models.get(m.modelName) || { modelName: m.modelName, totalTokens: 0, totalCost: 0 };
        cur.totalTokens += (m.inputTokens || 0) + (m.outputTokens || 0) + (m.cacheCreationTokens || 0) + (m.cacheReadTokens || 0);
        cur.totalCost += m.cost || 0;
        models.set(m.modelName, cur);
      }
    }
    // The same length of time just before, for the tiles' comparison.
    let previous = null;
    if (from) {
      const n = Number(this.range);
      const prevFrom = ymd(daysAgo(2 * n - 1));
      previous = sumTokens(d.daily.filter((x) => x.date >= prevFrom && x.date < from));
    }
    return { from, days, sessions, blocks, projects, models: [...models.values()], totals: sumTokens(days), previous };
  }

  value(row) {
    return this.measure === 'cost' ? row.totalCost || 0 : row.totalTokens || 0;
  }

  fmt(n) {
    return this.measure === 'cost' ? money(n) : compact(n);
  }

  // ---- Page

  render() {
    const s = this.slice();
    this.current = s;
    const page = [];
    page.push(this.header(), this.filters(), this.tiles(s));
    const chartCard = el('section', 'viz-card');
    this.chartCard = chartCard;
    page.push(chartCard);
    const breakdowns = el('div', 'usage-grid');
    breakdowns.append(this.projectsCard(s), this.typesCard(s), this.modelsCard(s));
    page.push(breakdowns);
    page.push(this.sessionsSection(s), this.daysSection(s), this.blocksSection(s), this.footer());
    this.page.replaceChildren(...page);
    this.renderChart();
  }

  header() {
    const head = el('div', 'usage-head');
    head.append(el('h2', '', 'Usage'));
    head.append(el('p', 'muted', 'Claude Code tokens in this container, from ccusage. Costs are estimates at API prices: a Claude subscription is not billed per token.'));
    return head;
  }

  segmented(options, current, onPick, label) {
    const box = el('div', 'seg');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', label);
    for (const [value, text] of options) {
      const b = el('button', '', text);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(value === current));
      b.addEventListener('click', () => onPick(value));
      box.append(b);
    }
    return box;
  }

  filters() {
    const row = el('div', 'usage-filters');
    row.append(
      this.segmented(RANGES, this.range, (v) => ((this.range = v), this.render()), 'Date range'),
      this.segmented([['cost', 'Est. cost'], ['tokens', 'Tokens']], this.measure, (v) => ((this.measure = v), this.render()), 'Measure'),
    );
    return row;
  }

  tile(label, value, sub, extra) {
    const t = el('div', 'stat');
    t.append(el('div', 'stat-label', label), el('div', 'stat-value', value));
    if (sub) t.append(el('div', 'stat-sub', sub));
    if (extra) t.append(extra);
    return t;
  }

  tiles(s) {
    const row = el('div', 'stat-row');
    const name = RANGES.find(([v]) => v === this.range)[1].toLowerCase();
    const vs = (now, before) => {
      if (!s.previous || !before) return s.previous ? `nothing in the ${name} before` : null;
      const change = (now - before) / before;
      return `${change >= 0 ? '+' : '−'}${Math.abs(change * 100).toFixed(0)}% vs the ${name} before`;
    };
    row.append(
      this.tile('Est. cost', money(s.totals.totalCost), vs(s.totals.totalCost, s.previous?.totalCost)),
      this.tile('Tokens', compact(s.totals.totalTokens), vs(s.totals.totalTokens, s.previous?.totalTokens)),
      this.tile('Sessions', String(s.sessions.length), `${s.days.filter((d) => d.totalTokens).length} active ${s.days.length === 1 ? 'day' : 'days'}`),
      this.blockTile(),
    );
    return row;
  }

  // The 5-hour window usage limits are counted in, with a meter for time used.
  blockTile() {
    const active = this.data.blocks.find((b) => b.isActive);
    if (!active) {
      const last = this.data.blocks[this.data.blocks.length - 1];
      return this.tile('5-hour block', 'None active', last ? `Last ended ${timeLabel(last.actualEndTime || last.endTime)}` : 'No blocks yet');
    }
    const start = Date.parse(active.startTime);
    const end = Date.parse(active.endTime);
    const used = Math.min(1, Math.max(0, (Date.now() - start) / (end - start)));
    const meter = el('div', 'meter');
    meter.setAttribute('role', 'meter');
    meter.setAttribute('aria-valuemin', '0');
    meter.setAttribute('aria-valuemax', '100');
    meter.setAttribute('aria-valuenow', String(Math.round(used * 100)));
    meter.setAttribute('aria-label', 'Time used in this 5-hour block');
    const fill = el('span', 'meter-fill');
    fill.style.width = `${used * 100}%`;
    meter.append(fill);
    const rate = active.burnRate?.costPerHour ? ` · ${money(active.burnRate.costPerHour)}/h` : '';
    return this.tile('5-hour block', compact(active.totalTokens), `${money(active.costUSD)} · ${span(end - Date.now())} left${rate}`, meter);
  }

  // ---- Per-day columns, one hue; a tooltip per column and a table twin.

  renderChart() {
    const card = this.chartCard;
    if (!card || !this.current) return;
    const s = this.current;
    const head = el('div', 'viz-head');
    head.append(el('h3', '', this.measure === 'cost' ? 'Estimated cost per day' : 'Tokens per day'));
    const toggle = el('button', 'ghost small', this.tableView ? 'Chart' : 'Table');
    toggle.type = 'button';
    toggle.addEventListener('click', () => {
      this.tableView = !this.tableView;
      this.renderChart();
    });
    head.append(toggle);
    // Every day in the range, including days with nothing.
    const byDate = new Map(this.data.daily.map((d) => [d.date, d]));
    const first = s.from || this.data.daily[0]?.date || ymd(new Date());
    const days = [];
    for (let d = new Date(`${first}T12:00:00`); ymd(d) <= ymd(new Date()); d.setDate(d.getDate() + 1)) {
      const key = ymd(d);
      days.push(byDate.get(key) || { date: key, totalTokens: 0, totalCost: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 });
    }
    card.replaceChildren(head, this.tableView ? this.dayTable(days) : this.columns(days));
  }

  columns(days) {
    const width = Math.max(280, this.chartCard.clientWidth - 32);
    const left = 48;
    const plotH = 180;
    const axisH = 26;
    const plotW = width - left - 8;
    const max = Math.max(...days.map((d) => this.value(d)), 0);
    const ticks = niceTicks(max);
    const top = ticks[ticks.length - 1] || 1;
    const svg = svgEl('svg', { width, height: plotH + axisH + 8, viewBox: `0 0 ${width} ${plotH + axisH + 8}`, class: 'viz' });
    const y = (v) => 8 + plotH - (v / top) * plotH;
    for (const t of ticks) {
      svg.append(svgEl('line', { x1: left, x2: width - 8, y1: y(t), y2: y(t), class: t === 0 ? 'viz-base' : 'viz-grid' }));
      const label = svgEl('text', { x: left - 8, y: y(t) + 4, class: 'viz-tick', 'text-anchor': 'end' });
      label.textContent = this.measure === 'cost' ? moneyTick(t) : compact(t);
      svg.append(label);
    }
    const band = plotW / days.length;
    const barW = Math.max(2, Math.min(24, band - 2, band * 0.7));
    const every = Math.ceil(days.length / Math.max(1, Math.floor(plotW / 64)));
    days.forEach((day, i) => {
      const cx = left + band * i + band / 2;
      const v = this.value(day);
      if (v > 0) {
        const h = Math.max(1, (v / top) * plotH);
        const r = Math.min(4, h, barW / 2);
        const x0 = cx - barW / 2;
        const y0 = 8 + plotH - h;
        // Rounded at the data end, square at the baseline.
        const d = `M${x0},${8 + plotH} V${y0 + r} Q${x0},${y0} ${x0 + r},${y0} H${x0 + barW - r} Q${x0 + barW},${y0} ${x0 + barW},${y0 + r} V${8 + plotH} Z`;
        svg.append(svgEl('path', { d, class: 'viz-bar' }));
      }
      // A date under every few columns, counted back from today so today is labelled.
      if ((days.length - 1 - i) % every === 0) {
        const label = svgEl('text', { x: cx, y: 8 + plotH + 18, class: 'viz-tick', 'text-anchor': 'middle' });
        label.textContent = dayLabel(day.date);
        svg.append(label);
      }
      this.hit(svg, day, cx, band, plotH);
    });
    const wrap = el('div', 'viz-wrap');
    wrap.append(svg);
    return wrap;
  }

  // The whole column band is the hover and focus target.
  hit(svg, day, cx, band, plotH) {
    const g = svgEl('rect', { x: cx - band / 2, y: 0, width: band, height: plotH + 8, class: 'viz-hit', tabindex: '0' });
    g.setAttribute('aria-label', `${dayLabel(day.date, { weekday: 'long', month: 'long', day: 'numeric' })}: ${money(day.totalCost)}, ${full(day.totalTokens)} tokens`);
    const show = (event) => this.showTip(day, event, g);
    g.addEventListener('pointermove', show);
    g.addEventListener('focus', show);
    g.addEventListener('pointerleave', () => (this.tooltip.hidden = true));
    g.addEventListener('blur', () => (this.tooltip.hidden = true));
    svg.append(g);
  }

  showTip(day, event, target) {
    const tip = this.tooltip;
    tip.replaceChildren();
    tip.append(el('div', 'viz-tip-title', dayLabel(day.date, { weekday: 'short', month: 'short', day: 'numeric' })));
    const main = el('div', 'viz-tip-value', this.fmt(this.value(day)));
    tip.append(main);
    const rows = [
      [this.measure === 'cost' ? 'Tokens' : 'Est. cost', this.measure === 'cost' ? full(day.totalTokens) : money(day.totalCost)],
      ...TOKEN_TYPES.map(([k, name]) => [name, full(day[k] || 0)]),
    ];
    for (const [k, v] of rows) {
      const r = el('div', 'viz-tip-row');
      r.append(el('span', '', k), el('strong', '', v));
      tip.append(r);
    }
    tip.hidden = false;
    const box = target.getBoundingClientRect();
    const x = event?.clientX ?? box.left + box.width / 2;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(window.innerWidth - tw - 8, Math.max(8, x + 12))}px`;
    tip.style.top = `${Math.max(8, box.top + 10)}px`;
  }

  dayTable(days) {
    const table = el('table', 'viz-table');
    const head = el('tr');
    for (const h of ['Day', 'Tokens', 'Est. cost']) head.append(el('th', '', h));
    table.append(el('thead'), el('tbody'));
    table.tHead.append(head);
    for (const d of [...days].reverse()) {
      const tr = el('tr');
      tr.append(el('td', '', dayLabel(d.date, { weekday: 'short', month: 'short', day: 'numeric' })), el('td', 'num', full(d.totalTokens)), el('td', 'num', money(d.totalCost)));
      table.tBodies[0].append(tr);
    }
    const wrap = el('div', 'viz-table-wrap');
    wrap.append(table);
    return wrap;
  }

  // ---- Ranked bars: one hue, largest first, the figure at the bar's end.

  ranked(title, rows, { note, onPick, pickLabel } = {}) {
    const card = el('section', 'viz-card');
    const head = el('div', 'viz-head');
    head.append(el('h3', '', title));
    card.append(head);
    if (note) card.append(el('p', 'viz-note', note));
    if (!rows.length) {
      card.append(el('p', 'muted', 'Nothing in this range.'));
      return card;
    }
    const max = Math.max(...rows.map((r) => r.value), 0) || 1;
    const list = el('div', 'rank');
    for (const r of rows) {
      const row = el(onPick ? 'button' : 'div', 'rank-row');
      if (onPick) {
        row.type = 'button';
        row.title = pickLabel;
        row.addEventListener('click', () => onPick(r));
      }
      if (r.hint) row.title = r.hint;
      const name = el('span', 'rank-name', r.label);
      const track = el('span', 'rank-track');
      const bar = el('span', 'rank-bar');
      bar.style.width = `${(r.value / max) * 100}%`;
      track.append(bar);
      row.append(name, track, el('span', 'rank-value', r.text));
      if (r.share) row.append(el('span', 'rank-share', r.share));
      list.append(row);
    }
    card.append(list);
    return card;
  }

  projectsCard(s) {
    const total = this.value(s.totals);
    const rows = s.projects
      .map((p) => ({ label: p.project, value: this.value(p), text: this.fmt(this.value(p)), share: pct(this.value(p), total), project: p }))
      .sort((a, b) => b.value - a.value);
    return this.ranked('By project', rows, {
      onPick: (r) => {
        this.projectFilter = r.project.project;
        this.open.add('sessions');
        this.render();
        this.page.querySelector('.usage-sessions')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
      pickLabel: 'Show this project’s sessions',
    });
  }

  typesCard(s) {
    const t = s.totals;
    const rows = TOKEN_TYPES.map(([k, name, hint]) => ({ label: name, value: t[k], text: compact(t[k]), share: pct(t[k], t.totalTokens), hint })).sort((a, b) => b.value - a.value);
    return this.ranked('By token type', rows, { note: 'Always in tokens. Cache reads are most of the count but cost the least.' });
  }

  modelsCard(s) {
    const total = s.models.reduce((a, m) => a + (this.measure === 'cost' ? m.totalCost : m.totalTokens), 0);
    const rows = s.models
      .map((m) => {
        const v = this.measure === 'cost' ? m.totalCost : m.totalTokens;
        return { label: prettyModel(m.modelName), value: v, text: this.fmt(v), share: pct(v, total) };
      })
      .sort((a, b) => b.value - a.value);
    return this.ranked('By model', rows);
  }

  // ---- Folded details: every session, day and block

  section(id, title, count, build) {
    const box = el('details', `usage-section usage-${id}`);
    box.open = this.open.has(id);
    box.addEventListener('toggle', () => (box.open ? this.open.add(id) : this.open.delete(id)));
    const summary = el('summary');
    summary.append(el('span', 'usage-section-title', title), el('span', 'usage-section-count', count));
    box.append(summary);
    box.append(build());
    return box;
  }

  tokenGrid(row, cost) {
    const grid = el('div', 'token-grid');
    for (const [k, name] of TOKEN_TYPES) {
      const cell = el('div');
      cell.append(el('span', 'muted', name), el('strong', '', full(row[k] || 0)));
      grid.append(cell);
    }
    if (cost !== undefined) {
      const cell = el('div');
      cell.append(el('span', 'muted', 'Est. cost'), el('strong', '', money(cost)));
      grid.append(cell);
    }
    return grid;
  }

  modelTable(breakdowns) {
    if (!breakdowns?.length) return el('span');
    const table = el('table', 'viz-table small');
    const head = el('tr');
    for (const h of ['Model', 'Input', 'Output', 'Cache write', 'Cache read', 'Est. cost']) head.append(el('th', '', h));
    table.append(el('thead'), el('tbody'));
    table.tHead.append(head);
    for (const m of breakdowns) {
      const tr = el('tr');
      tr.append(el('td', '', prettyModel(m.modelName)), el('td', 'num', full(m.inputTokens)), el('td', 'num', full(m.outputTokens)), el('td', 'num', full(m.cacheCreationTokens)), el('td', 'num', full(m.cacheReadTokens)), el('td', 'num', money(m.cost)));
      table.tBodies[0].append(tr);
    }
    const wrap = el('div', 'viz-table-wrap');
    wrap.append(table);
    return wrap;
  }

  // A folded row: one line of figures, opening to the details.
  line(cells, body, key) {
    const row = el('details', 'usage-row');
    row.open = this.open.has(key);
    row.addEventListener('toggle', () => (row.open ? this.open.add(key) : this.open.delete(key)));
    const summary = el('summary');
    for (const [text, cls] of cells) summary.append(el('span', cls || '', text));
    row.append(summary, body);
    return row;
  }

  sessionsSection(s) {
    let rows = s.sessions;
    if (this.projectFilter) rows = rows.filter((x) => x.project === this.projectFilter);
    rows = [...rows].sort((a, b) => (this.sessionSort === 'cost' ? b.totalCost - a.totalCost : Date.parse(b.lastActivity) - Date.parse(a.lastActivity)));
    return this.section('sessions', 'Sessions', String(rows.length), () => {
      const box = el('div', 'usage-list');
      const bar = el('div', 'usage-list-bar');
      bar.append(this.segmented([['recent', 'Recent'], ['cost', 'Most used']], this.sessionSort, (v) => ((this.sessionSort = v), this.open.add('sessions'), this.render()), 'Sort sessions'));
      if (this.projectFilter) {
        const chip = el('button', 'filter-chip', `${this.projectFilter} ✕`);
        chip.type = 'button';
        chip.title = 'Show every project';
        chip.addEventListener('click', () => ((this.projectFilter = null), this.render()));
        bar.append(chip);
      }
      box.append(bar);
      if (!rows.length) box.append(el('p', 'muted', 'No sessions in this range.'));
      for (const x of rows) {
        const body = el('div', 'usage-row-body');
        const meta = el('p', 'muted', `${timeLabel(x.firstActivity)} to ${clock(x.lastActivity)} · ${span(Date.parse(x.lastActivity) - Date.parse(x.firstActivity))} · ${x.project}`);
        body.append(meta, this.tokenGrid(x, x.totalCost), this.modelTable(x.modelBreakdowns));
        if (x.folder !== null) {
          const actions = el('div', 'usage-actions');
          const resume = el('button', 'ghost small', 'Resume');
          resume.type = 'button';
          resume.addEventListener('click', () => this.onStart({ folder: x.folder, resume: x.sessionId }));
          const open = el('button', 'ghost small', 'Open folder');
          open.type = 'button';
          open.addEventListener('click', () => this.onOpenFolder(x.folder));
          actions.append(resume, open);
          body.append(actions);
        }
        box.append(this.line([[x.title || `Session ${x.sessionId.slice(0, 8)}`, 'u-name'], [x.project, 'u-sub'], [timeLabel(x.lastActivity), 'u-when'], [compact(x.totalTokens), 'u-num'], [money(x.totalCost), 'u-num']], body, `s:${x.sessionId}`));
      }
      return box;
    });
  }

  daysSection(s) {
    const days = [...s.days].reverse();
    return this.section('days', 'Days', String(days.length), () => {
      const box = el('div', 'usage-list');
      if (!days.length) box.append(el('p', 'muted', 'Nothing in this range.'));
      for (const d of days) {
        const body = el('div', 'usage-row-body');
        body.append(this.tokenGrid(d, d.totalCost));
        const perProject = this.data.projects
          .map((p) => ({ project: p.project, day: p.days.find((x) => x.date === d.date) }))
          .filter((p) => p.day)
          .sort((a, b) => this.value(b.day) - this.value(a.day));
        if (perProject.length) {
          const list = el('div', 'mini-list');
          list.append(el('div', 'tool-label', 'Projects'));
          for (const p of perProject) {
            const r = el('div', 'mini-row');
            r.append(el('span', '', p.project), el('span', 'num', `${compact(p.day.totalTokens)} · ${money(p.day.totalCost)}`));
            list.append(r);
          }
          body.append(list);
        }
        body.append(this.modelTable(d.modelBreakdowns));
        box.append(this.line([[dayLabel(d.date, { weekday: 'short', month: 'short', day: 'numeric' }), 'u-name'], [(d.modelsUsed || []).map(prettyModel).join(', '), 'u-sub'], ['', 'u-when'], [compact(d.totalTokens), 'u-num'], [money(d.totalCost), 'u-num']], body, `d:${d.date}`));
      }
      return box;
    });
  }

  blocksSection(s) {
    const blocks = [...s.blocks].reverse();
    return this.section('blocks', '5-hour blocks', String(blocks.length), () => {
      const box = el('div', 'usage-list');
      box.append(el('p', 'viz-note', 'Claude’s usage limits are counted in 5-hour windows that start with your first message.'));
      if (!blocks.length) box.append(el('p', 'muted', 'No blocks in this range.'));
      for (const b of blocks) {
        const body = el('div', 'usage-row-body');
        const tc = b.tokenCounts || {};
        body.append(this.tokenGrid({ inputTokens: tc.inputTokens, outputTokens: tc.outputTokens, cacheCreationTokens: tc.cacheCreationInputTokens, cacheReadTokens: tc.cacheReadInputTokens }, b.costUSD));
        const facts = [`${b.entries} API calls`, `Models: ${(b.models || []).map(prettyModel).join(', ') || 'none'}`];
        if (b.isActive && b.burnRate) facts.push(`Burn rate ${compact(b.burnRate.tokensPerMinute)} tokens/min, ${money(b.burnRate.costPerHour)}/h`);
        if (b.isActive && b.projection) facts.push(`At this rate: ${compact(b.projection.totalTokens)} tokens, ${money(b.projection.totalCost)} by ${clock(b.endTime)}`);
        body.append(el('p', 'muted', facts.join(' · ')));
        const when = `${timeLabel(b.startTime)} to ${clock(b.endTime)}`;
        box.append(this.line([[when, 'u-name'], [b.isActive ? 'Active now' : `${span(Date.parse(b.actualEndTime || b.endTime) - Date.parse(b.startTime))} used`, b.isActive ? 'u-sub live' : 'u-sub'], ['', 'u-when'], [compact(b.totalTokens), 'u-num'], [money(b.costUSD), 'u-num']], body, `b:${b.id}`));
      }
      return box;
    });
  }

  footer() {
    const foot = el('div', 'usage-foot');
    const d = this.data;
    foot.append(el('span', '', `Usage data updated ${new Date(d.generatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' })} · ccusage ${d.version}, offline prices · days in ${d.timezone}`));
    const refresh = el('button', 'ghost small', 'Refresh');
    refresh.type = 'button';
    refresh.addEventListener('click', () => this.load({ refresh: true }));
    foot.append(refresh);
    return foot;
  }
}
