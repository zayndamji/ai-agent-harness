'use strict';
// The shared browser behind the Browser tab: a virtual X display (Xvfb),
// Google Chrome on it, and x11vnc sharing the display on localhost. One for
// all sessions: Claude Code's Claude in Chrome gives each session its own tab
// group. Each process is started again when it exits, so closing Chrome's
// last window restarts it (which also makes it read a new native messaging
// host file that `claude --chrome` writes).

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DISPLAY = ':99';
const X_SOCKET = '/tmp/.X11-unix/X99';
const WIDTH = 1280;
const HEIGHT = 800;
const VNC_PORT = 5900;
// Chrome's default profile, where `claude --chrome` writes its native host file.
const PROFILE = path.join(os.homedir(), '.config', 'google-chrome');

const PROGRAMS = {
  xvfb: ['Xvfb', [DISPLAY, '-screen', '0', `${WIDTH}x${HEIGHT}x24`, '-nolisten', 'tcp']],
  // --no-sandbox: Chrome's sandbox needs a user namespace, which the
  // container's dropped capabilities and Docker's seccomp profile refuse.
  // The container is the boundary.
  chrome: ['google-chrome', [
    '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    '--password-store=basic', '--window-position=0,0', `--window-size=${WIDTH},${HEIGHT}`, '--start-maximized',
  ]],
  vnc: ['x11vnc', [
    '-display', DISPLAY, '-localhost', '-rfbport', String(VNC_PORT), '-nopw', '-forever', '-shared', '-quiet',
  ]],
};

class Browser {
  constructor(env) {
    this.env = { ...env, DISPLAY };
    this.procs = {};
    this.missing = null;
    this.stopping = false;
    this.failures = { xvfb: 0, chrome: 0, vnc: 0 };
  }

  get available() {
    return this.missing === null;
  }

  start() {
    // Locks left by a container that stopped without cleaning up. Nothing else
    // runs Chrome or Xvfb yet, so they are stale.
    for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      fs.rmSync(path.join(PROFILE, name), { force: true });
    }
    fs.rmSync('/tmp/.X99-lock', { force: true });
    fs.rmSync(X_SOCKET, { force: true });
    this.run('xvfb');
    this.whenDisplay(() => {
      this.run('chrome');
      this.run('vnc');
    });
  }

  whenDisplay(callback, tries = 50) {
    if (fs.existsSync(X_SOCKET)) return callback();
    if (tries === 0 || !this.available) return console.error('browser: the virtual display did not start');
    setTimeout(() => this.whenDisplay(callback, tries - 1), 100);
  }

  run(name) {
    if (this.stopping || !this.available) return;
    const [command, args] = PROGRAMS[name];
    const startedAt = Date.now();
    const proc = spawn(command, args, { env: this.env, stdio: 'ignore' });
    this.procs[name] = proc;
    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        this.missing = command;
        console.error(`browser: ${command} is not installed, so the Browser tab is off`);
      }
    });
    proc.on('exit', (code, signal) => {
      if (this.procs[name] === proc) delete this.procs[name];
      if (this.stopping || !this.available || proc.noRestart) return;
      // Back off when it keeps failing, up to 30 s. A run of a minute or more
      // counts as healthy.
      this.failures[name] = Date.now() - startedAt > 60_000 ? 0 : this.failures[name] + 1;
      const delay = Math.min(30_000, 1000 * 2 ** Math.max(0, this.failures[name] - 1));
      console.log(`browser: ${command} exited (${signal || code}), starting it again in ${delay / 1000} s`);
      setTimeout(() => (name === 'xvfb' ? this.restartAll() : this.run(name)), delay);
    });
  }

  // Without the display, Chrome and x11vnc exit too; they start again after it.
  restartAll() {
    for (const proc of Object.values(this.procs)) {
      proc.noRestart = true;
      proc.kill();
    }
    this.start();
  }

  // Chrome alone, for the Browser tab's Restart button.
  restartChrome() {
    this.failures.chrome = 0;
    if (this.procs.chrome) this.procs.chrome.kill();
    else this.run('chrome');
  }

  stop() {
    this.stopping = true;
    for (const proc of Object.values(this.procs)) proc.kill();
  }
}

module.exports = { Browser, DISPLAY, VNC_PORT, WIDTH, HEIGHT };
