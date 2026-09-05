/**
 * Adapter-facing helpers for turning a shell command (or an already-resolved
 * file argument) into an absolute path: tier B evidence for attribution.ts,
 * and general path resolution for every adapter's edits.ts. Imports nothing
 * from agents/ or attribution.ts, so nothing here can be part of a cycle.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * `parseShellWrites` parses POSIX shell command TEXT, not a real filesystem
 * path - the command string an agent ran, which uses `/` regardless of the
 * host platform (an agent's Bash tool runs through a POSIX-shaped shell even
 * on Windows, via Git for Windows' own `sh`). Every path operation on that
 * text - `cd`/`pushd` tracking, redirect targets, `dirname`/`join`/`resolve`/
 * `isAbsolute` - therefore uses `path.posix`, so the result is always
 * forward-slash text and never depends on the host's own separator. Real
 * filesystem paths (an already-resolved tool argument, `locateFile`'s cwd)
 * are a separate concern, handled below with the real `path` module.
 */
const posix = path.posix;

// ------------------------------------------------------- tier B: shell writes

const SHELL_SPLIT = /(?:\|\||&&|[;\n|])/;
const NOT_A_FILE = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty', '-']);

function unquote(s: string | undefined): string {
  let v = String(s ?? '').trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v.replace(/\\ /g, ' ');
}

/** Split a segment into shell-ish words, keeping quoted runs together. */
function words(segment: string): string[] {
  const out: string[] = [];
  const re = /"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
  while ((m = re.exec(segment)) !== null) out.push(m[0]);
  return out;
}

function plausiblePath(p: string | undefined): string | null {
  const raw = String(p ?? '').trim();
  if (raw.startsWith('<') || raw.startsWith('>')) return null; // a redirect, not a path
  const v = unquote(raw);
  if (!v || NOT_A_FILE.has(v)) return null;
  if (v.startsWith('-')) return null;
  if (/^\$/.test(v)) return null; // unexpanded variable
  if (/[*?]/.test(v)) return null; // unexpanded glob: no single target
  if (/^&\d*$/.test(v)) return null; // `>&2`
  return v;
}

/**
 * Paths a shell command can be shown to write, tier B of PLAN §3.2. A
 * heuristic by construction: recorded with `confidence: 'shell'`, never
 * presented as hunk-level evidence.
 *
 * Handles `>`/`>>` redirects (including `cat > f <<'EOF'` heredocs, which are
 * just a redirect), `tee [-a]`, `sed -i`, `mv`, `cp` (destination only),
 * `git apply` and `patch`.
 *
 * `cd` (and `pushd`/`popd`) are tracked across the command, because an agent
 * routinely writes `cd /path/to/repo; echo x >> notes.txt` and the relative
 * path in the second half means nothing against the tool's starting
 * directory. A `cd` we cannot resolve (`$VAR`, `cd -`) marks the directory
 * UNKNOWN and every later relative path is dropped rather than guessed at.
 */
const UNKNOWN_DIR = Symbol('unknown cwd');
type Dir = string | null | typeof UNKNOWN_DIR;

/** `os.homedir()` as forward-slash text: the tracked `dir` is always POSIX
 * text (see the module-level comment above `posix`), even when the real
 * home directory is a Windows path. */
function homeForwardSlash(): string {
  return os.homedir().replace(/\\/g, '/');
}

/** Where a `cd`/`pushd` argument points, relative to `dir`. */
function resolveCd(dir: Dir, rawArg: string | undefined): Dir {
  if (rawArg == null) return homeForwardSlash(); // bare `cd` goes home
  const arg = unquote(rawArg);
  if (!arg || arg === '-') return UNKNOWN_DIR; // `cd -`: the previous dir
  if (/\$|`/.test(arg)) return UNKNOWN_DIR; // unexpanded variable
  if (arg === '~') return homeForwardSlash();
  if (arg.startsWith('~/')) return posix.join(homeForwardSlash(), arg.slice(2));
  if (posix.isAbsolute(arg)) return arg;
  if (dir === UNKNOWN_DIR) return UNKNOWN_DIR;
  // Still relative: keep it relative to wherever the caller resolves from.
  return dir == null ? arg : posix.join(dir, arg);
}

/**
 * Remove heredoc BODIES from a command string, keeping the line that opens
 * them (so `cat > notes.md <<'EOF'` still counts as a write to notes.md).
 *
 * The body is data, not script. Left in place it is split on newlines like
 * everything else and parsed as commands, so a document that happens to
 * contain `cd /somewhere` or `foo > bar` invents writes that never happened -
 * and worse, moves the tracked directory for the real commands after it.
 */
export function stripHeredocBodies(text: string | null | undefined): string {
  const lines = String(text ?? '').split('\n');
  const out: string[] = [];
  const opener = /<<([-~]?)\s*("[^"]*"|'[^']*'|\\?[A-Za-z_][A-Za-z0-9_]*)/g;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    out.push(line);
    const markers: Array<{ marker: string; dash: boolean }> = [];
    let m: RegExpExecArray | null;
    opener.lastIndex = 0;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
    while ((m = opener.exec(line)) !== null) {
      markers.push({ marker: unquote(m[2]).replace(/^\\/, ''), dash: m[1] === '-' });
    }
    if (!markers.length) continue;
    // Skip to (and including) each marker's terminator, in order.
    for (const { marker, dash } of markers) {
      let j = i + 1;
      while (j < lines.length) {
        const candidate = dash ? (lines[j] ?? '').replace(/^[\t ]+/, '') : (lines[j] ?? '');
        if (candidate.replace(/\s+$/, '') === marker) break;
        j += 1;
      }
      i = Math.min(j, lines.length - 1);
      if (j >= lines.length) i = lines.length; // unterminated: the rest is body
    }
  }
  return out.join('\n');
}

export function parseShellWrites(command: string | null | undefined): string[] {
  const cmd = stripHeredocBodies(command);
  const found: string[] = [];
  // null = the tool's own starting directory, which the caller resolves.
  let dir: Dir = null;
  const stack: Dir[] = [];
  const add = (p: string | undefined) => {
    const v = plausiblePath(p);
    if (!v) return;
    if (posix.isAbsolute(v)) {
      if (!found.includes(v)) found.push(v);
      return;
    }
    if (dir === UNKNOWN_DIR) return; // we cannot say where this landed
    const full = dir == null ? v : posix.join(dir, v);
    if (!found.includes(full)) found.push(full);
  };

  for (const rawSegment of cmd.split(SHELL_SPLIT)) {
    // A heredoc (`cat > f <<'EOF'`) is just a redirect as far as we are
    // concerned; the `<<MARKER` token itself is not a path, and neither is
    // anything an input redirect names.
    const segment = rawSegment
      .replace(/<<[-~]?\s*(?:"[^"]*"|'[^']*'|\\?\w+)/g, ' ')
      .replace(/(?:^|\s)<\s*("[^"]*"|'[^']*'|[^\s;|&<>()]+)/g, ' ')
      .trim();
    if (!segment) continue;

    // Redirects: `> f`, `>> f`, `1> f`. Never `2>&1`, `>&2` or `<`.
    const redir = /(?:^|[\s;)])(?:\d*)>>?\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^\s;|&<>()]+)/g;
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
    while ((m = redir.exec(segment)) !== null) add(m[1]);

    const w = words(segment);
    if (!w.length) continue;
    // Skip env assignments and a `sudo`/`command`/`time` prefix.
    let i = 0;
    while (i < w.length) {
      const word = w[i] as string;
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) &&
        !['sudo', 'command', 'time', 'nohup', 'exec'].includes(word)
      )
        break;
      i += 1;
    }
    if (i >= w.length) continue;
    const argv = w.slice(i);
    const cmd0 = posix.basename(unquote(argv[0]));
    const rest = argv.slice(1);
    const positional = rest.filter((a) => !a.startsWith('-'));

    if (cmd0 === 'cd' || cmd0 === 'pushd') {
      if (cmd0 === 'pushd') stack.push(dir);
      // `rest`, not `positional`: `cd -` must be SEEN (and give up), not
      // filtered away as a flag and mistaken for a bare `cd` to $HOME.
      dir = resolveCd(dir, rest.length ? rest[0] : undefined);
      continue;
    }
    if (cmd0 === 'popd') {
      dir = stack.length ? (stack.pop() as Dir) : UNKNOWN_DIR;
      continue;
    }

    if (cmd0 === 'tee') {
      for (const a of positional) add(a);
    } else if (cmd0 === 'sed') {
      // Only `-i` rewrites in place. `-i.bak` and BSD's `-i ''` both count.
      if (rest.some((a) => a === '-i' || /^-i\S*$/.test(a) || /^-[a-zA-Z]*i[a-zA-Z]*$/.test(a))) {
        // The first real argument is the script (`s/a/b/`), which is not a
        // path however much it looks like one; BSD's empty `-i ''` suffix
        // drops out on its own. Everything after the script is a file.
        const args = positional.filter((a) => plausiblePath(a));
        for (const a of args.slice(1)) add(a);
      }
    } else if (cmd0 === 'mv' || cmd0 === 'cp' || cmd0 === 'install' || cmd0 === 'rsync') {
      if (positional.length >= 2) add(positional[positional.length - 1]);
    } else if (cmd0 === 'patch') {
      for (const a of positional) add(a);
    } else if (cmd0 === 'git' && positional[0] === 'apply') {
      // `git apply f.patch` writes whatever the patch names, which the command
      // line does not say. The patch file itself is the only path we can see,
      // and it is not what changed - so record nothing rather than a lie.
      // (A `git apply` with no file reads stdin: also nothing to say.)
    } else if (cmd0 === 'truncate' || cmd0 === 'touch') {
      for (const a of positional) add(a);
    }
  }
  return found;
}

// --------------------------------------------------------------- file paths

function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** realpath of the longest existing prefix, with the rest appended. */
function realpathish(p: string): string {
  let dir = p;
  const tail: string[] = [];
  for (let i = 0; i < 40; i += 1) {
    if (fs.existsSync(dir)) return path.join(realpathSafe(dir), ...tail.reverse());
    const parent = path.dirname(dir);
    if (parent === dir) return p;
    tail.push(path.basename(dir));
    dir = parent;
  }
  return p;
}

/**
 * `abs` as a repo-relative, forward-slash path, or null when it is outside
 * `root`.
 *
 * Compared through `realpath` on the way out, because an agent records the cwd
 * it was given while git reports the resolved one: on macOS a session in
 * `/var/folders/...` and a repo root of `/private/var/folders/...` are the same
 * directory, and a plain `path.relative` would call every edit foreign.
 */
export function relativeTo(root: string | null | undefined, abs: string): string | null {
  if (!root) return null;
  const inside = (rel: string) => rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  const direct = path.relative(root, abs);
  if (inside(direct)) return direct.split(path.sep).join('/');
  const alt = path.relative(realpathSafe(root), realpathish(abs));
  if (inside(alt)) return alt.split(path.sep).join('/');
  return null;
}

export interface LocatedFile {
  file: string;
  rel: string | null;
}

/**
 * Absolute path (resolved against the session's cwd) plus `rel`.
 *
 * `file` and `cwd` are POSIX text like everything else in this module (a
 * transcript's recorded paths are forward-slash, whatever the host), so the
 * combination uses `path.posix` and the result stays forward-slash. The one
 * place a platform path enters is `relativeTo`'s `realpath` fallback below,
 * which asks the real filesystem whether `abs` exists under the real repo
 * root - and folds its answer straight back into forward-slash `rel`.
 */
export function locateFile(
  file: string | null | undefined,
  { cwd, root }: { cwd?: string | null; root?: string | null },
): LocatedFile | null {
  let abs = String(file ?? '');
  if (!abs) return null;
  if (!path.posix.isAbsolute(abs)) abs = path.posix.resolve(cwd || process.cwd(), abs);
  return { file: abs, rel: relativeTo(root, abs) };
}
