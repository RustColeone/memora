#!/usr/bin/env node
// Build docs/architecture/data.js: the code's architecture as data for the browsable page in
// docs/architecture/ (the viewer from DiscordStudyBot: app.js, diagram.js, style.css; Memora's own
// top map and guides are in site.js).
//
//   node build_tools/architecture.cjs                 write docs/architecture/data.js
//   node build_tools/architecture.cjs --check         exit 1 when it is out of date
//   node build_tools/architecture.cjs --root <dir>    read (and write into) another checkout
//                                                     (export-public.cjs does this for the public copy)
//
// Everything comes from the code: git's list of files, then each file's own header comment,
// imports, classes, functions, which call which inside the file, and calls into other files.
//   JavaScript  acorn. Memora's browser modules are scripts wrapped in (function (global) {…})(window)
//               that publish a global (global.MemoCore = …); a file "imports" the globals it uses
//               from the files that publish them. An object of functions (const OperationQueue = {…},
//               global.MemoX = { a() {…} }) is drawn like a class around its methods.
//   Python      build_tools/architecture_py.py (Python's ast).
//   Java        a brace-matching scan for classes, methods and their javadoc.
//   Pages       src/*.html and src/partials/*.html are data files naming the scripts they load.
// The output has no dates or commit ids, so it changes only when the code does.
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const acorn = require('acorn');

const args = process.argv.slice(2);
const ROOT = path.resolve(args.includes('--root') ? args[args.indexOf('--root') + 1] : path.join(__dirname, '..'));
const OUT = path.join(ROOT, 'docs', 'architecture', 'data.js');
const REPO = 'https://github.com/RustColeone/memora';
const BRANCH = 'main';
// The folders the page shows, in order.
const ROOTS = ['src', 'backend', 'desktop', 'android', 'build_tools', 'tests', 'mods-examples', 'docs', '.github'];
const SKIP = [/^src\/static\/vendor\//, /\.min\.js$/, /^docs\/architecture\//, /^docs\/mockups\//, /package-lock\.json$/, /\/__pycache__\//];
const CODE = /\.(js|cjs|mjs|py|java)$/;
const DATA = /\.(html|md|json|ya?ml|gradle)$/;
const SECTION = /^\s*(?:\/\/|#)\s*(?:──+|-{3,})\s*(.+?)\s*(?:──+|-{3,})?\s*$/;
// A short note for folders that have no README of their own.
const FOLDER_NOTES = {
  src: 'The web app every Memora runs: the Android app and the desktop apps show it from their own files, and the server serves it to a browser. Pages at the top, shared parts in partials/, scripts and styles in static/.',
  'src/partials': 'Pieces of the pages, included at build time (build_tools/build.js): the shared head, menus, dialogs and the list of core scripts.',
  'src/static/js/memo': 'The app itself, one script per part. Each publishes one global (MemoCore, MemoStateDb, OperationQueue…) that the others use; the pages load them in order (partials/scripts-core.html).',
  'src/static/js/planner': 'The Planner page: its store (on the same sync log as notes), calendar, to-dos, projects, habits and Today.',
  backend: 'The Memora server (Flask): the sync log and the database, uploads, backups, the Agent API and the server\'s own AI. memora_server.py runs it as one program.',
  'backend/api': 'The server\'s routes, one blueprint per area.',
  'backend/services': 'What the routes call: the SQLite store, the operation log, uploads, backups, AI.',
  desktop: 'The desktop app (Electron): shows the web app from app://memora and gives it what a browser cannot: the encrypted SQLite file, files, notifications, the built-in server, mods.',
  android: 'The Android app (Capacitor): the web app in a WebView plus native plugins (encrypted storage, camera and scanning, reminders, the Vault key, mods).',
  build_tools: 'Building and checking: src/ → www/, the packaged server, release checks, this page\'s data.',
  tests: 'Browser tests (Playwright, *.spec.js), the desktop app driven through Electron, and the server suites (test_*.py, run by run_all.py).',
  'mods-examples': 'Mods to copy into your mods folder (see docs/MODS.md).',
  docs: 'Guides: writing a mod, and this page.',
};

function tracked() {
  const list = execFileSync('git', ['ls-files', '-z', '--', ...ROOTS], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 }).split('\0').filter(Boolean);
  return list.filter((p) => (CODE.test(p) || DATA.test(p)) && !SKIP.some((re) => re.test(p)) && fs.existsSync(path.join(ROOT, p))).sort();
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const lineCount = (text) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

// ---- JavaScript ------------------------------------------------------------------------------------
function parseJs(text, file) {
  const comments = [];
  const options = { ecmaVersion: 'latest', locations: true, allowHashBang: true, allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true, onComment: comments };
  for (const sourceType of [file.endsWith('.mjs') ? 'module' : 'script', 'module']) {
    comments.length = 0;
    try { return { ast: acorn.parse(text, Object.assign({ sourceType }, options)), comments }; } catch (_e) { /* try as a module */ }
  }
  return null;
}
function walk(node, visit, parent) {
  if (!node || typeof node.type !== 'string') return;
  if (visit(node, parent) === false) return;
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    const value = node[key];
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit, node));
    else if (value && typeof value.type === 'string') walk(value, visit, node);
  }
}
const isFn = (n) => n && /^(FunctionExpression|ArrowFunctionExpression|FunctionDeclaration)$/.test(n.type);
const GLOBAL_HOLDERS = new Set(['global', 'window', 'self', 'globalThis']);
function globalName(member) {  // global.MemoX / window.MemoX → "MemoX"
  if (member && member.type === 'MemberExpression' && !member.computed && member.object.type === 'Identifier' &&
      GLOBAL_HOLDERS.has(member.object.name) && member.property.type === 'Identifier') return member.property.name;
  return '';
}
// The statements a script's names live in: its top level, and the body of a wrapping IIFE or of the
// one call a script is (Memora.mod('id', function (memora) {…}), window.SITE = (() => {…})()).
function scopes(program) {
  const out = [program.body];
  const into = (expr) => {
    if (!expr) return;
    if (expr.type === 'UnaryExpression') return into(expr.argument);
    if (expr.type === 'AssignmentExpression') return into(expr.right);
    if (expr.type === 'CallExpression') {
      if (isFn(expr.callee) && expr.callee.body.type === 'BlockStatement') out.push(expr.callee.body.body);
      else if (program.body.length <= 2) for (const a of expr.arguments) if (isFn(a) && a.body.type === 'BlockStatement') out.push(a.body.body);
    }
  };
  for (const s of program.body) if (s.type === 'ExpressionStatement') into(s.expression);
  return out;
}
function docBefore(comments, text, start) {  // the comments right above a node (only spaces between)
  const lines = [];
  let at = start;
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    if (c.end > at) continue;
    if (/\S/.test(text.slice(c.end, at))) break;
    if (c.type === 'Line' && SECTION.test('//' + c.value)) break;
    lines.unshift(c.type === 'Block' ? c.value.replace(/^\*+/, '').split('\n').map((l) => l.replace(/^\s*\* ?/, '')).join('\n').trim() : c.value.replace(/^ /, ''));
    at = c.start;
  }
  return lines.join('\n').trim();
}
function headerDoc(comments, text) {  // a file's opening comment
  const first = comments[0];
  if (!first || /\S/.test(text.slice(0, first.start).replace(/^#!.*\n/, ''))) return '';
  return docBefore(comments, text, (() => { let at = first.end; for (const c of comments) { if (/\S/.test(text.slice(at, c.start))) break; at = c.end; } return at; })()).replace(/^\s*'use strict';?\s*/, '');
}
function sectionAt(comments, before) {  // the last "// ── name ──" comment before a position
  let found = '';
  for (const c of comments) { if (c.start > before) break; if (c.type === 'Line') { const m = SECTION.exec('//' + c.value); if (m) found = m[1].replace(/[─-]+$/, '').trim(); } }
  return found;
}
function jsSignature(text, node, name) {
  const fn = node.value && isFn(node.value) ? node.value : isFn(node.init) ? node.init : node;
  const params = (fn.params || []).map((p) => text.slice(p.start, p.end)).join(', ');
  const async = fn.async ? 'async ' : '';
  if (node.type === 'Property' && fn.type === 'ArrowFunctionExpression') return `${name}: ${async}(${params}) =>`;
  if (node.type === 'MethodDefinition' || node.type === 'Property') return `${async}${name}(${params})`;
  return fn.type === 'ArrowFunctionExpression' ? `${name} = ${async}(${params}) =>` : `${async}function ${name}(${params})`;
}

function readJsFiles(paths) {
  const parsed = {};
  for (const p of paths) {
    const text = read(p);
    parsed[p] = { text, result: parseJs(text, p) };
  }
  // Who publishes which global (test mocks don't count).
  const publisher = {};
  for (const [p, { result }] of Object.entries(parsed)) {
    if (!result || p.startsWith('tests/')) continue;
    walk(result.ast, (n) => {
      if (n.type === 'AssignmentExpression') { const g = globalName(n.left); if (g && !publisher[g]) publisher[g] = p; }
    });
  }
  const files = {};
  for (const [p, { text, result }] of Object.entries(parsed)) {
    if (!result) { files[p] = { doc: '', lines: lineCount(text), imports: [], symbols: [], text }; continue; }
    const { ast, comments } = result;
    const symbols = [];
    const top = new Map();        // name → symbol (functions and object-classes)
    const bodies = new Map();     // symbol id → function node
    const addFn = (name, node, fnNode, parent = '', section = '') => {
      const id = parent ? `${parent}.${name}` : name;
      if (symbols.some((s) => s.id === id)) return;
      const s = { id, name, kind: parent ? 'method' : 'function', parent, line: node.loc.start.line, end: node.loc.end.line,
        signature: jsSignature(text, node, name), doc: docBefore(comments, text, node.start), decorators: [] };
      if (parent) s.section = section;
      symbols.push(s);
      bodies.set(id, fnNode);
      if (!parent) top.set(name, s);
    };
    const addClass = (name, node, members, ownerNode) => {
      const methods = members.filter((m) => (m.type === 'MethodDefinition' || m.type === 'Property') && (m.value && isFn(m.value)) &&
        (m.key.type === 'Identifier' || m.key.type === 'Literal'));
      if (!methods.length || top.has(name)) return;
      const cls = { id: name, name, kind: 'class', parent: '', line: (ownerNode || node).loc.start.line, end: (ownerNode || node).loc.end.line,
        signature: node.type.startsWith('Class') ? `class ${name}${node.superClass ? ` extends ${text.slice(node.superClass.start, node.superClass.end)}` : ''}` : `${name} = { … }`,
        doc: docBefore(comments, text, (ownerNode || node).start), decorators: [], bases: [] };
      symbols.push(cls); top.set(name, cls);
      for (const m of methods) {
        const key = m.key.type === 'Identifier' ? m.key.name : String(m.key.value);
        addFn(key, m, m.value, name, sectionAt(comments, m.start));
      }
    };
    // A Playwright test is a function named by its title (inside test.describe: "group › title").
    const testCall = (s) => {
      const e = s.type === 'ExpressionStatement' && s.expression.type === 'CallExpression' ? s.expression : null;
      if (!e || !e.arguments[0] || e.arguments[0].type !== 'Literal' || typeof e.arguments[0].value !== 'string') return null;
      const c = e.callee, name = c.type === 'Identifier' ? c.name : c.type === 'MemberExpression' && c.object.type === 'Identifier' && !c.computed
        ? `${c.object.name}.${c.property.name}` : '';
      const fn = e.arguments.find(isFn);
      if (!fn || !/^(test|it|describe)(\.(describe|only|skip|serial|fixme))?$/.test(name)) return null;
      return { describe: /describe/.test(name), title: e.arguments[0].value, fn };
    };
    const tests = (body, prefix) => {
      for (const s of body) {
        const t = testCall(s);
        if (!t || t.fn.body.type !== 'BlockStatement') continue;
        const title = (prefix ? `${prefix} › ` : '') + t.title.replace(/\s+/g, ' ').slice(0, 90);
        if (t.describe) tests(t.fn.body.body, title);
        else {
          const id = symbols.some((x) => x.id === title) ? `${title} (line ${s.loc.start.line})` : title;
          addFn(id, s, t.fn);
          symbols.find((x) => x.id === id).signature = `test(${JSON.stringify(t.title)}, …)`;
        }
      }
    };
    if (/\.spec\.js$/.test(p)) tests(ast.body, '');
    for (const body of scopes(ast)) {
      for (const s of body) {
        if (s.type === 'FunctionDeclaration' && s.id) addFn(s.id.name, s, s);
        else if (s.type === 'ClassDeclaration' && s.id) addClass(s.id.name, s, s.body.body);
        else if (s.type === 'VariableDeclaration') {
          for (const d of s.declarations) {
            if (d.id.type !== 'Identifier' || !d.init) continue;
            if (isFn(d.init)) addFn(d.id.name, s.declarations.length === 1 ? Object.assign({}, d, { start: s.start, loc: s.loc, init: d.init }) : d, d.init);
            else if (d.init.type === 'ObjectExpression') addClass(d.id.name, d.init, d.init.properties, s);
            else if (d.init.type === 'ClassExpression') addClass(d.id.name, d.init, d.init.body.body, s);
          }
        } else if (s.type === 'ExpressionStatement' && s.expression.type === 'AssignmentExpression') {
          const g = globalName(s.expression.left), right = s.expression.right;
          if (g && isFn(right)) addFn(g, Object.assign({}, right, { start: s.start, loc: s.loc }), right);
          else if (g && right.type === 'ObjectExpression') addClass(g, right, right.properties, s);
        }
      }
    }
    // Calls inside the file, and calls into the files that publish the globals used.
    const declared = new Set();
    walk(ast, (n) => { if ((n.type === 'VariableDeclarator' || n.type === 'FunctionDeclaration') && n.id && n.id.type === 'Identifier') declared.add(n.id.name); });
    const foreign = (name) => publisher[name] && publisher[name] !== p && !declared.has(name) ? publisher[name] : '';
    const useName = (target, g, member) => {
      const there = files[target] || null;   // (not read yet: resolved after the loop)
      return { path: target, name: member ? `${g}.${member}` : g, _g: g, _m: member, _there: there };
    };
    for (const [id, fn] of bodies) {
      const s = symbols.find((x) => x.id === id);
      const calls = [], uses = [];
      walk(fn.body || fn, (n) => {
        if (n.type !== 'CallExpression') return;
        let callee = n.callee.type === 'ChainExpression' ? n.callee.expression : n.callee;
        if (callee.type === 'Identifier') {
          if (top.has(callee.name) && (callee.name !== s.name || s.parent) && top.get(callee.name).kind !== 'class') calls.push(callee.name);
          else if (foreign(callee.name)) uses.push(useName(foreign(callee.name), callee.name, ''));
        } else if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
          const member = callee.property.name;
          let holder = callee.object.type === 'ChainExpression' ? callee.object.expression : callee.object;
          if (holder.type === 'ThisExpression' && s.parent && symbols.some((x) => x.id === `${s.parent}.${member}`)) calls.push(`${s.parent}.${member}`);
          else if (holder.type === 'Identifier' && top.has(holder.name) && top.get(holder.name).kind === 'class') {
            calls.push(symbols.some((x) => x.id === `${holder.name}.${member}`) ? `${holder.name}.${member}` : holder.name);
          } else {
            const g = holder.type === 'Identifier' ? holder.name : globalName(holder);
            const target = g && (holder.type === 'Identifier' ? foreign(g) : (publisher[g] !== p ? publisher[g] : ''));
            if (target) uses.push(useName(target, g, member));
          }
        }
      });
      s.calls = [...new Set(calls)].filter((c) => c !== s.id);
      s.uses = uses;
    }
    // Imports: the globals this file reads from other files, and require()/import of files.
    const imports = [], seen = new Set();
    const record = (module, target) => { const key = target || module; if (key && !seen.has(key) && target !== p) { seen.add(key); imports.push({ module, path: target || '' }); } };
    walk(ast, (n, parent) => {
      if (n.type === 'MemberExpression') { const g = globalName(n); if (g && publisher[g] && publisher[g] !== p && !(parent && parent.type === 'AssignmentExpression' && parent.left === n)) record(g, publisher[g]); }
      else if (n.type === 'Identifier' && foreign(n.name) && !(parent && parent.type === 'MemberExpression' && parent.property === n && !parent.computed) &&
               !(parent && parent.type === 'Property' && parent.key === n)) record(n.name, foreign(n.name));
      else if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'require' && n.arguments[0] && n.arguments[0].type === 'Literal') {
        const spec = String(n.arguments[0].value);
        record(spec, spec.startsWith('.') ? resolveFile(p, spec) : '');
      } else if (n.type === 'ImportDeclaration') { const spec = String(n.source.value); record(spec, spec.startsWith('.') ? resolveFile(p, spec) : ''); }
    });
    files[p] = { doc: headerDoc(comments, text), lines: lineCount(text), imports, symbols, text };
  }
  // A use names the function in the other file when it has one by that name.
  for (const file of Object.values(files)) for (const s of file.symbols) for (const u of s.uses || []) {
    const there = files[u.path];
    if (there && u._m) {
      if (there.symbols.some((x) => x.id === `${u._g}.${u._m}`)) u.name = `${u._g}.${u._m}`;
      else if (there.symbols.some((x) => x.id === u._m && !x.parent)) u.name = u._m;
    }
    delete u._g; delete u._m; delete u._there;
  }
  for (const file of Object.values(files)) for (const s of file.symbols) if (s.uses) s.uses = [...new Map(s.uses.map((u) => [`${u.path}|${u.name}`, u])).values()];
  return files;
}
let KNOWN = new Set();
function resolveFile(from, spec) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  for (const c of [base, `${base}.js`, `${base}.cjs`, `${base}/index.js`]) if (KNOWN.has(c)) return c;
  return '';
}

// ---- Java ------------------------------------------------------------------------------------------
function mask(text) {  // comments and strings to spaces (newlines kept), so braces can be counted
  let out = '', i = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === '//') { const j = text.indexOf('\n', i); const e = j < 0 ? text.length : j; out += ' '.repeat(e - i); i = e; }
    else if (two === '/*') { const j = text.indexOf('*/', i + 2); const e = j < 0 ? text.length : j + 2; out += text.slice(i, e).replace(/[^\n]/g, ' '); i = e; }
    else if (text[i] === '"' || text[i] === "'") {
      const q = text[i]; let j = i + 1;
      while (j < text.length && text[j] !== q && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      out += q + ' '.repeat(Math.max(0, j - i - 1)) + (j < text.length ? q : ''); i = j + 1;
    } else { out += text[i]; i++; }
  }
  return out;
}
const JAVA_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'synchronized', 'return', 'new', 'else', 'try', 'do', 'throw', 'super', 'this']);
function readJava(p, text, javaClasses) {
  const masked = mask(text);
  const lineOf = (i) => text.slice(0, i).split('\n').length;
  const close = (open) => { let depth = 0; for (let i = open; i < masked.length; i++) { if (masked[i] === '{') depth++; else if (masked[i] === '}' && --depth === 0) return i; } return masked.length - 1; };
  const javadoc = (start) => {
    const before = text.slice(0, start).replace(/(\s*@\w+(\([^)]*\))?)*\s*$/, '');
    const m = /\/\*\*([\s\S]*?)\*\/\s*$/.exec(before);
    return m ? m[1].split('\n').map((l) => l.replace(/^\s*\* ?/, '')).join('\n').trim() : '';
  };
  const symbols = [], classes = [];
  const classRe = /(?:^|\n)([ \t]*)((?:@\w+(?:\([^)]*\))?\s*)*(?:(?:public|private|protected|static|final|abstract)\s+)*(?:class|interface|enum)\s+(\w+)[^{;]*)\{/g;
  for (let m; (m = classRe.exec(masked));) {
    const open = m.index + m[0].length - 1, start = m.index + (m[0].startsWith('\n') ? 1 : 0) + m[1].length;
    const c = { name: m[3], open, close: close(open), start };
    classes.push(c);
    const head = text.slice(start, open).replace(/\s+/g, ' ').trim();
    const bases = (/\b(?:extends|implements)\s+([\w.<>, ]+)/.exec(head) || [])[1];
    symbols.push({ id: c.name, name: c.name, kind: 'class', parent: '', line: lineOf(start), end: lineOf(c.close), signature: head,
      doc: javadoc(start), decorators: (head.match(/@\w+/g) || []).map((d) => d.slice(1)), bases: bases ? bases.split(',').map((b) => b.trim()) : [] });
  }
  const depthAt = (i) => { let d = 0; for (let k = 0; k < i; k++) { if (masked[k] === '{') d++; else if (masked[k] === '}') d--; } return d; };
  const methodRe = /(?:^|\n)[ \t]*((?:@\w+(?:\([^)]*\))?\s*)*(?:(?:public|private|protected|static|final|synchronized|abstract|native|default)\s+)*(?:<[^>]+>\s+)?(?:([\w<>\[\],.? ]+?)\s+)?(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w., ]+)?)\s*\{/g;
  for (let m; (m = methodRe.exec(masked));) {
    const name = m[3], type = (m[2] || '').trim();
    if (JAVA_KEYWORDS.has(name) || JAVA_KEYWORDS.has(type.split(/\s+/).pop()) || /\bnew$/.test(type)) continue;
    const at = m.index + (m[0].startsWith('\n') ? 1 : 0) + (m[0].match(/^\n?[ \t]*/)[0].replace('\n', '').length);
    const owner = classes.filter((c) => c.open < at && at < c.close).sort((a, b) => b.open - a.open)[0];
    if (!owner || depthAt(at) !== depthAt(owner.open) + 1) continue;
    if (!type && name !== owner.name) continue;   // (only a constructor has no return type)
    const open = m.index + m[0].length - 1, end = close(open);
    const head = text.slice(at, open).replace(/\s+/g, ' ').trim();
    const id = `${owner.name}.${name}`;
    if (symbols.some((s) => s.id === id)) continue;   // (an overload: the first one stands for both)
    symbols.push({ id, name, kind: 'method', parent: owner.name, line: lineOf(at), end: lineOf(end), signature: head.replace(/^(@\w+(\([^)]*\))?\s*)+/, ''),
      doc: javadoc(at), decorators: (head.match(/^(@\w+(\([^)]*\))?\s*)+/) || [''])[0].match(/@\w+/g)?.map((d) => d.slice(1)) || [], section: '', _open: open, _end: end });
  }
  for (const s of symbols.filter((x) => x.kind === 'method')) {
    const body = masked.slice(s._open, s._end);
    const calls = new Set(), uses = new Map();
    for (const m of body.matchAll(/(?:\b(\w+)\s*\.\s*)?\b(\w+)\s*\(/g)) {
      const holder = m[1], name = m[2];
      if (!holder || holder === 'this') {
        const own = `${s.parent}.${name}`;
        if (symbols.some((x) => x.id === own) && own !== s.id) calls.add(own);
      } else if (symbols.some((x) => x.id === `${holder}.${name}`)) calls.add(`${holder}.${name}`);
      else if (javaClasses[holder] && javaClasses[holder] !== p) uses.set(`${holder}.${name}`, { path: javaClasses[holder], name: `${holder}.${name}` });
    }
    for (const m of body.matchAll(/\bnew\s+(\w+)\s*\(/g)) if (javaClasses[m[1]] && javaClasses[m[1]] !== p) uses.set(m[1], { path: javaClasses[m[1]], name: m[1] });
    s.calls = [...calls]; s.uses = [...uses.values()];
    delete s._open; delete s._end;
  }
  const imports = [], seen = new Set();
  for (const m of text.matchAll(/^import\s+(static\s+)?([\w.*]+);/gm)) { const n = m[2]; if (!seen.has(n)) { seen.add(n); imports.push({ module: n, path: '' }); } }
  for (const [name, target] of Object.entries(javaClasses)) {
    if (target !== p && new RegExp(`\\b${name}\\b`).test(masked)) imports.push({ module: name, path: target });
  }
  return { doc: symbols[0]?.doc || '', lines: lineCount(text), imports, symbols, text };
}

// ---- data files: pages, guides, mod.json, workflows ------------------------------------------------
function readData(p, text) {
  const imports = [], seen = new Set();
  const name = (module, target) => { if (target && KNOWN.has(target) && target !== p && !seen.has(target)) { seen.add(target); imports.push({ module, path: target }); } };
  let doc = '';
  if (p.endsWith('.html')) {
    doc = ((/<!--\s*([\s\S]*?)\s*-->/.exec(text) || [])[1] || (/<title>([^<]*)<\/title>/.exec(text) || [])[1] || '').trim();
    for (const m of text.matchAll(/\{%\s*include\s+'([^']+)'/g)) name(m[1], `src/${m[1]}`);
    for (const m of text.matchAll(/<script[^>]*\ssrc="\/?([^"?#]+)/g)) name(m[1].replace(/^static\//, ''), `src/${m[1].replace(/^\//, '')}`);
  } else if (p.endsWith('.md')) {
    doc = (text.split('\n').find((l) => l.trim()) || '').replace(/^#+\s*/, '');
    for (const m of text.matchAll(/\]\(([^)#\s]+)/g)) if (!/^[a-z]+:/.test(m[1])) name(m[1], path.posix.normalize(path.posix.join(path.posix.dirname(p), m[1])));
  } else if (p.endsWith('mod.json')) {
    try {
      const mod = JSON.parse(text);
      doc = mod.description || mod.name || '';
      for (const f of [].concat(mod.scripts || [], mod.styles || [])) name(f, path.posix.join(path.posix.dirname(p), f));
    } catch (_e) { /* listed as is */ }
  } else {
    doc = (text.split('\n').find((l) => /^\s*(#|\/\/)/.test(l)) || '').replace(/^\s*(#|\/\/)\s*/, '');
    for (const m of text.matchAll(/\b((?:build_tools|tests|backend|src|desktop)\/[\w./-]+\.\w+)/g)) name(m[1], m[1]);
  }
  return { doc, lines: lineCount(text), imports, symbols: [], text, data: true };
}

// ---- folders, mods, the whole -----------------------------------------------------------------------
function folders(files) {
  const tree = {};
  for (const p of Object.keys(files)) {
    const parts = p.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      const folder = parts.slice(0, depth).join('/'), child = parts.slice(0, depth + 1).join('/');
      const entry = tree[folder] || (tree[folder] = { children: [], readme: '' });
      if (!entry.children.includes(child)) entry.children.push(child);
    }
  }
  for (const [folder, entry] of Object.entries(tree)) {
    const readme = path.join(ROOT, folder, 'README.md');
    entry.readme = fs.existsSync(readme) ? firstParagraph(fs.readFileSync(readme, 'utf8')) : FOLDER_NOTES[folder] || '';
    entry.children.sort((a, b) => (Number(a in files) - Number(b in files)) || (a < b ? -1 : a > b ? 1 : 0));
  }
  return tree;
}
function firstParagraph(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || line.startsWith('<!--') || !line.trim()) { if (out.length) break; continue; }
    out.push(line.trim());
  }
  return out.join(' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').slice(0, 1200);
}
function mods(files) {  // each folder with a mod.json: what it is
  const out = {};
  for (const p of Object.keys(files)) {
    if (!p.endsWith('/mod.json')) continue;
    try { const m = JSON.parse(files[p].text); out[path.posix.dirname(p)] = { description: m.description || '', name: m.name || m.id, id: m.id, slots: [] }; } catch (_e) {}
  }
  return out;
}

function build() {
  const paths = tracked();
  KNOWN = new Set(paths);
  const js = paths.filter((p) => /\.(js|cjs|mjs)$/.test(p));
  const files = readJsFiles(js);
  const py = JSON.parse(execFileSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    [path.join(__dirname, 'architecture_py.py')], { cwd: ROOT, input: JSON.stringify(paths), encoding: 'utf8', maxBuffer: 1 << 28,
      env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', ARCH_ROOT: ROOT }) }));
  Object.assign(files, py);
  const javaClasses = {};
  for (const p of paths.filter((x) => x.endsWith('.java'))) javaClasses[path.posix.basename(p, '.java')] = p;
  for (const p of paths.filter((x) => x.endsWith('.java'))) files[p] = readJava(p, read(p), javaClasses);
  for (const p of paths.filter((x) => DATA.test(x))) files[p] = readData(p, read(p));
  const sorted = {};
  for (const p of Object.keys(files).sort()) sorted[p] = files[p];
  const data = { repo: REPO, branch: BRANCH, roots: ROOTS.filter((r) => paths.some((p) => p.startsWith(r + '/'))), core: [], modules: mods(sorted),
    folders: folders(sorted), files: sorted };
  return '// Generated by build_tools/architecture.cjs from the code; do not edit (run it again instead).\n' +
    `window.ARCH = ${JSON.stringify(data, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().reduce((o, key) => (o[key] = v[key], o), {}) : v))};\n`;
}

const text = build();
if (args.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== text) { console.error(`${path.relative(ROOT, OUT)} is out of date: run node build_tools/architecture.cjs`); process.exit(1); }
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(ROOT, OUT)} (${Math.round(text.length / 1024)} KB)`);
}
