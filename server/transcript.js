'use strict';
// Follows the transcript Claude Code writes for the running session
// (~/.claude/projects/<cwd>/<session id>.jsonl) and turns its lines into
// simple chat entries for the browser's Chat tab.

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const POLL_MS = 400;
const MAX_ENTRIES = 3000;
const MAX_TEXT = 20_000;
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

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

// One transcript line becomes zero or more entries. Bookkeeping lines
// (attachments, API requests, cost state, snapshots) become none.
function toEntries(line) {
  if (line.isSidechain || (line.isMeta && line.type === 'user')) return [];
  const base = { at: line.timestamp };
  if (line.type === 'system') {
    if (line.subtype === 'turn_duration') return [{ ...base, kind: 'turn-end', durationMs: line.durationMs }];
    if (line.subtype === 'local_command' && typeof line.content === 'string') {
      const entry = commandEntry(line.content);
      return entry ? [{ ...base, ...entry }] : [];
    }
    return [];
  }
  const content = line.message?.content;
  if (line.type === 'user') {
    if (typeof content === 'string') {
      if (content.startsWith('<local-command-caveat>')) return [];
      const entry = commandEntry(content);
      return [{ ...base, ...(entry || { kind: 'user', text: content }) }];
    }
    if (!Array.isArray(content)) return [];
    return content.flatMap((b) => {
      if (b.type === 'text' && !b.text.startsWith('<system-reminder>')) return [{ ...base, kind: 'user', text: b.text }];
      if (b.type === 'image') return [{ ...base, kind: 'user', text: '[image]' }];
      if (b.type === 'tool_result') {
        return [{ ...base, kind: 'tool-result', toolUseId: b.tool_use_id, isError: Boolean(b.is_error), text: clip(resultText(b.content)) }];
      }
      return [];
    });
  }
  if (line.type === 'assistant' && Array.isArray(content)) {
    return content.flatMap((b) => {
      if (b.type === 'text' && b.text.trim()) return [{ ...base, kind: 'assistant', text: b.text }];
      if (b.type === 'thinking' && b.thinking?.trim()) return [{ ...base, kind: 'thinking', text: clip(b.thinking) }];
      if (b.type === 'tool_use') return [{ ...base, kind: 'tool-use', toolUseId: b.id, name: b.name, input: b.input }];
      return [];
    });
  }
  return [];
}

class TranscriptFollower extends EventEmitter {
  constructor(cwd) {
    super();
    this.dir = projectDir(cwd);
    this.entries = [];
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
    this.emit('reset');
  }

  setBusy(busy) {
    if (busy === this.busy) return;
    this.busy = busy;
    this.emit('busy', busy);
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
    for (const text of lines) {
      if (!text.trim()) continue;
      let line;
      try {
        line = JSON.parse(text);
      } catch {
        continue;
      }
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
        added.push(entry);
        if (entry.kind === 'user') this.setBusy(true);
        if (entry.kind === 'turn-end') this.setBusy(false);
      }
    }
    if (!added.length) return;
    this.entries.push(...added);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.emit('entries', added);
  }
}

module.exports = { TranscriptFollower, toEntries };
