import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const SCAN_CHUNK = 64 * 1024;
const MAX_RECORD = 256 * 1024;
export const MAX_SCAN = 64 * 1024 * 1024;

/**
 * THREAD is the current task; SESSION is the root session that spawned it. Only THREAD names
 * the task. A child task inherits the root's SESSION, so a SESSION with no THREAD cannot tell
 * the root task from any of its children: it is never used as a task id.
 */
export function codexTaskId(env = process.env) { return env.CODEX_THREAD_ID || null; }

/** Any Codex id at all: the process runs under Codex, whether or not its task can be named. */
export function codexPresent(env = process.env) { return !!(env.CODEX_THREAD_ID || env.CODEX_SESSION_ID); }

/** Codex exposed the root session id but no task id. Fails closed: never attests or writes. */
export function codexRootOnly(env = process.env) { return !!(env.CODEX_SESSION_ID && !env.CODEX_THREAD_ID); }

export const CODEX_ROOT_ONLY_REASON = 'Codex exposed only the root session id (CODEX_SESSION_ID, no CODEX_THREAD_ID); cannot tell which task is writing';
export const CODEX_RELATIVE_HOME_REASON = 'CODEX_HOME is a relative path; Codex resolved it against its own start directory, which this process cannot know, so no rollout can be attested';

function homeDir(env = process.env) { return env.HOME || env.USERPROFILE || os.homedir(); }

/**
 * Codex resolves a relative CODEX_HOME against the directory it was started in and passes the
 * raw relative value on to its task shells, whose cwd differs. Reading it against this process's
 * cwd could find another tree's rollouts, so a relative CODEX_HOME is no CODEX_HOME: null.
 * On Windows only a drive-qualified or UNC path is absolute (`\x` depends on the current drive).
 */
export function codexHomeIsAbsolute(value, platform = process.platform) {
  return platform === 'win32' ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(value) : path.posix.isAbsolute(value);
}
export function codexRoot(env = process.env) {
  if (!env.CODEX_HOME) return path.join(homeDir(env), '.codex'); // empty is unset, as in Codex
  return codexHomeIsAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : null;
}

function containedFile(file, root) {
  try {
    const base = fs.realpathSync(root); const real = fs.realpathSync(file); const rel = path.relative(base, real);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && fs.statSync(real).isFile() ? real : null;
  } catch { return null; }
}

// Detail form: {path} or {reason} ('rollout-not-found' | 'rollout-ambiguous'). An incomplete
// search (directory budget exhausted) cannot rule out ambiguity, so it reports ambiguous.
function findRolloutDetail(root, session) {
  const suffix = `-${session}.jsonl`; const stack = [root]; let dirs = 0; let found = null;
  while (stack.length && dirs++ < 10_000) {
    const dir = stack.pop(); let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(suffix)) {
        const real = containedFile(p, root);
        if (real && rolloutNamesSession(real, session)) {
          if (found && found !== real) return { reason: 'rollout-ambiguous' }; // duplicate records cannot attest which is live
          found = real;
        }
      }
    }
  }
  if (stack.length) return { reason: 'rollout-ambiguous' };
  return found ? { path: found } : { reason: 'rollout-not-found' };
}

function findRollout(root, session) { return findRolloutDetail(root, session).path ?? null; }

function rolloutNamesSession(file, session) {
  let text;
  try {
    const size = Math.min(fs.statSync(file).size, 256 * 1024); const fd = fs.openSync(file, 'r');
    try { const buf = Buffer.alloc(size); fs.readSync(fd, buf, 0, size, 0); text = buf.toString('utf8'); }
    finally { fs.closeSync(fd); }
  } catch { return false; }
  for (const line of text.split('\n')) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'session_meta') return event.payload?.id === session;
  }
  return false;
}

/**
 * Locate only this process's own rollout beneath CODEX_HOME/sessions. CODEX_HOME/archived_sessions
 * is never searched: Codex shuts an archived thread down and refuses to resume it until
 * `codex unarchive` moves it back into sessions/, so an archived rollout belongs to no live task.
 */
export function codexRolloutPath(session, env = process.env) {
  if (typeof session !== 'string' || !ID_RE.test(session)) return null;
  const home = codexRoot(env); if (!home) return null;
  return findRollout(path.join(home, 'sessions'), session);
}

/**
 * Codex 0.160.1 runs hook commands without CODEX_THREAD_ID or CODEX_SESSION_ID of their own,
 * so any Codex id in a hook's environment is inherited (a Codex started from another Codex
 * task's shell) and names some other task. The hook's stdin carries `session_id`
 * and `transcript_path`. For the hook's READ-ONLY brief only, the session is the stdin id when
 * it names exactly one contained rollout under CODEX_HOME (default ~/.codex; a relative one
 * attests nothing) and `transcript_path` resolves to that same file. Codex ids in `env` are
 * ignored here; the caller strips them. Returns the session id, or null. Never used for a
 * write: the caller only builds a brief, and writes stay with the CLI in the task's own shell.
 */
export function codexHookSession(payload, env = process.env) {
  return codexHookSessionDetail(payload, env).session ?? null;
}

/**
 * Same checks as codexHookSession, but says which one failed: {session} on success, else
 * {reason} from a fixed enum (HOOK_SESSION_REASONS). The reason never carries a value.
 */
export function codexHookSessionDetail(payload, env = process.env) {
  const session = payload?.session_id; const transcript = payload?.transcript_path;
  if (typeof session !== 'string') return { reason: 'no-session-id' };
  if (!ID_RE.test(session)) return { reason: 'bad-session-id' };
  if (typeof transcript !== 'string' || !transcript) return { reason: 'no-transcript-path' };
  const clean = withoutCodexIds(env);
  const home = codexRoot(clean); if (!home) return { reason: 'no-codex-home' };
  const found = findRolloutDetail(path.join(home, 'sessions'), session);
  if (!found.path) return { reason: found.reason };
  let real; try { real = fs.realpathSync(transcript); } catch { return { reason: 'transcript-unresolvable' }; }
  return real === found.path ? { session } : { reason: 'transcript-mismatch' };
}

/** `env` minus the Codex task ids: in a hook they are inherited, never the hook's own. */
export function withoutCodexIds(env = process.env) {
  const out = { ...env }; delete out.CODEX_THREAD_ID; delete out.CODEX_SESSION_ID; return out;
}

function validModel(model) {
  return typeof model === 'string' && model.length > 0 && model.length <= 256 && !/[\s\x00-\x1f\x7f]/.test(model);
}

/** Validate an oversized JSON record while retaining only identity fields and bounded tokens. */
function largeRecordModel(fd, start, end) {
  const chunk = Buffer.alloc(SCAN_CHUNK); let position = start; let index = 0; let length = 0;
  const peek = () => {
    if (index === length) {
      length = fs.readSync(fd, chunk, 0, Math.min(chunk.length, end - position), position);
      position += length; index = 0;
    }
    return index < length ? chunk[index] : -1;
  };
  const take = () => { const byte = peek(); if (byte >= 0) index++; return byte; };
  const fail = () => { throw new Error('unclassifiable oversized rollout record'); };
  const space = () => { while ([9, 10, 13, 32].includes(peek())) take(); };
  const expect = (byte) => { if (take() !== byte) fail(); };
  const string = () => {
    expect(34); const bytes = [34]; let oversized = false;
    const remember = (byte) => { if (bytes.length < 4096) bytes.push(byte); else oversized = true; };
    while (true) {
      const byte = take(); if (byte < 32) fail(); remember(byte);
      if (byte === 34) break;
      if (byte === 92) {
        const escaped = take(); remember(escaped);
        if (escaped === 117) {
          for (let i = 0; i < 4; i++) { const hex = take(); if (!((hex >= 48 && hex <= 57) || (hex >= 65 && hex <= 70) || (hex >= 97 && hex <= 102))) fail(); remember(hex); }
        } else if (![34, 92, 47, 98, 102, 110, 114, 116].includes(escaped)) fail();
      }
    }
    return oversized ? undefined : JSON.parse(Buffer.from(bytes).toString('utf8'));
  };
  const value = (depth, mode = 0) => {
    if (depth > 64) fail(); space(); const byte = peek();
    if (byte === 34) return string();
    if (byte === 123) {
      take(); space(); const out = mode ? {} : undefined;
      if (peek() === 125) { take(); return out; }
      while (true) {
        const key = string(); space(); expect(58);
        const childMode = mode === 1 && key === 'payload' ? 2 : 0;
        const parsed = value(depth + 1, childMode);
        if (mode === 1 && (key === 'type' || key === 'payload')) out[key] = parsed;
        if (mode === 2 && key === 'model') out.model = parsed;
        space(); const separator = take(); if (separator === 125) return out;
        if (separator !== 44) fail(); space();
      }
    }
    if (byte === 91) {
      take(); space(); if (peek() === 93) { take(); return undefined; }
      while (true) { value(depth + 1); space(); const separator = take(); if (separator === 93) return undefined; if (separator !== 44) fail(); }
    }
    for (const [literal, parsed] of [['true', true], ['false', false], ['null', null]]) {
      if (byte === literal.charCodeAt(0)) { for (const char of literal) expect(char.charCodeAt(0)); return parsed; }
    }
    let number = '';
    while ([45, 43, 46, 69, 101].includes(peek()) || (peek() >= 48 && peek() <= 57)) {
      if (number.length >= 2048) fail(); number += String.fromCharCode(take());
    }
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(number)) fail();
    return undefined;
  };
  try {
    const record = value(0, 1); space(); if (peek() !== -1) fail();
    if (record?.type !== 'turn_context') return undefined;
    return validModel(record.payload?.model) ? record.payload.model : null;
  } catch { return null; } // an unclassifiable large record may be the newest context
}

/**
 * Scan at most 64 MiB backwards, retaining at most one bounded JSONL record.
 * Returns `{ model, problem }`: `problem` is null when the scan completed (a null model then
 * means the rollout has no turn context yet), else why the model cannot be established:
 * 'invalid-record' (the newest relevant record is complete but unparseable or names an
 * invalid model; fail closed), 'scan-cap' (no turn context within the cap), 'unreadable'.
 * A final segment with no terminating newline is a record Codex is still appending: it is
 * skipped as in flight, and the scan continues with the last complete record.
 */
export function scanCodexModel(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    let position = fs.fstatSync(fd).size; let recordEnd = position; const size = position;
    const minimum = Math.max(0, position - MAX_SCAN);
    let suffix = Buffer.alloc(0); let oversized = false;
    const chunk = Buffer.alloc(SCAN_CHUNK);
    let inFlight = false;
    if (size > 0) {
      const last = Buffer.alloc(1);
      if (fs.readSync(fd, last, 0, 1, size - 1) !== 1) return { model: null, problem: 'unreadable' };
      inFlight = last[0] !== 10;
    }
    const append = (fragment) => {
      if (oversized) return;
      if (fragment.length + suffix.length > MAX_RECORD) { suffix = Buffer.alloc(0); oversized = true; }
      else suffix = Buffer.concat([fragment, suffix]);
    };
    const modelInRecord = (start) => {
      if (inFlight && recordEnd === size) return undefined; // still being appended: not a record yet
      if (oversized) return largeRecordModel(fd, start, recordEnd);
      const text = suffix.toString('utf8'); if (!text.trim()) return undefined;
      let event; try { event = JSON.parse(text); } catch { return null; }
      if (event?.type !== 'turn_context') return undefined;
      return validModel(event.payload?.model) ? event.payload.model : null;
    };
    const found = (model) => (model === null ? { model: null, problem: 'invalid-record' } : { model, problem: null });
    while (position > minimum) {
      const length = Math.min(position - minimum, chunk.length); position -= length;
      const read = fs.readSync(fd, chunk, 0, length, position);
      if (read !== length) return { model: null, problem: 'unreadable' };
      let end = read;
      while (end > 0) {
        const newline = chunk.lastIndexOf(10, end - 1);
        append(chunk.subarray(newline + 1, end));
        if (newline < 0) break;
        const model = modelInRecord(position + newline + 1); if (model !== undefined) return found(model);
        suffix = Buffer.alloc(0); oversized = false; end = newline; recordEnd = position + newline;
      }
    }
    if (minimum > 0) return { model: null, problem: 'scan-cap' };
    const model = modelInRecord(0);
    return model === undefined ? { model: null, problem: null } : found(model);
  } catch { return { model: null, problem: 'unreadable' }; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** The active model named by the rollout, or null (see scanCodexModel for why). */
export function lastCodexModel(file) { return scanCodexModel(file).model; }

export function codexRolloutIdentity(env = process.env) {
  if (codexRootOnly(env)) return { harness: 'codex', session: null, rollout: null, model: null, rootOnly: true, unattestable: CODEX_ROOT_ONLY_REASON };
  const session = codexTaskId(env);
  if (!session) return null;
  if (!codexRoot(env)) return { harness: 'codex', session, rollout: null, model: null, unattestable: CODEX_RELATIVE_HOME_REASON };
  if (typeof session !== 'string' || !ID_RE.test(session)) return { harness: 'codex', session, rollout: null, model: null };
  const rollout = codexRolloutPath(session, env);
  if (!rollout) return { harness: 'codex', session, rollout, model: null };
  const { model, problem } = scanCodexModel(rollout);
  return { harness: 'codex', session, rollout, model, ...(problem ? { modelProblem: problem } : {}) };
}

/** How long readCodexHookPayload waits on an open stdin for a complete payload before giving up. */
export const CODEX_HOOK_STDIN_MS = 1500;

/**
 * Bounded, timed hook JSON read. Invalid or incomplete input is simply no payload.
 * `schedule` is a test seam standing in for `setTimeout` (see src/cli.js readHookPayload and
 * src/project.js probe() for the same idea): defaulted to the real one, it lets a test assert
 * the exact stdin-wait budget used, without any real waiting.
 */
export function readCodexHookPayload(stdin = process.stdin, { limit = 64 * 1024, ms = CODEX_HOOK_STDIN_MS, schedule = setTimeout } = {}) {
  if (!stdin || stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    const chunks = []; let size = 0; let done = false;
    const finish = (value) => {
      if (done) return; done = true; clearTimeout(timer);
      stdin.off?.('data', onData); stdin.off?.('end', onEnd); stdin.pause?.(); resolve(value);
    };
    const parse = () => {
      try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }
      catch { return null; }
    };
    const onData = (chunk) => {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += b.length;
      if (size > limit) return finish(null);
      chunks.push(b); const value = parse(); if (value) finish(value);
    };
    const onEnd = () => finish(parse());
    const timer = schedule(() => finish(null), ms); timer?.unref?.();
    stdin.on('data', onData); stdin.on('end', onEnd); stdin.resume?.();
  });
}
