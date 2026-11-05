import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeHookReceipt, HOOK_RECEIPT_FILE } from '../src/hook-receipt.js';
import { Agora } from '../src/api.js';

const bin = fileURLToPath(new URL('../bin/iac.js', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-receipt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, directory: path.join(root, 'iac-hook-receipt'), file: path.join(root, 'iac-hook-receipt', HOOK_RECEIPT_FILE) };
}
function check(file, status, reason) {
  const raw = fs.readFileSync(file, 'utf8'); const value = JSON.parse(raw);
  assert.deepEqual(Object.keys(value), reason ? ['schema', 'event', 'status', 'reason', 'timestamp'] : ['schema', 'event', 'status', 'timestamp']);
  if (reason) assert.ok(REASONS.has(value.reason));
  assert.equal(value.schema, 1); assert.equal(value.event, 'codex-hook-invocation');
  assert.equal(value.status, status); assert.equal(new Date(value.timestamp).toISOString(), value.timestamp);
  assert.ok(raw.length < 200); return raw;
}

test('receipt: fixed content-free schema, latest only, private mode and no environment attribution', t => {
  const { root, directory, file } = fixture(t);
  for (const status of ['no-payload', 'ignored-event', 'unattested-session', 'identity-rejected', 'brief-empty', 'brief-emitted', 'failure']) {
    writeHookReceipt(status, { PLUGIN_DATA: root, CODEX_THREAD_ID: 'SECRET', PROMPT: 'SECRET' });
    assert.ok(!check(file, status).includes('SECRET'));
    assert.deepEqual(fs.readdirSync(directory), [HOOK_RECEIPT_FILE]);
  }
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const previous = fs.readFileSync(file, 'utf8');
  writeHookReceipt('SECRET', { PLUGIN_DATA: root });
  assert.equal(fs.readFileSync(file, 'utf8'), previous);
});

test('receipt: absent, relative, traversal, missing and non-directory bases fail closed', t => {
  const { root, file } = fixture(t);
  const regular = path.join(root, 'regular'); fs.writeFileSync(regular, 'untouched');
  for (const value of [undefined, '', '.', 'relative', path.join(root, 'missing'), regular, `${root}${path.sep}..${path.sep}${path.basename(root)}`]) {
    assert.doesNotThrow(() => writeHookReceipt('failure', { PLUGIN_DATA: value }));
    assert.equal(fs.existsSync(file), false);
  }
  assert.equal(fs.readFileSync(regular, 'utf8'), 'untouched');
});

test('receipt: unsafe destination, hardlink, staging slot and readonly target never changed', t => {
  const { root, directory, file } = fixture(t); fs.mkdirSync(directory);
  const other = path.join(root, 'other'); fs.writeFileSync(other, 'untouched');
  fs.linkSync(other, file); writeHookReceipt('failure', { PLUGIN_DATA: root });
  assert.equal(fs.readFileSync(other, 'utf8'), 'untouched'); fs.unlinkSync(file);
  fs.writeFileSync(file, 'unrelated'); writeHookReceipt('failure', { PLUGIN_DATA: root });
  assert.equal(fs.readFileSync(file, 'utf8'), 'unrelated'); fs.unlinkSync(file);
  fs.mkdirSync(file); writeHookReceipt('failure', { PLUGIN_DATA: root }); assert.ok(fs.statSync(file).isDirectory()); fs.rmdirSync(file);
  fs.writeFileSync(`${file}.tmp`, 'untouched'); writeHookReceipt('failure', { PLUGIN_DATA: root });
  assert.equal(fs.existsSync(file), false); assert.equal(fs.readFileSync(`${file}.tmp`, 'utf8'), 'untouched'); fs.unlinkSync(`${file}.tmp`);
  fs.writeFileSync(file, 'readonly'); fs.chmodSync(file, 0o444);
  try { writeHookReceipt('failure', { PLUGIN_DATA: root }); assert.equal(fs.readFileSync(file, 'utf8'), 'readonly'); }
  finally { fs.chmodSync(file, 0o600); }
});

test('receipt: symlink or junction component and symlink destination are refused', t => {
  const { root, file } = fixture(t); const actual = path.join(root, 'actual'); fs.mkdirSync(actual);
  const alias = path.join(root, 'alias'); fs.symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
  writeHookReceipt('failure', { PLUGIN_DATA: alias }); assert.deepEqual(fs.readdirSync(actual), []);
  fs.mkdirSync(path.dirname(file));
  // Windows directory junction exercises the target rejection without requiring symlink privilege.
  fs.symlinkSync(actual, file, process.platform === 'win32' ? 'junction' : 'dir');
  writeHookReceipt('failure', { PLUGIN_DATA: root }); assert.ok(fs.lstatSync(file).isSymbolicLink());
});

test('receipt: real hook invalid/empty/unattested payload stays silent and never persists payload', t => {
  const { root, file } = fixture(t);
  const env = { ...process.env, PLUGIN_DATA: root, IAC_HOME: path.join(root, 'absent-store'), CODEX_THREAD_ID: 'SECRET', CODEX_SESSION_ID: 'SECRET' };
  for (const [input, status] of [['', 'no-payload'], ['{SECRET', 'no-payload'], [JSON.stringify({ hook_event_name: 'SECRET', prompt: 'SECRET' }), 'ignored-event'], [JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'SECRET', transcript_path: 'SECRET', prompt: 'SECRET' }), 'unattested-session']]) {
    const result = spawnSync(process.execPath, [bin, 'codex-hook'], { env, input, encoding: 'utf8', timeout: 10000 });
    assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', '']);
    assert.ok(!check(file, status, status === 'unattested-session').includes('SECRET')); assert.equal(fs.existsSync(env.IAC_HOME), false);
  }
});

test('receipt: concurrent invocations retain one complete receipt with bounded staging', async t => {
  const { root, directory, file } = fixture(t);
  const source = `import { writeHookReceipt } from ${JSON.stringify(new URL('../src/hook-receipt.js', import.meta.url).href)}; writeHookReceipt('failure');`;
  await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, PLUGIN_DATA: root }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
    child.on('error', reject); child.on('exit', code => { try { assert.equal(code, 0); assert.equal(output, ''); resolve(); } catch (e) { reject(e); } });
  })));
  check(file, 'failure'); assert.deepEqual(fs.readdirSync(directory), [HOOK_RECEIPT_FILE]);
});

test('receipt: attested CLI empty/nonempty brief, identity rejection and thrown failure stay content-free and board-read-only', async t => {
  const { root, file } = fixture(t);
  const home = path.join(root, 'board'); const codex = path.join(root, 'codex');
  const sessions = path.join(codex, 'sessions'); fs.mkdirSync(sessions, { recursive: true });
  const session = 'receipt-private-session'; const model = 'gpt-6.1-sol';
  const transcript = path.join(sessions, `rollout-2026-10-20-${session}.jsonl`);
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'session_meta', payload: { id: session } })}\n${JSON.stringify({ type: 'turn_context', payload: { model } })}\n`);
  const a = new Agora(home, { env: { IAC_PROJECT: 'global' } });
  a.init({ agents: ['sol'], human: 'ada' }); a.setFamilyModels('sol', [model]); a.setFamilyHarness('sol', 'codex');
  const env = { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: codex, IAC_HOME: home, PLUGIN_DATA: root,
    IAC_PROJECT: 'global', AGORA_PROJECT: '', IAC_AGENT: '', AGORA_AGENT: '', IAC_INSTANCE: '', AGORA_INSTANCE: '',
    CODEX_THREAD_ID: 'inherited-private-session', CODEX_SESSION_ID: 'inherited-private-session', CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '' };
  const input = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: session, transcript_path: transcript,
    cwd: root, prompt: 'PRIVATE-PROMPT-NEVER-PERSIST', injected_error: 'PRIVATE-ERROR-NEVER-PERSIST' });
  const snapshot = () => {
    const files = {};
    const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute); else files[path.relative(home, absolute)] = fs.readFileSync(absolute).toString('base64');
    } };
    walk(home); return files;
  };
  const run = (status, { binding, thrown = false, expected = '' } = {}) => {
    const before = snapshot();
    // Inject a failing cwd lookup only after imports: exercise the exported CLI entry point's
    // catch/finally wiring with a free-form error containing deliberately private input.
    const program = `import { main } from ${JSON.stringify(new URL('../src/cli.js', import.meta.url).href)}; process.cwd = () => { throw new Error('PRIVATE-ERROR-NEVER-PERSIST'); }; process.exitCode = await main(['codex-hook']);`;
    const result = spawnSync(process.execPath, thrown ? ['--input-type=module', '-e', program] : [bin, 'codex-hook'],
      { env: { ...env, IAC_AGENT: binding || '' }, input, encoding: 'utf8', timeout: 10000 });
    assert.deepEqual([result.status, result.stderr], [0, '']);
    if (expected instanceof RegExp) assert.match(result.stdout, expected); else assert.equal(result.stdout, expected);
    const raw = check(file, status);
    for (const secret of [session, root, transcript, model, 'PRIVATE-PROMPT-NEVER-PERSIST', 'PRIVATE-ERROR-NEVER-PERSIST', 'inherited-private-session']) assert.ok(!raw.includes(secret));
    assert.deepEqual(snapshot(), before, 'hook never changes board files');
  };
  run('brief-empty');
  await a.open({ as: 'ada', title: 'receipt fixture', body: 'waiting', waitingOn: ['sol'], project: 'global' });
  run('brief-emitted', { expected: /^iac\[sol#sol-receipt-private-session [^\]]*\]: waiting on sol/ });
  run('identity-rejected', { binding: 'other', expected: 'iac: identity conflict (stale-binding) — run iac whoami\n' });
  run('failure', { thrown: true });
});

// --- optional fixed-enum `reason`, only with unattested-session ---
import { codexHookSessionDetail, codexHookSession } from '../src/codex-hook.js';
import { REASONS } from '../src/hook-receipt.js';

const SID = 'sess-SECRETID-1';
function rollout(codex, id = SID, name = `rollout-2026-01-01T00-00-00-${id}.jsonl`, dir = 'sessions/2026') {
  const d = path.join(codex, dir); fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, name);
  fs.writeFileSync(f, `${JSON.stringify({ type: 'session_meta', payload: { id } })}\n`);
  return fs.realpathSync(f);
}
function codexFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-reason-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codex = path.join(root, 'codex'); fs.mkdirSync(codex);
  return { root, codex, env: { CODEX_HOME: codex } };
}

test('reason: each failed check maps to its fixed enum value; success and wrapper contract unchanged', t => {
  const { root, codex, env } = codexFixture(t);
  const none = codexHookSessionDetail;
  assert.deepEqual(none({}, env), { reason: 'no-session-id' });
  assert.deepEqual(none({ session_id: 7, transcript_path: 'x' }, env), { reason: 'no-session-id' });
  assert.deepEqual(none({ session_id: 'bad/id', transcript_path: 'x' }, env), { reason: 'bad-session-id' });
  assert.deepEqual(none({ session_id: SID }, env), { reason: 'no-transcript-path' });
  assert.deepEqual(none({ session_id: SID, transcript_path: '' }, env), { reason: 'no-transcript-path' });
  assert.deepEqual(none({ session_id: SID, transcript_path: 'x' }, { CODEX_HOME: 'relative/home' }), { reason: 'no-codex-home' });
  assert.deepEqual(none({ session_id: SID, transcript_path: 'x' }, env), { reason: 'rollout-not-found' });
  const real = rollout(codex);
  assert.deepEqual(none({ session_id: SID, transcript_path: path.join(root, 'missing.jsonl') }, env), { reason: 'transcript-unresolvable' });
  const other = path.join(root, 'other.jsonl'); fs.writeFileSync(other, 'x');
  assert.deepEqual(none({ session_id: SID, transcript_path: other }, env), { reason: 'transcript-mismatch' });
  assert.deepEqual(none({ session_id: SID, transcript_path: real }, env), { session: SID });
  assert.equal(codexHookSession({ session_id: SID, transcript_path: real }, env), SID);
  assert.equal(codexHookSession({ session_id: SID, transcript_path: other }, env), null);
  rollout(codex, SID, `rollout-2026-01-02T00-00-00-${SID}.jsonl`, 'sessions/2027');
  assert.deepEqual(none({ session_id: SID, transcript_path: real }, env), { reason: 'rollout-ambiguous' });
  assert.equal(codexHookSession({ session_id: SID, transcript_path: real }, env), null);
  for (const v of [none({}, env), none({ session_id: 'a/b' }, env)]) assert.ok(REASONS.has(v.reason));
});

test('reason: receipt records only the enum, only with unattested-session, content-free', t => {
  const { root, directory, file } = fixture(t);
  for (const reason of REASONS) {
    writeHookReceipt('unattested-session', { PLUGIN_DATA: root, CODEX_HOME: SID }, reason);
    const raw = fs.readFileSync(file, 'utf8'); const value = JSON.parse(raw);
    assert.deepEqual(Object.keys(value), ['schema', 'event', 'status', 'reason', 'timestamp']);
    assert.equal(value.schema, 1); assert.equal(value.status, 'unattested-session'); assert.equal(value.reason, reason);
    assert.ok(!raw.includes(SID) && !raw.includes(root) && !raw.includes(path.sep + 'tmp'));
    assert.ok(raw.length < 200);
    assert.deepEqual(fs.readdirSync(directory), [HOOK_RECEIPT_FILE]);
  }
  // Another status never carries a reason; unknown reasons are dropped, not written.
  writeHookReceipt('brief-emitted', { PLUGIN_DATA: root }, 'no-session-id'); check(file, 'brief-emitted');
  writeHookReceipt('unattested-session', { PLUGIN_DATA: root }, '/home/x/secret'); check(file, 'unattested-session');
  writeHookReceipt('unattested-session', { PLUGIN_DATA: root }); check(file, 'unattested-session');
});

test('reason: reader accepts old receipts and valid reasons, rejects unknown reasons and misplaced reason', t => {
  const { root, directory, file } = fixture(t); fs.mkdirSync(directory);
  const ts = '2020-01-01T00:00:00.000Z';
  const put = (obj) => { fs.rmSync(file, { force: true }); fs.writeFileSync(file, `${JSON.stringify(obj)}\n`); };
  const base = { schema: 1, event: 'codex-hook-invocation' };
  const replaced = () => JSON.parse(fs.readFileSync(file, 'utf8')).timestamp !== ts;
  put({ ...base, status: 'failure', timestamp: ts }); writeHookReceipt('brief-empty', { PLUGIN_DATA: root });
  assert.ok(replaced(), 'old receipt without reason is a valid prior target');
  put({ ...base, status: 'unattested-session', reason: 'no-session-id', timestamp: ts }); writeHookReceipt('brief-empty', { PLUGIN_DATA: root });
  assert.ok(replaced(), 'valid reason accepted');
  for (const bad of [{ status: 'unattested-session', reason: 'whatever' }, { status: 'failure', reason: 'no-session-id' }, { status: 'unattested-session', reason: '' }]) {
    put({ ...base, ...bad, timestamp: ts }); writeHookReceipt('brief-empty', { PLUGIN_DATA: root });
    assert.ok(!replaced(), `unknown or misplaced reason refused: ${JSON.stringify(bad)}`);
  }
});

test('reason: codex-hook CLI writes the reason for a synthetic unattested payload', t => {
  const { root, file } = fixture(t); const codex = path.join(root, 'codex'); fs.mkdirSync(codex);
  const run = (payload, extra = {}) => spawnSync(process.execPath, [bin, 'codex-hook'], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, PLUGIN_DATA: root, CODEX_HOME: codex, CODEX_THREAD_ID: '', CODEX_SESSION_ID: '', ...extra } });
  const r = run({ hook_event_name: 'UserPromptSubmit', transcript_path: 'x' });
  assert.equal(r.status, 0); assert.equal(r.stdout, '');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).reason, 'no-session-id');
  run({ hook_event_name: 'UserPromptSubmit', session_id: SID, transcript_path: 'x' }, { CODEX_HOME: 'relative' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).reason, 'no-codex-home');
});

// Frozen legacy writer data is verified before isolated hosted-fixture import.
import { createHash as receiptProposalSha1 } from 'node:crypto';
import { pathToFileURL as receiptProposalFileUrl } from 'node:url';

const LEGACY_RECEIPT_SOURCE = [
  "import fs from 'node:fs';\n",
  "import path from 'node:path';\n",
  "\n",
  "export const HOOK_RECEIPT_FILE = 'iac-codex-hook-receipt.json';\n",
  "const STATUSES = new Set(['no-payload', 'ignored-event', 'unattested-session', 'identity-rejected', 'brief-empty', 'brief-emitted', 'failure']);\n",
  "\n",
  "// Runtime-owned ancestors must remain stable during this operation. Node has no portable\n",
  "// dirfd-relative rename, so this is defensive local diagnostics, not an adversarial sandbox.\n",
  "function safeDirectory(value) {\n",
  "  if (typeof value !== 'string' || !value || value.includes('\\0') || !path.isAbsolute(value)) return null;\n",
  "  // UNC/device paths can perform network I/O; drive-relative paths are not absolute.\n",
  "  if (process.platform === 'win32' && !/^[A-Za-z]:[\\\\/]/.test(value)) return null;\n",
  "  const parts = value.split(/[\\\\/]/);\n",
  "  if (parts.includes('..') || parts.includes('.') || (process.platform === 'win32' && parts.slice(1).some(p => /[:]/.test(p) || /[. ]$/.test(p)))) return null;\n",
  "  const resolved = path.resolve(value); const root = path.parse(resolved).root;\n",
  "  let current = root;\n",
  "  for (const part of ['', ...resolved.slice(root.length).split(path.sep).filter(Boolean)]) {\n",
  "    if (part) current = path.join(current, part);\n",
  "    const stat = fs.lstatSync(current);\n",
  "    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;\n",
  "  }\n",
  "  return resolved;\n",
  "}\n",
  "\n",
  "function safeTarget(file) {\n",
  "  try {\n",
  "    const stat = fs.lstatSync(file);\n",
  "    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !(stat.mode & 0o222) || stat.size > 200) return false;\n",
  "    const value = JSON.parse(fs.readFileSync(file, 'utf8'));\n",
  "    return Object.keys(value).join(',') === 'schema,event,status,timestamp' && value.schema === 1 &&\n",
  "      value.event === 'codex-hook-invocation' && STATUSES.has(value.status) &&\n",
  "      typeof value.timestamp === 'string' && new Date(value.timestamp).toISOString() === value.timestamp;\n",
  "  } catch (e) { return e.code === 'ENOENT'; }\n",
  "}\n",
  "\n",
  "function sameFile(file, expected) {\n",
  "  try { const stat = fs.lstatSync(file); return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.dev === expected.dev && stat.ino === expected.ino; }\n",
  "  catch { return false; }\n",
  "}\n",
  "\n",
  "/** Best-effort, content-free last invocation only. Never receives stdin or identity data. */\n",
  "export function writeHookReceipt(status, env = process.env) {\n",
  "  let fd; let temporary; let owned = false; let staged;\n",
  "  try {\n",
  "    if (!STATUSES.has(status)) return;\n",
  "    const base = safeDirectory(env.PLUGIN_DATA); if (!base) return;\n",
  "    const child = path.join(base, 'iac-hook-receipt');\n",
  "    try { fs.mkdirSync(child, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') return; }\n",
  "    const directory = safeDirectory(child); if (!directory) return;\n",
  "    const target = path.join(directory, HOOK_RECEIPT_FILE);\n",
  "    temporary = `${target}.tmp`;\n",
  "    if (!safeTarget(target)) return;\n",
  "    // One fixed exclusive staging slot bounds retention and makes concurrent invocations skip.\n",
  "    // An abandoned slot is left alone; never remove a file owned by another invocation.\n",
  "    fd = fs.openSync(temporary, 'wx', 0o600); owned = true;\n",
  "    const stat = fs.fstatSync(fd); staged = stat;\n",
  "    if (!stat.isFile() || stat.nlink !== 1) return;\n",
  "    const receipt = { schema: 1, event: 'codex-hook-invocation', status, timestamp: new Date().toISOString() };\n",
  "    fs.writeFileSync(fd, `${JSON.stringify(receipt)}\\n`); fs.fsyncSync(fd);\n",
  "    fs.closeSync(fd); fd = undefined;\n",
  "    if (safeDirectory(child) !== directory || !safeTarget(target) || !sameFile(temporary, staged)) return;\n",
  "    fs.renameSync(temporary, target); owned = false;\n",
  "  } catch {} // Diagnostics must never change hook output or exit status.\n",
  "  finally {\n",
  "    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }\n",
  "    if (owned && staged && sameFile(temporary, staged)) { try { fs.unlinkSync(temporary); } catch {} }\n",
  "  }\n",
  "}\n",
].join('');
const LEGACY_RECEIPT_BLOB = '4e0eb2aad403efa314dba42be817fec4d35e5c92';
const RECEIPT_PROPOSAL_STATUSES = ['no-payload', 'ignored-event', 'unattested-session', 'identity-rejected', 'brief-empty', 'brief-emitted', 'failure'];
const RECEIPT_PROPOSAL_TS = '2020-01-01T00:00:00.000Z';
function receiptProposalBytes(file) { return fs.existsSync(file) ? fs.readFileSync(file) : null; }
function receiptProposalSeed(file, value, padding = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}${padding}`);
}
function receiptProposalRecord(status = 'failure') {
  return { schema: 1, event: 'codex-hook-invocation', status, timestamp: RECEIPT_PROPOSAL_TS };
}
function receiptProposalHookPayload(markers = {}) {
  return { hook_event_name: 'UserPromptSubmit', session_id: SID, transcript_path: 'synthetic-untrusted.jsonl', ...markers };
}
function receiptProposalHookRun(root, payload) {
  return spawnSync(process.execPath, [bin, 'codex-hook'], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PLUGIN_DATA: root, IAC_HOME: path.join(root, 'absent-store'), CODEX_HOME: path.join(root, 'absent-codex'),
      CODEX_THREAD_ID: '', CODEX_SESSION_ID: '', IAC_AGENT: '', AGORA_AGENT: '' }
  });
}

test('receipt: marked hook matrix preserves the receipt and stays silent', t => {
  const { root, directory, file } = fixture(t);
  const prior = receiptProposalRecord('brief-emitted'); receiptProposalSeed(file, prior, '\n');
  const before = receiptProposalBytes(file);
  const values = [null, '', 7, false, {}, [], 'unknown', 'subagent'];
  const cases = [];
  for (const value of values) { cases.push({ agent_id: value }); cases.push({ agent_type: value }); cases.push({ agent_id: value, agent_type: value }); }
  cases.push({ agent_id: 'different', agent_type: 'unknown' }, { agent_id: SID, session_id: 'wrong', transcript_path: null },
    { agent_type: 'subagent', session_id: null, transcript_path: [] });
  for (const marker of cases) {
    const r = receiptProposalHookRun(root, receiptProposalHookPayload(marker));
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
    assert.deepEqual(receiptProposalBytes(file), before);
    assert.deepEqual(fs.readdirSync(directory), [HOOK_RECEIPT_FILE]);
  }
  for (const raw of [
    '{"hook_event_name":"UserPromptSubmit","agent_id":"x","agent_id":null}',
    '{"hook_event_name":"UserPromptSubmit","agent_id":null,"agent_id":"x"}',
    '{"hook_event_name":"UserPromptSubmit","agent\\u005ftype":"x"}'
  ]) {
    const r = receiptProposalHookRun(root, raw);
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
    assert.deepEqual(receiptProposalBytes(file), before);
  }
});

test('receipt: marked hook skips preserve absence, malformed and every supported old/new record', t => {
  const { root, directory, file } = fixture(t);
  const rawRecords = [...RECEIPT_PROPOSAL_STATUSES.map(s => JSON.stringify(receiptProposalRecord(s))),
    ...[...REASONS].map(reason => JSON.stringify({ schema: 1, event: 'codex-hook-invocation', status: 'unattested-session', reason, timestamp: RECEIPT_PROPOSAL_TS }))];
  const cases = [null, Buffer.from('{bad'), Buffer.from('null'), Buffer.from('[]'), Buffer.from(JSON.stringify({ status: 'unknown' })),
    Buffer.alloc(201, 0x20), ...rawRecords.map(s => Buffer.from(s))];
  for (const initial of cases) {
    fs.rmSync(directory, { recursive: true, force: true });
    if (initial) { fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(file, initial); }
    const before = receiptProposalBytes(file);
    const r = receiptProposalHookRun(root, receiptProposalHookPayload({ agent_id: 'anything' }));
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
    assert.deepEqual(receiptProposalBytes(file), before);
    assert.equal(fs.existsSync(`${file}.tmp`), false);
    assert.equal(fs.existsSync(directory), Boolean(before));
  }
});

test('receipt: each legacy status and reason is accepted; skipped status is rejected', t => {
  const { root, file } = fixture(t); fs.mkdirSync(path.dirname(file), { recursive: true });
  const expectedStatuses = ['no-payload', 'ignored-event', 'unattested-session', 'identity-rejected', 'brief-empty', 'brief-emitted', 'failure'];
  const expectedReasons = ['no-session-id', 'bad-session-id', 'no-transcript-path', 'no-codex-home', 'rollout-not-found', 'rollout-ambiguous', 'transcript-unresolvable', 'transcript-mismatch'];
    assert.deepEqual([...REASONS].sort(), [...expectedReasons].sort());
  for (const status of expectedStatuses) {
    receiptProposalSeed(file, receiptProposalRecord('failure'), '\n');
    writeHookReceipt(status, { PLUGIN_DATA: root });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).status, status);
  }
  for (const reason of expectedReasons) {
    receiptProposalSeed(file, receiptProposalRecord('failure'), '\n');
    writeHookReceipt('unattested-session', { PLUGIN_DATA: root }, reason);
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(value), ['schema', 'event', 'status', 'reason', 'timestamp']);
    assert.equal(value.status, 'unattested-session'); assert.equal(value.reason, reason);
  }
  for (const reason of [undefined, 'no-session-id']) {
    receiptProposalSeed(file, receiptProposalRecord('failure'), '\n'); const before = receiptProposalBytes(file);
    writeHookReceipt('subagent-skipped', { PLUGIN_DATA: root }, reason);
    assert.deepEqual(receiptProposalBytes(file), before);
  }
  for (const reason of [undefined, 'no-session-id']) {
    receiptProposalSeed(file, receiptProposalRecord('failure'), '\n'); const beforeIncoming = receiptProposalBytes(file);
    writeHookReceipt('subagent-skipped', { PLUGIN_DATA: root }, reason); assert.deepEqual(receiptProposalBytes(file), beforeIncoming);
    const unsupported = { schema: 1, event: 'codex-hook-invocation', status: 'subagent-skipped', timestamp: RECEIPT_PROPOSAL_TS, ...(reason ? { reason } : {}) };
    receiptProposalSeed(file, unsupported, '\n'); const before = receiptProposalBytes(file);
    writeHookReceipt('brief-empty', { PLUGIN_DATA: root });
    assert.deepEqual(receiptProposalBytes(file), before);
  }
  assert.deepEqual([...REASONS].sort(), [...expectedReasons].sort());
});
test('receipt: malformed target matrix, exact byte boundary and supported file modes', t => {
  const { root, directory, file } = fixture(t); fs.mkdirSync(directory, { recursive: true });
  const valid4 = receiptProposalRecord('failure');
  const valid5 = { schema: 1, event: 'codex-hook-invocation', status: 'unattested-session', reason: [...REASONS][0], timestamp: RECEIPT_PROPOSAL_TS };
  const invalid = [
    { event: valid4.event, status: valid4.status, timestamp: valid4.timestamp },
    { schema: 1, status: valid4.status, timestamp: valid4.timestamp },
    { schema: 1, event: valid4.event, timestamp: valid4.timestamp },
    { schema: 1, event: valid4.event, status: valid4.status },
    { ...valid4, schema: '1' }, { ...valid4, schema: null }, { ...valid4, schema: 2 },
    { ...valid4, event: 'wrong' }, { ...valid4, event: 1 }, { ...valid4, event: null },
    { ...valid4, status: 'unknown' }, { ...valid4, status: 7 }, { ...valid4, status: null },
    { ...valid4, extra: true }, { status: valid4.status, schema: 1, event: valid4.event, timestamp: valid4.timestamp },
    { schema: 1, event: valid5.event, status: valid5.status, timestamp: valid5.timestamp, reason: valid5.reason },
    { ...valid5, reason: 'unknown' }, { ...valid5, reason: '' }, { ...valid5, reason: 7 }, { ...valid5, reason: null },
    { ...valid5, status: 'failure' }, { ...valid4, reason: 'no-session-id' },
    { schema: 1, event: valid5.event, reason: valid5.reason, status: valid5.status, timestamp: valid5.timestamp },
    { ...valid4, timestamp: '2020-01-01' }, { ...valid4, timestamp: '2020-01-01T00:00:00Z' },
    { ...valid4, timestamp: 'not-a-date' }, { ...valid4, timestamp: 1 }, { ...valid4, timestamp: null },
    null, [], 7, false, 'not-json'
  ];
  for (const bad of invalid) {
    fs.rmSync(file, { force: true });
    const value = typeof bad === 'string' ? bad : JSON.stringify(bad); fs.writeFileSync(file, value);
    const before = receiptProposalBytes(file); writeHookReceipt('brief-empty', { PLUGIN_DATA: root });
    assert.deepEqual(receiptProposalBytes(file), before);
  }
  // Pad valid canonical JSON with legal trailing whitespace to exact byte caps.
  for (const [size, accepted] of [[200, true], [201, false]]) {
    fs.rmSync(file, { force: true });
    const json = JSON.stringify(valid4); assert.ok(Buffer.byteLength(json + '\n') <= size);
    fs.writeFileSync(file, json + ' '.repeat(size - Buffer.byteLength(json)));
    const before = receiptProposalBytes(file); writeHookReceipt('brief-empty', { PLUGIN_DATA: root });
    assert.equal(receiptProposalBytes(file).equals(before), !accepted);
    if (accepted) assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).status, 'brief-empty');
  }
  fs.rmSync(file, { force: true }); fs.writeFileSync(file, JSON.stringify(valid4)); fs.chmodSync(file, 0o444);
  const before = receiptProposalBytes(file);
  try { writeHookReceipt('brief-empty', { PLUGIN_DATA: root }); assert.deepEqual(receiptProposalBytes(file), before); }
  finally { fs.chmodSync(file, 0o600); }
});

test('receipt: unsafe links, directories, bases and occupied staging remain untouched', t => {
  const { root, directory, file } = fixture(t); fs.mkdirSync(directory, { recursive: true });
  const marked = () => {
    const result = receiptProposalHookRun(root, receiptProposalHookPayload({ agent_type: null }));
    assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', '']);
  };
  const source = path.join(root, 'source'); fs.writeFileSync(source, JSON.stringify(receiptProposalRecord()));
  const link = path.join(root, 'hardlink'); fs.linkSync(source, link); fs.rmSync(file, { force: true }); fs.linkSync(source, file);
  const linked = receiptProposalBytes(source); marked();
  assert.deepEqual(receiptProposalBytes(source), linked); assert.deepEqual(receiptProposalBytes(file), linked);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  writeHookReceipt('brief-empty', { PLUGIN_DATA: root });
  assert.deepEqual(receiptProposalBytes(source), linked); fs.rmSync(file);
  fs.writeFileSync(file, JSON.stringify(receiptProposalRecord()));
  if (process.platform !== 'win32') {
    const alias = path.join(root, 'alias'); fs.symlinkSync(directory, alias, 'dir');
    const prior = receiptProposalBytes(file); const entries = fs.readdirSync(directory); writeHookReceipt('brief-empty', { PLUGIN_DATA: alias }); assert.deepEqual(receiptProposalBytes(file), prior); assert.deepEqual(fs.readdirSync(directory), entries);
    fs.rmSync(file); fs.symlinkSync(source, file); marked();
    assert.ok(fs.lstatSync(file).isSymbolicLink()); assert.deepEqual(receiptProposalBytes(source), linked);
    assert.equal(fs.existsSync(`${file}.tmp`), false);
    writeHookReceipt('brief-empty', { PLUGIN_DATA: root }); assert.ok(fs.lstatSync(file).isSymbolicLink());
    fs.rmSync(file);
  } else {
    fs.rmSync(file); const actual = path.join(root, 'junction-target'); fs.mkdirSync(actual);
    fs.symlinkSync(actual, file, 'junction'); marked();
    assert.ok(fs.lstatSync(file).isSymbolicLink()); assert.deepEqual(fs.readdirSync(actual), []);
    assert.equal(fs.existsSync(`${file}.tmp`), false);
    writeHookReceipt('brief-empty', { PLUGIN_DATA: root });
    assert.ok(fs.lstatSync(file).isSymbolicLink()); assert.deepEqual(fs.readdirSync(actual), []);
    fs.unlinkSync(file);
  }
  fs.rmSync(file, { force: true });
  fs.mkdirSync(file); writeHookReceipt('brief-empty', { PLUGIN_DATA: root }); assert.ok(fs.statSync(file).isDirectory()); fs.rmdirSync(file);
  fs.writeFileSync(`${file}.tmp`, 'owned elsewhere'); marked();
  assert.equal(fs.existsSync(file), false); assert.equal(fs.readFileSync(`${file}.tmp`, 'utf8'), 'owned elsewhere');
  writeHookReceipt('brief-empty', { PLUGIN_DATA: root });
  assert.equal(fs.existsSync(file), false); assert.equal(fs.readFileSync(`${file}.tmp`, 'utf8'), 'owned elsewhere');
  receiptProposalSeed(file, receiptProposalRecord()); const stagedTarget = receiptProposalBytes(file); marked();
  assert.deepEqual(receiptProposalBytes(file), stagedTarget); assert.equal(fs.readFileSync(`${file}.tmp`, 'utf8'), 'owned elsewhere');
  writeHookReceipt('brief-empty', { PLUGIN_DATA: root });
  assert.deepEqual(receiptProposalBytes(file), stagedTarget); assert.equal(fs.readFileSync(`${file}.tmp`, 'utf8'), 'owned elsewhere');
  fs.rmSync(file); fs.rmSync(`${file}.tmp`);
  for (const base of [undefined, '', 'relative', path.join(root, 'missing'), source, `${root}${path.sep}..${path.sep}${path.basename(root)}`]) {
    fs.writeFileSync(file, JSON.stringify(receiptProposalRecord('failure'))); const before = receiptProposalBytes(file);
    writeHookReceipt('brief-empty', { PLUGIN_DATA: base }); assert.deepEqual(receiptProposalBytes(file), before);
    assert.equal(fs.existsSync(`${file}.tmp`), false); fs.rmSync(file);
  }
});

test('receipt: pinned old module mixed-version forward and rollback controls', async t => {
  const { root, directory, file } = fixture(t); fs.mkdirSync(directory, { recursive: true });
  const legacySource = Buffer.from(LEGACY_RECEIPT_SOURCE, 'utf8');
  assert.equal(receiptProposalSha1('sha1').update(Buffer.from(`blob ${legacySource.length}\0`)).update(legacySource).digest('hex'), LEGACY_RECEIPT_BLOB);
  const oldPath = path.join(root, 'legacy-hook-receipt.mjs'); fs.writeFileSync(oldPath, legacySource);
  const legacy = await import(receiptProposalFileUrl(oldPath).href);
  const runMarked = () => {
    const result = receiptProposalHookRun(root, receiptProposalHookPayload({ agent_id: 'child' }));
    assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', '']);
  };
  legacy.writeHookReceipt('brief-empty', { PLUGIN_DATA: root });
  let before = receiptProposalBytes(file); assert.deepEqual(Object.keys(JSON.parse(before)), ['schema', 'event', 'status', 'timestamp']);
  runMarked(); assert.deepEqual(receiptProposalBytes(file), before);
  writeHookReceipt('unattested-session', { PLUGIN_DATA: root }, 'no-session-id');
  const five = receiptProposalBytes(file); assert.deepEqual(Object.keys(JSON.parse(five)), ['schema', 'event', 'status', 'reason', 'timestamp']);
  legacy.writeHookReceipt('failure', { PLUGIN_DATA: root }); assert.deepEqual(receiptProposalBytes(file), five);
  runMarked(); assert.deepEqual(receiptProposalBytes(file), five);
  writeHookReceipt('brief-empty', { PLUGIN_DATA: root });
  before = receiptProposalBytes(file); assert.deepEqual(Object.keys(JSON.parse(before)), ['schema', 'event', 'status', 'timestamp']);
  legacy.writeHookReceipt('failure', { PLUGIN_DATA: root }); assert.notDeepEqual(receiptProposalBytes(file), before);
  for (const writer of [legacy, { writeHookReceipt }]) {
    const unsupported = { schema: 1, event: 'codex-hook-invocation', status: 'subagent-skipped', timestamp: RECEIPT_PROPOSAL_TS };
    receiptProposalSeed(file, unsupported, '\n'); before = receiptProposalBytes(file);
    writer.writeHookReceipt('brief-empty', { PLUGIN_DATA: root }); assert.deepEqual(receiptProposalBytes(file), before);
    writer.writeHookReceipt('subagent-skipped', { PLUGIN_DATA: root }); assert.deepEqual(receiptProposalBytes(file), before);
  }
});
