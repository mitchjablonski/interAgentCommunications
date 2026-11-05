import fs from 'node:fs';
import path from 'node:path';

export const HOOK_RECEIPT_FILE = 'iac-codex-hook-receipt.json';
const STATUSES = new Set(['no-payload', 'ignored-event', 'unattested-session', 'identity-rejected', 'brief-empty', 'brief-emitted', 'failure']);

// Why a session went unattested; written only with that status. Fixed enum, never a value.
export const REASONS = new Set(['no-session-id', 'bad-session-id', 'no-transcript-path', 'no-codex-home',
  'rollout-not-found', 'rollout-ambiguous', 'transcript-unresolvable', 'transcript-mismatch']);

// Runtime-owned ancestors must remain stable during this operation. Node has no portable
// dirfd-relative rename, so this is defensive local diagnostics, not an adversarial sandbox.
function safeDirectory(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) return null;
  // UNC/device paths can perform network I/O; drive-relative paths are not absolute.
  if (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(value)) return null;
  const parts = value.split(/[\\/]/);
  if (parts.includes('..') || parts.includes('.') || (process.platform === 'win32' && parts.slice(1).some(p => /[:]/.test(p) || /[. ]$/.test(p)))) return null;
  const resolved = path.resolve(value); const root = path.parse(resolved).root;
  let current = root;
  for (const part of ['', ...resolved.slice(root.length).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
  }
  return resolved;
}

function safeTarget(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !(stat.mode & 0o222) || stat.size > 200) return false;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const keys = Object.keys(value).join(',');
    const reasonOk = keys === 'schema,event,status,timestamp' ||
      (keys === 'schema,event,status,reason,timestamp' && value.status === 'unattested-session' && REASONS.has(value.reason));
    return reasonOk && value.schema === 1 &&
      value.event === 'codex-hook-invocation' && STATUSES.has(value.status) &&
      typeof value.timestamp === 'string' && new Date(value.timestamp).toISOString() === value.timestamp;
  } catch (e) { return e.code === 'ENOENT'; }
}

function sameFile(file, expected) {
  try { const stat = fs.lstatSync(file); return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.dev === expected.dev && stat.ino === expected.ino; }
  catch { return false; }
}

/** Best-effort, content-free last invocation only. Never receives stdin or identity data. */
export function writeHookReceipt(status, env = process.env, reason) {
  let fd; let temporary; let owned = false; let staged;
  try {
    if (!STATUSES.has(status)) return;
    if (reason !== undefined && !(status === 'unattested-session' && REASONS.has(reason))) reason = undefined;
    const base = safeDirectory(env.PLUGIN_DATA); if (!base) return;
    const child = path.join(base, 'iac-hook-receipt');
    try { fs.mkdirSync(child, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') return; }
    const directory = safeDirectory(child); if (!directory) return;
    const target = path.join(directory, HOOK_RECEIPT_FILE);
    temporary = `${target}.tmp`;
    if (!safeTarget(target)) return;
    // One fixed exclusive staging slot bounds retention and makes concurrent invocations skip.
    // An abandoned slot is left alone; never remove a file owned by another invocation.
    fd = fs.openSync(temporary, 'wx', 0o600); owned = true;
    const stat = fs.fstatSync(fd); staged = stat;
    if (!stat.isFile() || stat.nlink !== 1) return;
    const receipt = { schema: 1, event: 'codex-hook-invocation', status, ...(reason ? { reason } : {}), timestamp: new Date().toISOString() };
    fs.writeFileSync(fd, `${JSON.stringify(receipt)}\n`); fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    if (safeDirectory(child) !== directory || !safeTarget(target) || !sameFile(temporary, staged)) return;
    fs.renameSync(temporary, target); owned = false;
  } catch {} // Diagnostics must never change hook output or exit status.
  finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    if (owned && staged && sameFile(temporary, staged)) { try { fs.unlinkSync(temporary); } catch {} }
  }
}
