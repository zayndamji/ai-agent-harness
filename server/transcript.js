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
  return Object.keys(detail).length ? detail : undefined;
}

// One transcript line becomes zero or more entries. Bookkeeping lines
// (attachments, API requests, cost state, snapshots) become none.
function toEntries(line) {
  if (line.isSidechain) return [];
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
  if (line.type === 'queue-operation' && line.operation === 'enqueue' && typeof line.content === 'string') {
    return [{ ...base, kind: 'queued', text: line.content }];
  }
  const content = line.message?.content;
  if (line.type === 'user') {
    if (line.isCompactSummary) return [{ ...base, kind: 'compact-summary', text: clip(resultText(content)) }];
    if (line.isMeta) return [];
    if (typeof content === 'string') {
      if (content.startsWith('<local-command-caveat>')) return [];
      if (INTERRUPTED.test(content.trim())) return [{ ...base, kind: 'interrupt' }];
      const entry = commandEntry(content);
      return [{ ...base, ...(entry || { kind: 'user', text: content }) }];
    }
    if (!Array.isArray(content)) return [];
    return content.flatMap((b) => {
      if (b.type === 'text') {
        if (b.text.startsWith('<system-reminder>')) return [];
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
      if (b.type === 'tool_use') return [{ ...base, kind: 'tool-use', toolUseId: b.id, name: b.name, input: b.input }];
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

  // Follows the newest transcript written since `sinceMs`. After /clear or
  // /resume, Claude Code writes to another file, and the follower switches to it.
  start(sinceMs) {
    this.stop();
    this.since = sinceMs;
    this.file = null;
    this.setEntries([]);
    this.timer = setInterval(() => this.poll(), POLL_MS);
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

  newestFile() {
    let best = null;
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return null;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(this.dir, name);
      try {
        const { mtimeMs } = fs.statSync(file);
        if (mtimeMs >= this.since && (!best || mtimeMs > best.mtimeMs)) best = { file, mtimeMs };
      } catch {
        // The file went away between readdir and stat.
      }
    }
    return best?.file || null;
  }

  poll() {
    const file = this.newestFile();
    if (!file) return;
    if (file !== this.file) {
      this.file = file;
      this.offset = 0;
      this.partial = '';
      this.setEntries([]);
    }
    let chunk;
    try {
      const fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      chunk = Buffer.alloc(Math.max(0, size - this.offset));
      fs.readSync(fd, chunk, 0, chunk.length, this.offset);
      fs.closeSync(fd);
    } catch {
      return;
    }
    if (!chunk.length) return;
    this.offset += chunk.length;
    const lines = (this.partial + chunk.toString('utf8')).split('\n');
    this.partial = lines.pop();
    const added = [];
    let metaChanged = false;
    for (const text of lines) {
      if (!text.trim()) continue;
      let line;
      try {
        line = JSON.parse(text);
      } catch {
        continue;
      }
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
        entry.id = `${line.uuid || this.offset}:${added.length}`;
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
    if (metaChanged) this.emit('meta', this.meta);
    if (!added.length) return;
    this.entries.push(...added);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.emit('entries', added);
  }
}

module.exports = { TranscriptFollower, toEntries };
