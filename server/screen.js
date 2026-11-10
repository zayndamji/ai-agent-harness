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

  status.dialog = readDialog(lines);
  return status;
}

// What Claude Code's input box holds: the ❯ line under a rule, the lines
// under it down to the next rule (newlines and wrapped lines, indented), or
// null when no box is on screen (a dialog or menu took its place). Faint
// placeholder or suggestion text counts as empty. A dialog's "❯ 1. Yes" line
// can look like the box, so a box line shaped like a choice doesn't count.
function readInputBox(term) {
  const lines = rows(term);
  for (let i = lines.length - 1; i > 0; i--) {
    const input = INPUT.exec(lines[i].text);
    if (!input || !RULE.test(lines[i - 1].text)) continue;
    if (OPTION.test(lines[i].text)) return null;
    const parts = [input[1]];
    for (let j = i + 1; j < lines.length; j++) {
      if (RULE.test(lines[j].text)) {
        const faint = input[1] && isFaint(lines[i].line, lines[i].text.indexOf('❯') + 1);
        return { text: faint ? '' : parts.join('\n').trim(), rows: j - i };
      }
      parts.push(lines[j].text.trim());
    }
    return null;
  }
  return null;
}

// "❯ 1. main.py", "  2. utils.py": numbered choices, the ❯ marking the
// highlighted one. A line indented under a choice is its description.
const OPTION = /^(\s*)(❯\s*)?(\d{1,2})\.\s+(.*\S)\s*$/;
const CHECKBOX = /^(\[[ xX✓✔]\]|[☐☑☒□■✓✔])\s/;
const LOOKBACK = 40;

// The question is the block of text right above the choices: one or more
// wrapped screen lines, sometimes inside a box drawn with │. Long questions
// come with context, so the last sentence ending in "?" is the question.
function readQuestion(above) {
  const parts = [];
  for (let i = above.length - 1; i >= 0 && parts.length < 20; i--) {
    const text = above[i].text.replace(/^[\s│┃|╭╰╮╯]+|[\s│┃|╭╰╮╯]+$/g, '');
    if (!text) {
      if (parts.length) break;
      continue;
    }
    if (RULE.test(above[i].text) || /^[☐☑□■✔←→]/.test(text)) break;
    parts.unshift(text);
  }
  const block = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (!block) return '';
  const end = block.lastIndexOf('?');
  if (end < 0) return block.slice(-300);
  // Back to the start of that sentence: after ". " or "? " before a capital.
  let start = 0;
  const boundary = /[.!?]\s+(?=[A-Z(])/g;
  for (let m; (m = boundary.exec(block)) && m.index < end; ) start = m.index + m[0].length;
  return block.slice(start, end + 1).slice(-300);
}

// A dialog waiting for an answer: a question (permission prompt,
// AskUserQuestion, a picker) with numbered choices, or just a footer like
// "Esc to cancel". Choices can be answered from the Chat tab when the
// highlighted one is known and it's a single choice, not a checklist.
function readDialog(lines) {
  let footer = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (DIALOG.test(lines[i].text)) {
      footer = i;
      break;
    }
  }
  if (footer < 0) return null;
  const from = Math.max(0, footer - LOOKBACK);
  const options = [];
  let selected = null;
  let firstOption = -1;
  for (let i = from; i <= footer; i++) {
    const text = lines[i].text;
    const m = OPTION.exec(text);
    if (m) {
      const n = Number(m[3]);
      // A new list starting at 1 replaces anything seen above it.
      if (n === 1) {
        options.length = 0;
        selected = null;
        firstOption = i;
      }
      if (options.length && n !== options[options.length - 1].n + 1) continue;
      options.push({ n, label: m[4], description: '', indent: m[1].length + (m[2] ? m[2].length : 0) });
      if (m[2]) selected = n;
      continue;
    }
    const last = options[options.length - 1];
    if (last && text.trim() && !RULE.test(text) && !DIALOG.test(text)) {
      const indent = text.length - text.trimStart().length;
      if (indent > last.indent && !last.description) last.description = text.trim();
    }
  }
  const question = readQuestion(firstOption >= 0 ? lines.slice(from, firstOption) : lines.slice(from, footer)) || lines[footer].text.trim();
  const multi = options.some((o) => CHECKBOX.test(o.label));
  const clean = options.map(({ n, label, description }) => ({ n, label, description }));
  return {
    question,
    options: clean,
    selected,
    // "Type something." turns into a text box when chosen.
    freeText: clean.find((o) => /^type something\.?$/i.test(o.label))?.n || null,
    answerable: clean.length > 0 && selected !== null && !multi,
  };
}

module.exports = { readStatus, readInputBox };
