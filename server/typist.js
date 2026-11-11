'use strict';
// Types the Chat tab's message box into Claude Code's input box while the
// user types, key by key like a person at the terminal: characters, Backspace,
// the Left and Right arrow keys, and a line feed for a new line. Send then
// only presses Enter.
//
// Keys go in at a person's pace: a key the user types goes in when they type
// it, and several keys from one edit come a typist's gap apart. A short
// paste is pasted at the cursor, as a terminal pastes. Clearing a long box
// is Escape twice, or Backspace held down while Claude works.
//
// Anything it can't do that way waits for Send instead: a long or
// multi-line paste, a tab or other control character, a leading "!" (which
// switches Claude Code to shell mode) or "?", or an edit while a dialog
// covers the input box. Send then clears what was typed and pastes the
// whole message. The screen is read back after typing; if Claude's box
// doesn't hold what was typed (someone typed in the Terminal tab, say),
// typing stops and Send clears the box before pasting.

const { readStatus, readInputBox } = require('./screen');

// Every gap between keys is random, around a person's usual speed, and
// mostly near the middle: [average, spread] in ms, giving average ± spread.
// Typing averages 120 ms a key, about 100 words a minute.
const TYPE = [120, 60];
// A held-down Backspace or arrow key starts repeating after a moment, then
// repeats at a usual key-repeat rate.
const REPEAT_DELAY = [350, 100];
const REPEAT = [40, 10];
const ESCAPE = [180, 60]; // between the two Escapes that clear the box
const LOOK = [300, 100]; // a look at the box before pressing Enter
// Clearing more than this many characters is Escape twice, as Claude Code
// offers, rather than holding Backspace.
const CLEAR_WITH_ESCAPE = 20;
const PASTE_MAX = 200; // a longer or multi-line paste waits for Send and is pasted whole
const TYPE_MAX = 2000; // text inserted any other way waits for Send past this
const SETTLE = 200; // ms for Claude Code to redraw before the box is read
const WAIT_SAFE = 3000; // how long an edit waits for a dialog to close
const BACKSPACE = '\x7f';
// A line feed is Claude Code's "enter" key, which inserts a new line; a
// carriage return would submit. Tabs, escapes and other controls aren't typed.
const TYPEABLE = /^[^\x00-\x09\x0b-\x1f\x7f]*$/;

const segmenter = new Intl.Segmenter();
const graphemes = (text) => Array.from(segmenter.segment(text), (s) => s.segment);
const squash = (text) => text.replace(/\s+/g, '');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A random gap: the sum of two random numbers, so gaps near the average are
// the most common and the ends are rare.
const human = ([average, spread]) => average + (Math.random() + Math.random() - 1) * spread;
const typeGap = () => human(TYPE);
const lookGap = () => human(LOOK);
const repeatable = (key) => key === BACKSPACE || key.startsWith('\x1b[') || key.startsWith('\x1bO');

// Claude Code moves and deletes by grapheme, so offsets must fall between them.
function onBoundary(text, offset) {
  if (offset === 0 || offset === text.length) return true;
  let at = 0;
  for (const g of graphemes(text)) {
    at += g.length;
    if (at === offset) return true;
    if (at > offset) return false;
  }
  return false;
}

// The smallest edit from `before` to `after`, placed to end at the caret, so
// typing "a" at the start of "aa" is an insert at 0, not at 2.
function diff(before, after, caret) {
  const end = Number.isInteger(caret) ? Math.min(Math.max(caret, 0), after.length) : after.length;
  const suffixMax = Math.min(before.length, after.length - end);
  let suffix = 0;
  while (suffix < suffixMax && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const prefixMax = Math.min(before.length, after.length) - suffix;
  let prefix = 0;
  while (prefix < prefixMax && before[prefix] === after[prefix]) prefix++;
  return { start: prefix, end: before.length - suffix, insert: after.slice(prefix, after.length - suffix) };
}

// Messages that Claude Code reads differently when typed from an empty box.
const leadsWithMode = (text) => /^[!?]/.test(text);

class Typist {
  constructor(session) {
    this.session = session;
    this.gen = 0;
    this.chain = Promise.resolve();
    this.checkTimer = null;
    this.reset();
  }

  // 'idle': nothing typed yet. 'live': Claude's box holds `text` with the
  // cursor at `cursor`. 'deferred': it holds `text`, the rest waits for Send.
  // 'lost': what it holds is unknown.
  reset() {
    this.gen += 1;
    this.state = 'idle';
    this.text = '';
    this.cursor = 0;
    this.lastWrite = 0;
    this.mismatches = 0;
    clearTimeout(this.checkTimer);
    this.checkTimer = null;
  }

  // Runs one step at a time, in order. A reset (session start or exit) drops
  // the steps still waiting.
  enqueue(step) {
    const gen = this.gen;
    this.chain = this.chain
      .then(() => (gen === this.gen && this.session.running ? step(gen) : undefined))
      .catch((err) => console.error('typist:', err.message));
    return this.chain;
  }

  // The message box changed: text is its whole value, caret where the
  // insertion or deletion ended, paste whether it came from a paste or drop.
  compose(text, caret, paste) {
    if (typeof text !== 'string') return;
    this.enqueue((gen) => this.apply(gen, text.replace(/\r\n?/g, '\n'), caret, Boolean(paste)));
  }

  // Send: finish typing, then press Enter; or paste when typing couldn't keep
  // up. Calls back with an error message when nothing was sent.
  submit(text, done) {
    if (typeof text !== 'string' || !text.trim()) return;
    this.enqueue(async (gen) => {
      try {
        await this.send(gen, text.replace(/\r\n?/g, '\n'));
      } catch (err) {
        if (!(err instanceof SendError)) throw err;
        done(err.message);
      }
    });
  }

  // Keys typed in the Terminal tab (or the Interrupt button) can change
  // Claude's box, so check it again.
  noteRawInput() {
    if (this.state === 'live' || this.state === 'deferred') this.scheduleCheck(SETTLE);
  }

  // ---- Screen

  screen() {
    return new Promise((resolve) => {
      if (!this.session.running) return resolve(null);
      this.session.withScreen((mirror) => resolve({ status: readStatus(mirror), box: readInputBox(mirror), mirror }));
    });
  }

  async settledScreen() {
    const wait = this.lastWrite + SETTLE - Date.now();
    if (wait > 0) await sleep(wait);
    return this.screen();
  }

  // Keys only go to the input box when it is on screen.
  async waitForBox(gen, limit = WAIT_SAFE) {
    const until = Date.now() + limit;
    for (;;) {
      const screen = await this.screen();
      if (!screen || gen !== this.gen) return null;
      if (screen.box) return screen;
      if (Date.now() >= until) return null;
      await sleep(250);
    }
  }

  matches(box) {
    const want = squash(this.text);
    const have = squash(box.text);
    // A tall box may scroll, showing only part of the text.
    return have === want || (box.rows >= 6 && have.length > 0 && want.includes(have));
  }

  scheduleCheck(delay) {
    clearTimeout(this.checkTimer);
    this.checkTimer = setTimeout(() => {
      this.checkTimer = null;
      this.enqueue(() => this.check());
    }, delay);
  }

  async check() {
    if (this.state !== 'live' && this.state !== 'deferred') return;
    if (Date.now() - this.lastWrite < SETTLE) return this.scheduleCheck(SETTLE);
    const screen = await this.screen();
    if (!screen) return;
    // A dialog covers the box; look again once it's gone.
    if (!screen.box) return this.scheduleCheck(1000);
    if (this.matches(screen.box)) {
      this.mismatches = 0;
      return;
    }
    // Claude Code may still be redrawing, so a second look decides.
    this.mismatches += 1;
    if (this.mismatches < 2) return this.scheduleCheck(400);
    console.log(`typist: input box no longer matches what was typed (${this.state}), Send will clear it`);
    this.state = 'lost';
  }

  // ---- Keys

  arrows(mirror) {
    const app = mirror.modes.applicationCursorKeysMode;
    return { left: app ? '\x1bOD' : '\x1b[D', right: app ? '\x1bOC' : '\x1b[C' };
  }

  // Writes one key (or one paste) no sooner than `gap` ms after the last
  // write. False if the session ended or was reset meanwhile.
  async writeAfter(gen, gap, data) {
    const wait = this.lastWrite + gap - Date.now();
    if (wait > 0) await sleep(wait);
    if (gen !== this.gen || !this.session.running) return false;
    this.session.write(data);
    this.lastWrite = Date.now();
    return true;
  }

  // Presses keys one at a time. The first goes in now, when the user made
  // the edit; the rest follow at a typist's pace, and a run of one
  // Backspace or arrow key repeats like a held-down key.
  async press(gen, keys) {
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const held = i > 0 && repeatable(key) && keys[i - 1] === key;
      const gap = i === 0 ? 0 : !held ? typeGap() : human(keys[i - 2] === key ? REPEAT : REPEAT_DELAY);
      if (!(await this.writeAfter(gen, gap, key))) return false;
    }
    return true;
  }

  // Pastes text at the cursor as a terminal does: new lines become carriage
  // returns, wrapped in bracketed paste markers when Claude Code asked for them.
  pasteText(gen, mirror, text) {
    const body = text.replace(/\x1b/g, '').replace(/\n/g, '\r');
    return this.writeAfter(gen, typeGap(), mirror.modes.bracketedPasteMode ? `\x1b[200~${body}\x1b[201~` : body);
  }

  // Escape twice: Claude Code clears a box that has text in it. Never while
  // Claude works, when Escape would interrupt it.
  async clearWithEscape(gen) {
    return (await this.writeAfter(gen, typeGap(), '\x1b')) && this.writeAfter(gen, human(ESCAPE), '\x1b');
  }

  // Deletes everything typed: Escape twice for a long box when Claude is
  // idle, else Backspace from the end.
  async erase(gen, screen) {
    const working = screen.status.spinner || screen.status.working;
    const ok =
      graphemes(this.text).length > CLEAR_WITH_ESCAPE && !working
        ? await this.clearWithEscape(gen)
        : await this.press(gen, [...this.moves(screen.mirror, this.cursor, this.text.length), ...graphemes(this.text).map(() => BACKSPACE)]);
    if (!ok) return false;
    this.text = '';
    this.cursor = 0;
    return true;
  }

  // Keys that move the cursor from `from` to `to` in the typed text.
  moves(mirror, from, to) {
    const { left, right } = this.arrows(mirror);
    if (to > from) return graphemes(this.text.slice(from, to)).map(() => right);
    return graphemes(this.text.slice(to, from)).map(() => left);
  }

  async apply(gen, text, caret, paste) {
    if (this.state === 'deferred' || this.state === 'lost') return;
    if (this.state === 'idle') {
      if (!text || leadsWithMode(text)) return;
      // Start only from an empty box, so what it holds is known.
      const screen = await this.screen();
      if (!screen?.box || screen.box.text !== '') return;
      this.state = 'live';
      this.text = '';
      this.cursor = 0;
    }
    if (text === this.text) return;
    if (leadsWithMode(text)) return this.defer('leading ! or ?');

    const edit = diff(this.text, text, caret);
    if (!onBoundary(this.text, edit.start) || !onBoundary(this.text, edit.end)) return this.defer('edit splits a character');
    if (!TYPEABLE.test(edit.insert)) return this.defer('tab or control character');
    const pasted = paste && edit.insert !== '';
    if (pasted && (edit.insert.length > PASTE_MAX || edit.insert.includes('\n'))) return this.defer('long or multi-line paste');
    if (edit.insert.length > TYPE_MAX) return this.defer('long insert');

    const screen = await this.waitForBox(gen);
    if (gen !== this.gen) return;
    if (!screen) return this.defer('input box not on screen');

    // Everything deleted at once (select all, then Backspace).
    if (!edit.insert && edit.start === 0 && edit.end === this.text.length) {
      if (await this.erase(gen, screen)) this.scheduleCheck(SETTLE + 100);
      return;
    }
    const keys = [
      ...this.moves(screen.mirror, this.cursor, edit.end),
      ...graphemes(this.text.slice(edit.start, edit.end)).map(() => BACKSPACE),
      ...(pasted ? [] : graphemes(edit.insert)),
    ];
    // A run cut off by the session ending is discarded with the reset.
    if (!(await this.press(gen, keys))) return;
    if (pasted && !(await this.pasteText(gen, screen.mirror, edit.insert))) return;
    this.text = text;
    this.cursor = edit.start + edit.insert.length;
    this.scheduleCheck(SETTLE + 100);
  }

  defer(reason) {
    if (this.state !== 'live') return;
    console.log(`typist: ${reason}, the message will be pasted on Send`);
    this.state = 'deferred';
  }

  // ---- Send

  async send(gen, message) {
    if (this.state === 'live') await this.apply(gen, message, message.length, false);
    if (gen !== this.gen) return;

    if (this.state === 'live') {
      const screen = await this.settledScreen();
      if (screen?.box && this.matches(screen.box)) return this.enter(gen, message);
      this.state = 'lost';
    }

    if (this.state === 'deferred') {
      const screen = await this.waitForBox(gen);
      if (!screen) return this.refuse('Claude Code is showing a question or a menu. Answer it in the Chat or Terminal tab, then send again.');
      if (!(await this.erase(gen, screen))) return;
      const after = await this.settledScreen();
      if (after?.box?.text === '') return this.paste(gen, message);
      this.state = 'lost';
    }

    if (this.state === 'lost') return this.recover(gen, message);

    // Nothing typed (the box had other text, or the message starts with ! or
    // ?): paste it, as the message box always did, unless a dialog took the
    // box's place and would read the text as answers.
    const screen = await this.screen();
    if (screen && !screen.box && screen.status.dialog) {
      return this.refuse('Claude Code is showing a question or a menu. Answer it in the Chat or Terminal tab, then send again.');
    }
    return this.paste(gen, message);
  }

  // The box holds something unknown. Send what's needed to get the message in.
  async recover(gen, message) {
    const screen = await this.waitForBox(gen);
    if (!screen) return this.refuse('Claude Code is showing a question or a menu. Answer it in the Chat or Terminal tab, then send again.');
    const have = squash(screen.box.text);
    if (have === squash(message)) return this.enter(gen, message);
    if (have === '') return this.paste(gen, message);
    // Escape twice clears the box, but while Claude works Escape interrupts it.
    if (screen.status.spinner || screen.status.working) {
      return this.refuse("Claude Code's input box has other text in it. Clear it in the Terminal tab, then send again.");
    }
    if (!(await this.clearWithEscape(gen))) return;
    const after = await this.settledScreen();
    if (after?.box?.text === '') return this.paste(gen, message);
    return this.refuse("Couldn't clear Claude Code's input box. Clear it in the Terminal tab, then send again.");
  }

  async paste(gen, message) {
    const screen = await this.screen();
    if (!screen || gen !== this.gen) return;
    if (!(await this.pasteText(gen, screen.mirror, message))) return;
    return this.enter(gen, message);
  }

  // Enter. Claude Code ignores Enter while its autocomplete list is open
  // (after "@file" or "/command"); if the text is still in the box a moment
  // later, Enter is pressed once more, as a person would.
  async enter(gen, message) {
    if (!(await this.writeAfter(gen, lookGap(), '\r'))) return;
    this.state = 'idle';
    this.text = '';
    this.cursor = 0;
    await sleep(500);
    const first = await this.screen();
    if (!first?.box || gen !== this.gen) return;
    const left = squash(first.box.text);
    if (!left || left !== squash(message)) return;
    await sleep(400);
    const second = await this.screen();
    if (gen !== this.gen || !second?.box || squash(second.box.text) !== left) return;
    console.log('typist: Enter left the message in the box (autocomplete open), pressing Enter again');
    await this.writeAfter(gen, 0, '\r');
  }

  // Nothing was sent. What was typed stays in Claude's box and in the
  // model, so sending again picks up from there.
  refuse(message) {
    throw new SendError(message);
  }
}

class SendError extends Error {}

module.exports = { Typist, diff, graphemes, human, typeGap, lookGap };
