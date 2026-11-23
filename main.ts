// mend — one patch tool for every AI edit format (SPEC.md version 1).
//
// Reads an edit written as a unified diff, as SEARCH/REPLACE blocks, as a V4A patch or as JSON
// text-editor calls, and applies it to the tree in the working directory: every file is changed
// or nothing is. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file
// hands over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** An exit-2 outcome: exactly this one line on stdout, nothing written. */
class Bail {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

/** One edit's failure (exit 1): a code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines (SPEC section 3): split at \n, one trailing \r removed, no final empty piece. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A safe path (section 3): relative, no backslash, no empty, dot or dot-dot segment. */
function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its own line break, and whether its text ends with that break. */
interface FileLines {
  ls: string[];
  br: '\n' | '\r\n';
  fin: boolean;
}

function toLines(text: string): FileLines {
  if (text === '') return { ls: [], br: '\n', fin: false };
  const at = text.indexOf('\n');
  const br = at > 0 && text[at - 1] === '\r' ? '\r\n' : '\n';
  const ls = text.split(br);
  let fin = false;
  if (text.endsWith(br)) {
    ls.pop();
    fin = true;
  }
  return { ls, br, fin };
}

function fromLines(m: FileLines): string {
  if (m.ls.length === 0) return '';
  return m.ls.join(m.br) + (m.fin ? m.br : '');
}

/** The tree as the edits leave it: `now` holds the paths an edit touched (null: deleted). */
class Store {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }
}

type Edit = (store: Store) => void;

// ---------------------------------------------------------------- matching (section 5)

const trailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const bothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function tierKey(s: string, tier: number): string {
  return tier === 0 ? s : tier === 1 ? trailWs(s) : bothWs(s);
}

/** Every start position, at or after `from`, where O's lines match the file's under `tier`. */
function occurrences(ls: string[], o: string[], tier: number, from: number): number[] {
  const found: number[] = [];
  if (o.length === 0) return found;
  const keys = o.map((l) => tierKey(l, tier));
  outer: for (let i = from; i + o.length <= ls.length; i += 1) {
    for (let j = 0; j < o.length; j += 1) {
      if (tierKey(ls[i + j]!, tier) !== keys[j]) continue outer;
    }
    found.push(i);
  }
  return found;
}

/** The first tier at which O occurs at or after `from`, with its positions; null when none. */
function firstTier(
  ls: string[],
  o: string[],
  strict: boolean,
  from: number,
): { tier: number; at: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const at = occurrences(ls, o, tier, from);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

/**
 * A tier-2 re-indent (section 5): a non-blank new line that starts with P, the leading
 * whitespace of O's first line, has that P replaced by F, the file's own first matched line's.
 */
function reindent(line: string, oFirst: string, fileFirst: string): string {
  if (line.trim() === '') return line;
  const p = leadWs(oFirst);
  if (!line.startsWith(p)) return line;
  return leadWs(fileFirst) + line.slice(p.length);
}

/** One line of a replacement: a context line (oi: its index in O) or a new line (oi: -1). */
interface NLine {
  ctx: boolean;
  oi: number;
  text: string;
}

/** The lines a match writes: context lines are the file's own, new lines per the tier. */
function renderN(ls: string[], pos: number, o: string[], n: NLine[], tier: number): string[] {
  return n.map((e) => {
    if (e.ctx) return ls[pos + e.oi]!;
    return tier === 2 ? reindent(e.text, o[0]!, ls[pos]!) : e.text;
  });
}

// ---------------------------------------------------------------- unified diffs (section 6)

interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

const gitStart = (l: string): boolean => l.startsWith('diff --git ');

/** The two paths of a `diff --git a/<X> b/<Y>` line, or null when it is not of that form. */
function gitPaths(l: string): [string, string] | null {
  const rest = l.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const at = rest.lastIndexOf(' b/');
  if (at < 2) return null;
  const x = rest.slice(2, at);
  const y = rest.slice(at + 3);
  return x === '' || y === '' ? null : [x, y];
}

/** A ---/+++ header path: up to the first tab, spaces removed, a leading a/ or b/ removed. */
function headerPath(l: string): string {
  const raw = l.slice(4).split('\t')[0]!.trim();
  return raw.startsWith('a/') || raw.startsWith('b/') ? raw.slice(2) : raw;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Whether line i ends a hunk body: a new section starts there. */
function bodyEnds(lines: string[], i: number): boolean {
  const l = lines[i]!;
  return gitStart(l) || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '));
}

/**
 * Reads one section whose header begins at line i (a diff --git line, already consumed when
 * git is given, else a --- line). Returns the section and the line after it.
 */
function readSection(lines: string[], i: number, git: [string, string] | null): [Section, number] {
  let oldP: string | null = null;
  let newP: string | null = null;
  let renFrom: string | null = null;
  let renTo: string | null = null;
  let create = false;
  let del = false;
  const hunks: Hunk[] = [];
  let header = true;

  const readPair = (at: number): number => {
    // lines[at] is a --- line; the line after it has to be a +++ line.
    if (!(lines[at + 1] ?? '').startsWith('+++ ')) throw new Bail(`error: parse ${at + 2}`);
    oldP = headerPath(lines[at]!);
    newP = headerPath(lines[at + 1]!);
    return at + 2;
  };

  if (git === null) i = readPair(i); // the section opened with its --- line

  while (i < lines.length) {
    const l = lines[i]!;
    if (gitStart(l)) break;
    if (!header && l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('@@')) {
      const m = HUNK_RE.exec(l);
      if (m === null) throw new Bail(`error: parse ${i + 1}`);
      header = false;
      const body: BodyLine[] = [];
      i += 1;
      while (i < lines.length && !bodyEnds(lines, i)) {
        const b = lines[i]!;
        const c = b[0];
        if (b === '') body.push({ kind: ' ', text: '' });
        else if (c === ' ' || c === '-' || c === '+' || c === '\\') body.push({ kind: c, text: b.slice(1) });
        else break;
        i += 1;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === ' ' && body[body.length - 1]!.text === '') body.pop();
      hunks.push({ a: Number(m[1]), body });
      continue;
    }
    if (header) {
      if (l.startsWith('--- ')) {
        i = readPair(i);
        continue;
      }
      if (l.startsWith('+++ ')) {
        newP = headerPath(l);
        i += 1;
        continue;
      }
      if (l.startsWith('rename from ')) renFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) renTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) create = true;
      else if (l.startsWith('deleted file mode')) del = true;
      i += 1;
      continue;
    }
    i += 1; // past the header, a line that starts nothing is ignored
  }

  const sec: Section = {
    oldPath: oldP ?? renFrom ?? (git === null ? null : git[0]),
    newPath: newP ?? renTo ?? (git === null ? null : git[1]),
    create: create || oldP === '/dev/null',
    del: del || newP === '/dev/null',
    hunks,
  };
  return [sec, i];
}

/** Whether a `\` line follows the body's last context or + line. */
function backslashAfterLastNew(body: BodyLine[]): boolean {
  for (let i = body.length - 1; i >= 0; i -= 1) {
    const k = body[i]!.kind;
    if (k === ' ' || k === '+') return body[i + 1]?.kind === '\\';
  }
  return false;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('@@')) throw new Bail(`error: parse ${i + 1}`); // a hunk before any section
    if (gitStart(l)) {
      const git = gitPaths(l);
      if (git === null) throw new Bail(`error: parse ${i + 1}`);
      const [sec, next] = readSection(lines, i + 1, git);
      edits.push(unifiedEdit(sec, strict));
      i = next;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const [sec, next] = readSection(lines, i, null);
      edits.push(unifiedEdit(sec, strict));
      i = next;
      continue;
    }
    i += 1; // prose between sections
  }
  if (edits.length === 0) throw new Bail('error: parse 1');
  return edits;
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (store) => {
    if (sec.create) {
      const p = sec.newPath!;
      if (!isSafe(p)) throw new Fail('unsafe', p);
      if (store.get(p) !== null) throw new Fail('exists', p);
      const ls: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.kind === '+') ls.push(b.text);
      // The created file ends with a line break unless a `\` line follows its last + line.
      let fin = true;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi -= 1) {
        const body = sec.hunks[hi]!.body;
        for (let bi = body.length - 1; bi >= 0; bi -= 1) {
          if (body[bi]!.kind === '+') {
            fin = body[bi + 1]?.kind !== '\\';
            break outer;
          }
        }
      }
      store.set(p, fromLines({ ls, br: '\n', fin: ls.length > 0 && fin }));
      return;
    }
    const p = sec.oldPath!;
    if (!isSafe(p)) throw new Fail('unsafe', p);
    if (sec.del) {
      if (store.get(p) === null) throw new Fail('missing', p);
      store.set(p, null);
      return;
    }
    const target = sec.newPath ?? p;
    if (target !== p && !isSafe(target)) throw new Fail('unsafe', target);
    const cur = store.get(p);
    if (cur === null) throw new Fail('missing', p);
    if (target !== p && store.get(target) !== null) throw new Fail('exists', target);
    const m = toLines(cur);
    let d = 0;
    for (const h of sec.hunks) {
      applyHunk(m, h, d, strict, p);
      let nLen = 0;
      let oLen = 0;
      for (const b of h.body) {
        if (b.kind === ' ' || b.kind === '+') nLen += 1;
        if (b.kind === ' ' || b.kind === '-') oLen += 1;
      }
      d += nLen - oLen;
    }
    store.set(target, fromLines(m));
    if (target !== p) {
      store.set(p, null);
      store.moves.push([p, target]);
    }
  };
}

function applyHunk(m: FileLines, h: Hunk, d: number, strict: boolean, path: string): void {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of h.body) {
    if (b.kind === ' ') {
      n.push({ ctx: true, oi: o.length, text: b.text });
      o.push(b.text);
    } else if (b.kind === '-') o.push(b.text);
    else if (b.kind === '+') n.push({ ctx: false, oi: -1, text: b.text });
  }
  if (o.length === 0) {
    const pos = Math.min(h.a + d, m.ls.length);
    const atEnd = pos === m.ls.length;
    m.ls.splice(pos, 0, ...n.map((e) => e.text));
    if (atEnd && m.ls.length > 0) m.fin = !backslashAfterLastNew(h.body);
    return;
  }
  const found = firstTier(m.ls, o, strict, 0);
  if (found === null) throw new Fail('no-match', path);
  const want = h.a - 1 + d;
  let pos = found.at[0]!;
  for (const at of found.at) if (Math.abs(at - want) < Math.abs(pos - want)) pos = at;
  const toEnd = pos + o.length === m.ls.length;
  const written = renderN(m.ls, pos, o, n, found.tier);
  m.ls.splice(pos, o.length, ...written);
  if (toEnd) m.fin = !backslashAfterLastNew(h.body);
}

// ---------------------------------------------------------------- SEARCH/REPLACE (section 7)

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const at = i;
    let path: string | null = null;
    for (let j = at - 1; j >= prevEnd; j -= 1) {
      const l = lines[j]!;
      if (isBlank(l) || l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Bail(`error: parse ${at + 1}`);
      path = prevPath;
    }
    let mid = at + 1;
    while (mid < lines.length && lines[mid]!.trimEnd() !== '=======') mid += 1;
    if (mid >= lines.length) throw new Bail(`error: parse ${at + 1}`);
    let end = mid + 1;
    while (end < lines.length && lines[end]!.trimEnd() !== '>>>>>>> REPLACE') end += 1;
    if (end >= lines.length) throw new Bail(`error: parse ${at + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(at + 1, mid), lines.slice(mid + 1, end), strict));
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  if (edits.length === 0) throw new Bail('error: parse 1');
  return edits;
}

function searchReplaceEdit(path: string, oldLs: string[], newLs: string[], strict: boolean): Edit {
  return (store) => {
    if (!isSafe(path)) throw new Fail('unsafe', path);
    if (oldLs.length === 0) {
      if (store.get(path) !== null) throw new Fail('exists', path);
      store.set(path, fromLines({ ls: [...newLs], br: '\n', fin: newLs.length > 0 }));
      return;
    }
    const cur = store.get(path);
    if (cur === null) throw new Fail('missing', path);
    const m = toLines(cur);
    const found = firstTier(m.ls, oldLs, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.at.length > 1) throw new Fail('ambiguous', path);
    const pos = found.at[0]!;
    const written = newLs.map((t) => (found.tier === 2 ? reindent(t, oldLs[0]!, m.ls[pos]!) : t));
    m.ls.splice(pos, oldLs.length, ...written);
    store.set(path, fromLines(m));
  };
}

// ---------------------------------------------------------------- V4A patches (section 8)

interface Chunk {
  anchor: string | null;
  eof: boolean;
  entries: { kind: ' ' | '-' | '+'; text: string }[];
}

interface V4aSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  startLine: number;
  addLines: string[];
  moveTo: string | null;
  chunks: Chunk[];
}

const V4A_HEADS: [string, V4aSection['kind']][] = [
  ['*** Add File:', 'add'],
  ['*** Delete File:', 'del'],
  ['*** Update File:', 'upd'],
];

function v4aHead(l: string): { kind: V4aSection['kind']; path: string } | null {
  for (const [head, kind] of V4A_HEADS) {
    if (l.startsWith(head)) return { kind, path: l.slice(head.length).trim() };
  }
  return null;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Bail('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Bail(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && isBlank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Bail(`error: parse ${lines.length + 1}`);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (isBlank(l)) {
      i += 1;
      continue;
    }
    const head = v4aHead(l);
    if (head === null) throw new Bail(`error: parse ${i + 1}`);
    const startLine = i + 1;
    i += 1;
    const body: { text: string; no: number }[] = [];
    while (i < last && v4aHead(lines[i]!) === null) {
      body.push({ text: lines[i]!, no: i + 1 });
      i += 1;
    }
    while (body.length > 0 && isBlank(body[body.length - 1]!.text)) body.pop();
    edits.push(v4aEdit(parseV4aSection(head.kind, head.path, startLine, body), strict));
  }
  if (edits.length === 0) throw new Bail('error: parse 1');
  return edits;
}

function parseV4aSection(
  kind: V4aSection['kind'],
  path: string,
  startLine: number,
  body: { text: string; no: number }[],
): V4aSection {
  const sec: V4aSection = { kind, path, startLine, addLines: [], moveTo: null, chunks: [] };
  if (kind === 'add') {
    for (const b of body) {
      if (b.text.startsWith('+')) sec.addLines.push(b.text.slice(1));
      else if (b.text === '') sec.addLines.push('');
      else throw new Bail(`error: parse ${b.no}`);
    }
    return sec;
  }
  if (kind === 'del') {
    for (const b of body) if (!isBlank(b.text)) throw new Bail(`error: parse ${b.no}`);
    return sec;
  }
  let rest = body;
  if (rest.length > 0 && rest[0]!.text.startsWith('*** Move to:')) {
    sec.moveTo = rest[0]!.text.slice('*** Move to:'.length).trim();
    rest = rest.slice(1);
  }
  let cur: Chunk | null = null;
  for (const b of rest) {
    const l = b.text;
    if (l.startsWith('@@')) {
      cur = { anchor: l.slice(2).trim() || null, eof: false, entries: [] };
      sec.chunks.push(cur);
    } else if (l.trim() === '*** End of File') {
      if (cur === null) {
        cur = { anchor: null, eof: true, entries: [] };
        sec.chunks.push(cur);
      } else cur.eof = true;
    } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        cur = { anchor: null, eof: false, entries: [] };
        sec.chunks.push(cur);
      }
      cur.entries.push({ kind: l === '' ? ' ' : (l[0] as ' ' | '-' | '+'), text: l === '' ? '' : l.slice(1) });
    } else throw new Bail(`error: parse ${b.no}`);
  }
  if (sec.chunks.length === 0 && sec.moveTo === null) throw new Bail(`error: parse ${startLine}`);
  return sec;
}

function v4aEdit(sec: V4aSection, strict: boolean): Edit {
  return (store) => {
    const p = sec.path;
    if (!isSafe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (store.get(p) !== null) throw new Fail('exists', p);
      store.set(p, sec.addLines.length === 0 ? '' : `${sec.addLines.join('\n')}\n`);
      return;
    }
    if (sec.kind === 'del') {
      if (store.get(p) === null) throw new Fail('missing', p);
      store.set(p, null);
      return;
    }
    const target = sec.moveTo ?? p;
    if (target !== p && !isSafe(target)) throw new Fail('unsafe', target);
    const cur = store.get(p);
    if (cur === null) throw new Fail('missing', p);
    if (target !== p && store.get(target) !== null) throw new Fail('exists', target);
    const m = toLines(cur);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        let at = -1;
        for (const tier of strict ? [0] : [0, 1, 2]) {
          const key = tierKey(chunk.anchor, tier);
          for (let k = cursor; k < m.ls.length; k += 1) {
            if (tierKey(m.ls[k]!, tier) === key) {
              at = k;
              break;
            }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', p);
        cursor = at + 1;
      }
      const o: string[] = [];
      const n: NLine[] = [];
      for (const e of chunk.entries) {
        if (e.kind === ' ') {
          n.push({ ctx: true, oi: o.length, text: e.text });
          o.push(e.text);
        } else if (e.kind === '-') o.push(e.text);
        else n.push({ ctx: false, oi: -1, text: e.text });
      }
      if (o.length === 0) {
        const pos = chunk.eof ? m.ls.length : Math.min(cursor, m.ls.length);
        m.ls.splice(pos, 0, ...n.map((e) => e.text));
        cursor = pos + n.length;
        continue;
      }
      let found = firstTier(m.ls, o, strict, cursor);
      if (found !== null && chunk.eof) {
        const ok = found.at.filter((at) => at + o.length === m.ls.length);
        found = ok.length > 0 ? { tier: found.tier, at: ok } : null;
      }
      if (found === null) throw new Fail('no-match', p);
      const pos = found.at[0]!;
      const written = renderN(m.ls, pos, o, n, found.tier);
      m.ls.splice(pos, o.length, ...written);
      cursor = pos + written.length;
    }
    store.set(target, fromLines(m));
    if (target !== p) {
      store.set(p, null);
      store.moves.push([p, target]);
    }
  };
}

// ---------------------------------------------------------------- JSON edits (section 9)

/** One JSON edit object as an Edit, or null when it is not a well-formed one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const needFile = (store: Store): string => {
    if (!isSafe(p)) throw new Fail('unsafe', p);
    const t = store.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (store) => {
      if (!isSafe(p)) throw new Fail('unsafe', p);
      if (store.get(p) !== null) throw new Fail('exists', p);
      store.set(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (store) => {
      const before = needFile(store);
      const m = toLines(before);
      const crlf = m.br === '\r\n';
      const lf = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      store.set(p, crlf ? out.split('\n').join('\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (store) => {
      const before = needFile(store);
      const m = toLines(before);
      if (line < 0 || line > m.ls.length) throw new Fail('no-match', p);
      m.ls.splice(line, 0, ...add);
      store.set(p, fromLines(m));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Bail('error: parse 1');
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Bail(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Bail(`error: parse ${first + 1}`);
    const edits: Edit[] = [];
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Bail(`error: parse ${first + 1}`);
      edits.push(e);
    }
    if (edits.length === 0) throw new Bail('error: parse 1');
    return edits;
  }
  const edits: Edit[] = [];
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Bail(`error: parse ${i + 1}`);
    edits.push(e);
  });
  if (edits.length === 0) throw new Bail('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------- the run (sections 1, 2, 4, 10)

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Format detection (section 4): the first of its rules that holds. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => gitStart(l) || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice('--format='.length))) {
        format = a.slice('--format='.length);
      } else if (a === '--check' && !checkOnly) checkOnly = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text: string;
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
    text = '';
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
  } catch (e) {
    if (e instanceof Bail) return { code: 2, out: [e.text] };
    throw e;
  }
  const store = new Store();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(store.now);
    const movesBefore = store.moves.length;
    try {
      edit(store);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      store.now.clear();
      for (const [k, v] of before) store.now.set(k, v);
      store.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  // The R lines: a move pair whose old path is gone and whose new path is new (section 2).
  const renamed = new Map<string, string>(); // new path -> old path
  for (const [o, n] of store.moves) {
    if (store.original(o) !== null && store.get(o) === null && store.original(n) === null && store.get(n) !== null) {
      renamed.set(n, o);
    }
  }
  const renamedFrom = new Set(renamed.values());
  const rows: { key: string; line: string }[] = [];
  for (const p of store.now.keys()) {
    const was = store.original(p);
    const is = store.get(p);
    if (was === is) continue;
    if (!checkOnly) {
      if (is === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, is);
      }
    }
    if (renamed.has(p)) rows.push({ key: p, line: `R ${renamed.get(p)} -> ${p}` });
    else if (!renamedFrom.has(p)) rows.push({ key: p, line: `${was === null ? 'A' : is === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key, 'utf8'), Buffer.from(y.key, 'utf8')));
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
