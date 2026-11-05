import fs from 'node:fs';
import path from 'node:path';

// cmd.exe metacharacters, caret-escaped the way cross-spawn does it. Quotes are
// caret-escaped too, so cmd.exe never sees a quoted region and every caret applies.
//
// Beyond ASCII space, cmd.exe's command-name parser treats a run of Unicode "space
// separator" code points (U+00A0, U+1680, U+2000-U+200A, U+202F, U+205F, U+3000), the two
// Unicode line separators (U+2028, U+2029), NEL (U+0085) and the Mongolian vowel separator
// (U+180E) as delimiters too (measured on real cmd.exe): an unescaped one ends the
// name early, so 'C:\x\a<NBSP>b\tool.cmd' resolves only as far as 'C:\x\a' and can run a
// sibling 'a.exe'. A caret before each of them, same as ASCII space, keeps the name whole.
// Built via fromCodePoint/RegExp instead of literal \uXXXX escapes so each code point is an
// unambiguous number on the page rather than text that something upstream could mangle.
const WIDE_CMD_WS = [0x00A0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
  0x2007, 0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0x0085, 0x180E]
  .map((c) => String.fromCodePoint(c)).join('');
const META = new RegExp(`([()\\][%!^"\`<>&|;, *?${WIDE_CMD_WS}])`, 'g');

/**
 * Neutralise cmd.exe phase-1 percent expansion. Phase 1 runs before caret and quote
 * processing, so '^%' does not stop it: '^%EVIL:zz=q^%' still expands EVIL, with the caret
 * landing only in the replacement text. Breaking the name ('%^EVIL%') is not enough either:
 * the characters we could later remove (^ and ") are both legal in a variable name.
 *
 * Phase 1 in command-line context (verified on real cmd.exe): at a '%' it takes the text up
 * to the next '%' as a name; an undefined name keeps the first '%' and resumes AT the closing
 * '%'; a defined one is replaced and scanning resumes after it. So each literal '%' is
 * emitted as '%' + '%cd:~,%':
 *   - '%%' has an empty name, which no environment can define: the first '%' stays literal;
 *   - '%cd:~,%' is a zero-length substring of CD, which is always defined (dynamic, or an env
 *     override) whatever its value: it expands to nothing and consumes both of its '%'.
 * Every '%' in the line is then consumed locally, so no argument text ever sits between two
 * '%' as a candidate name, whatever %...% form the argument spells (%X:a=b%, %X:~n%, %=C:%,
 * %*, %~0, names with ^ or "). This needs command extensions (cmd's default, and what npm's
 * %~dp0 shims need anyway); winShell passes /e:on so the registry cannot turn them off.
 */
const PCT_SAFE = '%%cd:~,%';
const noPct = (s) => s.replaceAll('%', PCT_SAFE);

/**
 * Quote one argument for `cmd.exe /d /s /c "..."` + the MSVCRT argv parser.
 * batch: the target is a .cmd/.bat shim, whose %* re-parses the line, so escape twice.
 * The percent guard is applied once: %* is substituted, not percent-rescanned.
 */
export function quoteWinArg(arg, batch = false) {
  let s = `${arg}`;
  s = s.replace(/(\\*)"/g, '$1$1\\"');   // backslashes before a quote double; the quote is escaped
  s = s.replace(/(\\*)$/, '$1$1');        // trailing backslashes double (they precede the closing quote)
  s = `"${s}"`.replace(META, '^$1');
  return noPct(batch ? s.replace(META, '^$1') : s);
}

/** Thrown by winCommandLine for argv that cmd.exe cannot carry faithfully. */
export class WinArgError extends Error {
  constructor(code, message) { super(message); this.name = 'WinArgError'; this.code = code; }
}

const unquote = (d) => d.trim().replace(/^"(.*)"$/, '$1');
const isNative = (f) => /\.(exe|com)$/i.test(f);

/**
 * Does `cmd` need batch (double) escaping? True for a .cmd/.bat shim, whose %* re-parses
 * the line.
 *
 * Tradeoff when unsure: single-escaping a .cmd target is command injection (the shim's %*
 * re-parse sees bare metacharacters), while double-escaping a .exe only leaves literal
 * carets in its args (data corruption, not injection). So only a command that positively
 * resolves to a .exe/.com gets single escaping; anything unresolved or of another type
 * (.cmd, .bat, .js, .ps1, ...) is treated as batch.
 */
// App Execution Aliases (WindowsApps\winget.exe, python.exe, wt.exe) are reparse points:
// existsSync is false and statSync fails with EACCES, but lstat succeeds. Count them as found,
// or an alias .exe falls through to batch escaping and receives stray carets.
export function present(f) { try { fs.lstatSync(f); return true; } catch { return false; } }

export function isWinBatch(cmd, env = process.env, exists = present) {
  const exts = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim()).filter(Boolean);
  // 'python3.11' has extname '.11': only a PATHEXT extension counts as explicit.
  const ext = path.win32.extname(cmd).toLowerCase();
  if (ext && exts.some((e) => e.toLowerCase() === ext)) return !isNative(cmd);
  const dirs = /[\\/]/.test(cmd) ? [''] : ['.', ...(env.PATH || env.Path || '').split(';').map(unquote).filter(Boolean)];
  for (const d of dirs) for (const e of exts) {
    // PATHEXT is upper-case but a case-sensitive dir may hold 'codex.cmd': try both.
    for (const v of new Set([e, e.toLowerCase()])) {
      const f = d ? path.win32.join(d, cmd + v) : cmd + v;
      if (exists(f)) return !isNative(f);
    }
  }
  return true;
}

/**
 * The executable token for `cmd.exe /d /s /c "..."` (Node adds that wrapper for shell: true;
 * /s strips only its outer quotes, so a line that starts with a quote is safe).
 *
 * Default: the caret form, as before. Measured on real cmd.exe, it fails in two cases, and only
 * those get quoted:
 *  - a native .exe/.com whose path holds whitespace or '=': cmd.exe finds the program but hands
 *    CreateProcess the unquoted path, so the child splits its own argv
 *    ('C:\Program Files\nodejs\node.exe' ran ...\Files\nodejs\node.exe as a script);
 *  - any target whose path holds '=': cmd.exe ends the command name there even when escaped.
 * A batch shim in a spaced dir already works in the caret form, %~dp0 included.
 *
 * Quoting is whole-token only. Quote toggles inside the name would land in a batch file's %0 and
 * corrupt %~dp0. Inside quotes, %VAR% still expands, and !VAR! does too under delayed expansion,
 * so a path that needs quoting and also holds '%' or '!' is refused as
 * WinArgError('percent-in-path'); no form keeps it both literal and intact.
 * The caret form gets the same '%' guard as arguments (PCT_SAFE): phase 1 then yields exactly
 * the old caret form (so %0 and %~dp0 are unchanged), and no '%' in the name can pair with
 * a '%' in the arguments.
 * Bare names ('codex') never need quoting, and must not be quoted: a quoted, PATH-searched batch
 * file sees a wrong %~dp0, which would break npm shims.
 *
 * Two or more consecutive ';' in the command name are collapsed by cmd.exe to a single ';'
 * while it parses the name, quoted or not (measured on real cmd.exe): a path containing
 * '...;;...' or '...;;;...' runs whatever sits at '...;...' instead, and no escaping (caret or
 * a whole-token quote) changes that, so it is refused outright as WinArgError('semicolons-in-path').
 * Other doubled separator-like characters measured alongside it do NOT collapse: ',,', '==',
 * ';,', ',;' and '..' each run their own, literal path, so only runs of ';' are refused.
 *
 * A '/' in a RELATIVE command path is read as a switch, not a separator (measured on real
 * cmd.exe): 'sub/tool.cmd' runs 'sub.com' (or '.bat') from PATHEXT resolution of 'sub', never
 * 'sub\tool.cmd'. An absolute (drive-letter or UNC) path with '/' is unaffected either way, so
 * '/' is normalised to '\' unconditionally before anything else below runs - as cross-spawn
 * does for argv[0] - rather than only for the relative case.
 *
 * Win32 path resolution also strips a trailing '.' or ' ' from every backslash-separated
 * component other than '.'/'..' (even through a '\\.\' device-namespace prefix), and that
 * stripping happens underneath cmd.exe too (measured): 'a.\tool.cmd' and 'a \tool.cmd'
 * both run the sibling 'a\tool.cmd', quoted or not, the same way ';;' does. '\\?\' skips the
 * stripping but cmd.exe cannot resolve a '\\?\' path at all ('the system cannot find the path
 * specified', measured). Both are refused outright: WinArgError('device-path') for a '\\.\' or
 * '\\?\' prefix, WinArgError('trailing-dot-or-space') for any other component ending in '.' or
 * ' ' (including the final component, even where today it happens to resolve to itself).
 */
const hasTrailingDotOrSpace = (s) => s.split('\\').some((part) => part !== '' && part !== '.' && part !== '..' && /[. ]$/.test(part));
const isDevicePath = (s) => /^\\\\[.?]\\/.test(s);

const DELIM = new RegExp(`[\\s;,${WIDE_CMD_WS}]`);

export function winExe(exe, batch = true, cwd = process.cwd()) {
  let s = `${exe}`.replace(/\//g, '\\');
  if (s.includes('"')) throw new WinArgError('quote', 'the command contains a double quote, which no Windows path can hold and cmd.exe cannot carry in a command name');
  const check = () => {
    if (isDevicePath(s)) throw new WinArgError('device-path', `the command path ${s} uses a '\\\\.\\' or '\\\\?\\' device-namespace prefix: cmd.exe cannot run a '\\\\?\\' path at all, and '\\\\.\\' still has Win32's trailing-dot/space stripping underneath it, so a different, sibling path could run instead; launch the plain drive-letter or UNC path`);
    if (hasTrailingDotOrSpace(s)) throw new WinArgError('trailing-dot-or-space', `the command path ${s} has a directory or file name ending in '.' or a space, which Win32 silently strips when resolving the path, so a different, sibling path could run instead; rename it without the trailing '.' or space`);
    if (/;;/.test(s)) throw new WinArgError('semicolons-in-path', `the command path ${s} contains two or more consecutive semicolons, which cmd.exe collapses to a single ';' while parsing the command name (quoted or not), so it could run a different, sibling path instead; rename the directory or executable so no run of ';' repeats`);
  };
  check();
  if (!/^[A-Za-z]:/.test(s) && !s.startsWith('\\\\')) {
    if (s.includes('\\')) {
      s = path.win32.resolve(cwd, s);
      check();   // the resolved path (cwd included) gets the same refusals
    } else if (DELIM.test(s)) {
      throw new WinArgError('delimiter-in-name', `the command name ${s} contains whitespace, ';' or ',', which cmd.exe treats as a delimiter in a bare (PATH-searched) command name, so it could run a different, sibling program instead; quoting it would break %~dp0 for PATH-found shims, so launch it by its full path or rename it`);
    }
  }
  // A UNC path is cut at a caret-escaped delimiter just like a relative one (measured);
  // a whole-token quote carries it intact, and being a full path leaves %~dp0 unaffected.
  const uncDelim = s.startsWith('\\\\') && DELIM.test(s);
  if (!uncDelim && !(batch ? /=/ : /[\s=]/).test(s)) return noPct(s.replace(META, '^$1'));
  if (/[%!]/.test(s)) throw new WinArgError('percent-in-path', `the command path ${s} must be quoted for cmd.exe (it contains ${uncDelim ? 'a delimiter (whitespace, \';\' or \',\') in a UNC path' : batch ? "'='" : "whitespace or '='"}), but it also contains % or !, which cmd.exe would expand inside quotes; launch it from a path without % or !`);
  return `"${s}"`;
}

/**
 * [file, args] that run a winCommandLine line as spawn(line, { shell: true }) would
 * (cmd.exe /d /s /c "line"; spawn it with windowsVerbatimArguments: true), plus /e:on and
 * /v:off so the registry cannot change how the line parses: the percent guard needs command
 * extensions, and under delayed expansion a literal !X! in an argument would expand.
 */
export function winShell(line, env = process.env) {
  return [env.ComSpec || 'cmd.exe', ['/d', '/e:on', '/v:off', '/s', '/c', `"${line}"`]];
}

/**
 * One command line for cmd.exe on win32; run it with winShell (or spawn(line, { shell: true })).
 * A RELATIVE command path (not drive-prefixed, not UNC, holding a backslash) is resolved
 * against `cwd` (the child's cwd; bin/iac-launch.js sets none, so it is process.cwd()) before
 * escaping (measured on real cmd.exe): cmd.exe cuts a relative name at a caret-escaped
 * delimiter ('my dir\\tool.cmd' ran a sibling 'my.bat'; ';', ',' and Unicode spaces likewise),
 * whereas the absolute form is carried whole. A bare name with such a delimiter is refused as
 * WinArgError('delimiter-in-name'): quoting it would break %~dp0 for PATH-found shims.
 * Throws WinArgError('newline') for CR/LF in any argument: cmd.exe silently drops everything
 * after a line break, and no escaping survives it.
 */
export function winCommandLine(cmd, { env = process.env, exists = present, cwd = process.cwd() } = {}) {
  const bad = cmd.findIndex((a) => /[\r\n]/.test(`${a}`));
  if (bad !== -1) throw new WinArgError('newline', `argument ${bad} contains a line break, which cmd.exe would silently truncate; pass multi-line text via a file or stdin instead`);
  const batch = isWinBatch(cmd[0], env, exists);
  return [winExe(cmd[0], batch, cwd), ...cmd.slice(1).map((a) => quoteWinArg(a, batch))].join(' ');
}
