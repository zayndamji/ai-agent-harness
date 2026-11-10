'use strict';
// One slot per Claude Code session: its `claude` process and screen mirror
// (session.js), the transcript the Chat tab follows (transcript.js), the
// typist for the message box (typist.js) and the live status read from the
// screen (screen.js). A slot keeps its id, made up by the harness, when
// /clear or /resume inside the session changes Claude's own session id.

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Session } = require('./session');
const { TranscriptFollower, listSessions } = require('./transcript');
const { readStatus, readInputBox } = require('./screen');
const { Typist } = require('./typist');

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

// start {folder?, resume?}: folder is relative to the workspace; resume is
// 'latest', a session id from that folder, or absent for a new session.
// Returns the folder and the session id to run, or throws StartError with a
// message for the browser. New sessions get an id from the server
// (--session-id), so the Chat tab follows exactly that transcript.
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
  return { folder, sessionId: sessionId || crypto.randomUUID(), resuming: Boolean(sessionId) };
}

// Messages to the browsers attached to a slot are emitted as 'message'; the
// server adds the slot's id and sends them. 'changed' means the summary in
// the slot list may have changed.
class Slot extends EventEmitter {
  // `mayFollow(id, mtimeMs, slot)` says whether this slot's transcript
  // follower may switch to the transcript with that session id (server.js
  // decides).
  constructor({ command, args, env, workdir, mayFollow }) {
    super();
    this.sid = crypto.randomBytes(6).toString('hex');
    this.args = args;
    this.folder = '';
    this.session = new Session({ command, args, cwd: workdir, env });
    this.transcript = new TranscriptFollower(workdir, { mayFollow: (id, mtimeMs) => mayFollow(id, mtimeMs, this) });
    this.typist = new Typist(this.session);
    this.tuiStatus = null;
    this.tuiTimer = null;
    this.answering = false;
    this.stopRequested = false;
    // When this session last got keys or a message, and when it last got a
    // command that switches transcripts (null once the switch happened).
    this.lastInputAt = 0;
    this.switchAt = null;

    this.session.on('start', () => {
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
      this.transcript.stop();
      this.typist.reset();
      this.tuiStatus = null;
      this.send({ type: 'tui', status: null });
      this.send({ type: 'exit', exitCode, signal, stopped: this.stopRequested });
      this.stopRequested = false;
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
      this.send({ type: 'meta', meta });
      this.emit('changed');
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
    const args = [...this.args, ...(resuming ? ['--resume', sessionId] : ['--session-id', sessionId])];
    try {
      this.folder = folder.rel;
      // A little slack, so a transcript created in the same second still counts.
      this.transcript.start(Date.now() - 2000, { cwd: folder.real, sessionId });
      this.session.start(cols, rows, { cwd: folder.real, args });
    } catch (err) {
      this.transcript.stop();
      console.error('could not start claude:', err.message);
      throw new StartError(`Could not start claude: ${err.message}`);
    }
    console.log(`claude started in slot ${this.sid}, /${folder.rel || ''} (${resuming ? `resuming ${sessionId}` : `new ${sessionId}`}, ${cols}x${rows})`);
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
    const box = data.includes('\r') && this.session.mirror ? readInputBox(this.session.mirror) : null;
    this.noteInput(box?.text);
    this.session.write(data);
    this.typist.noteRawInput();
  }

  compose(text, caret, paste) {
    this.noteInput();
    this.typist.compose(text, caret, paste);
  }

  submit(text, fail) {
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
  // chosen one, then Enter. For "Type something." the text is typed before
  // Enter. The screen is read again first, and nothing is sent unless it
  // still shows the same question with that choice. `fail` gets a message
  // for the browser when nothing was sent.
  answer(msg, fail) {
    if (!this.running) return fail('No session is running.');
    if (this.answering) return fail('Still sending the last answer.');
    this.session.withScreen((mirror) => {
      const dialog = readStatus(mirror).dialog;
      if (!dialog || !dialog.answerable) return fail('That question is no longer on screen. Answer it in the Terminal tab.');
      if (dialog.question !== msg.question) return fail('The question on screen changed. Check the Terminal tab.');
      const option = dialog.options.find((o) => o.n === msg.option);
      if (!option) return fail('That choice is no longer on screen.');
      const text = typeof msg.text === 'string' ? msg.text.replace(/[\r\n]+/g, ' ').trim() : '';
      if (option.n === dialog.freeText && !text) return fail('Type an answer first.');
      // Arrow keys depend on the terminal's cursor key mode.
      const app = mirror.modes.applicationCursorKeysMode;
      const down = app ? '\x1bOB' : '\x1b[B';
      const up = app ? '\x1bOA' : '\x1b[A';
      const delta = option.n - dialog.selected;
      const keys = Array(Math.abs(delta)).fill(delta > 0 ? down : up);
      if (option.n === dialog.freeText) keys.push(text);
      keys.push('\r');
      this.answering = true;
      this.noteInput();
      const sendNext = () => {
        if (!keys.length || !this.running) {
          this.answering = false;
          return;
        }
        this.session.write(keys.shift());
        setTimeout(sendNext, 60);
      };
      sendNext();
      this.typist.noteRawInput();
      console.log(`answered "${dialog.question.slice(0, 60)}" with ${option.n}. ${option.label.slice(0, 40)}`);
    });
  }
}

module.exports = { Slot, StartError, resolveStart };
