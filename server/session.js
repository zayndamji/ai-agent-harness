'use strict';
// One `claude` process in a pseudo-terminal, plus a headless terminal that
// mirrors its screen so a browser that connects later sees the current state.

const { EventEmitter } = require('node:events');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

const SCROLLBACK = 5000;

class Session extends EventEmitter {
  constructor({ command, args, cwd, env }) {
    super();
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.proc = null;
    this.mirror = null;
    this.serializer = null;
    this.startedAt = null;
  }

  get running() {
    return this.proc !== null;
  }

  start(cols, rows) {
    if (this.proc) return;
    this.mirror?.dispose();
    this.mirror = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.mirror.loadAddon(this.serializer);

    this.proc = pty.spawn(this.command, this.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: this.cwd,
      env: this.env,
    });
    this.startedAt = Date.now();
    this.proc.onData((data) => {
      this.mirror.write(data);
      this.emit('output', data);
    });
    this.proc.onExit(({ exitCode, signal }) => {
      this.proc = null;
      this.emit('exit', { exitCode, signal });
    });
    this.emit('start');
  }

  write(data) {
    this.proc?.write(data);
  }

  resize(cols, rows) {
    if (!this.proc) return;
    this.proc.resize(cols, rows);
    this.mirror.resize(cols, rows);
  }

  stop() {
    this.proc?.kill();
  }

  // Calls back with the screen and scrollback as terminal escape codes. The
  // empty write waits until the mirror has parsed all output received so far,
  // so the snapshot plus any output emitted after this call is complete.
  snapshot(callback) {
    if (!this.mirror) return callback('');
    this.mirror.write('', () => callback(this.serializer.serialize()));
  }
}

module.exports = { Session };
