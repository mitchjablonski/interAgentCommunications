import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { envVar, envSource } from './env.js';

export const DEFAULT_CONFIG = {
  human: 'human',
  repo: null,
  port: 4747,
  // agent name -> argv that starts that agent's harness, used by `iac-launch`.
  // Empty by default: a deployment decides its own roster. Seed it with
  // `iac set-launch <agent> -- <command...>`.
  launch: {},
  // agent name -> model-id globs. A session whose harness reports a matching model
  // writes as that agent. Seeded for the Claude families; an entry is inert unless
  // the name is also a registered agent, so this is not a roster. Extend with
  // `iac add-agent <name> --models '<glob>,...'` or `iac set-models`.
  families: {
    fable: ['claude-fable-*'],
    opus: ['claude-opus-*'],
    sonnet: ['claude-sonnet-*'],
    haiku: ['claude-haiku-*'],
  },
  // family -> the one harness ('claude-code' | 'codex') whose session record may attest it.
  // A harness can attest a family only when the family names that harness here. A family
  // with no entry falls back to the older model-prefix rule (Codex never attests 'claude-*',
  // Claude Code never attests 'gpt-*'); declare one with `iac set-models <agent> --harness`.
  familyHarness: {
    fable: 'claude-code',
    opus: 'claude-code',
    sonnet: 'claude-code',
    haiku: 'claude-code',
  },
  limits: {
    titleMax: 80,
    openerBodyMax: 3000,
    postBodyMax: 1500,
    ackBodyMax: 240,
    mentionsMax: 3,
    perThreadPerHour: 3,
    perThreadLifetime: 8,
    familyGlobalPerHour: 36,
    openThreadsPerAgent: 3,
    consecutiveGraceMin: 120,
    pingPongWindow: 6,
    threadPostCap: 24,
    objectionsPerAgentPerThread: 1,
    threadTtlHours: 72,
    closedTtlHours: 24,
    // A thread with no activity for this many days, and no outstanding wait, is shown as 'idle' (derived,
    // never written): it leaves the brief, inbox and open-thread allowance, and any post revives it. 0 disables.
    threadIdleCloseDays: 14,
    // An unclaimed wait stops being a claim on anyone's attention after this long:
    // it leaves the wait surfaces (brief, inbox, waiting, viewer) but stays in the thread.
    waitTtlHours: 72,
    // An unclaimed wait this old is "stalled": nobody of that family has picked it up in
    // that project, which usually means no session of theirs is running there. Derived
    // only (no events, no escalation); it keeps showing until claimed, answered or expired.
    stallHours: 12,
  },
};

export const KINDS = ['question', 'answer', 'proposal', 'objection', 'status', 'ack', 'handoff', 'resolution'];

/** The store directory name: ~/.inter-agent-comms, and ~/.agora from before the rename. */
export const STORE_DIR = '.inter-agent-comms';
export const LEGACY_STORE_DIR = '.agora';

/**
 * Which store, and why: --home > IAC_HOME > AGORA_HOME > ~/.inter-agent-comms if initialised >
 * ~/.agora if initialised > (WSL) C:\\Users\\<name>\\.inter-agent-comms, then \\.agora, if initialised >
 * ~/.inter-agent-comms. An initialised legacy store is used where it is; nothing is ever moved.
 * The WSL step lets agents in WSL and in native Windows share one board when the store was
 * initialised on the Windows side.
 */
export function resolveHomeWhy(explicit, env = process.env, { homedir = os.homedir(), wslUsers = process.platform === 'linux' ? '/mnt/c/Users' : null, username } = {}) {
  if (explicit) return { home: explicit, why: '--home' };
  const src = envSource(env, 'HOME');
  if (src) return { home: env[src], why: src };
  const init = (d) => fs.existsSync(path.join(d, 'config.json'));
  const local = path.join(homedir, STORE_DIR);
  if (init(local)) return { home: local, why: `initialised ~/${STORE_DIR}` };
  const legacy = path.join(homedir, LEGACY_STORE_DIR);
  if (init(legacy)) return { home: legacy, why: `initialised legacy ~/${LEGACY_STORE_DIR} (used in place)` };
  if (wslUsers && fs.existsSync(wslUsers)) {
    let name = username || 'unknown'; if (!username) try { name = os.userInfo().username; } catch {}
    for (const [dir, label] of [[STORE_DIR, ''], [LEGACY_STORE_DIR, 'legacy ']]) {
      const win = path.posix.join(wslUsers, name, dir);
      if (init(win)) return { home: win, why: `initialised ${label}Windows-side store (WSL)${label ? ', used in place' : ''}` };
    }
  }
  return { home: local, why: 'default (no store initialised yet)' };
}

export function resolveHome(explicit, env = process.env) { return resolveHomeWhy(explicit, env).home; }

/** One read cache per process. Entries are keyed by a store's spelled path (see storeCacheKey). */
const READS = new Map();
/** Physical directory id -> every path key this process has used for it. */
const ALIASES = new Map();

/**
 * How the read cache names a store directory: `key`, a normalised spelling, and `id`, the
 * directory's physical identity (`dev:ino`) when it exists and the filesystem reports one.
 *
 * Cached reads are filed under `key` and tagged with the `id` they were read under; a read
 * whose spelling now resolves to a different id is a miss, so a retargeted junction or
 * symlink never serves the old target's text. Invalidation goes by `id`: a write or a lock
 * through any spelling of one directory (symlink, WSL drvfs case variant,
 * `\\localhost\C$\...`, `\\?\...`, a junction) drops what every spelling with that id has
 * cached, so no alias keeps a stale copy. Ids are compared, never used as the key, so an
 * inode reused after a store is deleted can cost an extra disk read but never answers one
 * store's read from another's cache.
 *
 * Where no usable identity exists (dev or ino 0, as Windows reports for \\wsl.localhost
 * shares, or the directory not created yet) the key alone must carry it, so it resolves
 * through realpath, and on Windows folds the `\\?\` / `\\?\UNC\` prefixes, `/` separators,
 * drive-letter case and `\\wsl$\` to `\\wsl.localhost\`. Only names are normalised; the
 * store itself is never moved or renamed.
 */
export function storeCacheKey(home, { platform = process.platform, realpath = fs.realpathSync.native,
  stat = (p) => fs.statSync(p, { bigint: true }) } = {}) {
  const win = platform === 'win32';
  const P = win ? path.win32 : path.posix;
  const fold = (p) => {
    if (!win) return p;
    let q = String(p).replace(/\//g, '\\');
    if (/^\\\\[?.]\\UNC\\/i.test(q)) q = '\\\\' + q.slice(8);   // \\?\UNC\srv\share -> \\srv\share
    else if (/^\\\\[?.]\\[A-Za-z]:/.test(q)) q = q.slice(4);         // \\?\C:\x -> C:\x
    q = q.replace(/^\\\\wsl\$\\/i, '\\\\wsl.localhost\\');          // two names for one WSL share
    return q.replace(/^([A-Za-z]):/, (_, d) => d.toLowerCase() + ':');
  };
  const spelled = P.resolve(fold(home));
  let id = null; let found = false;
  try {
    const st = stat(spelled); found = true;
    if (st.isDirectory() && BigInt(st.dev) !== 0n && BigInt(st.ino) !== 0n) id = `${st.dev}:${st.ino}`;
  } catch { /* missing */ }
  if (id) return { key: fold(spelled), id, found };
  let real = null;
  try { real = realpath(spelled); found = true; } catch { /* not created yet: the resolved spelling stands in */ }
  return { key: fold(real ?? spelled), id: null, found };
}

/**
 * renameSync over an existing file, retried for up to ~1 s with backoff on EPERM/EBUSY/EACCES:
 * on native Windows a concurrent reader briefly holding the target makes the replace fail.
 */
function renameReplacing(from, to, budgetMs = 1000) {
  const start = Date.now(); let wait = 5;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try { return fs.renameSync(from, to); } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || Date.now() - start >= budgetMs) throw e;
      Atomics.wait(pause, 0, 0, wait); wait = Math.min(wait * 2, 100);
    }
  }
}

/** How long a writer waits for the store lock before giving up. */
export const LOCK_TIMEOUT_MS = 10_000;
/** A lock untouched this long belongs to a dead holder and may be broken. Live holders heartbeat well inside it. */
export const LOCK_STALE_MS = 30_000;
/** A `.lock.stale-*` dir left by an earlier iac's breaker that died mid-break is removed by the next taker once it is this old. */
export const LOCK_ASIDE_MAX_AGE_MS = 5 * 60_000;

export class Store {
  constructor(home, { cacheKey } = {}) {
    const r = resolveHomeWhy(home);
    this.home = r.home;
    this.homeSource = r.why;   // which resolution rule chose the store (iac paths / whoami)
    this._keyOpts = cacheKey;   // tests only: storeCacheKey options (injected stat/realpath)
    this._damaged = new Set();   // thread ids whose last parse found unparseable lines
    this.threadsDir = path.join(this.home, 'threads');
    this.keysDir = path.join(this.home, 'keys');
    this.seenDir = path.join(this.home, 'seen');
    // Per-process read cache. Board files live wherever the store does (on WSL often /mnt/c,
    // where every read is a slow 9p round trip), and one brief derives the board several
    // times over. Entries are dropped on this process's own writes and whenever the store
    // lock is taken, so a read-modify-write always sees other processes' appends; a
    // long-lived reader (the MCP server) calls invalidate() per request. Every write forgets
    // what it touches both before it mutates and after, even when it fails part-way, so a
    // half-written file is never answered from a pre-write copy.
    this._ck = null;   // { key, id } from storeCacheKey, re-resolved on invalidate() and on each write
    this._lockToken = null;   // the token naming our entry (.lock/owner-<token>) while we hold the store lock
    this._lockDirIdent = null;   // identity (ino, birthtime) of the .lock dir we hold, so release removes only that one
    this._lastBeat = 0;
    this._lockNow = () => Date.now();   // the lock's clock: stale judgement and heartbeat stamps (tests move it)
    this._heartbeatMs = 3_000;   // async holders refresh the lock this often
    this._fs = { platform: process.platform };   // tests stand in another platform
    this._warn = (m) => { try { process.stderr.write(m + '\n'); } catch { /* no stderr */ } };
  }

  /**
   * Resolve this Store's cache key (one stat) and register it under its physical id. Done
   * on first use, on invalidate() and before and after each write, so a symlink retargeted mid-process
   * is followed at the next lock; until the directory exists, on every use. Once it exists
   * the result is kept whether or not it carries an id: a share with no usable id (native
   * Windows reports dev 0 for \\wsl.localhost) must not pay a stat and a realpath per read.
   */
  _resolve() {
    const ck = storeCacheKey(this.home, this._keyOpts);
    if (ck.id) { let set = ALIASES.get(ck.id); if (!set) ALIASES.set(ck.id, set = new Set()); set.add(ck.key); }
    this._ck = ck.found ? ck : null;
    return ck;
  }
  _own() { return (this._ck || this._resolve()).key + '\0'; }
  /** Every cache prefix that names the same physical directory as `ck`. */
  _group(ck) { return ck.id ? [...ALIASES.get(ck.id)].map((k) => k + '\0') : [ck.key + '\0']; }
  _drop(prefixes, keys) {
    for (const pre of prefixes) {
      if (keys) for (const key of keys) READS.delete(pre + key);
      else for (const k of [...READS.keys()]) if (k.startsWith(pre)) READS.delete(k);
    }
  }
  /** Forget cached reads, through every spelling of this store; the next read goes to disk. */
  invalidate() {
    const before = this._ck;
    const now = this._resolve();
    this._drop(new Set([...(before ? this._group(before) : []), ...this._group(now)]));
  }
  _cached(key, load) {
    const k = this._own() + key;
    const id = this._ck?.id ?? null;
    // An entry is only an answer for the directory it was read from: a spelling that now
    // resolves to another physical directory (a retargeted junction or symlink, seen by a
    // Store created since) misses rather than serving the previous target's text.
    const hit = READS.get(k);
    if (hit && hit.id === id) return hit.v;
    const v = load(); READS.set(k, { v, id }); return v;
  }
  /** Run a mutation with `keys` forgotten, through every spelling, before it starts and again however it ends. */
  _mutating(keys, fn) {
    const seen = [this._ck];
    // Resolve before and again after the write: the path may be retargeted between this
    // lookup and the write's own, so the directory actually written is only known afterwards.
    // Every group this Store has resolved to around the write is forgotten, both times.
    const forget = () => {
      seen.push(this._resolve());
      this._drop(new Set(seen.filter(Boolean).flatMap((ck) => this._group(ck))), keys);
    };
    forget();
    this._assertStillLocked();
    let ok = false;
    try { const r = fn(); ok = true; return r; } finally {
      forget();
      // Fencing after the fact: the check above cannot stop a write already in flight when
      // a breaker takes the lock during it, so look again once it has landed. The write is
      // done and is not undone (the caller would retry and duplicate it); it is reported,
      // and the next mutation refuses. A concurrent append shows up in verify as chain-break.
      if (ok && this._lockToken && !this._stillLocked()) {
        this._warn(`iac: the store lock ${path.join(this.home, '.lock')} was lost while writing ${keys.join(', ')}; another writer may have overlapped this one (run iac verify)`);
      }
    }
  }

  /** True while this process's owner entry is still in .lock (see withLock). */
  _stillLocked() {
    if (!this._lockToken) return false;
    try { fs.statSync(this._ownerPath(this._lockToken)); return true; } catch { return false; }
  }

  /**
   * A write made while this Store holds the lock goes ahead only if the lock is still ours
   * (our owner entry in .lock): a holder whose lock was broken as stale must not write
   * alongside the new holder. Writes made without the lock (seen marks) are not checked.
   */
  _assertStillLocked() {
    if (!this._lockToken || this._stillLocked()) return;
    const lockDir = path.join(this.home, '.lock');
    let cur; try { cur = this._lockOwner(lockDir); } catch { cur = undefined; }
    throw Object.assign(new Error(`the store lock ${lockDir} is no longer held by this process (${cur ? 'another process took it over' : 'it is gone'}); nothing more was written`), { code: 'ELOCKLOST' });
  }

  exists() { return this._cached('exists', () => fs.existsSync(path.join(this.home, 'config.json'))); }

  ensureDirs() {
    for (const d of [this.home, this.threadsDir, this.keysDir, this.seenDir]) fs.mkdirSync(d, { recursive: true });
  }

  readJson(file, fallback) {
    // cache the text, not the object: callers may mutate what they get back
    const text = this._cached(`json:${file}`, () => { try { return fs.readFileSync(path.join(this.home, file), 'utf8'); } catch { return null; } });
    if (text == null) return fallback;
    try { return JSON.parse(stripBom(text)); } catch { return fallback; }
  }
  /**
   * A JSON object read straight from disk for a read-modify-write: undefined only when the
   * file does not exist (ENOENT). Any other read error, invalid JSON, or a non-object is
   * thrown, so a transient EBUSY/EACCES or a hand-damaged file can never be mistaken for
   * "absent" and overwritten with defaults.
   */
  readJsonStrict(file) {
    const p = path.join(this.home, file);
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
    let v;
    try { v = JSON.parse(stripBom(text)); } catch (e) { throw new Error(`${p} is not valid JSON (${e.message}); fix or move it aside, nothing was written`); }
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${p} does not hold a JSON object; fix or move it aside, nothing was written`);
    return v;
  }
  /**
   * Atomic replace: write a uniquely named sibling, then rename it over the target. The
   * target's permission bits are carried over (a 0600 config stays 0600), the temp name is
   * per call so two writers never share one, and the temp file is removed if anything fails.
   */
  writeJson(file, obj) {
    const p = path.join(this.home, file);
    this._mutating([`json:${file}`, 'exists'], () => {
      let mode;
      try { mode = fs.statSync(p).mode & 0o7777; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const tmp = `${p}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { flag: 'wx', ...(mode !== undefined ? { mode } : {}) });
        if (mode !== undefined) fs.chmodSync(tmp, mode);   // the create mode is masked by umask
        renameReplacing(tmp, p);
      } finally {
        try { fs.unlinkSync(tmp); } catch { /* renamed into place, or never created */ }
      }
    });
  }

  config() {
    // a config.json that parses but is not an object (null, an array, a number) is treated
    // like unparseable JSON: readJson's fallback, the defaults
    const raw = this.readJson('config.json', {});
    const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const cfg = { ...DEFAULT_CONFIG, ...c, limits: { ...DEFAULT_CONFIG.limits, ...(c.limits || {}) }, launch: { ...(c.launch || {}) },
      families: { ...DEFAULT_CONFIG.families, ...(c.families || {}) },
      familyHarness: mergeFamilyHarness(c.familyHarness) };
    // a limit that is not a finite number ("72h", null, NaN) would poison every derivation: use the default
    for (const [k, d] of Object.entries(DEFAULT_CONFIG.limits)) {
      if (typeof d !== 'number') continue;
      const v = cfg.limits[k]; const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      // these two have long meant 'invalid = disabled' (0); everything else falls back to its default
      cfg.limits[k] = typeof n === 'number' && Number.isFinite(n) ? n : (k === 'waitTtlHours' || k === 'stallHours' ? 0 : d);
    }
    delete cfg.limits.globalPerHour;   // retired: superseded by familyGlobalPerHour
    return cfg;
  }
  saveConfig(c) { this.writeJson('config.json', c); }

  registry() { const r = this.readJson('agents.json', {}); return r && typeof r === 'object' && !Array.isArray(r) ? r : {}; }
  saveRegistry(r) { this.writeJson('agents.json', r); }

  keyPath(name) { return path.join(this.keysDir, `${name}.pem`); }
  privateKey(name) {
    const p = envVar(process.env, 'KEY') || this.keyPath(name);
    if (!fs.existsSync(p)) throw new Error(`no private key for '${name}' at ${p} (run: iac init, or iac add-agent ${name})`);
    return fs.readFileSync(p, 'utf8');
  }
  /**
   * Create a private key file, never replace one: exclusive create ('wx'), mode 0600. An
   * existing file at that path (another agent's key, or one left by an earlier run) is an
   * error rather than something to overwrite. `dir` lets a fresh init build in a temp dir.
   */
  writePrivateKey(name, pem, dir = this.keysDir) {
    const p = path.join(dir, `${name}.pem`);
    return this._mutating([], () => this._writePrivateKeyAt(p, pem));   // a store write: the lock, when held, must still be ours
  }
  _writePrivateKeyAt(p, pem) {
    let fd;
    try { fd = fs.openSync(p, 'wx', 0o600); } catch (e) {
      // the open failed, so nothing at p is ours (another writer's file may be there): leave it
      if (e.code === 'EEXIST') throw Object.assign(new Error(`a key file already exists at ${p}; refusing to overwrite it (move it aside if it is stale)`), { code: 'EEXIST' });
      throw e;
    }
    // the exclusive open succeeded: this call created p, so a torn write is ours to remove
    try { fs.writeFileSync(fd, pem); } catch (e) {
      try { fs.closeSync(fd); } catch { /* already failing */ }
      fd = undefined;
      try { fs.unlinkSync(p); } catch { /* already gone */ }
      throw e;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    return p;
  }

  /** Thread ids: `t-` + hex. New ids carry 4 random bytes (8 hex); 3-byte ids from before stay valid. */
  threadPath(id) {
    if (!/^t-[0-9a-f]{6,}$/.test(id)) throw new Error(`bad thread id: ${id}`);
    return path.join(this.threadsDir, `${id}.ndjson`);
  }
  threadIds() {
    return this._cached('threadIds', () => {
      let names; try { names = fs.readdirSync(this.threadsDir); } catch { return []; }
      return names.filter((f) => f.endsWith('.ndjson')).map((f) => f.slice(0, -7));
    }).slice();
  }
  /**
   * The thread's valid events, plus the lines that are not one: `damaged` is
   * [{thread, line, kind: 'unparseable'}] with 1-based file line numbers. A torn or corrupt line
   * never throws; it is skipped here and reported by verify. null when there is no such thread.
   */
  readEventsDetailed(id) {
    this._beatIfDue();   // a holder deriving a big board keeps its lock fresh (see _beatIfDue)
    const p = this.threadPath(id);
    // cache the raw text and parse per call, so callers can never share or mutate events
    const text = this._cached(`t:${id}`, () => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } });
    if (text == null) return null;
    const { events, damaged } = parseThread(id, Buffer.from(text));
    if (damaged.length) this._damaged.add(id); else this._damaged.delete(id);
    return { events, damaged };
  }
  /**
   * Fill the read cache with every thread file's text, up to `concurrency` reads at a time, so
   * a derivation of the whole board that follows is answered from memory. It only changes when
   * the reads happen, not what they return: the entries are the ones readEventsDetailed would
   * make (raw text, null for a file that is gone), filed under the same key and directory id,
   * and an entry already cached is left as it is. A read that fails any other way is not
   * cached, so the synchronous read that follows meets the same error and reports it as before.
   *
   * On a WSL /mnt/c (drvfs) store each file access is a round trip of about 5 ms when issued
   * one after another (a stat costs about as much as a read), but concurrent reads overlap:
   * 1,000 files take about 5 s one at a time and about 0.4-0.6 s sixteen at a time.
   * Callers hold the store lock, so no writer changes a file between this read and its use.
   */
  async prefetchThreads({ concurrency = 16 } = {}) {
    const ids = this.threadIds();
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const id = ids[next++];
        let p; try { p = this.threadPath(id); } catch { continue; }   // a stray name: the sync read throws for it as before
        // key and id as they are when the read starts: if the store is re-resolved meanwhile, the entry is a miss, never a wrong answer
        const k = this._own() + `t:${id}`; const dirId = this._ck?.id ?? null;
        const hit = READS.get(k);
        if (hit && hit.id === dirId) continue;
        this._beatIfDue();
        let text;
        try { text = await fs.promises.readFile(p, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') continue; text = null; }
        READS.set(k, { v: text, id: dirId });
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, ids.length)) }, worker));
  }
  markDamaged(id) { this._damaged.add(id); }
  /** Thread ids this process last read as damaged: unparseable lines, or structural damage (no open) found by Agora.thread. No extra reads. */
  damagedThreads() { const ids = new Set(this.threadIds()); return [...this._damaged].filter((i) => ids.has(i)); }
  readEvents(id) { return this.readEventsDetailed(id)?.events ?? null; }
  /**
   * Under the caller's store lock, retain physical bytes and quarantine only lines the
   * normal parser calls unparseable. prepare validates ALL retained history and signs
   * the audit event before any file is created. Sidecars and candidates are exclusive;
   * failures keep them for recovery, never remove an existing or racing peer's file.
   */
  repairThread(id, prepare) {
    const p = this.threadPath(id);
    return this._mutating([`t:${id}`, 'threadIds'], () => {
      const dir = fs.lstatSync(this.threadsDir);
      if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('repair refuses a linked or non-directory threads path');
      let source;
      try { source = readRegular(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
      const read = parseThread(id, source.bytes);
      const event = prepare(read);
      if (!event) return { ok: true, thread: id, repaired: false, lines: 0 };
      const damagedPath = path.join(this.threadsDir, `${id}.damaged`);
      const candidatePath = `${p}.repair-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`;
      const retained = read.retained;
      const separator = retained.length && retained.at(-1) !== 0x0a ? Buffer.from('\n') : Buffer.alloc(0);
      const candidate = Buffer.concat([retained, separator, Buffer.from(JSON.stringify(event) + '\n')]);
      this._beatIfDue();   // a big file on a slow drive: read, parsed, written and synced with no thread read to keep the lock fresh
      // Durable quarantine precedes replacement. Even a crash while writing a sidecar
      // leaves the complete original in place; an existing sidecar blocks a retry.
      try {
        writeExclusive(damagedPath, read.quarantine, 0o600);
        syncDirectory(this.threadsDir);
        writeExclusive(candidatePath, candidate, source.stat.mode & 0o7777);
        syncDirectory(this.threadsDir);
        const currentDir = fs.lstatSync(this.threadsDir);
        const current = readRegular(p);
        if (!sameFile(dir, currentDir) || !sameFile(source.stat, current.stat) || !source.bytes.equals(current.bytes)) {
          throw new Error('thread or threads directory changed during repair; refusing replacement');
        }
        renameReplacing(candidatePath, p);
        syncDirectory(this.threadsDir);
      } catch (e) {
        e.message += ` (repair recovery paths: original ${p}; quarantine ${damagedPath}; candidate ${candidatePath}; inspect before retrying)`;
        throw e;
      }
      this._damaged.delete(id);
      return { ok: true, thread: id, repaired: true, lines: read.damaged.length, damagedPath, event: event.id };
    });
  }
  /**
   * Create a thread file holding its first event, exclusively ('wx'): an existing file at
   * that id, live, closed or expired-but-not-yet-swept, is never appended to or reused.
   * Throws with code EEXIST on a collision so the caller can pick a new id. The exclusive
   * create is the guard across processes and filesystems; the store lock only orders writers.
   */
  createThread(id, event) {
    const p = this.threadPath(id); const line = JSON.stringify(event) + '\n';
    this._mutating([`t:${id}`, 'threadIds'], () => {
      const fd = fs.openSync(p, 'wx');   // EEXIST: nothing at p is ours, leave it alone
      let ok = false;
      try { fs.writeFileSync(fd, line); ok = true; } finally {
        try { fs.closeSync(fd); } catch { /* already failing or closed */ }
        if (!ok) try { fs.unlinkSync(p); } catch { /* already gone */ }
      }
    });
  }
  /**
   * Append one event line to an existing thread file; never creates one (no O_CREAT), so a
   * thread deleted between a caller's existence check and its write (gc) fails instead of
   * reappearing as a file whose first event is not its `open`. Only createThread starts a
   * thread file. A file whose last byte is not '\n' (a torn final write) would glue the new
   * event onto the fragment and corrupt it too, so the append starts on a new line. Callers
   * hold the store lock, so the check and the write do not race another writer.
   */
  appendEvent(id, event) {
    const p = this.threadPath(id); let line = JSON.stringify(event) + '\n';
    this._mutating([`t:${id}`, 'threadIds'], () => {
      let fd;
      try {
        fd = fs.openSync(p, 'r');
        const size = fs.fstatSync(fd).size;
        if (size > 0) { const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, size - 1); if (b[0] !== 0x0a) line = '\n' + line; }
      } catch (e) { if (e.code !== 'ENOENT') throw e; } finally { if (fd !== undefined) fs.closeSync(fd); }
      fs.appendFileSync(p, line, { flag: fs.constants.O_WRONLY | fs.constants.O_APPEND });   // ENOENT if gone
    });
  }
  /** The thread file's stat straight from disk (size, mtimeMs), or null when it is gone. */
  threadStat(id) { try { return fs.statSync(this.threadPath(id)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
  /** The thread file's raw text straight from disk, bypassing the read cache, or null when it is gone. */
  threadText(id) { try { return fs.readFileSync(this.threadPath(id), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
  deleteThread(id) { const p = this.threadPath(id); this._mutating([`t:${id}`, 'threadIds'], () => fs.rmSync(p, { force: true })); }

  seen(subject) { return this.readJson(path.join('seen', `${seenName(subject)}.json`), {}); }
  saveSeen(subject, obj) { this.writeJson(path.join('seen', `${seenName(subject)}.json`), obj); }

  /**
   * Cross-process mutex via atomic mkdir. Guardrail checks and the append
   * happen inside it, so two agents cannot both slip past a limit. `timeoutMs` bounds the
   * wait (default 10 s); when it runs out the call throws an error with code ELOCKBUSY.
   *
   * Ownership is an entry whose name is the holder's token: the taker mkdirs `.lock`, then
   * creates `.lock/owner-<token>` (random, exclusive) and counts the lock as held only when
   * that is the dir's sole entry. Everything that removes lock state names the token it
   * means to remove, so the ownership check and the act are one system call: release and a
   * stale break unlink `owner-<token>` by exact name (ENOENT: not ours, nothing touched), and
   * `.lock` itself goes only by a non-recursive rmdir, which fails on a dir holding anyone's
   * entry. Nothing renames a lock and nothing deletes one recursively, so a release can
   * never free another holder's lock and a break can never strand or remove a fresh one.
   *
   * A lock is broken as stale only when its owner entry (or, for a lock with no entry, such
   * as one taken by iac 0.3.x, the directory) has not been touched for LOCK_STALE_MS. Holders
   * refresh both: an async holder on a timer, a long synchronous one by calling heartbeat()
   * between steps (thread reads do), so a live holder is never taken for a dead one.
   *
   * Guarantees, among clients of this version: no lost lock and no double holder, for any
   * interleaving of releases, breaks and acquisitions, given atomic mkdir, unlink by name and
   * non-recursive rmdir on the file system (ext4, NTFS, NTFS over drvfs). The one residual
   * is a holder that stops heartbeating for LOCK_STALE_MS yet is alive: its lock is broken,
   * its next write refuses (ELOCKLOST), and a write already in flight is reported (see
   * _mutating) and shows in verify as a chain-break.
   *
   * Mixed with iac 0.3.x clients (a bare `.lock` dir is their whole lock), these residuals
   * remain, none closable from this side:
   * - a 0.3.x client releases with rm -rf regardless of who holds the lock, so one whose
   *   lock was broken as stale removes the new holder's on its way out (ELOCKLOST here);
   * - a 0.3.x client breaks any lock whose dir mtime is 30 s old with a stat-then-rm -rf,
   *   a check-then-act inside 0.3.x that can remove a lock taken fresh in between (hence the
   *   heartbeat on the dir mtime, which keeps a live holder of this version out of its way);
   * - second order: when that 0.3.x break removes a dir this version has just emptied (its
   *   stale entry unlinked, or judged stale while bare) and a 0.3.x client recreates the name
   *   before our non-recursive rmdir, our rmdir can remove the replacement. The rmdir is
   *   preceded by a stat that must show the same inode and birth time as judged, and (for a
   *   bare dir) an mtime still stale, so on NTFS and drvfs, whose file ids are not reused,
   *   what remains is the gap between that stat and the rmdir; on ext4 the inode and birth
   *   time are reused within the coarse clock tick, so there the whole unlink-to-rmdir
   *   window is open. A fresh lock of this version is never at risk: its entry makes the
   *   rmdir fail. Stale content iac did not write next to an owner entry costs one extra
   *   LOCK_STALE_MS, since unlinking the entry refreshes the dir mtime the rest is judged by.
   */
  async withLock(fn, { timeoutMs = LOCK_TIMEOUT_MS } = {}) {
    const start = Date.now();
    while (!this._tryLock(start, timeoutMs)) await new Promise((r) => setTimeout(r, Math.min(40 + Math.random() * 80, Math.max(1, timeoutMs))));
    const beat = setInterval(() => { try { this.heartbeat(); } catch { /* best effort */ } }, this._heartbeatMs);
    beat.unref?.();
    let result;
    try { result = await fn(); } catch (e) { clearInterval(beat); this._unlockAfter(e); throw e; }
    clearInterval(beat);
    this._unlock();
    return result;
  }

  /** withLock for synchronous callers (init, add-agent, gc): same lock dir, blocking wait. A long holder calls heartbeat(). */
  withLockSync(fn, { timeoutMs = LOCK_TIMEOUT_MS } = {}) {
    const start = Date.now();
    const pause = new Int32Array(new SharedArrayBuffer(4));
    while (!this._tryLock(start, timeoutMs)) Atomics.wait(pause, 0, 0, Math.min(40 + Math.random() * 80, Math.max(1, timeoutMs)));
    let result;
    try { result = fn(); } catch (e) { this._unlockAfter(e); throw e; }
    this._unlock();
    return result;
  }

  /**
   * Refresh the held lock's owner entry so no other process breaks it as stale. Returns false
   * (and leaves everything alone) when this process does not hold the lock any more: the
   * touch names our own entry, so it fails (ENOENT) rather than refresh anyone else's.
   */
  heartbeat() {
    if (!this._lockToken) return false;
    this._lastBeat = Date.now();
    const t = new Date(this._lockNow());
    try { fs.utimesSync(this._ownerPath(this._lockToken), t, t); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false; throw e; }
    // iac 0.3.x and earlier judge a lock by the directory's mtime and break it at 30 s; an
    // old client (a stale plugin cache mid-upgrade) must see a live holder as live too.
    try { fs.utimesSync(path.join(this.home, '.lock'), t, t); } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }
    return true;
  }

  /**
   * Heartbeat from inside long synchronous work: thread reads call this, so a holder deriving
   * a large board (minutes on a slow drive) keeps its lock fresh although no timer can run.
   */
  _beatIfDue() {
    if (this._lockToken && Date.now() - this._lastBeat >= this._heartbeatMs) { try { this.heartbeat(); } catch { /* best effort */ } }
  }

  /**
   * Release the lock after `primary` failed. A failure to release (EBUSY on Windows, say) must
   * not replace the error that explains what went wrong: it is attached to it instead.
   */
  _unlockAfter(primary) {
    try { this._unlock(); } catch (u) {
      try {
        primary.lockReleaseError = u;
        if (typeof primary.message === 'string') primary.message += ` (and releasing the store lock ${path.join(this.home, '.lock')} failed: ${u.code || u.message})`;
      } catch { /* a frozen or non-object throw: keep it as it is */ }
    }
  }

  _ownerPath(token, dir = path.join(this.home, '.lock')) { return path.join(dir, `owner-${token}`); }

  /**
   * What is in a lock dir: `owners` are the tokens of its owner entries (one for a held
   * lock), `foreign` any other names, `mtimeMs` the newest touch that counts for staleness:
   * the owner entries' (heartbeats touch those) or, with none, the directory's (an iac 0.3.x
   * lock has no entries). null when the dir is gone. A plain file at `.lock` counts as a
   * foreign entry of its own.
   */
  _lockEntries(dir) {
    let names;
    try { names = fs.readdirSync(dir); } catch (e) {
      if (e.code === 'ENOENT') return null;
      if (e.code !== 'ENOTDIR') throw e;
      let st; try { st = fs.statSync(dir); } catch (d) { if (d.code === 'ENOENT') return null; throw d; }
      return { owners: [], foreign: [path.basename(dir)], mtimeMs: st.mtimeMs, file: true };
    }
    const owners = []; const foreign = []; let newest = -Infinity; let vanished = 0;
    for (const n of names) {
      const m = /^owner-([0-9a-f]{32})$/.exec(n);
      if (m) owners.push(m[1]); else foreign.push(n);
      try { newest = Math.max(newest, fs.statSync(path.join(dir, n)).mtimeMs); } catch (e) { if (e.code !== 'ENOENT') throw e; vanished++; }
    }
    let st; try { st = fs.statSync(dir); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    const ident = { ino: st.ino, birthtimeMs: st.birthtimeMs };   // which directory object this is: a recreated .lock has another
    let mtimeMs;
    // Every listed entry gone by its stat: the dir is being emptied or replaced under us (a
    // release, a break, a 0.3.x client taking the name), which is change, not staleness.
    if (names.length && vanished === names.length) mtimeMs = Infinity;
    else if (owners.length && !foreign.length) mtimeMs = newest;
    else mtimeMs = Math.max(newest, st.mtimeMs);
    return { owners, foreign, mtimeMs, ident, file: false };
  }

  /** The owner token and freshness of a lock dir: { token, mtimeMs }, token null when it has no (single) owner entry; null when the dir is gone. */
  _lockOwner(dir) {
    const e = this._lockEntries(dir);
    if (!e) return null;
    return { token: e.owners.length === 1 ? e.owners[0] : null, mtimeMs: e.mtimeMs, ident: e.ident };
  }

  /**
   * Break `.lock` if its holder is dead (untouched for LOCK_STALE_MS). The stale owner entry
   * is unlinked by the exact name that was judged stale, so a lock a new holder has taken
   * since the look (a different entry) is untouched, and the dir is then removed only if it
   * is empty. A dir with no entries (iac 0.3.x's, or a taker's between its mkdir and its
   * write) is removed by that same non-recursive rmdir once the directory itself is stale.
   * Content no iac of this line wrote is removed one name at a time, each only while it is
   * still the stale object that was judged; nothing is ever deleted recursively.
   */
  _breakStale(lockDir) {
    const seen = this._lockOwner(lockDir);
    if (!seen || this._lockNow() - seen.mtimeMs <= LOCK_STALE_MS) return;
    // true when this call removed the entry; ENOENT means another breaker did, and then the
    // dir is that breaker's to remove: by now the name may be a fresh 0.3.x lock (a bare dir)
    const unlinkOwner = (token) => { try { fs.unlinkSync(this._ownerPath(token, lockDir)); return true; } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; return false; } };
    if (seen.token !== null) {   // a dead holder's entry, judged by its own mtime: remove exactly that one
      if (unlinkOwner(seen.token)) this._rmdirIfEmpty(lockDir, { ghosts: [seen.token], ident: seen.ident });
      return;
    }
    const entries = this._lockEntries(lockDir);
    if (!entries || this._lockNow() - entries.mtimeMs <= LOCK_STALE_MS) return;
    if (entries.file) {   // a plain file at .lock: a fresh lock is a dir, which unlink cannot remove
      try { fs.unlinkSync(lockDir); } catch (e) { if (!['ENOENT', 'EISDIR', 'EPERM'].includes(e.code)) throw e; }
      return;
    }
    const bare = !entries.owners.length && !entries.foreign.length;   // judged stale by its own mtime: a dead 0.3.x holder, or a crashed breaker's leftover
    let emptied = bare;
    for (const token of entries.owners) if (unlinkOwner(token)) emptied = true;
    // Content no iac of this line writes (a lock from another build, or a hand-made one):
    // never deleted recursively, since by the time a delete ran the name could be a fresh
    // holder's dir. Each name seen is removed on its own, only if it is still the same
    // stale object (a fresh holder's entries are not stale), and only a plain file or an
    // empty dir; anything else is left for a human, with a warning that says so.
    const left = [];
    for (const n of entries.foreign) {
      const p = path.join(lockDir, n);
      try {
        const st = fs.lstatSync(p);
        if (this._lockNow() - st.mtimeMs <= LOCK_STALE_MS) { left.push(n); continue; }   // touched since the look: not the stale thing we judged
        if (st.isDirectory()) fs.rmdirSync(p); else fs.unlinkSync(p);
        emptied = true;
      } catch (e) {
        if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') left.push(n);   // non-empty, busy, or unreadable: not ours to force
      }
    }
    if (left.length) this._warn(`iac: the store lock ${lockDir} is stale but holds content iac did not write (${left.join(', ')}); if no iac is running, remove that directory by hand`);
    if (emptied) this._rmdirIfEmpty(lockDir, { ghosts: entries.owners, ident: entries.ident, stillStale: bare });
  }

  /**
   * Remove `.lock` only if it is empty: false when it is gone or someone's entry is in it
   * (a new holder, or a taker about to yield), which makes it theirs. `ghosts` are entries
   * this caller has just unlinked; on Windows and drvfs one can linger in a listing for a
   * moment (delete pending), so a dir holding nothing else is retried briefly. Any other
   * error, or one that persists, is thrown to the caller.
   */
  _rmdirIfEmpty(lockDir, { tries = 12, ghosts = [], ident = null, stillStale = false } = {}) {
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (let i = 0; ; i++) {
      // The name could by now be a fresh iac 0.3.x lock, a bare dir that rmdir would take
      // for empty. A dir judged stale while bare (stillStale) must still look stale right
      // before the rmdir: a fresh dir's mtime is now, which no clock confuses with 30 s ago.
      // A dir this caller emptied itself is safe by construction: its unlink refreshed the
      // dir mtime, so nobody judges it stale for LOCK_STALE_MS and nothing replaces it. The
      // identity check (inode, birth time) is a further guard where the file system gives
      // one (NTFS file ids); ext4 reuses both within a few ms, so it is not relied on.
      if (ident || stillStale) {
        let st; try { st = fs.statSync(lockDir); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
        if (ident && (st.ino !== ident.ino || st.birthtimeMs !== ident.birthtimeMs)) return false;
        if (stillStale && this._lockNow() - st.mtimeMs <= LOCK_STALE_MS) return false;
      }
      try { fs.rmdirSync(lockDir); return true; } catch (e) {
        if (e.code === 'ENOENT') return false;
        let transient;
        if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST') {
          const now = this._lockEntries(lockDir);
          if (!now) return false;
          if (now.foreign.length || now.owners.some((t) => !ghosts.includes(t))) return false;   // theirs
          transient = true;
        } else transient = this._transientLockError(e);
        if (!transient || i >= tries) throw e;
        Atomics.wait(pause, 0, 0, 20);
      }
    }
  }

  /** One attempt at the lock: true when taken, false to retry, throws on timeout or a real error. */
  _tryLock(start, timeoutMs = LOCK_TIMEOUT_MS) {
    const lockDir = path.join(this.home, '.lock');
    let made;
    try { fs.mkdirSync(lockDir); made = fs.statSync(lockDir); } catch (e) {
      if (e.code === 'EEXIST') {
        try { this._breakStale(lockDir); } catch { /* lock changed under us; retry */ }
      } else if (!this._transientLockError(e)) throw e;
      if (Date.now() - start > timeoutMs) {
        const why = e.code === 'EEXIST' ? '' : ` (last attempt: ${e.code})`;
        const permissionHint = ['EPERM', 'EACCES'].includes(e.code)
          ? '; this can mean the process lacks access to the store; if it is outside writable paths, normal scoped filesystem approval may be needed (the error alone does not distinguish sandbox policy from ACL or sharing restrictions)'
          : '';
        const message = permissionHint && timeoutMs >= LOCK_TIMEOUT_MS
          ? `could not acquire store lock${why}${permissionHint}`
          : (timeoutMs >= LOCK_TIMEOUT_MS ? 'could not acquire store lock (stale .lock dir?)' : `store lock busy for ${timeoutMs} ms`) + why + permissionHint;
        throw Object.assign(new Error(message), { code: 'ELOCKBUSY' });
      }
      return false;
    }
    // The dir is ours only once our entry is its sole content. Our mkdir may have been
    // undone and redone by others between the mkdir and this write (a breaker removes an
    // empty dir it judges stale; a taker mkdirs again), so the entry could land in a dir
    // another taker also writes into: whoever sees another entry yields, and since a taker
    // only ever writes after its own mkdir, the one that saw itself alone saw it before the
    // other's write, and the other then sees both. At most one proceeds.
    const token = crypto.randomBytes(16).toString('hex');
    const owner = this._ownerPath(token, lockDir);
    const ident = { ino: made.ino, birthtimeMs: made.birthtimeMs };   // the directory object we made (see _rmdirIfEmpty)
    try {
      fs.writeFileSync(owner, JSON.stringify({ token, pid: process.pid, host: os.hostname(), since: new Date().toISOString() }), { flag: 'wx' });
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;   // the dir went: someone else's turn
      try { this._rmdirIfEmpty(lockDir, { tries: 0, ident }); } catch { /* not empty or busy: the next taker judges it */ }
      throw e;
    }
    const yieldIt = () => {
      let mine = false;
      try { fs.unlinkSync(owner); mine = true; } catch { /* gone with the dir */ }
      if (mine) try { this._rmdirIfEmpty(lockDir, { tries: 0, ghosts: [token], ident }); } catch { /* theirs now, or busy: the next taker judges it */ }
    };
    let entries;
    try { entries = this._lockEntries(lockDir); } catch (e) { yieldIt(); throw e; }
    // the sole entry must be ours: this process may have stalled past the stale limit between
    // its write and this look, and the one entry there now is the breaker's that replaced it
    if (!entries || entries.owners.length !== 1 || entries.owners[0] !== token || entries.foreign.length) { yieldIt(); return false; }
    this._lockToken = token; this._lockDirIdent = ident; this._lastBeat = Date.now();
    this.invalidate();
    this._clearOldAsides();
    return true;
  }

  /**
   * A mkdir error that means "busy, try again" rather than a real failure. ENOENT while the
   * store directory exists is a `.lock` still being deleted (delete-pending on drvfs with
   * Windows and WSL writers mixed); on Windows and drvfs, EPERM/EACCES/EBUSY are the same.
   */
  _transientLockError(e) {
    if (e.code === 'ENOENT') { try { return fs.statSync(this.home).isDirectory(); } catch { return false; } }
    if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) return false;
    return this._fs.platform === 'win32' || (this._fs.platform === 'linux' && /^\/mnt\/[a-z]\//i.test(this.home));
  }

  /** Remove `.lock.stale-*` dirs an earlier iac's breaker left behind (it crashed between rename and delete) once they are clearly old. */
  _clearOldAsides() {
    let names; try { names = fs.readdirSync(this.home); } catch { return; }
    for (const n of names) {
      if (!n.startsWith('.lock.stale-')) continue;
      const p = path.join(this.home, n);
      try { if (Date.now() - fs.statSync(p).mtimeMs > LOCK_ASIDE_MAX_AGE_MS) fs.rmSync(p, { recursive: true, force: true }); } catch { /* gone or busy: next time */ }
    }
  }

  /**
   * Release the lock: unlink our own entry by name (so a lock someone else holds, whatever
   * the dir looks like, is left in place, with a warning), then remove the dir only if that
   * left it empty.
   */
  _unlock() {
    const token = this._lockToken; this._lockToken = null; const ident = this._lockDirIdent; this._lockDirIdent = null;
    const lockDir = path.join(this.home, '.lock');
    // a look first, for the record only: what it shows can change before the unlink, which
    // is the one check that counts (it names our entry, so it fails rather than touch another's)
    let seen; try { seen = this._lockOwner(lockDir); } catch { seen = undefined; }
    const notOurs = () => {
      let cur; try { cur = this._lockOwner(lockDir); } catch { cur = seen; }
      this._warn(`iac: the store lock ${lockDir} is ${cur && cur.token !== token ? 'held by another process' : 'gone'}; not ours to release, left alone`);
    };
    if (!token) { notOurs(); return; }
    try { fs.unlinkSync(this._ownerPath(token, lockDir)); } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') { notOurs(); return; }
      throw e;
    }
    this._rmdirIfEmpty(lockDir, { ghosts: [token], ident });
  }
}

/** Every name init or add-agent ever writes to disk (human or agent) must match this. */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,31}$/;
/**
 * Windows device names. `keys/con.pem` or `seen/nul.json` opens the device, not a file, on
 * Windows (with or without an extension, in any case), so no name may be one of these.
 */
export const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)(\..*)?$/i;

/** Why `name` cannot be an agent or human name, or null when it can. */
export function nameProblem(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return `name must match ${NAME_RE}: ${name}`;
  if (WIN_RESERVED_RE.test(name)) return `name '${name}' is a reserved Windows device name (con, prn, aux, nul, com0-9, lpt0-9) and cannot name a key file`;
  return null;
}

const EVENT_TYPES = ['open', 'post', 'lock', 'unlock', 'close', 'project', 'wait-clear', 'repair'];
const isStr = (v) => typeof v === 'string';
const isStrArray = (v) => Array.isArray(v) && v.every(isStr);
/**
 * Why a parsed line cannot be replayed as an event, or null. Replay does date arithmetic and
 * string handling on these fields, so a parseable-but-wrong line must be set aside like a torn
 * one instead of throwing for the whole board. Extra fields are allowed.
 */
export function eventShapeProblem(ev) {
  if (!EVENT_TYPES.includes(ev.type)) return `unknown event type ${JSON.stringify(ev.type)}`;
  for (const f of ['id', 'thread', 'author', 'sig']) if (!isStr(ev[f]) || !ev[f]) return `missing or non-string ${f}`;
  const t = isStr(ev.ts) ? Date.parse(ev.ts) : NaN;
  if (!Number.isFinite(t)) return 'ts is not a valid date string';
  // fixed bounds only: validity must never depend on the reader's clock (a fast-clocked writer's signed post is still a post)
  if (t < Date.UTC(2000, 0, 1) || t > Date.UTC(9999, 11, 31)) return 'ts is outside the supported range (year 2000 to 9999)';
  if (ev.prev !== null && !isStr(ev.prev)) return 'prev is neither null nor a string';
  for (const f of ['instance', 'idSource', 'reason', 'project', 'issueUrl', 're']) if (ev[f] != null && !isStr(ev[f])) return `${f} is not a string`;
  for (const f of ['mentions', 'waitingOn']) if (ev[f] != null && !isStrArray(ev[f])) return `${f} is not a list of strings`;
  if (ev.type === 'open' && !isStr(ev.title)) return 'open event has no title';
  if (ev.type === 'open' || ev.type === 'post') {
    if (!isStr(ev.body)) return 'body is not a string';
    if (!KINDS.includes(ev.kind)) return `unknown post kind ${JSON.stringify(ev.kind)}`;
  }
  if (ev.type === 'project' && !isStr(ev.project)) return 'project event has no project';
  if (ev.type === 'wait-clear' && (!isStr(ev.post) || !isStr(ev.on))) return 'wait-clear needs post and on';
  if (ev.type === 'repair' && (!Number.isSafeInteger(ev.lines) || ev.lines < 1 || !isStr(ev.quarantine))) return 'repair needs a positive line count and quarantine filename';
  return null;
}

/** One parser for normal reads and repair classification; raw slices include CR/LF/BOM. */
function parseThread(id, bytes) {
  const events = []; const damaged = []; const keep = []; const removed = [];
  let start = 0; let line = 1;
  while (start < bytes.length) {
    const newline = bytes.indexOf(0x0a, start);
    const end = newline < 0 ? bytes.length : newline + 1;
    const raw = bytes.subarray(start, end);
    const text = line === 1 ? stripBom(raw.toString('utf8')) : raw.toString('utf8');
    let kind; let reason;
    if (text.trim()) {
      let ev; try { ev = JSON.parse(text); } catch { /* normal parser classifies below */ }
      if (!ev || typeof ev !== 'object' || Array.isArray(ev)) kind = 'unparseable';
      else { reason = eventShapeProblem(ev); if (reason) kind = 'malformed'; else events.push(ev); }
      if (kind) damaged.push({ thread: id, line, kind, ...(reason ? { reason } : {}) });
    }
    (kind === 'unparseable' ? removed : keep).push(raw);
    start = end; line++;
  }
  return { events, damaged, retained: Buffer.concat(keep), quarantine: Buffer.concat(removed) };
}

function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino && a.isDirectory() === b.isDirectory() && !b.isSymbolicLink(); }
/** O_NOFOLLOW where supported, plus lstat/fstat checks for Windows and path races. */
function readRegular(p) {
  const before = fs.lstatSync(p);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`repair refuses a linked or non-regular thread: ${p}`);
  const fd = fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || !sameFile(before, stat) || !sameFile(stat, fs.lstatSync(p))) throw new Error(`thread changed while opening: ${p}`);
    return { stat, bytes: fs.readFileSync(fd) };
  } finally { fs.closeSync(fd); }
}
function writeExclusive(p, bytes, mode) {
  const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), mode);
  try {
    fs.fchmodSync(fd, mode); // carry the source mode despite the process umask
    let offset = 0;
    while (offset < bytes.length) {
      const n = fs.writeSync(fd, bytes, offset, bytes.length - offset);
      if (!Number.isSafeInteger(n) || n <= 0 || n > bytes.length - offset) throw new Error(`write made no valid progress: ${p}`);
      offset += n;
    }
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
function syncDirectory(p) {
  // Native Windows does not support opening directories for fsync.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(p, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** A leading UTF-8 byte-order mark (Notepad and PowerShell 5 add one) is not part of the JSON. */
function stripBom(text) { return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; }

function seenName(subject) {
  return /^[a-z][a-z0-9_-]{1,31}$/.test(subject || '') && !WIN_RESERVED_RE.test(subject) ? subject : `instance-${Buffer.from(subject || '').toString('base64url')}`;
}

/** Defaults fill in only families the file does not name in any case: "Opus" overrides opus. */
function mergeFamilyHarness(own) {
  const mine = own && typeof own === 'object' ? own : {};
  const named = new Set(Object.keys(mine).map((k) => k.toLowerCase()));
  const defaults = Object.entries(DEFAULT_CONFIG.familyHarness).filter(([k]) => !named.has(k));
  return { ...Object.fromEntries(defaults), ...mine };
}
