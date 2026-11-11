'use strict';
// One slot per Claude Code session: its `claude` process and screen mirror
// (session.js), the transcript the Chat tab follows (transcript.js), the
// typist for the message box (typist.js) and the live status read from the
// screen (screen.js). A slot keeps its id, made up by the harness, when
// /clear or /resume inside the session changes Claude's own session id.

const crypto = require('node:crypto');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { Session } = require('./session');
const { TranscriptFollower, listSessions, processSessionId } = require('./transcript');
const { readStatus, readInputBox } = require('./screen');
const { Typist, graphemes, human, typeGap, lookGap } = require('./typist');

const ARROW = [200, 70]; // ms between arrow key presses in a dialog: average, spread
const SETTLE = 200; // ms for Claude Code to redraw before the screen is read again
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class StartError extends Error {}

// Slash commands that make Claude Code write to another transcript: /clear
// (also /reset, /new) starts a new one, /resume (also /continue) opens an
// earlier one. A command typed in part ("/cle") counts too, because Enter runs
// the highlighted autocomplete choice.
const SWITCH_COMMANDS = ['clear', 'reset', 'new', 'resume', 'continue'];
function isSwitchCommand(text) {
  const word = /^\/([a-z-]+)(?:\s|$)/.exec((text || '').trim())?.[1];
  return Boolean(word) && SWITCH_COMMANDS.some((name) => name === word || (word.length >= 3 && name.startsWith(word)));
}
// How long after such a command its session may take over a transcript: the
// /resume picker can stay open a while.
const SWITCH_WINDOW_MS = 10 * 60 * 1000;
// How long a new session may take to record its id.
const LEARN_ID_MS = 20_000;

// start {folder?, resume?}: folder is relative to the workspace; resume is
// 'latest', a session id from that folder, or absent for a new session.
// Returns the folder and the session id to run, or throws StartError with a
// message for the browser. A new session runs plain `claude`, which picks
// its own id (sessionId null here); the slot learns it afterwards.
function resolveStart(files, { folder: wanted, resume }) {
  let folder;
  try {
    folder = files.folder(wanted || '');
  } catch (err) {
    throw new StartError(err.code === 'ENOENT' ? 'That folder does not exist.' : `Can't start there: ${err.message}`);
  }
  let sessionId = resume;
  if (sessionId === 'latest') sessionId = listSessions(folder.real)[0]?.id;
  if (sessionId && !UUID.test(sessionId)) throw new StartError('That session id is not valid.');
  if (sessionId && !listSessions(folder.real).some((s) => s.id === sessionId)) throw new StartError('That session is not in this folder.');
  return { folder, sessionId: sessionId || null, resuming: Boolean(sessionId) };
}

// Messages to the browsers attached to a slot are emitted as 'message'; the
// server adds the slot's id and sends them. 'changed' means the summary in
// the slot list may have changed.
class Slot extends EventEmitter {
  // `mayFollow(id, mtimeMs, slot)` says whether this slot's transcript
  // follower may switch to the transcript with that session id (server.js
  // decides). `peerNames` maps a `claude` process id to the name other
  // sessions message it by, shared by all slots.
  constructor({ command, args, env, workdir, mayFollow, peerNames }) {
    super();
    this.sid = crypto.randomBytes(6).toString('hex');
    this.args = args;
    this.peerNames = peerNames;
    this.folder = '';
    this.session = new Session({ command, args, cwd: workdir, env });
    this.transcript = new TranscriptFollower(workdir, { mayFollow: (id, mtimeMs) => mayFollow(id, mtimeMs, this) });
    this.typist = new Typist(this.session);
    this.tuiStatus = null;
    this.tuiTimer = null;
    this.answering = false;
    this.stopRequested = false;
    // Why the harness ended the session, sent with its exit ('folder-gone').
    this.endReason = null;
    // The folder's real path and identity (device and inode) at start.
    this.folderReal = null;
    this.folderId = null;
    // When this session last got keys or a message, and when it last got a
    // command that switches transcripts (null once the switch happened).
    this.lastInputAt = 0;
    this.switchAt = null;

    this.session.on('start', () => {
      this.startedPid = this.pid;
      this.typist.reset();
      this.send({ type: 'reset' });
      this.send(this.state());
      this.emit('changed');
    });
    this.session.on('output', (data) => {
      this.send({ type: 'output', data });
      this.scheduleStatus();
    });
    this.session.on('exit', ({ exitCode, signal }) => {
      console.log(`claude exited in slot ${this.sid} (code ${exitCode}, signal ${signal})`);
      // Another process may get the same pid later.
      this.peerNames.delete(this.startedPid);
      this.transcript.stop();
      this.typist.reset();
      this.tuiStatus = null;
      this.send({ type: 'tui', status: null });
      this.send({ type: 'exit', exitCode, signal, stopped: this.stopRequested, reason: this.endReason, folder: this.folder });
      this.stopRequested = false;
      this.endReason = null;
      this.send(this.state());
      this.emit('changed');
      this.emit('exit');
    });
    const t = this.transcript;
    t.on('reset', () => this.send({ type: 'chat-reset' }));
    t.on('entries', (entries) => this.send({ type: 'chat', entries }));
    t.on('busy', (busy) => {
      this.send({ type: 'chat-busy', busy });
      this.emit('changed');
    });
    t.on('meta', (meta) => {
      // ListAgents told this session its own name.
      if (meta.peerName && this.pid) this.peerNames.set(this.pid, meta.peerName);
      this.send({ type: 'meta', meta });
      this.emit('changed');
    });
    // A message from another session tells that session's name.
    t.on('peer', ({ pid, name }) => {
      if (this.peerNames.get(pid) === name) return;
      this.peerNames.set(pid, name);
      this.emit('peer-name');
    });
    // After /clear or /resume inside the session, the session id changes.
    t.on('file', () => {
      this.switchAt = null;
      this.send(this.state());
      this.emit('changed');
    });
  }

  send(message) {
    this.emit('message', message);
  }

  get running() {
    return this.session.running;
  }

  // The `claude` process id: other sessions reach this one at
  // /tmp/cc-socks/<pid>.sock, so messages from it carry this pid.
  get pid() {
    return this.session.proc?.pid ?? null;
  }

  get sessionId() {
    return this.running ? this.transcript.currentSessionId : null;
  }

  // Whether this slot is running the conversation with that session id: the
  // one it started with, or the one it follows now.
  claims(id) {
    return this.running && (this.transcript.sessionId === id || this.transcript.currentSessionId === id);
  }

  state() {
    return {
      type: 'state',
      running: this.running,
      startedAt: this.session.startedAt,
      folder: this.folder,
      sessionId: this.sessionId,
    };
  }

  // The slot's line in the list every browser gets.
  summary() {
    const status = this.tuiStatus;
    const working = this.running && (status ? Boolean(status.spinner || status.working) : this.transcript.busy);
    return {
      sid: this.sid,
      running: this.running,
      startedAt: this.session.startedAt,
      folder: this.folder,
      sessionId: this.sessionId,
      title: this.transcript.meta.title || null,
      pid: this.running ? this.pid : null,
      peerName: (this.running && (this.transcript.meta.peerName || this.peerNames.get(this.pid))) || null,
      state: !this.running ? 'exited' : status?.dialog ? 'waiting' : working ? 'working' : 'ready',
    };
  }

  // Everything a browser needs when it attaches, in order: the state, the
  // screen, the chat so far, the session details and the live status. The
  // empty write inside snapshot() waits until the mirror has parsed all
  // output so far, so this plus any output emitted afterwards is complete.
  snapshot(callback) {
    this.session.snapshot((screen) => {
      const messages = [this.state(), { type: 'reset' }];
      if (screen) messages.push({ type: 'output', data: screen });
      messages.push({ type: 'chat-reset' });
      if (this.transcript.entries.length) messages.push({ type: 'chat', entries: this.transcript.entries });
      messages.push(
        { type: 'chat-busy', busy: this.transcript.busy },
        { type: 'meta', meta: this.transcript.meta },
        { type: 'tui', status: this.tuiStatus },
      );
      callback(messages);
    });
  }

  // Starts `claude` for a start resolved by resolveStart(). Throws
  // StartError with a message for the browser.
  start({ folder, sessionId, resuming }, cols, rows) {
    // As a person starts it: `claude`, or `claude --resume <id>` as Claude
    // Code itself suggests when a session ends.
    const args = [...this.args, ...(resuming ? ['--resume', sessionId] : [])];
    try {
      this.folder = folder.rel;
      this.folderReal = folder.real;
      const stat = fs.statSync(folder.real);
      this.folderId = `${stat.dev}:${stat.ino}`;
      // A little slack, so a transcript created in the same second still counts.
      this.transcript.start(Date.now() - 2000, { cwd: folder.real, sessionId, waitForId: !resuming });
      this.session.start(cols, rows, { cwd: folder.real, args });
      if (!resuming) this.learnSessionId();
    } catch (err) {
      this.transcript.stop();
      console.error('could not start claude:', err.message);
      throw new StartError(`Could not start claude: ${err.message}`);
    }
    console.log(`claude started in slot ${this.sid}, /${folder.rel || ''} (${resuming ? `resuming ${sessionId}` : 'new'}, ${cols}x${rows})`);
  }

  // A new session's id, from the record Claude Code keeps for its process.
  // Without one after a while, the Chat tab follows the newest transcript in
  // the folder instead.
  learnSessionId() {
    const pid = this.pid;
    const until = Date.now() + LEARN_ID_MS;
    const look = () => {
      if (!this.running || this.pid !== pid) return;
      const id = processSessionId(pid);
      if (id && UUID.test(id)) {
        this.transcript.setSessionId(id);
        console.log(`slot ${this.sid} is session ${id}`);
      } else if (Date.now() < until) {
        return setTimeout(look, 250);
      } else {
        this.transcript.setSessionId(null);
        console.log(`slot ${this.sid}: no session id from claude, following the newest transcript`);
      }
      this.send(this.state());
      this.emit('changed');
    };
    look();
  }

  stop() {
    this.stopRequested = true;
    this.session.stop();
  }

  // Ends the slot for good: a slot that is removed is never started again.
  dispose() {
    clearTimeout(this.tuiTimer);
    this.tuiTimer = null;
    this.transcript.stop();
    this.session.stop();
    this.removeAllListeners('message');
  }

  // Whether the session's folder has been moved out of the workspace, renamed,
  // removed, or swapped for another folder with the same name. Moving it out
  // and back in while the session runs keeps its inode, so that still counts
  // as the same folder.
  folderGone() {
    try {
      const stat = fs.statSync(this.folderReal);
      return !stat.isDirectory() || `${stat.dev}:${stat.ino}` !== this.folderId;
    } catch {
      return true;
    }
  }

  // Checked whenever the session gets keys, a message, an answer or a
  // browser: a session whose folder is gone is stopped, and the input that
  // came with the check is dropped. Returns whether it was stopped.
  checkFolder() {
    if (!this.running || !this.folderReal || !this.folderGone()) return false;
    if (this.endReason) return true;
    console.log(`folder /${this.folder} of slot ${this.sid} is gone, stopping its session`);
    this.endReason = 'folder-gone';
    this.session.stop();
    return true;
  }

  // Whether a switch command was sent recently and its switch hasn't happened.
  get switching() {
    return this.switchAt !== null && Date.now() - this.switchAt < SWITCH_WINDOW_MS;
  }

  noteInput(text) {
    this.lastInputAt = Date.now();
    if (text !== undefined && isSwitchCommand(text)) this.switchAt = this.lastInputAt;
  }

  // Keys from the Terminal tab. Enter runs what Claude Code's input box
  // holds, so the box is read first, the way a person glances at it.
  input(data) {
    if (this.checkFolder()) return;
    const box = data.includes('\r') && this.session.mirror ? readInputBox(this.session.mirror) : null;
    this.noteInput(box?.text);
    this.session.write(data);
    this.typist.noteRawInput();
  }

  compose(text, caret, paste) {
    if (this.checkFolder()) return;
    this.noteInput();
    this.typist.compose(text, caret, paste);
  }

  submit(text, fail) {
    if (this.checkFolder()) return fail(`/${this.folder} was moved or removed, so the session ended.`);
    this.noteInput(text);
    this.typist.submit(text, fail);
  }

  resize(cols, rows) {
    this.session.resize(cols, rows);
  }

  // The live status read from the terminal screen, sent only when it
  // changes. Reading waits a little after output so bursts are read once.
  scheduleStatus() {
    if (this.tuiTimer) return;
    this.tuiTimer = setTimeout(() => {
      this.tuiTimer = null;
      this.session.withScreen((mirror) => {
        const next = this.running ? readStatus(mirror) : null;
        if (JSON.stringify(next) === JSON.stringify(this.tuiStatus)) return;
        const before = this.summary().state;
        this.tuiStatus = next;
        this.send({ type: 'tui', status: next });
        if (this.summary().state !== before) this.emit('changed');
      });
    }, 250);
  }

  // answer {question, option, text?}: picks a choice in the dialog on screen,
  // the way a person would: arrow keys from the highlighted choice to the
  // chosen one, a look at the screen, then Enter. For "Type something." the
  // text is typed key by key before Enter. Nothing is sent unless the screen
  // still shows the same question with that choice, and Enter waits until
  // the highlight is on it. `fail` gets a message for the browser when
  // nothing more was sent.
  answer(msg, fail) {
    if (!this.running) return fail('No session is running.');
    if (this.checkFolder()) return fail(`/${this.folder} was moved or removed, so the session ended.`);
    if (this.answering) return fail('Still sending the last answer.');
    this.answering = true;
    this.noteInput();
    this.sendAnswer(msg)
      .then((problem) => problem && fail(problem))
      .catch((err) => console.error('answer:', err.message))
      .finally(() => {
        this.answering = false;
        this.typist.noteRawInput();
      });
  }

  screenNow() {
    return new Promise((resolve) => {
      if (!this.running) return resolve(null);
      this.session.withScreen(resolve);
    });
  }

  // Writes keys one at a time, `gap()` ms apart. False if the session ended.
  async pressKeys(keys, gap) {
    for (const key of keys) {
      await sleep(gap());
      if (!this.running) return false;
      this.session.write(key);
    }
    return this.running;
  }

  async sendAnswer(msg) {
    const mirror = await this.screenNow();
    if (!mirror) return 'No session is running.';
    const dialog = readStatus(mirror).dialog;
    if (!dialog || !dialog.answerable) return 'That question is no longer on screen. Answer it in the Terminal tab.';
    if (dialog.question !== msg.question) return 'The question on screen changed. Check the Terminal tab.';
    const option = dialog.options.find((o) => o.n === msg.option);
    if (!option) return 'That choice is no longer on screen.';
    const free = option.n === dialog.freeText;
    // Only printable text is typed: new lines and control keys would answer
    // or cancel the dialog.
    const text = typeof msg.text === 'string' ? msg.text.replace(/[\x00-\x1f\x7f]+/g, ' ').trim() : '';
    if (free && !text) return 'Type an answer first.';

    // Arrow keys depend on the terminal's cursor key mode.
    const app = mirror.modes.applicationCursorKeysMode;
    const delta = option.n - dialog.selected;
    const arrow = delta > 0 ? (app ? '\x1bOB' : '\x1b[B') : app ? '\x1bOA' : '\x1b[A';
    if (!(await this.pressKeys(Array(Math.abs(delta)).fill(arrow), () => human(ARROW)))) return null;

    // Look before pressing on: the same question, with the highlight on the
    // chosen line. "Type something." may turn into a text box and lose its
    // highlight, so there only a different highlight stops it.
    await sleep(SETTLE);
    const moved = await this.screenNow();
    const now = moved && readStatus(moved).dialog;
    const stray = 'The highlighted choice on screen isn\'t the one you picked. Check the Terminal tab.';
    if (!now || now.question !== msg.question) return 'The question on screen changed. Check the Terminal tab.';
    if (now.selected !== option.n && !(free && now.selected === null)) return stray;

    if (free && !(await this.pressKeys(graphemes(text), typeGap))) return null;
    // A glance at the choice (or the typed answer) before Enter.
    await sleep(lookGap());
    if (!this.running) return null;
    this.session.write('\r');
    console.log(`answered "${dialog.question.slice(0, 60)}" with ${option.n}. ${option.label.slice(0, 40)}`);
    return null;
  }
}

module.exports = { Slot, StartError, resolveStart };
