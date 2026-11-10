'use strict';
// Follows the transcript Claude Code writes for the running session
// (~/.claude/projects/<cwd>/<session id>.jsonl) and turns its lines into
// simple chat entries and session details for the browser's Chat tab.

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const POLL_MS = 400;
const MAX_ENTRIES = 3000;
const MAX_TEXT = 20_000;
const MAX_PATCH_LINES = 600;
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]$/;

// Claude Code names a project's folder after its path, with every character
// that isn't a letter or digit replaced by a dash: /workspace is -workspace.
function projectDir(cwd) {
  const config = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(config, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

const clip = (text) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[... ${text.length - MAX_TEXT} more characters]` : text);
const tag = (text, name) => text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];

// A slash command and its output arrive as tagged strings.
function commandEntry(text) {
  const name = tag(text, 'command-name');
  if (name !== undefined) return { kind: 'command', text: `${name} ${tag(text, 'command-args') || ''}`.trim() };
  const stdout = tag(text, 'local-command-stdout');
  if (stdout !== undefined) return { kind: 'command-output', text: clip(stdout.replace(ANSI, '').trim()) };
  return null;
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : '')).join('\n');
}

// The parts of a tool's structured result the Chat tab draws: diffs for file
// edits, stdout and stderr for commands, the to-do list after an update.
function toolDetail(result) {
  if (!result || typeof result !== 'object') return undefined;
  const detail = {};
  if (Array.isArray(result.structuredPatch)) {
    let budget = MAX_PATCH_LINES;
    detail.patch = [];
    for (const hunk of result.structuredPatch) {
      if (budget <= 0) break;
      const lines = (hunk.lines || []).slice(0, budget);
      budget -= lines.length;
      detail.patch.push({ oldStart: hunk.oldStart, newStart: hunk.newStart, lines });
    }
    detail.truncated = budget <= 0;
  }
  if (typeof result.filePath === 'string') detail.filePath = result.filePath;
  if (result.type === 'create' && typeof result.content === 'string') detail.created = result.content.split('\n').length;
  if (typeof result.stdout === 'string') detail.stdout = clip(result.stdout);
  if (typeof result.stderr === 'string' && result.stderr) detail.stderr = clip(result.stderr);
  if (result.interrupted) detail.interrupted = true;
  if (Array.isArray(result.newTodos)) detail.todos = result.newTodos;
  if (typeof result.backgroundTaskId === 'string') detail.backgroundTaskId = result.backgroundTaskId;
  // Agent tool: an async agent returns at once and finishes later with a task notification.
  if (typeof result.agentId === 'string') {
    detail.agentId = result.agentId;
    detail.isAsync = Boolean(result.isAsync);
    if (typeof result.status === 'string') detail.agentStatus = result.status;
    if (typeof result.resolvedModel === 'string') detail.model = result.resolvedModel;
  }
  return Object.keys(detail).length ? detail : undefined;
}

// <task-notification> arrives as a user message when a background command or
// agent finishes: which tool call started it, its status, a summary, and for
// agents the final result.
function taskNotification(text) {
  if (!text.startsWith('<task-notification>')) return null;
  const usage = tag(text, 'usage');
  return {
    kind: 'task-done',
    taskId: tag(text, 'task-id') || null,
    toolUseId: tag(text, 'tool-use-id') || null,
    status: (tag(text, 'status') || '').trim(),
    summary: (tag(text, 'summary') || '').trim(),
    result: clip((tag(text, 'result') || '').trim()),
    usage: usage ? usage.replace(/\s+/g, ' ').trim().slice(0, 200) : '',
  };
}

// One transcript line becomes zero or more entries. Bookkeeping lines
// (attachments, API requests, cost state, snapshots) become none.
// Agents' own transcripts (`sidechain`) are read only when asked for.
function toEntries(line, { sidechain = false } = {}) {
  if (line.isSidechain && !sidechain) return [];
  const base = { at: line.timestamp };
  if (line.type === 'system') {
    switch (line.subtype) {
      case 'turn_duration':
        return [{ ...base, kind: 'turn-end', durationMs: line.durationMs }];
      case 'compact_boundary':
        return [{ ...base, kind: 'compact' }];
      case 'api_error': {
        const message = line.error?.message || line.error?.error?.message || (typeof line.content === 'string' ? line.content : 'API error');
        const retry = line.retryAttempt ? ` Retrying (attempt ${line.retryAttempt}${line.maxRetries ? ` of ${line.maxRetries}` : ''}).` : '';
        return [{ ...base, kind: 'error', text: `${message}${retry}` }];
      }
      case 'local_command': {
        const entry = typeof line.content === 'string' && commandEntry(line.content);
        return entry ? [{ ...base, ...entry }] : [];
      }
      default:
        return [];
    }
  }
  if (line.type === 'queue-operation' && line.operation === 'enqueue' && typeof line.content === 'string' && !line.content.startsWith('<')) {
    return [{ ...base, kind: 'queued', text: line.content }];
  }
  const content = line.message?.content;
  if (line.type === 'user') {
    if (line.isCompactSummary) return [{ ...base, kind: 'compact-summary', text: clip(resultText(content)) }];
    if (line.isMeta) return [];
    if (typeof content === 'string') {
      if (content.startsWith('<local-command-caveat>')) return [];
      const done = taskNotification(content);
      if (done) return [{ ...base, ...done }];
      if (INTERRUPTED.test(content.trim())) return [{ ...base, kind: 'interrupt' }];
      const entry = commandEntry(content);
      return [{ ...base, ...(entry || { kind: 'user', text: content }) }];
    }
    if (!Array.isArray(content)) return [];
    return content.flatMap((b) => {
      if (b.type === 'text') {
        if (b.text.startsWith('<system-reminder>')) return [];
        const done = taskNotification(b.text);
        if (done) return [{ ...base, ...done }];
        if (INTERRUPTED.test(b.text.trim())) return [{ ...base, kind: 'interrupt' }];
        return [{ ...base, kind: 'user', text: b.text }];
      }
      if (b.type === 'image') return [{ ...base, kind: 'user', text: '[image]' }];
      if (b.type === 'tool_result') {
        return [{
          ...base,
          kind: 'tool-result',
          toolUseId: b.tool_use_id,
          isError: Boolean(b.is_error),
          text: clip(resultText(b.content)),
          detail: toolDetail(line.toolUseResult),
        }];
      }
      return [];
    });
  }
  if (line.type === 'assistant' && Array.isArray(content)) {
    if (line.isApiErrorMessage) return [{ ...base, kind: 'error', text: resultText(content) }];
    return content.flatMap((b) => {
      if (b.type === 'text' && b.text.trim()) return [{ ...base, kind: 'assistant', text: b.text }];
      if (b.type === 'thinking' && b.thinking?.trim()) return [{ ...base, kind: 'thinking', text: clip(b.thinking) }];
      if (b.type === 'tool_use') return [{ ...base, kind: 'tool-use', toolUseId: b.id, name: b.name, input: b.input, background: Boolean(b.input?.run_in_background) }];
      return [];
    });
  }
  return [];
}

const emptyMeta = () => ({ title: null, model: null, permissionMode: null, contextTokens: null, outputTokens: 0 });

class TranscriptFollower extends EventEmitter {
  constructor(cwd) {
    super();
    this.dir = projectDir(cwd);
    this.entries = [];
    this.meta = emptyMeta();
    this.busy = false;
    this.file = null;
    this.timer = null;
  }

  // Follows the session's own transcript, `<sessionId>.jsonl`, which the
  // server chose (new sessions) or Claude Code appends to (resumed ones).
  // After /clear or /resume inside the session, Claude Code writes another
  // file in the same folder, and the follower switches to the newest one.
  start(sinceMs, { cwd, sessionId } = {}) {
    this.stop();
    if (cwd) this.dir = projectDir(cwd);
    this.since = sinceMs;
    this.sessionId = sessionId || null;
    this.file = null;
    this.agents = new Map();
    this.setEntries([]);
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  get currentSessionId() {
    return this.file ? path.basename(this.file, '.jsonl') : this.sessionId;
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.poll();
    this.setBusy(false);
  }

  setEntries(entries) {
    this.entries = entries;
    this.recentCommands = [];
    this.lastMessageId = null;
    this.turnTokens = 0;
    this.meta = emptyMeta();
    this.emit('reset');
    this.emit('meta', this.meta);
  }

  setBusy(busy) {
    if (busy === this.busy) return;
    this.busy = busy;
    this.emit('busy', busy);
  }

  // Session details from the lines that aren't chat entries. Returns true if
  // anything changed. An assistant message spans several lines with the same
  // id and the same usage, so usage counts once per id.
  updateMeta(line) {
    const meta = this.meta;
    const before = JSON.stringify(meta);
    if (line.type === 'ai-title' && line.aiTitle) meta.title = line.aiTitle;
    if (line.type === 'permission-mode' && line.permissionMode) meta.permissionMode = line.permissionMode;
    if (line.type === 'assistant' && !line.isSidechain && line.message) {
      const m = line.message;
      if (m.model && !m.model.startsWith('<')) meta.model = m.model;
      if (m.usage && m.id !== this.lastMessageId) {
        this.lastMessageId = m.id;
        const u = m.usage;
        meta.contextTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
        meta.outputTokens += u.output_tokens || 0;
        this.turnTokens += u.output_tokens || 0;
      }
    }
    return JSON.stringify(meta) !== before;
  }

  // The session's own file wins unless another file in the folder was
  // written after it since the session started (/clear, /resume).
  newestFile() {
    let best = null;
    let own = null;
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(this.dir, name);
      try {
        const { mtimeMs } = fs.statSync(file);
        if (this.sessionId && name === `${this.sessionId}.jsonl`) own = { file, mtimeMs };
        else if (mtimeMs >= this.since && (!best || mtimeMs > best.mtimeMs)) best = { file, mtimeMs };
      } catch {
        // The file went away between readdir and stat.
      }
    }
    if (own && (!best || own.mtimeMs >= best.mtimeMs)) return own.file;
    return best?.file || own?.file || null;
  }

  // Reads what was appended to a file since `state.offset`, as parsed lines.
  readLines(file, state) {
    let chunk;
    try {
      const fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      chunk = Buffer.alloc(Math.max(0, size - state.offset));
      fs.readSync(fd, chunk, 0, chunk.length, state.offset);
      fs.closeSync(fd);
    } catch {
      return [];
    }
    if (!chunk.length) return [];
    state.offset += chunk.length;
    const texts = (state.partial + chunk.toString('utf8')).split('\n');
    state.partial = texts.pop();
    const lines = [];
    for (const text of texts) {
      if (!text.trim()) continue;
      try {
        lines.push(JSON.parse(text));
      } catch {
        // A line cut mid-write is completed on the next read.
      }
    }
    return lines;
  }

  poll() {
    const file = this.newestFile();
    if (!file) return;
    if (file !== this.file) {
      this.file = file;
      this.main = { offset: 0, partial: '' };
      this.agents = new Map();
      this.setEntries([]);
      this.emit('file', this.currentSessionId);
    }
    const added = [];
    let metaChanged = false;
    for (const line of this.readLines(file, this.main)) {
      metaChanged = this.updateMeta(line) || metaChanged;
      for (const entry of toEntries(line)) {
        // Some commands are written twice, once as system lines and once as
        // user lines: the command, its output, then both again.
        if (entry.kind.startsWith('command')) {
          const key = `${entry.kind}:${entry.text}`;
          if (this.recentCommands.includes(key)) continue;
          this.recentCommands = [...this.recentCommands, key].slice(-2);
        } else {
          this.recentCommands = [];
        }
        entry.id = `${line.uuid || this.main.offset}:${added.length}`;
        if (entry.kind === 'user') {
          this.turnTokens = 0;
          this.setBusy(true);
        }
        if (entry.kind === 'turn-end') {
          entry.outputTokens = this.turnTokens;
          this.setBusy(false);
        }
        added.push(entry);
      }
    }
    added.push(...this.pollAgents());
    if (metaChanged) this.emit('meta', this.meta);
    if (!added.length) return;
    this.entries.push(...added);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.emit('entries', added);
  }

  // Each agent the session starts writes its own transcript in
  // <session id>/subagents/agent-<id>.jsonl, with agent-<id>.meta.json naming
  // the Agent tool call that started it. Its steps become `agent-step`
  // entries, which the Chat tab draws inside that call's card.
  pollAgents() {
    const dir = path.join(this.dir, this.currentSessionId || '', 'subagents');
    let names;
    try {
      names = fs.readdirSync(dir).filter((n) => /^agent-[\w-]+\.jsonl$/.test(n));
    } catch {
      return [];
    }
    const added = [];
    for (const name of names) {
      const agentId = name.slice(6, -6);
      let state = this.agents.get(agentId);
      if (!state) {
        state = { offset: 0, partial: '', toolUseId: null };
        this.agents.set(agentId, state);
      }
      if (!state.toolUseId) {
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(dir, `agent-${agentId}.meta.json`), 'utf8'));
          state.toolUseId = meta.toolUseId || null;
          state.agentType = meta.agentType || null;
        } catch {
          // Not written yet; steps still carry the agent id.
        }
      }
      for (const line of this.readLines(path.join(dir, name), state)) {
        for (const step of toEntries(line, { sidechain: true })) {
          // The agent's first message is its prompt, already on the Agent card.
          if (!['assistant', 'tool-use', 'tool-result', 'error'].includes(step.kind)) continue;
          // The agent's hand-back carries its report: that is the agent's result.
          if (step.kind === 'tool-use' && step.name === 'SubagentHandback') {
            const report = typeof step.input?.message === 'string' ? step.input.message : '';
            if (report) added.push({ kind: 'agent-report', at: step.at, id: `${agentId}:report:${line.uuid}`, agentId, parentToolUseId: state.toolUseId, text: clip(report) });
            continue;
          }
          added.push({
            kind: 'agent-step',
            at: step.at,
            id: `${agentId}:${line.uuid || state.offset}:${added.length}`,
            agentId,
            parentToolUseId: state.toolUseId,
            step,
          });
        }
      }
    }
    return added;
  }
}

// Reads the head and tail of a transcript for its title and last prompt.
// Transcripts can be megabytes, and both kinds of line recur, so the ends are enough.
function summarize(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size, mtimeMs } = fs.fstatSync(fd);
    const chunks = [];
    const read = (pos, len) => {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      chunks.push(buf.toString('utf8'));
    };
    const HEAD = 64 * 1024;
    const TAIL = 256 * 1024;
    read(0, Math.min(size, HEAD));
    if (size > HEAD) read(Math.max(HEAD, size - TAIL), Math.min(TAIL, size - HEAD));
    let title = null;
    let lastPrompt = null;
    let firstPrompt = null;
    let prompts = 0;
    let cwd = null;
    for (const chunk of chunks) {
      for (const text of chunk.split('\n')) {
        if (!text.startsWith('{')) continue;
        let line;
        try {
          line = JSON.parse(text);
        } catch {
          continue;
        }
        if (!cwd && typeof line.cwd === 'string' && !line.isSidechain) cwd = line.cwd;
        if (line.type === 'ai-title' && line.aiTitle) title = line.aiTitle;
        if (line.type === 'last-prompt' && typeof line.lastPrompt === 'string') lastPrompt = line.lastPrompt;
        if (line.type === 'user' && !line.isMeta && !line.isSidechain && typeof line.message?.content === 'string' && !line.message.content.startsWith('<')) {
          prompts += 1;
          firstPrompt ||= line.message.content;
          lastPrompt = lastPrompt || line.message.content;
        }
      }
    }
    return { title, lastPrompt: (lastPrompt || firstPrompt || '').slice(0, 200), mtime: mtimeMs, size, cwd, hasPrompts: prompts > 0 || Boolean(title) };
  } finally {
    fs.closeSync(fd);
  }
}

// Past sessions for a folder, newest first. Sessions with no prompt at all
// (started and closed) are left out.
function listSessions(cwd) {
  const dir = projectDir(cwd);
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => /^[0-9a-f-]{36}\.jsonl$/.test(n));
  } catch {
    return [];
  }
  const sessions = [];
  for (const name of names) {
    try {
      const summary = summarize(path.join(dir, name));
      if (summary.hasPrompts) sessions.push({ id: name.slice(0, 36), ...summary });
    } catch {
      // Unreadable or vanished; skip it.
    }
  }
  return sessions.sort((a, b) => b.mtime - a.mtime);
}

// Every session in every folder, newest first. Project folder names are a
// lossy encoding of the path, so each session's folder comes from the `cwd`
// its own lines record. Only folders inside `root` are listed.
function listAllSessions(root, limit = 300) {
  const projects = path.dirname(projectDir(root));
  const rootReal = fs.realpathSync(root);
  const found = [];
  let dirs;
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return [];
  }
  for (const dir of dirs) {
    let names;
    try {
      names = fs.readdirSync(path.join(projects, dir)).filter((n) => /^[0-9a-f-]{36}\.jsonl$/.test(n));
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const summary = summarize(path.join(projects, dir, name));
        if (!summary.hasPrompts || !summary.cwd) continue;
        if (summary.cwd !== rootReal && !summary.cwd.startsWith(rootReal + path.sep)) continue;
        const folder = path.relative(rootReal, summary.cwd).split(path.sep).join('/');
        const { cwd, hasPrompts, ...rest } = summary;
        found.push({ id: name.slice(0, 36), folder, ...rest });
      } catch {
        // Unreadable or vanished; skip it.
      }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

function countSessions(cwd) {
  try {
    return fs.readdirSync(projectDir(cwd)).filter((n) => n.endsWith('.jsonl')).length;
  } catch {
    return 0;
  }
}

module.exports = { TranscriptFollower, toEntries, listSessions, listAllSessions, countSessions, projectDir };
