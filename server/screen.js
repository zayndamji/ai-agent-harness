'use strict';
// Reads Claude Code's live status from the server's copy of the terminal
// screen: the spinner line, its tip, the footer, a prompt suggestion, and
// whether a dialog is waiting for an answer. Claude Code doesn't publish any
// of this, so it is matched from the screen text; a CLI update can change it.

// "✻ Scampering… (3s · ↓ 120 tokens · thinking with high effort)"
const SPINNER = /^\s*\S\s+([A-Z][\w'-]*(?: [\w'-]+)*…)\s*(?:\((.*)\))?\s*$/;
// "⎿ Tip: Did you know you can drag and drop image files into your terminal?"
const BRANCH = /^\s*[⎿└]\s+(.*\S)\s*$/;
const RULE = /^\s*─{8,}\s*$/;
const INPUT = /^\s*❯\s?(.*?)\s*$/;
const EFFORT = /\b(low|medium|high|xhigh|max)\s*·\s*\/effort/;
const DIALOG = /Enter to (?:select|confirm|submit)|Esc to (?:cancel|go back|exit)|Do you want to /;

function rows(term) {
  const buffer = term.buffer.active;
  const out = [];
  for (let y = buffer.baseY; y < buffer.baseY + term.rows; y++) {
    const line = buffer.getLine(y);
    if (line) out.push({ line, text: line.translateToString(true) });
  }
  return out;
}

// Placeholder and suggestion text in the input box is drawn dim or grey.
function isFaint(line, fromCol) {
  for (let x = fromCol; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell || !cell.getChars().trim()) continue;
    if (cell.isDim()) return true;
    if (cell.isFgPalette() && [8, 240, 241, 242, 243, 244, 245, 246, 247].includes(cell.getFgColor())) return true;
    if (cell.isFgRGB()) {
      const c = cell.getFgColor();
      const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
      return Math.max(r, g, b) - Math.min(r, g, b) < 16 && r > 90 && r < 170;
    }
    return false;
  }
  return false;
}

function readStatus(term) {
  const lines = rows(term);
  const status = { spinner: null, detail: null, tip: null, mode: null, effort: null, suggestion: null, dialog: null, working: false };

  lines.forEach(({ text }, i) => {
    const spin = SPINNER.exec(text);
    if (spin && !status.spinner) {
      status.spinner = spin[1];
      status.detail = spin[2] ? spin[2].replace(/\s*·\s*esc to interrupt\s*$/, '') : null;
      const next = lines[i + 1] && BRANCH.exec(lines[i + 1].text);
      if (next && /^Tip:/.test(next[1])) status.tip = next[1].replace(/^Tip:\s*/, '');
    }
    if (/shift\+tab to cycle/.test(text)) {
      status.mode = text.replace(/\(shift\+tab to cycle\).*/, '').replace(/^[\s⏵▸►»>]+/, '').trim() || null;
    }
    const effort = EFFORT.exec(text);
    if (effort) status.effort = effort[1];
    if (/esc to interrupt/.test(text)) status.working = true;
  });

  // The input box sits between two horizontal rules.
  for (let i = lines.length - 1; i > 0; i--) {
    const input = INPUT.exec(lines[i].text);
    if (!input || !RULE.test(lines[i - 1].text)) continue;
    const text = input[1];
    if (text && !/^Try "/.test(text) && isFaint(lines[i].line, lines[i].text.indexOf('❯') + 1)) status.suggestion = text;
    break;
  }

  const dialogAt = lines.findIndex(({ text }) => DIALOG.test(text));
  if (dialogAt >= 0) {
    const question = lines.slice(0, dialogAt + 1).reverse().find(({ text }) => /\?\s*$/.test(text));
    status.dialog = (question ? question.text : lines[dialogAt].text).trim().slice(0, 200);
  }
  return status;
}

module.exports = { readStatus };
