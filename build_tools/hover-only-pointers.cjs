// Moves every :hover selector into @media (hover: hover), so touch screens do
// not keep a tapped or scrolled-over button in its hover look. Selector lists
// are split: the :hover parts move, the rest (focus, pressed…) stay put.
// Idempotent: rules already inside an (hover: hover) block are left alone.
//   node build_tools/hover-only-pointers.cjs <file.css> [...]
//   node build_tools/hover-only-pointers.cjs --check <file.css> [...]   (test gate)
'use strict';
const fs = require('fs');

function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === separator && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

// Returns [{ prelude, body, start, end }] for the blocks directly inside text.
function blocks(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    // The prelude starts after the previous ';' or '}' (or comment end).
    let preludeStart = i;
    const prelude = text.slice(preludeStart, open);
    let depth = 1, j = open + 1;
    while (j < text.length && depth) {
      if (text.startsWith('/*', j)) { j = text.indexOf('*/', j + 2) + 2; continue; }
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
      j++;
    }
    out.push({ prelude, body: text.slice(open + 1, j - 1), start: preludeStart, end: j });
    i = j;
  }
  return out;
}

function transform(text, insideHoverMedia = false) {
  let result = '';
  let cursor = 0;
  for (const block of blocks(text)) {
    // Keep comments/whitespace that precede the selector as they are.
    const raw = block.prelude;
    const commentEnd = raw.lastIndexOf('*/');
    const lead = commentEnd >= 0 ? raw.slice(0, commentEnd + 2) : '';
    const preludeText = commentEnd >= 0 ? raw.slice(commentEnd + 2) : raw;
    const indent = (preludeText.match(/^\s*/) || [''])[0];
    const selector = preludeText.trim();
    result += text.slice(cursor, block.start) + lead;
    cursor = block.end;
    if (selector.startsWith('@')) {
      const hoverMedia = /@media[^{]*\(\s*hover\s*:\s*hover\s*\)/.test(selector);
      result += `${indent}${selector} {${transform(block.body, insideHoverMedia || hoverMedia)}}`;
      continue;
    }
    if (insideHoverMedia || !selector.includes(':hover')) {
      result += `${indent}${selector} {${block.body}}`;
      continue;
    }
    const parts = splitTopLevel(selector, ',').map(part => part.trim()).filter(Boolean);
    const hover = parts.filter(part => part.includes(':hover'));
    const other = parts.filter(part => !part.includes(':hover'));
    if (other.length) result += `${indent}${other.join(', ')} {${block.body}}`;
    result += `${indent}@media (hover: hover) { ${hover.join(', ')} {${block.body}} }`;
  }
  return result + text.slice(cursor);
}

const check = process.argv.includes('--check');
for (const file of process.argv.slice(2).filter(arg => arg !== '--check')) {
  const before = fs.readFileSync(file, 'utf8');
  const after = transform(before);
  if (check) {
    if (after !== before) {
      console.error(`${file}: a :hover rule applies on touch screens; run node build_tools/hover-only-pointers.cjs ${file}`);
      process.exitCode = 1;
    } else {
      console.log(`${file}: hover styles apply only with a hovering pointer`);
    }
    continue;
  }
  const moved = (before.match(/:hover/g) || []).length;
  fs.writeFileSync(file, after);
  const left = blocks(after).length;
  console.log(`${file}: ${moved} :hover selectors now only apply with a hovering pointer (${left} top-level blocks)`);
}
