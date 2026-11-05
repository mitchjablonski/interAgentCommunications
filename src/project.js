import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Rejected } from './rules.js';
import { envVar } from './env.js';

/** Normalise a git remote URL to owner/repo (host dropped for github.com, kept otherwise). */
export function slugFromRemote(url) {
  if (!url) return null;
  let m = url.trim().match(/^(?:git@|ssh:\/\/git@|https?:\/\/(?:[^@\/]+@)?)([^:\/]+)[:\/](.+?)(?:\.git)?\/?$/);
  if (!m) return null;
  const [, host, p] = m;
  return host === 'github.com' ? p : `${host}/${p}`;
}

/** Read paths (brief, inbox, hooks) must stay fast; a write can afford to wait for a slow checkout. */
export const READ_TIMEOUT_MS = 3000;
export const WRITE_TIMEOUT_MS = 10000;

// The last answer git gave per resolved cwd, for the life of the process. It is only a fallback
// for when git does not answer: a long-lived process (the MCP server) must see a remote added
// after it started, so every call asks git first. "Unknown" is never cached.
const cache = new Map();
export function clearProjectCache() { cache.clear(); }

/** The nearest directory at or above `dir` holding a .git (directory or file), else null. */
function findGitDir(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    try { fs.statSync(path.join(d, '.git')); return d; } catch {}
    if (path.dirname(d) === d) return null;
  }
}

/**
 * Ask git. Returns { project } when git answered (a remote, or a repo with no remote),
 * { project, weak: true } when git said "not a repo" or is not installed (a fallback that is
 * right unless a .git says otherwise), or { unknown: reason } when git did not answer: timed out,
 * was killed, or failed to run. Both calls share one deadline, so the worst case is `timeout`.
 * `now` and `spawn` are injectable so tests can exercise the deadline arithmetic (one budget
 * split across up to two calls) without real wall time or a real subprocess; they default to
 * the real clock and `spawnSync`.
 */
export function probe(cwd, timeout, { now = Date.now, spawn = spawnSync } = {}) {
  const deadline = now() + timeout;
  const run = (args) => {
    const left = deadline - now();
    if (left <= 0) return { error: Object.assign(new Error('deadline'), { code: 'ETIMEDOUT' }) };
    return spawn('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'ignore'], timeout: left, windowsHide: true });
  };
  const failed = (r) => {
    if (r.error?.code === 'ENOENT') return null;
    if (r.error) return r.error.code === 'ETIMEDOUT' ? `git did not answer within ${timeout} ms` : `git failed to run (${r.error.code || r.error.message})`;
    if (r.signal) return `git was killed (${r.signal})`;
    return null;
  };
  const fallback = { project: `local:${path.basename(cwd)}`, weak: true };
  const remote = run(['config', '--get', 'remote.origin.url']);
  let why = failed(remote);
  if (why) return { unknown: why };
  if (remote.error) return fallback;                       // no git on this machine
  // exit 0 with a value: a remote. exit 1: no such key. Anything else: git spoke, and said no.
  const slug = remote.status === 0 ? slugFromRemote(remote.stdout.toString()) : null;
  if (slug) return { project: slug };
  const top = run(['rev-parse', '--show-toplevel']);
  why = failed(top);
  if (why) return { unknown: why };
  const dir = top.status === 0 ? top.stdout.toString().trim() : '';
  return dir ? { project: `local:${path.basename(dir)}` } : fallback;
}

/**
 * Project id: explicit > IAC_PROJECT (or legacy AGORA_PROJECT) > git remote of cwd > local:<dirname>.
 * `write: true` is for choosing where a new thread goes: it waits longer for git, and refuses
 * (project-unknown) rather than file under local:<dir> when git has not answered, or when git
 * says "not a repo" although a .git sits at or above cwd (safe.directory / ownership refusals,
 * Windows git on \\wsl$, git not installed). Read paths (brief, hooks) fall back to the last
 * answer git gave for this cwd, then to local:<dir>, as before.
 */
export function detectProject({ explicit, cwd = process.cwd(), env = process.env, write = false, timeout, now, spawn } = {}) {
  if (explicit) return explicit;
  const pinned = envVar(env, 'PROJECT');
  if (pinned) return pinned;
  const key = path.resolve(cwd);
  const r = probe(key, timeout ?? (write ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS), { now, spawn });
  if (r.project && !r.weak) { cache.set(key, r.project); return r.project; }
  if (write) {
    const gitDir = r.project ? findGitDir(key) : null;
    if (!r.project || gitDir) {
      const reason = r.unknown || `${gitDir} has a .git, but git would not report the repository (safe.directory or ownership?)`;
      throw new Rejected('project-unknown', `cannot tell which project ${key} belongs to: ${reason}`,
        'pass --project owner/repo or set IAC_PROJECT');
    }
    return r.project;
  }
  if (r.unknown && cache.has(key)) return cache.get(key);
  return r.project || `local:${path.basename(key)}`;
}

export const UNSCOPED = 'unscoped';
export const GLOBAL = 'global';
