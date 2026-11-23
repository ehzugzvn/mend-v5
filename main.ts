// main.ts is mend, the CLI SPEC.md specifies (MIT). mend applies an edit that an AI model wrote to a tree of text
// files; models write edits in four formats (unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON tool
// calls) and mend reads each one exactly as SPEC.md says, changing every file or nothing at all.
//
// Design: a class per format. PatchReader is the abstract reader; UnifiedReader, SearchReplaceReader, V4aReader
// and JsonReader each turn patch text into Edit objects (ChangeEdit, CreateEdit, DeleteEdit, MoveEdit). Every
// edit knows how to apply itself to a Workspace, which wraps the file map and remembers the before/after state
// of each path for the A/D/M/R report. Matcher is a small utility class holding the three matching tiers of
// section 5 as static methods. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// ============================================================================
// Banner: errors, small text helpers, and the file-body record
// ============================================================================

/** An exit-2 condition; `line` is the whole line to print. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
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

/** Byte order of paths (UTF-8), the only ordering mend ever uses. */
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** A patch's lines: split at \n, one trailing \r removed from each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Section 3: a safe path is non-empty, relative, backslash-free, with no empty, `.` or `..` segment. */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/**
 * A text file as lines plus the two facts section 3 attaches to it: its own line break, and whether its text
 * ends with one. An empty file has no lines and no final break; a file of no lines is written empty.
 */
class FileBody {
  lines: string[];
  readonly br: string;
  finalBreak: boolean;
  constructor(lines: string[], br: string, finalBreak: boolean) {
    this.lines = lines;
    this.br = br;
    this.finalBreak = finalBreak;
  }
  static parse(text: string): FileBody {
    if (text === '') return new FileBody([], '\n', false);
    const nl = text.indexOf('\n');
    const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
    const lines = text.split(br);
    const finalBreak = text.endsWith(br);
    if (finalBreak) lines.pop();
    return new FileBody(lines, br, finalBreak);
  }
  static join(lines: string[], br: string, finalBreak: boolean): string {
    if (lines.length === 0) return '';
    return lines.join(br) + (finalBreak ? br : '');
  }
  text(): string {
    return FileBody.join(this.lines, this.br, this.finalBreak);
  }
}

// ============================================================================
// Banner: Matcher — the three tiers of section 5, as static methods
// ============================================================================

class Matcher {
  static stripTrail(s: string): string {
    let end = s.length;
    while (end > 0 && (s[end - 1] === ' ' || s[end - 1] === '\t')) end -= 1;
    return s.slice(0, end);
  }
  static stripBoth(s: string): string {
    let start = 0;
    while (start < s.length && (s[start] === ' ' || s[start] === '\t')) start += 1;
    return Matcher.stripTrail(s.slice(start));
  }
  static leadingWs(s: string): string {
    let end = 0;
    while (end < s.length && (s[end] === ' ' || s[end] === '\t')) end += 1;
    return s.slice(0, end);
  }
  static lineEq(a: string, b: string, tier: number): boolean {
    if (tier === 0) return a === b;
    if (tier === 1) return Matcher.stripTrail(a) === Matcher.stripTrail(b);
    return Matcher.stripBoth(a) === Matcher.stripBoth(b);
  }
  /** Every start position at one tier where the old lines occur in `lines`, at or after `from`. */
  static positionsAt(lines: string[], old: string[], tier: number, from: number): number[] {
    const found: number[] = [];
    for (let i = Math.max(0, from); i + old.length <= lines.length; i += 1) {
      let ok = true;
      for (let j = 0; j < old.length; j += 1) {
        if (!Matcher.lineEq(lines[i + j]!, old[j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) found.push(i);
    }
    return found;
  }
  /**
   * The first tier (0..maxTier) at which `old` occurs at or after `from`, with that tier's positions; when
   * `mustEnd` is set, only occurrences ending at the file's last line count. Null when no tier has one.
   */
  static scan(lines: string[], old: string[], maxTier: number, from: number, mustEnd: boolean): { tier: number; positions: number[] } | null {
    for (let tier = 0; tier <= maxTier; tier += 1) {
      let positions = Matcher.positionsAt(lines, old, tier, from);
      if (mustEnd) positions = positions.filter((i) => i + old.length === lines.length);
      if (positions.length > 0) return { tier, positions };
    }
    return null;
  }
  /**
   * The lines that replace the matched old lines: context lines are the file's own matched lines; at tier 2
   * every other new line that starts with the old block's indentation P has P replaced by the file's F.
   * `items` interleaves context and added lines in order; `ctxOldIndex[k]` says which old line the k-th item
   * is, when it is a context line (-1 for an added line).
   */
  static buildSegment(fileLines: string[], at: number, old: string[], items: string[], ctxOldIndex: number[], tier: number): string[] {
    const f = tier === 2 && old.length > 0 ? Matcher.leadingWs(fileLines[at] ?? '') : '';
    const p = tier === 2 && old.length > 0 ? Matcher.leadingWs(old[0]!) : '';
    const out: string[] = [];
    for (let k = 0; k < items.length; k += 1) {
      const text = items[k]!;
      const oi = ctxOldIndex[k]!;
      if (oi >= 0) {
        out.push(fileLines[at + oi]!);
      } else if (tier === 2 && text !== '' && text.trim() !== '' && text.startsWith(p)) {
        out.push(f + text.slice(p.length));
      } else {
        out.push(text);
      }
    }
    return out;
  }
}

// ============================================================================
// Banner: Workspace — the file map an edit applies itself to
// ============================================================================

/**
 * The tree as the edits leave it. `now` holds the post-patch text of every path an edit has touched (null:
 * deleted); untouched paths are read from disk on demand. `original` caches each path's pre-patch text so the
 * final report can compare before and after. Successful move edits are noted in `moves` for the R line.
 */
class Workspace {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  moves: { from: string; to: string }[] = [];

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
  set(p: string, text: string | null): void {
    this.now.set(p, text);
  }
  noteMove(from: string, to: string): void {
    this.moves.push({ from, to });
  }
  snapshot(): { now: Map<string, string | null>; moves: { from: string; to: string }[] } {
    return { now: new Map(this.now), moves: [...this.moves] };
  }
  restore(snap: { now: Map<string, string | null>; moves: { from: string; to: string }[] }): void {
    this.now.clear();
    for (const [k, v] of snap.now) this.now.set(k, v);
    this.moves = [...snap.moves];
  }
  /** Paths whose final bytes differ from their initial bytes, in byte order. */
  changedPaths(): string[] {
    const out: string[] = [];
    for (const p of this.now.keys()) {
      if (this.original(p) !== this.now.get(p)!) out.push(p);
    }
    return out.sort(byteCompare);
  }
}

// ============================================================================
// Banner: edits — one class per kind of change, each applying itself
// ============================================================================

/** One body line of a unified hunk or a V4A chunk, in body order. */
interface BodyItem {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  /** A `\` line followed this body line: it claims there is no line break after it. */
  noEol: boolean;
  /** This item came from an empty patch line (a candidate trailing body line). */
  fromEmpty: boolean;
}

interface UnifiedHunk {
  aStart: number;
  items: BodyItem[];
}

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

/** The old lines of an item list: its context and deleted lines, in order. */
function oldOf(items: BodyItem[]): string[] {
  return items.filter((it) => it.kind !== 'add').map((it) => it.text);
}

/** The replacement segment for a match at `at`, per Matcher's tier rules. */
function segmentOf(fileLines: string[], at: number, items: BodyItem[], tier: number): string[] {
  const texts: string[] = [];
  const ctxOldIndex: number[] = [];
  let oi = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      texts.push(it.text);
      ctxOldIndex.push(oi);
      oi += 1;
    } else if (it.kind === 'del') {
      oi += 1;
    } else {
      texts.push(it.text);
      ctxOldIndex.push(-1);
    }
  }
  return Matcher.buildSegment(fileLines, at, oldOf(items), texts, ctxOldIndex, tier);
}

/** Whether a `\` line follows the item list's last context or added line. */
function tailNoEol(items: BodyItem[]): boolean {
  for (let k = items.length - 1; k >= 0; k -= 1) {
    if (items[k]!.kind !== 'del') return items[k]!.noEol;
  }
  return false;
}

abstract class Edit {
  abstract apply(ws: Workspace): void;

  protected guardSafe(p: string): void {
    if (!isSafePath(p)) throw new Fail('unsafe', p);
  }
  /** The current text of a file an edit changes, after its safety check, or a `missing` failure. */
  protected requireText(ws: Workspace, p: string): string {
    const t = ws.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  }

  /** Section 6: apply unified hunks in order to a parsed file body, tracking the running offset d. */
  protected applyUnified(body: FileBody, hunks: UnifiedHunk[], maxTier: number, failPath: string): void {
    let d = 0;
    for (const hunk of hunks) {
      const old = oldOf(hunk.items);
      const newCount = hunk.items.filter((it) => it.kind !== 'del').length;
      if (old.length === 0) {
        const segment = hunk.items.filter((it) => it.kind === 'add').map((it) => it.text);
        const at = Math.min(Math.max(hunk.aStart + d, 0), body.lines.length);
        const atEnd = at === body.lines.length;
        body.lines.splice(at, 0, ...segment);
        if (atEnd) body.finalBreak = !tailNoEol(hunk.items);
        d += segment.length;
        continue;
      }
      const hit = Matcher.scan(body.lines, old, maxTier, 0, false);
      if (hit === null) throw new Fail('no-match', failPath);
      const target = hunk.aStart - 1 + d;
      let at = hit.positions[0]!;
      for (const pos of hit.positions) {
        if (Math.abs(pos - target) < Math.abs(at - target)) at = pos;
      }
      const segment = segmentOf(body.lines, at, hunk.items, hit.tier);
      const atEnd = at + old.length === body.lines.length;
      body.lines.splice(at, old.length, ...segment);
      if (atEnd) body.finalBreak = !tailNoEol(hunk.items);
      d += newCount - old.length;
    }
  }

  /** Section 7: replace the old lines of a SEARCH/REPLACE block, which must occur exactly once. */
  protected applySearchReplace(body: FileBody, oldLines: string[], newLines: string[], maxTier: number, failPath: string): void {
    const hit = Matcher.scan(body.lines, oldLines, maxTier, 0, false);
    if (hit === null) throw new Fail('no-match', failPath);
    if (hit.positions.length > 1) throw new Fail('ambiguous', failPath);
    const at = hit.positions[0]!;
    // A block has no context lines: every new line is an added line (old index -1 in Matcher's terms).
    const segment = Matcher.buildSegment(body.lines, at, oldLines, newLines, newLines.map(() => -1), hit.tier);
    body.lines.splice(at, oldLines.length, ...segment);
  }

  /** Section 8: apply V4A chunks in order, moving the cursor past each chunk's written lines. */
  protected applyV4a(body: FileBody, chunks: V4aChunk[], maxTier: number, failPath: string): void {
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const anchorHit = Matcher.scan(body.lines, [chunk.anchor], maxTier, cursor, false);
        if (anchorHit === null) throw new Fail('no-match', failPath);
        cursor = anchorHit.positions[0]! + 1;
      }
      const old = oldOf(chunk.items);
      if (old.length === 0) {
        const segment = chunk.items.filter((it) => it.kind === 'add').map((it) => it.text);
        const at = chunk.eof ? body.lines.length : Math.min(cursor, body.lines.length);
        body.lines.splice(at, 0, ...segment);
        cursor = at + segment.length;
        continue;
      }
      const hit = Matcher.scan(body.lines, old, maxTier, cursor, chunk.eof);
      if (hit === null) throw new Fail('no-match', failPath);
      const at = hit.positions[0]!;
      const segment = segmentOf(body.lines, at, chunk.items, hit.tier);
      body.lines.splice(at, old.length, ...segment);
      cursor = at + segment.length;
    }
  }
}

/** A created file: either raw bytes (JSON create) or lines joined with LF and a final-break flag. */
class CreateEdit extends Edit {
  private readonly path: string;
  private readonly raw: string | null;
  private readonly fileLines: string[];
  private readonly endBreak: boolean;
  constructor(path: string, fileLines: string[], endBreak: boolean, raw: string | null = null) {
    super();
    this.path = path;
    this.fileLines = fileLines;
    this.endBreak = endBreak;
    this.raw = raw;
  }
  apply(ws: Workspace): void {
    this.guardSafe(this.path);
    if (ws.get(this.path) !== null) throw new Fail('exists', this.path);
    ws.set(this.path, this.raw !== null ? this.raw : FileBody.join(this.fileLines, '\n', this.endBreak));
  }
}

/** A deleted file. */
class DeleteEdit extends Edit {
  private readonly path: string;
  constructor(path: string) {
    super();
    this.path = path;
  }
  apply(ws: Workspace): void {
    this.guardSafe(this.path);
    if (ws.get(this.path) === null) throw new Fail('missing', this.path);
    ws.set(this.path, null);
  }
}

/** A moved file, optionally with hunks or chunks applied to its lines on the way. */
class MoveEdit extends Edit {
  private readonly from: string;
  private readonly to: string;
  private readonly style: 'none' | 'unified' | 'v4a';
  private readonly hunks: UnifiedHunk[];
  private readonly chunks: V4aChunk[];
  private readonly maxTier: number;
  constructor(from: string, to: string, style: 'none' | 'unified' | 'v4a', hunks: UnifiedHunk[], chunks: V4aChunk[], maxTier: number) {
    super();
    this.from = from;
    this.to = to;
    this.style = style;
    this.hunks = hunks;
    this.chunks = chunks;
    this.maxTier = maxTier;
  }
  apply(ws: Workspace): void {
    this.guardSafe(this.from);
    this.guardSafe(this.to);
    const before = this.requireText(ws, this.from);
    if (ws.get(this.to) !== null) throw new Fail('exists', this.to);
    let after = before;
    if (this.style !== 'none') {
      const body = FileBody.parse(before);
      if (this.style === 'unified') this.applyUnified(body, this.hunks, this.maxTier, this.from);
      else this.applyV4a(body, this.chunks, this.maxTier, this.from);
      after = body.text();
    }
    ws.set(this.from, null);
    ws.set(this.to, after);
    ws.noteMove(this.from, this.to);
  }
}

/** A changed file, in whichever line-based (or JSON text) style its reader produced. */
class ChangeEdit extends Edit {
  private readonly path: string;
  private readonly style: 'unified' | 'v4a' | 'sr' | 'json-str' | 'json-insert';
  private readonly hunks: UnifiedHunk[];
  private readonly chunks: V4aChunk[];
  private readonly oldLines: string[];
  private readonly newLines: string[];
  private readonly oldStr: string;
  private readonly newStr: string;
  private readonly insertLine: number;
  private readonly maxTier: number;
  constructor(
    path: string,
    style: 'unified' | 'v4a' | 'sr' | 'json-str' | 'json-insert',
    opts: {
      hunks?: UnifiedHunk[];
      chunks?: V4aChunk[];
      oldLines?: string[];
      newLines?: string[];
      oldStr?: string;
      newStr?: string;
      insertLine?: number;
    },
    maxTier: number,
  ) {
    super();
    this.path = path;
    this.style = style;
    this.hunks = opts.hunks ?? [];
    this.chunks = opts.chunks ?? [];
    this.oldLines = opts.oldLines ?? [];
    this.newLines = opts.newLines ?? [];
    this.oldStr = opts.oldStr ?? '';
    this.newStr = opts.newStr ?? '';
    this.insertLine = opts.insertLine ?? 0;
    this.maxTier = maxTier;
  }
  apply(ws: Workspace): void {
    this.guardSafe(this.path);
    const before = this.requireText(ws, this.path);
    if (this.style === 'json-str') {
      ws.set(this.path, this.applyJsonStrReplace(before));
      return;
    }
    if (this.style === 'json-insert') {
      ws.set(this.path, this.applyJsonInsert(before));
      return;
    }
    const body = FileBody.parse(before);
    if (this.style === 'unified') this.applyUnified(body, this.hunks, this.maxTier, this.path);
    else if (this.style === 'v4a') this.applyV4a(body, this.chunks, this.maxTier, this.path);
    else this.applySearchReplace(body, this.oldLines, this.newLines, this.maxTier, this.path);
    ws.set(this.path, body.text());
  }
  /** Section 9 str_replace: exact text, counted with overlap, CRLF files read and written with \n inside. */
  private applyJsonStrReplace(before: string): string {
    const nl = before.indexOf('\n');
    const crlf = nl > 0 && before[nl - 1] === '\r';
    const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
    const t = lf(before);
    const old = lf(this.oldStr);
    let count = 0;
    for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
    if (count === 0) throw new Fail('no-match', this.path);
    if (count > 1) throw new Fail('ambiguous', this.path);
    const at = t.indexOf(old);
    const out = t.slice(0, at) + lf(this.newStr) + t.slice(at + old.length);
    return crlf ? out.replaceAll('\n', '\r\n') : out;
  }
  /** Section 9 insert: new lines go after line `insertLine`; the file's final break stays as it was. */
  private applyJsonInsert(before: string): string {
    const body = FileBody.parse(before);
    if (this.insertLine < 0 || this.insertLine > body.lines.length) throw new Fail('no-match', this.path);
    body.lines.splice(this.insertLine, 0, ...patchLines(this.newStr));
    return body.text();
  }
}

// ============================================================================
// Banner: readers — a class per format, each producing edits
// ============================================================================

abstract class PatchReader {
  protected readonly lines: string[];
  protected readonly maxTier: number;
  constructor(lines: string[], strict: boolean) {
    this.lines = lines;
    this.maxTier = strict ? 0 : 2;
  }
  abstract read(): Edit[];
}

/** Section 6: unified diffs, read section by section, one edit per section. */
class UnifiedReader extends PatchReader {
  private pos = 0;

  read(): Edit[] {
    const edits: Edit[] = [];
    while (this.pos < this.lines.length) {
      const line = this.lines[this.pos]!;
      if (line.startsWith('diff --git ')) {
        const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
        if (m === null) throw new Exit2(`error: parse ${this.pos + 1}`);
        this.pos += 1;
        edits.push(this.readSection(m[1]!, m[2]!, null));
      } else if (line.startsWith('--- ') && (this.lines[this.pos + 1] ?? '').startsWith('+++ ')) {
        edits.push(this.readSection(null, null, this.readPair()));
      } else if (line.startsWith('@@')) {
        throw new Exit2(`error: parse ${this.pos + 1}`);
      } else {
        this.pos += 1;
      }
    }
    return edits;
  }

  /** A `--- `/`+++ ` pair at the cursor: the two paths it names, prefix-stripped, `/dev/null` kept as a marker. */
  private readPair(): { oldPath: string; newPath: string } {
    const clean = (raw: string): string => {
      const tab = raw.indexOf('\t');
      const p = (tab >= 0 ? raw.slice(0, tab) : raw).trim();
      return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
    };
    const oldPath = clean(this.lines[this.pos]!.slice(4));
    const newPath = clean(this.lines[this.pos + 1]!.slice(4));
    this.pos += 2;
    return { oldPath, newPath };
  }

  private atNextSection(): boolean {
    const line = this.lines[this.pos]!;
    return line.startsWith('diff --git ') || (line.startsWith('--- ') && (this.lines[this.pos + 1] ?? '').startsWith('+++ '));
  }

  private readSection(gitOld: string | null, gitNew: string | null, pair: { oldPath: string; newPath: string } | null): Edit {
    let renameFrom: string | null = null;
    let renameTo: string | null = null;
    let isNew = false;
    let isDeleted = false;
    // Header: everything before the first hunk. A deletion's hunks are not read at all.
    while (this.pos < this.lines.length) {
      const line = this.lines[this.pos]!;
      if (isDeleted || (pair !== null && pair.newPath === '/dev/null')) {
        // Deletion: skip to the next section start without validating anything. The section's own ---/+++
        // pair still belongs to it even when `deleted file mode` came first, so consume that pair here.
        if (line.startsWith('diff --git ')) break;
        if (pair === null && line.startsWith('--- ') && (this.lines[this.pos + 1] ?? '').startsWith('+++ ')) {
          pair = this.readPair();
          continue;
        }
        this.pos += 1;
        continue;
      }
      if (line.startsWith('diff --git ')) break;
      if (line.startsWith('--- ')) {
        if ((this.lines[this.pos + 1] ?? '').startsWith('+++ ')) {
          if (pair !== null) break;
          pair = this.readPair();
          continue;
        }
        throw new Exit2(`error: parse ${this.pos + 2}`);
      }
      if (line.startsWith('@@')) break;
      if (line.startsWith('rename from ')) renameFrom = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) renameTo = line.slice('rename to '.length);
      else if (line.startsWith('new file mode')) isNew = true;
      else if (line.startsWith('deleted file mode')) isDeleted = true;
      this.pos += 1;
    }
    const oldPath = pair !== null ? pair.oldPath : (renameFrom ?? gitOld ?? gitNew ?? '');
    const newPath = pair !== null ? pair.newPath : (renameTo ?? gitNew ?? gitOld ?? '');
    if (isDeleted || newPath === '/dev/null') return new DeleteEdit(oldPath);
    const hunks = this.readHunks();
    if (isNew || oldPath === '/dev/null') {
      const fileLines: string[] = [];
      let lastAdd: BodyItem | null = null;
      for (const hunk of hunks) {
        for (const it of hunk.items) {
          if (it.kind === 'add') {
            fileLines.push(it.text);
            lastAdd = it;
          }
        }
      }
      return new CreateEdit(newPath, fileLines, lastAdd === null ? true : !lastAdd.noEol);
    }
    if (oldPath !== newPath) return new MoveEdit(oldPath, newPath, 'unified', hunks, [], this.maxTier);
    return new ChangeEdit(newPath, 'unified', { hunks }, this.maxTier);
  }

  private readHunks(): UnifiedHunk[] {
    const hunks: UnifiedHunk[] = [];
    while (this.pos < this.lines.length) {
      const line = this.lines[this.pos]!;
      if (line.startsWith('diff --git ') || (line.startsWith('--- ') && (this.lines[this.pos + 1] ?? '').startsWith('+++ '))) break;
      if (!line.startsWith('@@')) {
        this.pos += 1;
        continue;
      }
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:\s.*)?$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${this.pos + 1}`);
      const aStart = Number.parseInt(m[1]!, 10);
      this.pos += 1;
      const items: BodyItem[] = [];
      while (this.pos < this.lines.length) {
        const bl = this.lines[this.pos]!;
        if (bl.startsWith('diff --git ') || (bl.startsWith('--- ') && (this.lines[this.pos + 1] ?? '').startsWith('+++ '))) break;
        const c = bl[0];
        if (bl === '') items.push({ kind: 'ctx', text: '', noEol: false, fromEmpty: true });
        else if (c === ' ') items.push({ kind: 'ctx', text: bl.slice(1), noEol: false, fromEmpty: false });
        else if (c === '-') items.push({ kind: 'del', text: bl.slice(1), noEol: false, fromEmpty: false });
        else if (c === '+') items.push({ kind: 'add', text: bl.slice(1), noEol: false, fromEmpty: false });
        else if (c === '\\') {
          if (items.length > 0) items[items.length - 1]!.noEol = true;
        } else break;
        this.pos += 1;
      }
      while (items.length > 0 && items[items.length - 1]!.fromEmpty) items.pop();
      hunks.push({ aStart, items });
    }
    return hunks;
  }
}

/** Section 7: SEARCH/REPLACE blocks, one edit per block. */
class SearchReplaceReader extends PatchReader {
  read(): Edit[] {
    const edits: Edit[] = [];
    let prevEnd = -1;
    let prevPath: string | null = null;
    let i = 0;
    while (i < this.lines.length) {
      if (this.lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
        i += 1;
        continue;
      }
      const searchLine = i;
      let path: string | null = null;
      for (let k = searchLine - 1; k > prevEnd; k -= 1) {
        const cand = this.lines[k]!;
        if (isBlank(cand)) continue;
        if (cand.trim().startsWith('```')) continue;
        path = cand.trim();
        break;
      }
      if (path === null) path = prevPath;
      if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      let eq = -1;
      for (let k = searchLine + 1; k < this.lines.length; k += 1) {
        if (this.lines[k]!.trimEnd() === '=======') {
          eq = k;
          break;
        }
      }
      let rep = -1;
      if (eq >= 0) {
        for (let k = eq + 1; k < this.lines.length; k += 1) {
          if (this.lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
            rep = k;
            break;
          }
        }
      }
      if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
      const oldLines = this.lines.slice(searchLine + 1, eq);
      const newLines = this.lines.slice(eq + 1, rep);
      if (oldLines.length === 0) edits.push(new CreateEdit(path, newLines, true));
      else edits.push(new ChangeEdit(path, 'sr', { oldLines, newLines }, this.maxTier));
      prevPath = path;
      prevEnd = rep;
      i = rep + 1;
    }
    return edits;
  }
}

/** Section 8: V4A patches, one edit per Add/Delete/Update section. */
class V4aReader extends PatchReader {
  private pos = 0;
  private end = 0;

  read(): Edit[] {
    const first = this.lines.findIndex((l) => !isBlank(l));
    if (first < 0) throw new Exit2('error: parse 1');
    if (this.lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
    let last = this.lines.length - 1;
    while (last > first && isBlank(this.lines[last]!)) last -= 1;
    if (this.lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${this.lines.length + 1}`);
    this.pos = first + 1;
    this.end = last;
    const edits: Edit[] = [];
    while (this.pos < this.end) {
      const line = this.lines[this.pos]!;
      if (isBlank(line)) {
        this.pos += 1;
      } else if (line.startsWith('*** Add File: ')) {
        edits.push(this.readAdd(line));
      } else if (line.startsWith('*** Delete File: ')) {
        edits.push(this.readDelete(line));
      } else if (line.startsWith('*** Update File: ')) {
        edits.push(this.readUpdate(line));
      } else {
        throw new Exit2(`error: parse ${this.pos + 1}`);
      }
    }
    return edits;
  }

  private atSectionStart(): boolean {
    const line = this.lines[this.pos]!;
    return line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');
  }

  private readAdd(header: string): Edit {
    const path = header.slice('*** Add File: '.length).trim();
    this.pos += 1;
    const fileLines: string[] = [];
    const fromEmpty: boolean[] = [];
    while (this.pos < this.end && !this.atSectionStart()) {
      const line = this.lines[this.pos]!;
      if (line.startsWith('+')) {
        fileLines.push(line.slice(1));
        fromEmpty.push(false);
      } else if (line === '') {
        fileLines.push('');
        fromEmpty.push(true);
      } else {
        throw new Exit2(`error: parse ${this.pos + 1}`);
      }
      this.pos += 1;
    }
    while (fileLines.length > 0 && fromEmpty[fromEmpty.length - 1]) {
      fileLines.pop();
      fromEmpty.pop();
    }
    return new CreateEdit(path, fileLines, true);
  }

  private readDelete(header: string): Edit {
    const path = header.slice('*** Delete File: '.length).trim();
    this.pos += 1;
    while (this.pos < this.end && !this.atSectionStart()) {
      if (!isBlank(this.lines[this.pos]!)) throw new Exit2(`error: parse ${this.pos + 1}`);
      this.pos += 1;
    }
    return new DeleteEdit(path);
  }

  private readUpdate(header: string): Edit {
    const headerLine = this.pos + 1;
    const path = header.slice('*** Update File: '.length).trim();
    this.pos += 1;
    let moveTo: string | null = null;
    if (this.pos < this.end && this.lines[this.pos]!.startsWith('*** Move to: ')) {
      moveTo = this.lines[this.pos]!.slice('*** Move to: '.length).trim();
      this.pos += 1;
    }
    const chunks: V4aChunk[] = [];
    let current: V4aChunk | null = null;
    let closedByEof = false;
    while (this.pos < this.end && !this.atSectionStart()) {
      const line = this.lines[this.pos]!;
      if (line.startsWith('@@')) {
        current = { anchor: line.slice(2).trim() === '' ? null : line.slice(2).trim(), eof: false, items: [] };
        chunks.push(current);
        closedByEof = false;
      } else if (line.trim() === '*** End of File') {
        if (current === null) {
          current = { anchor: null, eof: true, items: [] };
          chunks.push(current);
        } else {
          current.eof = true;
        }
        current = null;
        closedByEof = true;
      } else if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
        if (current === null) {
          if (chunks.length > 0 || closedByEof) throw new Exit2(`error: parse ${this.pos + 1}`);
          current = { anchor: null, eof: false, items: [] };
          chunks.push(current);
        }
        // A whitespace-only line is a context line with empty text, but it is also a blank line: at the end
        // of a section blank lines are not part of it, so tag it droppable like an empty line.
        if (line === '') current.items.push({ kind: 'ctx', text: '', noEol: false, fromEmpty: true });
        else if (line[0] === ' ') current.items.push({ kind: 'ctx', text: line.slice(1), noEol: false, fromEmpty: line.trim() === '' });
        else if (line[0] === '-') current.items.push({ kind: 'del', text: line.slice(1), noEol: false, fromEmpty: false });
        else current.items.push({ kind: 'add', text: line.slice(1), noEol: false, fromEmpty: false });
      } else {
        throw new Exit2(`error: parse ${this.pos + 1}`);
      }
      this.pos += 1;
    }
    if (chunks.length > 0) {
      const lastItems = chunks[chunks.length - 1]!.items;
      while (lastItems.length > 0 && lastItems[lastItems.length - 1]!.fromEmpty) lastItems.pop();
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
    if (moveTo !== null) return new MoveEdit(path, moveTo, chunks.length > 0 ? 'v4a' : 'none', [], chunks, this.maxTier);
    return new ChangeEdit(path, 'v4a', { chunks }, this.maxTier);
  }
}

/** Section 9: JSON edits, either one array of edit objects or JSON Lines. */
class JsonReader extends PatchReader {
  private readonly text: string;
  constructor(text: string, lines: string[], strict: boolean) {
    super(lines, strict);
    this.text = text;
  }

  read(): Edit[] {
    const first = this.lines.findIndex((l) => !isBlank(l));
    if (first < 0) throw new Exit2('error: parse 1');
    const edits: Edit[] = [];
    if (this.lines[first]!.trimStart().startsWith('[')) {
      let v: unknown;
      try {
        v = JSON.parse(this.text);
      } catch {
        throw new Exit2(`error: parse ${first + 1}`);
      }
      if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
      for (const x of v) {
        const e = this.oneEdit(x);
        if (e === null) throw new Exit2(`error: parse ${first + 1}`);
        edits.push(e);
      }
      return edits;
    }
    this.lines.forEach((l, i) => {
      if (isBlank(l)) return;
      let e: Edit | null = null;
      try {
        e = this.oneEdit(JSON.parse(l));
      } catch {
        e = null;
      }
      if (e === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(e);
    });
    return edits;
  }

  /** One JSON edit object, or null when it is not one: a wrong command, or a missing or mistyped key. */
  private oneEdit(v: unknown): Edit | null {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    const p = o.path;
    if (typeof p !== 'string') return null;
    if (o.command === 'create' && typeof o.file_text === 'string') {
      return new CreateEdit(p, [], true, o.file_text);
    }
    if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
      return new ChangeEdit(p, 'json-str', { oldStr: o.old_str, newStr: (o.new_str as string | undefined) ?? '' }, this.maxTier);
    }
    if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
      return new ChangeEdit(p, 'json-insert', { insertLine: o.insert_line, newStr: o.new_str }, this.maxTier);
    }
    return null;
  }
}

// ============================================================================
// Banner: the command line (sections 1, 2, 4 and 10)
// ============================================================================

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Section 4: the first of the four tests that holds, in the spec's order. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    const reader: PatchReader =
      kind === 'unified'
        ? new UnifiedReader(lines, strict)
        : kind === 'search-replace'
          ? new SearchReplaceReader(lines, strict)
          : kind === 'v4a'
            ? new V4aReader(lines, strict)
            : new JsonReader(text, lines, strict);
    edits = reader.read();
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const ws = new Workspace();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const snap = ws.snapshot();
    try {
      edit.apply(ws);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      ws.restore(snap);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  // The report: one line per changed path, byte order; a qualifying move pair becomes one R line sorted by
  // its new path, and counts as one file.
  const changed = ws.changedPaths();
  const changedSet = new Set(changed);
  const used = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const mv of ws.moves) {
    if (used.has(mv.from) || used.has(mv.to)) continue;
    if (!changedSet.has(mv.from) || !changedSet.has(mv.to)) continue;
    if (ws.original(mv.from) === null || ws.get(mv.from) !== null) continue;
    if (ws.original(mv.to) !== null || ws.get(mv.to) === null) continue;
    rows.push({ key: mv.to, line: `R ${mv.from} -> ${mv.to}` });
    used.add(mv.from);
    used.add(mv.to);
  }
  for (const p of changed) {
    if (used.has(p)) continue;
    const was = ws.original(p);
    const now = ws.get(p);
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCompare(a.key, b.key));
  if (!check) {
    for (const p of changed) {
      const now = ws.get(p);
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
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


