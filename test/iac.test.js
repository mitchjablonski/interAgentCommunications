import { test } from 'node:test';
import './hook-receipt.test.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { eventHash, signEvent } from '../src/crypto.js';
import { pathToFileURL } from 'node:url';
import { Agora, Rejected } from '../src/api.js';
import { Store, storeCacheKey, LOCK_ASIDE_MAX_AGE_MS, LOCK_TIMEOUT_MS } from '../src/store.js';
import { quoteWinArg, isWinBatch, winCommandLine, winExe, winShell, WinArgError } from '../src/winargs.js';

// Generic subprocess probes must not adopt the harness running this test suite.
// Identity tests add their intentional Codex/Claude variables after these defaults.
// IAC_DOCTOR_WSL_USERS='' keeps doctor (in-process or in a subprocess) off the real /mnt/c/Users/*/.codex.
const HARNESS_CLEAN = { IAC_AGENT: '', IAC_INSTANCE: '', AGORA_AGENT: '', AGORA_INSTANCE: '', CODEX_THREAD_ID: '', CODEX_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '', IAC_DOCTOR_WSL_USERS: '', IAC_DOCTOR_MANAGED_SETTINGS: '' };

function shellCommand(command, options = {}) {
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'sh';
  const args = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command];
  // PowerShell's cold start on a loaded Windows CI runner has exceeded 10 s; the timeout only
  // bounds a hung shell, it is not what these tests assert, so give the start-up real headroom.
  const result = spawnSync(shell, args, { encoding: 'utf8', timeout: process.platform === 'win32' ? 60_000 : 10_000, ...options });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function fresh() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-test-'));
  let t = Date.parse('2026-09-05T12:00:00Z');
  const clock = { now: () => t, tick: (ms) => { t += ms; } };
  // IAC_PROJECT pins where project-less opens go, so no test depends on how fast git answers
  const a = new Agora(home, { now: clock.now, env: { IAC_PROJECT: 'test/suite' } });
  a.init({ agents: ['fable', 'opus', 'sol', 'astra'], human: 'ada' });
  return { a, clock, home };
}
const MIN = 60_000;

test('codex-hook: every own agent marker skips before access, identity, project and output; ordinary controls still run', async () => {
  const { codexHook } = await import('../src/cli.js');
  const { clearProjectCache } = await import('../src/project.js');
  const { a, home } = fresh(); a.setFamilyModels('sol', ['gpt-6-sol']); a.setFamilyHarness('sol', 'codex');
  const s = fakeCodexSession({ id: 'marked-hook-control' });
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-marked-hook-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-marked-project-'));
  const env = { ...HARNESS_CLEAN, ...s.env, IAC_HOME: home, PLUGIN_DATA: pluginData, IAC_PROJECT: '', AGORA_PROJECT: '' };
  const payload = { hook_event_name: 'UserPromptSubmit', session_id: s.id, transcript_path: s.file, cwd };
  const values = [null, '', false, 7, {}, [], 'bad/id', 'child', s.id];
  const cases = values.flatMap(value => [{ agent_id: value }, { agent_type: value }, { agent_id: value, agent_type: value }]);
  cases.push({ agent_id: 'child', agent_type: 'unknown-role' }, { agent_id: 'child', session_id: null, transcript_path: [] },
    { agent_type: '', session_id: 7, transcript_path: null });
  const rawCases = cases.map(marker => JSON.stringify({ ...payload, ...marker }));
  rawCases.push(
    '{"hook_event_name":"UserPromptSubmit","agent_id":"child","agent_id":null}',
    '{"hook_event_name":"UserPromptSubmit","agent_id":null,"agent_id":"child"}',
    '{"hook_event_name":"UserPromptSubmit","agent_type":"role","agent_type":false}',
    '{"hook_event_name":"UserPromptSubmit","agent_type":false,"agent_type":"role"}',
    '{"hook_event_name":"UserPromptSubmit","agent\\u005fid":null}',
    '{"hook_event_name":"UserPromptSubmit","agent\\u005ftype":"role"}',
    '{"hook_event_name":"UserPromptSubmit","agent_id":"child"}',
    '{"hook_event_name":"UserPromptSubmit","agent_type":"role"}'
  );
  const invoke = async raw => {
    const counts = { fs: 0, identity: 0, project: 0, output: 0 };
    const originals = new Map();
    const methods = ['readdirSync', 'realpathSync', 'statSync', 'lstatSync', 'openSync', 'readSync', 'readFileSync',
      'mkdirSync', 'writeFileSync', 'fstatSync', 'fsyncSync', 'closeSync', 'renameSync', 'unlinkSync', 'existsSync'];
    const identity = Agora.prototype.identity; const log = console.log; const error = console.error;
    for (const method of methods) {
      const original = fs[method]; originals.set(method, original);
      fs[method] = (...args) => { counts.fs++; return original(...args); };
    }
    Agora.prototype.identity = function (...args) { counts.identity++; return identity.apply(this, args); };
    console.log = console.error = () => { counts.output++; };
    const projectSpawn = () => { counts.project++; return { status: 1, stdout: '', stderr: '' }; };
    try {
      const result = await withProcessEnv(env, () => codexHook([], { stdin: fakeStdin(raw), spawn: projectSpawn }));
      assert.equal(result, 0);
    } finally {
      for (const [method, original] of originals) fs[method] = original;
      Agora.prototype.identity = identity; console.log = log; console.error = error;
    }
    return counts;
  };
  try {
    clearProjectCache();
    for (const raw of rawCases) assert.deepEqual(await invoke(raw), { fs: 0, identity: 0, project: 0, output: 0 });
    assert.deepEqual(fs.readdirSync(pluginData), [], 'a skipped hook does not even create its receipt directory');
    const ordinary = await invoke(JSON.stringify({ ...payload, foo: 'unrelated' }));
    assert.ok(ordinary.fs > 0 && ordinary.identity > 0 && ordinary.project > 0, 'unmarked control proves access/identity/project counters work');
    assert.equal(ordinary.output, 0, 'empty board has no brief');
    const receipt = path.join(pluginData, 'iac-hook-receipt', 'iac-codex-hook-receipt.json');
    assert.equal(JSON.parse(fs.readFileSync(receipt, 'utf8')).status, 'brief-empty');
    const ignored = await invoke(JSON.stringify({ ...payload, hook_event_name: 'OtherEvent', agent_id: null }));
    assert.ok(ignored.fs > 0); assert.equal(ignored.identity, 0);
    assert.equal(JSON.parse(fs.readFileSync(receipt, 'utf8')).status, 'ignored-event', 'event gate still precedes marker suppression');
    await invoke('{');
    assert.equal(JSON.parse(fs.readFileSync(receipt, 'utf8')).status, 'no-payload', 'invalid input keeps its existing diagnostic');
  } finally {
    clearProjectCache();
    for (const dir of [pluginData, cwd, s.home, home]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('codex-hook: marked turns leave a waiting board and receipt untouched while deliberate child CLI uses its own thread', async () => {
  const { a, home } = fresh(); noIdle(a); a.setFamilyModels('sol', ['gpt-6-sol']); a.setFamilyModels('astra', ['gpt-6-astra']);
  a.setFamilyHarness('sol', 'codex'); a.setFamilyHarness('astra', 'codex');
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-child-cli-'));
  const root = fakeCodexSession({ id: 'root-cli-pin', model: 'gpt-6-astra', root: shared });
  const child = fakeCodexSession({ id: 'child-cli-pin', root: shared });
  fs.writeFileSync(child.file, `${JSON.stringify({ type: 'session_meta', payload: { id: child.id, session_id: root.id } })}\n${JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-sol' } })}\n`);
  const opened = await new Agora(home, { env: { IAC_PROJECT: 'global' } }).open({ as: 'ada', title: 'child CLI fixture', body: 'review', waitingOn: ['sol'], project: 'global' });
  const pluginData = path.join(shared, 'plugin-data'); fs.mkdirSync(pluginData);
  const env = { ...process.env, ...HARNESS_CLEAN, ...child.env, CODEX_SESSION_ID: root.id, IAC_HOME: home,
    PLUGIN_DATA: pluginData, IAC_PROJECT: 'global', AGORA_PROJECT: '' };
  const bin = path.join(import.meta.dirname, '..', 'bin', 'iac.js');
  const run = (...args) => spawnSync(process.execPath, [bin, '--home', home, ...args], { env, encoding: 'utf8', timeout: 10000 });
  const boardFile = path.join(home, 'threads', `${opened.thread}.ndjson`);
  const before = fs.readFileSync(boardFile);
  try {
    const who = run('whoami', '--json'); assert.equal(who.status, 0, who.stderr);
    const own = JSON.parse(who.stdout); assert.equal(own.session, child.id); assert.equal(own.model, 'gpt-6-sol');
    assert.deepEqual([new Agora(home, { env }).identity().session, new Agora(home, { env: { ...env, CODEX_THREAD_ID: root.id } }).identity().session], [child.id, root.id]);
    assert.equal(new Agora(home, { env: { ...env, CODEX_THREAD_ID: '' } }).identity().rootOnly, true);
    const briefed = run('brief', '--all-projects'); assert.equal(briefed.status, 0, briefed.stderr); assert.match(briefed.stdout, /waiting on sol/);
    const shown = run('show', opened.thread); assert.equal(shown.status, 0, shown.stderr); assert.match(shown.stdout, /child CLI fixture/);
    const dry = run('post', opened.thread, '--body', 'synthetic dry run', '--dry-run', '--json'); assert.equal(dry.status, 0, dry.stderr);
    assert.deepEqual(fs.readFileSync(boardFile), before, 'intentional dry-run never appends');
    const input = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: root.id, agent_id: child.id, transcript_path: child.file });
    const skipped = codexHookRun(env, input); assert.deepEqual([skipped.status, skipped.stdout, skipped.stderr], [0, '', '']);
    assert.deepEqual(fs.readdirSync(pluginData), []); assert.deepEqual(fs.readFileSync(boardFile), before);
    const unmarked = codexHookRun(env, JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: root.id, transcript_path: child.file }));
    assert.deepEqual([unmarked.status, unmarked.stdout, unmarked.stderr], [0, '', '']);
    const receipt = JSON.parse(fs.readFileSync(path.join(pluginData, 'iac-hook-receipt', 'iac-codex-hook-receipt.json'), 'utf8'));
    assert.equal(receipt.reason, 'transcript-mismatch');
    assert.deepEqual(fs.readFileSync(boardFile), before);
  } finally { fs.rmSync(shared, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
});

test('Codex discovery: exact directory budget accepts a complete search and refuses pending work even after an early match', async () => {
  const { codexHookSessionDetail, codexHookSession, codexRolloutPath } = await import('../src/codex-hook.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-budget-'));
  const sessions = path.join(root, 'sessions'); fs.mkdirSync(sessions);
  const id = 'budget-fixture'; const file = path.join(sessions, `rollout-2026-01-01-${id}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id } })}\n`);
  const env = { CODEX_HOME: root }; const input = { session_id: id, transcript_path: file };
  try {
    for (let i = 0; i < 9999; i++) fs.mkdirSync(path.join(sessions, `dir-${String(i).padStart(5, '0')}`));
    assert.deepEqual(codexHookSessionDetail(input, env), { session: id });
    assert.equal(codexHookSession(input, env), id); assert.equal(codexRolloutPath(id, env), fs.realpathSync(file));
    fs.mkdirSync(path.join(sessions, 'dir-09999'));
    for (const present of [true, false]) {
      if (!present) fs.unlinkSync(file);
      assert.deepEqual(codexHookSessionDetail(input, env), { reason: 'rollout-ambiguous' });
      assert.equal(codexHookSession(input, env), null); assert.equal(codexRolloutPath(id, env), null);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('CI concurrency source contract preserves accepted events, jobs and security', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const blocks = workflow.match(/^concurrency:\n(?:  [^\n]*\n)+/gm);
  assert.equal(blocks?.length, 1, 'one workflow-level concurrency block');
  assert.equal(blocks[0], `concurrency:
  # Replace obsolete runs only within one PR; each main/manual run is independent.
  group: \${{ github.workflow }}-\${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || format('run-{0}', github.run_id) }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}
`);
  // Snapshot the accepted workflow outside concurrency, including pinned action
  // upgrades, consolidated private tooling, disabled caching and required scan.
  // This intentionally requires explicit review when events, job/check names,
  // matrix, commands, timeouts, permissions or privacy checks change.
  const outsideConcurrency = workflow.replace(blocks[0], '');
  assert.equal(createHash('sha256').update(outsideConcurrency).digest('hex'),
    'c791182f61712f76a255f27dcf1721e6ee6b4924851150f8b9df0b979b56ba75');
});

test('CI private tooling stays gated and failure-propagating on both Node 24 OS jobs', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const jobsSource = workflow.slice(workflow.indexOf('\njobs:\n') + '\njobs:\n'.length);
  const jobs = [...jobsSource.matchAll(/^  ([a-z][a-z-]*):\n([\s\S]*?)(?=^  [a-z][a-z-]*:\n|$(?![\s\S]))/gm)];
  assert.deepEqual(jobs.map(([, name]) => name), ['linux', 'private-scan', 'windows'], 'only duplicate tooling jobs removed');
  const privateStep = `      - name: Private tooling at Node 24
        if: github.event.repository.private
        run: bash private/ci.sh test
        shell: bash
`;
  for (const [osName, runner, versions] of [['linux', 'ubuntu-latest', ['20', '24']], ['windows', 'windows-latest', ['24']]]) {
    const body = jobs.find(([, name]) => name === osName)[2];
    assert.match(body, new RegExp(`^    runs-on: ${runner}$`, 'm'));
    assert.deepEqual([...body.matchAll(/node-version: '([^']+)'/g)].map(([, version]) => version), versions);
    assert.equal(body.split(privateStep).length, 2, 'one exact private-only bash step, no failure suppression');
    assert.match(body, /node-version: '24'\n      - run: npm test\n      - name: Private tooling at Node 24\n/);
    assert.doesNotMatch(body, /continue-on-error:|always\(\)|\|\| true/, 'tooling failure fails its OS job');
    assert.equal((body.match(/- run: npm test/g) || []).length, versions.length);
    assert.match(body, /- name: Pack, install elsewhere, exercise the CLI/);
  }
  // This is a source contract, not an expression evaluator. The exact GitHub
  // boolean visibility guard runs the step in private copies, skips it in public
  // copies/absent visibility, and never substitutes a private/ existence test.
  assert.equal((workflow.match(/        if: github\.event\.repository\.private\n/g) || []).length, 2);
  assert.match(workflow, /if \[ "\$REPO_PRIVATE" != "true" \] && \[ -e private \]; then/);
  const scan = jobs.find(([, name]) => name === 'private-scan')[2];
  assert.match(scan, /^    if: github\.event\.repository\.private$/m);
  assert.doesNotMatch(scan, /continue-on-error:|needs:|IAC_PRIVATE_TERMS\s*[!=]=/);
  assert.match(scan, /IAC_PRIVATE_TERMS: \$\{\{ secrets\.IAC_PRIVATE_TERMS \}\}/);
  assert.match(scan, /- run: bash private\/ci\.sh scan/);
});

test('CI pins reviewed actions and gates privacy with optional personal terms', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const actions = [...workflow.matchAll(/uses: (actions\/[^\s]+) # (v[^\s]+)/g)].map(([, action, version]) => [action, version]);
  assert.equal(actions.length, 7);
  for (const [action, version] of actions) {
    assert.deepEqual([action, version], action.startsWith('actions/checkout@')
      ? ['actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'v7.0.1']
      : ['actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1', 'v7.1.0']);
  }
  assert.equal((workflow.match(/package-manager-cache: false/g) || []).length, 4);
  const scan = workflow.match(/^  private-scan:\n[\s\S]*?(?=^  windows:)/m)?.[0];
  assert.ok(scan);
  assert.match(scan, /if: github\.event\.repository\.private\n/);
  assert.match(scan, /IAC_PRIVATE_TERMS: \$\{\{ secrets\.IAC_PRIVATE_TERMS \}\}/);
  assert.match(scan, /run: bash private\/ci\.sh scan/);
  assert.doesNotMatch(scan, /continue-on-error|needs:|IAC_PRIVATE_TERMS\s*[!=]=/);
});

test('CI concurrency event fixtures isolate PRs, consecutive main commits and manual runs', () => {
  // These fixtures describe the source contract above, not a GitHub expression
  // evaluator or scheduler simulation. Hosted acceptance still verifies CI.
  const policy = ({ workflow = 'ci', event, number, runId }) => ({
    group: `${workflow}-${event === 'pull_request' ? `pr-${number}` : `run-${runId}`}`,
    cancel: event === 'pull_request',
  });
  const pr = { event: 'pull_request', number: 88, runId: 100, head: 'first', draft: false };
  assert.deepEqual(policy(pr), policy({ ...pr, runId: 101, head: 'next' }), 'new ready head replaces obsolete work in the same PR');
  assert.notEqual(policy(pr).group, policy({ ...pr, number: 89 }).group, 'another PR is independent');
  assert.notEqual(policy(pr).group, policy({ event: 'push', runId: 88 }).group, 'PR numbers and non-PR run IDs have separate namespaces');
  assert.notEqual(policy(pr).group, policy({ ...pr, workflow: 'release' }).group, 'another workflow is independent');
  const main = [200, 201, 202].map((runId, index) => policy({ event: 'push', runId, ref: 'refs/heads/main', sha: `commit-${index}` }));
  assert.equal(new Set(main.map(({ group }) => group)).size, 3, 'three main commits cannot replace pending or running validation');
  const manual = [300, 301].map((runId) => policy({ event: 'workflow_dispatch', runId, ref: 'refs/heads/main', sha: 'same-commit' }));
  assert.equal(new Set(manual.map(({ group }) => group)).size, 2, 'manual runs on the same commit are independent');
  assert.equal(new Set([...main, ...manual, policy(pr)].map(({ group }) => group)).size, 6);
  for (const result of [...main, ...manual]) assert.equal(result.cancel, false);
  assert.equal(policy(pr).cancel, true);
  assert.notEqual(main[0].group, policy({ event: 'push', runId: 200, workflow: 'release' }).group);
});

// stores whose threads are read by a subprocess on the real clock, or aged far past 14 days, are not about idle-close
const noIdle = (a) => a.store.saveConfig({ ...a.config(), limits: { ...a.config().limits, threadIdleCloseDays: 0 } });
// the smallest event the store accepts as well-formed, for store-level tests
const E = (x) => ({ type: 'post', id: 'e-1', thread: 't-aaaaaa', author: 'a', ts: '2026-01-01T00:00:00.000Z', prev: null, sig: 'AA==', body: 'b', kind: 'status', ...x });
async function rejects(p, code) {
  try { await p; } catch (e) { assert.ok(e instanceof Rejected, `expected Rejected, got ${e}`); assert.equal(e.code, code); return e; }
  assert.fail(`expected rejection ${code}`);
}

test('init registers agents with keys; posts are signed and chain verifies', async () => {
  const { a, home } = fresh();
  assert.deepEqual(Object.keys(a.registry()).sort(), ['ada', 'astra', 'fable', 'opus', 'sol']);
  assert.equal(a.registry().ada.role, 'human');
  if (process.platform !== 'win32') assert.equal((fs.statSync(path.join(home, 'keys', 'fable.pem')).mode & 0o777), 0o600);
  const { thread } = await a.open({ as: 'fable', title: 'Schema', kind: 'question', body: 'Which shape? @astra' });
  await a.post({ as: 'astra', thread, body: 'See commit abc123.' });
  const v = a.verify(thread);
  assert.equal(v.ok, true); assert.equal(v.events, 2);
});

test('init defaults to the human only; deployments register their own agents', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-test-'));
  const a = new Agora(home, { env: {} });
  a.init({ human: 'ada' });
  assert.deepEqual(Object.keys(a.registry()), ['ada']);
  assert.equal(a.registry().ada.role, 'human');
  a.addAgent('sonnet');
  a.setLaunch('sonnet', ['claude', '--model', 'sonnet']);
  assert.equal(a.registry().sonnet.role, 'agent');
  assert.deepEqual(a.config().launch.sonnet, ['claude', '--model', 'sonnet']);
});

test('tampering with a body or deleting an event is detected', async () => {
  const { a, home } = fresh();
  const { thread } = await a.open({ as: 'fable', title: 'T', body: 'hello' });
  await a.post({ as: 'opus', thread, body: 'hi' });
  await a.post({ as: 'sol', thread, body: 'hey' });
  const p = path.join(home, 'threads', `${thread}.ndjson`);
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
  const ev = JSON.parse(lines[1]); ev.body = 'forged'; lines[1] = JSON.stringify(ev);
  fs.writeFileSync(p, lines.join('\n') + '\n');
  let v = a.verify(thread);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((x) => x.problem === 'bad-signature'));
  assert.ok(v.problems.some((x) => x.problem === 'chain-break'));
  fs.writeFileSync(p, [lines[0], lines[2]].join('\n') + '\n');
  v = a.verify(thread);
  assert.ok(v.problems.some((x) => x.problem === 'chain-break'));
});

test('mentions are parsed, validated, and @human resolves', async () => {
  const { a } = fresh();
  const { thread } = await a.open({ as: 'fable', title: 'T', body: 'ping @astra and @human, email me@example.com is not a mention' });
  const s = a.thread(thread);
  assert.deepEqual(s.posts[0].mentions, ['astra', 'ada']);
  await rejects(a.post({ as: 'opus', thread, body: '@nobody hi' }), 'unknown-mention');
  await rejects(a.post({ as: 'opus', thread, body: '@opus talking to myself' }), 'self-mention');
  await rejects(a.post({ as: 'opus', thread, body: '@fable @sol @astra @ada' }), 'too-many-mentions');
});

test('length, kind, and paste-dump limits', async () => {
  const { a } = fresh();
  await rejects(a.open({ as: 'fable', title: 'x'.repeat(81), body: 'b' }), 'too-long');
  await rejects(a.open({ as: 'fable', title: 'T', body: 'x'.repeat(3001) }), 'too-long');
  await rejects(a.open({ as: 'fable', title: 'T', kind: 'ack', body: 'b' }), 'bad-opener-kind');
  await rejects(a.open({ as: 'fable', title: 'T', kind: 'nope', body: 'b' }), 'bad-kind');
  const { thread } = await a.open({ as: 'fable', title: 'T', body: 'b' });
  await rejects(a.post({ as: 'opus', thread, body: 'x'.repeat(1501) }), 'too-long');
  await rejects(a.post({ as: 'opus', thread, kind: 'ack', body: 'x'.repeat(241) }), 'too-long');
  await rejects(a.post({ as: 'opus', thread, body: '```\n' + 'x'.repeat(900) + '\n```' }), 'paste-dump');
  const e = await rejects(a.post({ as: 'ghost', thread, body: 'hi' }), 'unknown-author');
  assert.match(e.hint, /add-agent/);
});

test('no double posting, with a 2h grace', async () => {
  const { a, clock } = fresh();
  const { thread } = await a.open({ as: 'fable', title: 'T', body: 'b' });
  await rejects(a.post({ as: 'fable', thread, body: 'me again' }), 'double-post');
  clock.tick(121 * MIN);
  await a.post({ as: 'fable', thread, kind: 'status', body: 'still here' });
  // ack is a placeholder: one substantive follow-up is allowed, then blocked again
  clock.tick(MIN); await a.post({ as: 'opus', thread, kind: 'question', body: 'eta?' });
  clock.tick(MIN); await a.post({ as: 'fable', thread, kind: 'ack', body: 'on it' });
  clock.tick(MIN); await a.post({ as: 'fable', thread, kind: 'answer', body: 'done, see abc123' });
  await rejects(a.post({ as: 'fable', thread, body: 'and another' }), 'double-post');
});

test('per-thread hourly and lifetime rate limits', async () => {
  const { a, clock } = fresh();
  const { thread } = await a.open({ as: 'fable', title: 'T', body: 'b' });
  // alternate fable/opus/sol so ping-pong and double-post don't trigger first
  const cycle = ['opus', 'fable', 'sol'];
  let i = 0;
  const posted = { fable: 1 };
  while (posted.fable < 3) { const who = cycle[i++ % 3]; await a.post({ as: who, thread, body: `p${i}` }); posted[who] = (posted[who] || 0) + 1; clock.tick(MIN); }
  await a.post({ as: 'opus', thread, body: 'x' }); clock.tick(MIN);
  await rejects(a.post({ as: 'fable', thread, body: 'fourth in an hour' }), 'thread-rate');
  clock.tick(61 * MIN);
  await a.post({ as: 'fable', thread, body: 'fine after an hour' });
});

test('global hourly rate limit spans threads', async () => {
  const { a, clock } = fresh();
  a.store.saveConfig({ ...a.config(), limits: { ...a.config().limits, familyGlobalPerHour: 12 } });
  // fable: 3 opens (open cap) + 2 posts in each = 9, then 3 posts in threads opened by opus = 12
  const mine = [];
  for (let k = 0; k < 3; k++) mine.push((await a.open({ as: 'fable', title: `T${k}`, body: 'b', project: 'o/r' })).thread);
  await rejects(a.open({ as: 'fable', title: 'T4', body: 'b', project: 'o/r' }), 'open-cap');
  for (const t of mine) for (const who of ['opus', 'fable', 'sol', 'fable']) { await a.post({ as: who, thread: t, body: 'x' }); clock.tick(MIN); }
  const o1 = (await a.open({ as: 'opus', title: 'O1', body: 'b', project: 'o/r' })).thread;
  const o2 = (await a.open({ as: 'opus', title: 'O2', body: 'b', project: 'o/r' })).thread;
  await a.post({ as: 'fable', thread: o1, body: 'x' }); clock.tick(MIN);
  await a.post({ as: 'fable', thread: o2, body: 'x' }); clock.tick(MIN);
  await a.post({ as: 'sol', thread: o1, body: 'x' }); clock.tick(MIN);
  await a.post({ as: 'fable', thread: o1, body: 'x' }); clock.tick(MIN);   // 12th fable write this hour
  await a.post({ as: 'astra', thread: o2, body: 'x' }); clock.tick(MIN);
  const e = await rejects(a.post({ as: 'fable', thread: o2, body: 'thirteenth' }), 'global-rate');
  assert.match(e.message, /fable family/); assert.match(e.hint, /do the work/);
  clock.tick(61 * MIN);
  await a.post({ as: 'fable', thread: o2, body: 'fine an hour later' });
});

test('fallback open-thread cap is scoped by agent and project', async () => {
  const { a } = fresh();
  for (let k = 0; k < 3; k++) {
    await a.open({ as: 'astra', title: `One ${k}`, body: 'b', project: 'o/one' });
  }
  const e = await rejects(a.open({ as: 'astra', title: 'One 4', body: 'b', project: 'o/one' }), 'open-cap');
  assert.match(e.message, /astra@o\/one/);
  await a.open({ as: 'astra', title: 'Two 1', body: 'b', project: 'o/two' });
  await a.open({ as: 'sol', title: 'One by Sol', body: 'b', project: 'o/one' });
});

test('objection rules: needs ref, one per agent, none on objections', async () => {
  const { a, clock } = fresh();
  const { thread, post } = await a.open({ as: 'fable', title: 'T', kind: 'proposal', body: 'do X' });
  await rejects(a.post({ as: 'opus', thread, kind: 'objection', body: 'no' }), 'objection-needs-ref');
  await rejects(a.post({ as: 'opus', thread, kind: 'objection', re: 'p-00000000', body: 'no' }), 'bad-ref');
  const o1 = await a.post({ as: 'opus', thread, kind: 'objection', re: post, body: 'X breaks Y' }); clock.tick(MIN);
  await rejects(a.post({ as: 'sol', thread, kind: 'objection', re: o1.post, body: 'objecting to your objection' }), 'objection-to-objection');
  await a.post({ as: 'fable', thread, kind: 'answer', body: 'Y is fine because Z' }); clock.tick(MIN);
  const e = await rejects(a.post({ as: 'opus', thread, kind: 'objection', re: post, body: 'still no' }), 'objection-cap');
  assert.match(e.hint, /escalate/);
});

test('ping-pong between two agents freezes both until a third party or human posts; time does not lift it', async () => {
  const { a, clock } = fresh();
  const { thread } = await a.open({ as: 'fable', title: 'T', body: 'p0' }); clock.tick(MIN);
  // 6 alternating posts total, spaced so hourly rate isn't the first tripwire
  for (const who of ['astra', 'fable', 'astra', 'fable', 'astra']) { await a.post({ as: who, thread, body: 'again' }); clock.tick(25 * MIN); }
  const s = a.thread(thread);
  assert.equal(s.status, 'cooldown');
  assert.deepEqual([...s.cooldown.authors].sort(), ['astra', 'fable']);
  const e = await rejects(a.post({ as: 'fable', thread, body: 'one more time' }), 'cooldown');
  assert.match(e.hint, /doom loop/);
  await rejects(a.post({ as: 'astra', thread, body: 'me too' }), 'cooldown');
  clock.tick(24 * 60 * MIN);
  await rejects(a.post({ as: 'fable', thread, body: 'a day later' }), 'cooldown');
  await a.post({ as: 'sol', thread, body: 'third party here' });          // others may post
  assert.equal(a.thread(thread).status, 'open');
  await a.post({ as: 'ada', thread, body: 'human weighs in' });        // human exempt
});

test('post cap auto-locks; only human unlocks; escalate always works and closes', async () => {
  const { a, clock } = fresh();
  a.store.saveConfig({ ...a.config(), limits: { ...a.config().limits, threadPostCap: 4, perThreadPerHour: 99, perThreadLifetime: 99, familyGlobalPerHour: 999, pingPongWindow: 99 } });
  const { thread } = await a.open({ as: 'fable', title: 'T', body: 'p0' }); clock.tick(MIN);
  for (const who of ['opus', 'sol', 'astra']) { await a.post({ as: who, thread, body: 'x' }); clock.tick(MIN); }
  const s = a.thread(thread);
  assert.equal(s.locked, true); assert.equal(s.autoLocked, true);
  await rejects(a.post({ as: 'fable', thread, body: 'x' }), 'locked');
  await rejects(a.unlock({ as: 'fable', thread }), 'forbidden');
  await a.unlock({ as: 'ada', thread, reason: 'carry on' });
  assert.equal(a.thread(thread).locked, false);
  await a.post({ as: 'fable', thread, body: 'thanks' });
  // escalation bypasses limits and closes
  let created = null;
  const r = await a.escalate({ as: 'opus', thread, repo: 'o/r', createIssue: async (x) => { created = x; return 'https://github.com/o/r/issues/7'; } });
  assert.equal(r.issueUrl, 'https://github.com/o/r/issues/7');
  assert.match(created.body, /Escalated from the inter-agent-comms thread/);
  assert.deepEqual(created.labels, ['iac']);
  const s2 = a.thread(thread);
  assert.equal(s2.closed, true); assert.equal(s2.issueUrl, r.issueUrl);
  await rejects(a.post({ as: 'ada', thread, body: 'x' }), 'closed');
  assert.equal(a.verify(thread).ok, true);
});

test('close: opener or human only, bypasses rate limits, produces resolution', async () => {
  const { a } = fresh();
  const { thread } = await a.open({ as: 'fable', title: 'T', body: 'p0' });
  await rejects(a.post({ as: 'opus', thread, kind: 'resolution', body: 'I decide' }), 'not-opener');
  await a.close({ as: 'fable', thread, body: 'Decided X.' }); // fable posted last: double-post would normally block
  const s = a.thread(thread);
  assert.equal(s.closed, true);
  assert.equal(s.posts.at(-1).kind, 'resolution');
});

test('waiting-on board and inbox', async () => {
  const { a, clock } = fresh();
  const { thread } = await a.open({ as: 'fable', title: 'Need schema', kind: 'status', waitingOn: ['astra'], body: 'Blocked on /users shape.' });
  assert.deepEqual(a.thread(thread).posts[0].mentions, ['astra']);
  let board = a.waitingBoard();
  assert.equal(board.length, 1); assert.equal(board[0].from, 'fable'); assert.equal(board[0].on, 'astra');
  let inbox = a.inbox({ as: 'astra' });
  assert.equal(inbox.length, 1); assert.equal(inbox[0].posts[0].id, a.thread(thread).posts[0].id);
  assert.equal(a.inbox({ as: 'sol' }).length, 0);
  clock.tick(MIN);
  await a.post({ as: 'astra', thread, kind: 'ack', body: 'on it' });
  board = a.waitingBoard();
  assert.equal(board.length, 1); assert.equal(board[0].acked, true, 'ack acknowledges but does not clear');
  clock.tick(MIN);
  await a.post({ as: 'astra', thread, body: 'Here: docs/api.md @fable' });
  assert.equal(a.waitingBoard().length, 0, 'wait clears once astra posts substantively');
  inbox = a.inbox({ as: 'fable', markRead: true });
  assert.equal(inbox.length, 1);
  assert.equal(a.inbox({ as: 'fable' }).length, 0, 'mark-read clears');
  // closed threads wake nobody unless the closing post mentions them
  clock.tick(MIN);
  a.inbox({ as: 'astra', markRead: true });
  await a.close({ as: 'fable', thread, body: 'Done. @sol please pick up the client tests.' });
  assert.equal(a.inbox({ as: 'astra' }).length, 0, 'closed thread does not wake a participant');
  assert.equal(a.inbox({ as: 'sol' }).length, 1, 'explicit mention in the closing post does');
});

test('inbox: a fresh instance does not see mentions older than waitTtlHours as new', async () => {
  const { a, clock } = fresh();
  const old = await a.open({ as: 'sol', title: 'Old mention', kind: 'status', body: 'Heads up @fable.' });
  clock.tick(73 * 60 * MIN);
  const recent = await a.open({ as: 'astra', title: 'Recent mention', kind: 'status', body: 'Look at this @fable.' });
  const threads = a.inbox({ as: 'fable', instance: 'fable-new' }).map((it) => it.thread);
  assert.deepEqual(threads, [recent.thread], 'old mention is not new; recent one is');
  assert.ok(!threads.includes(old.thread));
  // a seen-mark newer than the cutoff still wins
  a.inbox({ as: 'fable', instance: 'fable-new', markRead: true });
  assert.equal(a.inbox({ as: 'fable', instance: 'fable-new' }).length, 0);
});

test('inbox: closed threads keep their rule, and the cutoff applies to them too', async () => {
  const { a, clock } = fresh();
  const t1 = await a.open({ as: 'astra', title: 'Old closed', kind: 'status', body: 'Starting.' });
  await a.close({ as: 'astra', thread: t1.thread, body: 'Done. @sol take the follow-up.' });
  clock.tick(73 * 60 * MIN);
  const t2 = await a.open({ as: 'astra', title: 'Recent closed', kind: 'status', body: 'Starting.' });
  await a.post({ as: 'fable', thread: t2.thread, body: 'Noted, will review.' });
  clock.tick(MIN);
  await a.close({ as: 'astra', thread: t2.thread, body: 'Done. @sol please pick up client tests.' });
  assert.deepEqual(a.inbox({ as: 'sol', instance: 'sol-new' }).map((it) => it.thread), [t2.thread],
    'recent mention on a closed thread is new; the >TTL one is not');
  assert.equal(a.inbox({ as: 'fable', instance: 'fable-new' }).length, 0, 'closed thread does not wake an unmentioned participant');
});

test('inbox: after close, only the closing post\'s mentions wake anyone', async () => {
  const { a, clock } = fresh();
  const t1 = await a.open({ as: 'astra', title: 'Ping sol', kind: 'status', body: 'Heads up @sol.' });
  clock.tick(MIN);
  await a.close({ as: 'astra', thread: t1.thread, body: 'Done, nothing needed.' });
  assert.equal(a.inbox({ as: 'sol', instance: 'sol-new' }).length, 0, 'a pre-close mention does not wake a fresh instance');
  const t2 = await a.open({ as: 'astra', title: 'Hand over', kind: 'status', body: 'Heads up @sol.' });
  clock.tick(MIN);
  await a.close({ as: 'astra', thread: t2.thread, body: 'Done. @sol take the follow-up.' });
  const items = a.inbox({ as: 'sol', instance: 'sol-new2' });
  assert.deepEqual(items.map((it) => it.thread), [t2.thread]);
  assert.equal(items[0].posts.length, 1, 'only the closing post, not the opener');
});

test('inbox: a custom waitTtlHours sets the cutoff', async () => {
  const { a, clock } = fresh();
  a.store.saveConfig({ ...a.config(), limits: { ...a.config().limits, waitTtlHours: 2 } });
  const { thread } = await a.open({ as: 'sol', title: 'Ping', kind: 'status', body: 'Heads up @fable.' });
  clock.tick(60 * MIN);
  assert.equal(a.inbox({ as: 'fable', instance: 'f1' }).length, 1, 'inside 2h: new');
  clock.tick(61 * MIN);
  assert.equal(a.inbox({ as: 'fable', instance: 'f2' }).length, 0, 'past 2h: not new');
  assert.ok(a.thread(thread), 'the thread itself is untouched');
});

test('inbox: a thread already seen keeps its seen-mark past the TTL (returning instance)', async () => {
  const { a, clock } = fresh();
  const { thread } = await a.open({ as: 'astra', title: 'Long-running', kind: 'status', body: 'Starting @sol.' });
  a.inbox({ as: 'sol', instance: 'sol-stable', markRead: true });
  clock.tick(24 * 60 * MIN);
  await a.close({ as: 'astra', thread, body: 'Done. @sol take the follow-up.' });
  clock.tick(96 * 60 * MIN);
  assert.deepEqual(a.inbox({ as: 'sol', instance: 'sol-stable' }).map((it) => it.thread), [thread],
    'a mention that arrived while the instance was away is still new to it');
  assert.equal(a.inbox({ as: 'sol', instance: 'sol-fresh' }).length, 0, 'but not to a brand-new instance');
});

test('inbox: a non-positive or non-numeric waitTtlHours means no floor, never "nothing is new"', async () => {
  for (const ttl of [0, -5, null, '', 'abc']) {
    const { a, clock } = fresh();
    a.store.saveConfig({ ...a.config(), limits: { ...a.config().limits, waitTtlHours: ttl } });
    await a.open({ as: 'sol', title: 'Ping', kind: 'status', body: 'Heads up @fable.' });
    clock.tick(MIN);
    await a.open({ as: 'sol', title: 'Needs you', kind: 'status', body: 'Review please.', waitingOn: ['fable'] });
    clock.tick(100 * 60 * MIN);
    assert.equal(a.inbox({ as: 'fable', instance: 'f1' }).length, 2, `inbox, waitTtlHours=${JSON.stringify(ttl)}`);
    assert.equal(a.waitingBoard({ on: 'fable' }).length, 1, `board agrees: never expire, waitTtlHours=${JSON.stringify(ttl)}`);
  }
});

test('wait cleanup is signed, selective, exact-instance owned, idempotent, and bypasses a lock', async () => {
  const { a } = fresh();
  const opened = await a.open({
    as: 'sol', instance: 'sol-task-a', project: 'o/r', title: 'Two dependencies',
    kind: 'status', body: 'Need both reviews.', waitingOn: ['fable', 'opus'],
  });

  await rejects(a.clearWait({ as: 'sol', instance: 'sol-task-b', thread: opened.thread }), 'not-wait-owner');
  await rejects(a.clearWait({ as: 'fable', instance: 'fable-review', thread: opened.thread }), 'not-wait-owner');
  const ambiguous = await rejects(a.clearWait({ as: 'sol', instance: 'sol-task-a', thread: opened.thread }), 'ambiguous-wait');
  assert.match(ambiguous.message, new RegExp(`${opened.post}/fable`));
  assert.match(ambiguous.message, new RegExp(`${opened.post}/opus`));

  await a.lock({ as: 'sol', thread: opened.thread, reason: 'No more discussion.' });
  assert.equal(a.thread(opened.thread).locked, true);
  const cleared = await a.clearWait({
    as: 'sol', instance: 'sol-task-a', thread: opened.thread, post: opened.post,
    on: 'fable', reason: 'Fable review is no longer required.',
  });
  assert.equal(cleared.post, opened.post);
  assert.equal(cleared.on, 'fable');
  assert.deepEqual(a.waitingBoard().map((w) => w.on), ['opus'], 'only the selected target is cleared');

  const state = a.threadWithVerification(opened.thread);
  assert.equal(state.waitClears.length, 1);
  assert.equal(state.waitClears[0].author, 'sol');
  assert.equal(state.waitClears[0].instance, 'sol-task-a');
  assert.equal(state.waitClears[0].reason, 'Fable review is no longer required.');
  assert.equal(state.waitClears[0].verified, true);
  assert.equal(a.verify(opened.thread).ok, true);

  const repeat = await a.clearWait({
    as: 'sol', instance: 'sol-task-a', thread: opened.thread, post: opened.post, on: 'fable',
  });
  assert.equal(repeat.already, true);
  assert.equal(a.thread(opened.thread).waitClears.length, 1, 'idempotent cleanup appends no duplicate event');

  const inferred = await a.clearWait({ as: 'sol', instance: 'sol-task-a', thread: opened.thread });
  assert.equal(inferred.on, 'opus', 'the sole remaining owned wait can be inferred');
  assert.equal(a.waitingBoard().length, 0);
});

test('human may clear another task wait, including after its target has claimed it', async () => {
  const { a, clock } = fresh();
  const opened = await a.open({
    as: 'astra', instance: 'astra-task-a', project: 'o/r', title: 'Human cleanup',
    kind: 'status', body: 'Need review.', waitingOn: ['fable'],
  });
  clock.tick(MIN);
  await a.post({ as: 'fable', instance: 'fable-review', thread: opened.thread, kind: 'ack', body: 'Claimed.' });
  assert.equal(a.waitingBoard()[0].claimedBy, 'fable-review');

  const result = await a.clearWait({
    as: 'ada', thread: opened.thread, post: opened.post, on: 'fable', reason: 'Stale request.',
  });
  assert.equal(result.on, 'fable');
  assert.equal(a.waitingBoard().length, 0);
  const clear = a.threadWithVerification(opened.thread).waitClears[0];
  assert.equal(clear.authorRole, 'human');
  assert.equal(clear.verified, true);
});

test('fallback instance ownership survives retagging an unscoped thread', async () => {
  const { a } = fresh();
  const opened = await a.open({
    as: 'sol', project: 'unscoped', title: 'Retagged dependency', body: 'Need review.', waitingOn: ['fable'],
  });
  assert.equal(a.thread(opened.thread).posts[0].instance, 'sol@unscoped');
  await a.setProject({ as: 'sol', thread: opened.thread, project: 'o/r' });
  assert.equal(a.thread(opened.thread).project, 'o/r');

  const cleared = await a.clearWait({ as: 'sol', thread: opened.thread });
  assert.equal(cleared.post, opened.post);
  assert.equal(cleared.on, 'fable');
  assert.equal(a.waitingBoard().length, 0);
  assert.equal(a.verify(opened.thread).ok, true);
});

test('replay ignores validly signed wait-clear events from a target or sibling task', async () => {
  const { a, clock } = fresh();
  const opened = await a.open({
    as: 'sol', instance: 'sol-task-source', project: 'o/r', title: 'Forged cleanup',
    body: 'Need Fable.', waitingOn: ['fable'],
  });
  const appendClear = (author, instance, id) => {
    clock.tick(MIN);
    a._finalize(opened.thread, {
      type: 'wait-clear', id, thread: opened.thread, author, instance, idSource: 'self', ts: a.ts(),
      post: opened.post, on: 'fable', reason: 'I should not be allowed to clear this wait.',
    }, author);
  };

  appendClear('fable', 'fable-target', 'e-target01');
  assert.equal(a.verify(opened.thread).ok, true, 'target event is correctly signed and chained');
  assert.equal(a.waitingBoard().length, 1, 'the target family cannot clear a wait merely by appending an event');

  appendClear('sol', 'sol-task-sibling', 'e-sibling1');
  assert.equal(a.verify(opened.thread).ok, true, 'sibling event is correctly signed and chained');
  assert.equal(a.waitingBoard().length, 1, 'a sibling task sharing the family key cannot clear the source task wait');
});

test('clearing without a selector never reports success for a wait this task never raised', async () => {
  const { a, clock } = fresh();
  const opened = await a.open({
    as: 'sol', instance: 'sol-task-a', project: 'o/r', title: 'Own wait',
    kind: 'status', body: 'Need review.', waitingOn: ['fable'],
  });
  const cleared = await a.clearWait({ as: 'sol', instance: 'sol-task-a', thread: opened.thread });
  assert.equal(cleared.on, 'fable');

  clock.tick(MIN);
  await a.post({ as: 'opus', thread: opened.thread, kind: 'status', body: 'Now I need astra.', waitingOn: ['astra'] });
  // sol owns nothing outstanding here; a prior clear of its own must not mask the rejection
  await rejects(a.clearWait({ as: 'sol', instance: 'sol-task-a', thread: opened.thread }), 'not-wait-owner');
  assert.deepEqual(a.waitingBoard().map((w) => w.on), ['astra'], 'the other task wait is untouched');

  const again = await a.clearWait({
    as: 'sol', instance: 'sol-task-a', thread: opened.thread, post: opened.post, on: 'fable',
  });
  assert.equal(again.already, true, 'naming the wait still answers idempotently');
  assert.equal(a.thread(opened.thread).waitClears.length, 1);
});

test('a task with a harness identity may not hand-pick an instance label when clearing a wait', async () => {
  const { a, home, clock } = fresh();
  const opened = await a.open({
    as: 'sol', instance: 'sol-task-a', project: 'o/r', title: 'Sibling replay',
    kind: 'status', body: 'Need review.', waitingOn: ['fable'],
  });
  // a sibling task of the same family, with its own harness session id
  const sibling = new Agora(home, { now: clock.now, env: { CLAUDE_SESSION_ID: 'task-b' } });
  await rejects(sibling.clearWait({ as: 'sol', thread: opened.thread }), 'not-wait-owner');
  const e = await rejects(sibling.clearWait({
    as: 'sol', thread: opened.thread, instance: 'sol-task-a', reason: 'read off agora show',
  }), 'instance-override');
  assert.match(e.hint, /raised it/);
  assert.equal(a.waitingBoard().length, 1);
  assert.equal(a.thread(opened.thread).eventCount, 1, 'the rejected write appends nothing');

  // no harness id at all: a human or a resumed task may still address a specific wait
  const unsessioned = new Agora(home, { now: clock.now, env: {} });
  const r = await unsessioned.clearWait({
    as: 'ada', thread: opened.thread, post: opened.post, on: 'fable', instance: 'ada-console', reason: 'Stale.',
  });
  assert.equal(r.on, 'fable');
  assert.equal(a.waitingBoard().length, 0);
});

test('an unverifiable wait-clear cannot silence a wait on the wait surfaces', async () => {
  const { a, home } = fresh();
  const { brief } = await import('../src/format.js');
  const opened = await a.open({
    as: 'sol', instance: 'sol-task-a', project: 'o/r', title: 'Forged silence',
    kind: 'status', body: 'Need review.', waitingOn: ['fable'],
  });
  const p = path.join(home, 'threads', `${opened.thread}.ndjson`);
  fs.appendFileSync(p, JSON.stringify({
    type: 'wait-clear', id: 'e-forged1', thread: opened.thread, author: 'ada', ts: a.ts(),
    post: opened.post, on: 'fable', reason: 'silenced', prev: 'garbage', sig: 'garbage',
  }) + '\n');

  const v = a.verify(opened.thread);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((x) => x.problem === 'bad-signature'));
  assert.ok(v.problems.some((x) => x.problem === 'chain-break'));
  assert.equal(a.waitingBoard().length, 1, 'a forged clear must not remove a claim on attention');
  assert.equal(a.waitingBoard({ on: 'fable' }).length, 1);
  assert.match(brief(a, 'fable', { project: 'o/r', instance: 'fable-review' }), new RegExp(opened.thread));

  // a genuine clear by the same author still works
  await a.clearWait({ as: 'ada', thread: opened.thread, post: opened.post, on: 'fable', reason: 'Really stale.' });
  assert.equal(a.waitingBoard().length, 0);
});

test('closing a thread withdraws the closer own outstanding waits, and only those', async () => {
  const { a, clock } = fresh();
  const opened = await a.open({
    as: 'sol', project: 'o/r', title: 'Two dependencies', kind: 'status',
    body: 'Need both reviews.', waitingOn: ['fable', 'opus'],
  });
  clock.tick(MIN);
  const theirs = await a.post({ as: 'astra', thread: opened.thread, kind: 'status', body: 'I need fable as well.', waitingOn: ['fable'] });
  clock.tick(MIN);
  assert.equal(a.waitingBoard().length, 3);

  const closed = await a.close({ as: 'sol', thread: opened.thread, body: 'Doing it myself; nothing needed.' });
  assert.deepEqual(closed.cleared.map((w) => w.on).sort(), ['fable', 'opus']);

  const s = a.threadWithVerification(opened.thread);
  assert.equal(s.closed, true);
  assert.equal(s.waitClears.length, 2, 'another author wait in the same thread is left alone');
  assert.ok(s.waitClears.every((c) => c.post === opened.post), 'only the waits sol raised are withdrawn');
  assert.ok(!s.waitClears.some((c) => c.post === theirs.post));
  assert.ok(s.waitClears.every((c) => c.author === 'sol' && c.instance === 'sol@o/r' && c.idSource === 'self'));
  assert.ok(s.waitClears.every((c) => c.reason === 'thread closed by sol' && c.verified));
  assert.equal(a.verify(opened.thread).ok, true);
});

test('the human closing a thread withdraws every outstanding wait in it', async () => {
  const { a, clock } = fresh();
  const opened = await a.open({
    as: 'sol', project: 'o/r', title: 'Stalled', kind: 'status', body: 'Need fable.', waitingOn: ['fable'],
  });
  clock.tick(MIN);
  await a.post({ as: 'astra', thread: opened.thread, kind: 'status', body: 'And I need opus.', waitingOn: ['opus'] });
  clock.tick(MIN);
  assert.equal(a.waitingBoard().length, 2);

  const closed = await a.close({ as: 'ada', thread: opened.thread, body: 'Overtaken by events.' });
  assert.equal(closed.cleared.length, 2);
  const s = a.threadWithVerification(opened.thread);
  assert.deepEqual(s.waitClears.map((c) => c.on).sort(), ['fable', 'opus']);
  assert.ok(s.waitClears.every((c) => c.author === 'ada' && c.authorRole === 'human' && c.verified));
  assert.equal(a.verify(opened.thread).ok, true);
});

test('an unclaimed wait expires off the wait surfaces after waitTtlHours but stays in the thread', async () => {
  const { a, clock } = fresh();
  const { brief } = await import('../src/format.js');
  const { renderMarkdown } = await import('../src/api.js');
  const F = { project: 'o/r', instance: 'fable-review' };
  const stale = await a.open({
    as: 'sol', project: 'o/r', title: 'Old ask', kind: 'status', body: 'Need fable.', waitingOn: ['fable'],
  });
  const acked = await a.open({
    as: 'astra', project: 'o/r', title: 'Acked ask', kind: 'status', body: 'Need fable here too.', waitingOn: ['fable'],
  });
  clock.tick(MIN);
  await a.post({ as: 'fable', instance: 'fable-review', thread: acked.thread, kind: 'ack', body: 'On it.' });
  assert.equal(a.waitingBoard().length, 2);
  assert.match(brief(a, 'fable', F), new RegExp(stale.thread));
  a.inbox({ as: 'fable', markRead: true, project: 'o/r', instance: 'fable-review' });   // mentions read; waits remain

  clock.tick(73 * 60 * MIN);
  assert.deepEqual(a.waitingBoard().map((w) => w.thread), [acked.thread], 'a claimed wait never expires: the claimer owes an answer');
  assert.equal(a.waitingBoard({ on: 'fable' }).length, 1);
  const line = brief(a, 'fable', F);
  assert.doesNotMatch(line, new RegExp(stale.thread));
  assert.match(line, new RegExp(acked.thread));

  const all = a.waitingBoard({ includeExpired: true });
  assert.equal(all.length, 2);
  assert.deepEqual(all.filter((w) => w.expired).map((w) => w.thread), [stale.thread]);

  // derivation only: nothing was appended or rewritten, and the thread still shows the wait
  const s = a.thread(stale.thread);
  assert.equal(s.eventCount, 1);
  assert.deepEqual(s.waitClears, []);
  assert.deepEqual(s.posts[0].waitingOn, ['fable']);
  assert.match(renderMarkdown(s), /waiting on fable/);
});

test('an unclaimed wait stalls after stallHours: derived, never for claimed or expired waits', async () => {
  const { a, clock } = fresh();
  const asked = await a.open({ as: 'sol', project: 'o/r', title: 'Need opus', kind: 'status', body: 'Need opus.', waitingOn: ['opus'] });
  const acked = await a.open({ as: 'astra', project: 'o/r', title: 'Acked', kind: 'status', body: 'Need fable.', waitingOn: ['fable'] });
  clock.tick(MIN);
  await a.post({ as: 'fable', instance: 'f1', thread: acked.thread, kind: 'ack', body: 'On it.' });
  const before = a.store.readEvents(asked.thread).length;

  clock.tick(11 * 60 * MIN);
  assert.ok(a.waitingBoard().every((w) => !w.stalled), 'not stalled before stallHours');
  assert.equal(a.waitingBoard().find((w) => w.thread === asked.thread).ageHours, 11);

  clock.tick(2 * 60 * MIN);
  const board = a.waitingBoard();
  assert.deepEqual(board.filter((w) => w.stalled).map((w) => w.thread), [asked.thread]);
  assert.equal(board.find((w) => w.thread === acked.thread).stalled, false, 'a claimed wait never stalls');
  assert.equal(a.store.readEvents(asked.thread).length, before, 'derivation only: nothing written');

  // past waitTtlHours it is expired, not stalled
  clock.tick(60 * 60 * MIN);
  const expired = a.waitingBoard({ includeExpired: true }).find((w) => w.thread === asked.thread);
  assert.equal(expired.expired, true);
  assert.equal(expired.stalled, false);
});

test('stallHours 0 or invalid disables stalling', async () => {
  for (const h of [0, -3, 'soon', null]) {
    const { a, clock } = fresh();
    a.store.saveConfig({ ...a.config(), limits: { ...a.config().limits, stallHours: h } });
    await a.open({ as: 'sol', project: 'o/r', title: 'Need opus', kind: 'status', body: 'Need opus.', waitingOn: ['opus'] });
    clock.tick(30 * 60 * MIN);
    assert.equal(a.waitingBoard()[0].stalled, false, `stallHours=${JSON.stringify(h)}`);
  }
  const { a } = fresh();
  assert.equal(a.config().limits.stallHours, 12, 'default');
});

test('brief: the human sees a capped stalled count by project; agent briefs are unchanged and never scan the whole board', async () => {
  const { a, clock } = fresh();
  const { brief } = await import('../src/format.js');
  await a.open({ as: 'sol', instance: 's1', project: 'o/r', title: 'Need opus', kind: 'status', body: 'Need opus.', waitingOn: ['opus'] });
  await a.open({ as: 'astra', project: 'x/y', title: 'Need opus too', kind: 'status', body: 'Need opus.', waitingOn: ['opus'] });
  await a.open({ as: 'astra', project: 'x/y', title: 'And fable', kind: 'status', body: 'Need fable.', waitingOn: ['fable'] });
  await a.open({ as: 'sol', project: 'global', title: 'Anyone fable', kind: 'status', body: 'Need fable.', waitingOn: ['fable'] });
  await a.open({ as: 'fable', project: 'p/q', title: 'Need sol', kind: 'status', body: 'Need sol.', waitingOn: ['sol'] });
  await a.open({ as: 'sol', project: 'o/r', title: 'Need ada', kind: 'question', body: 'Need the human.', waitingOn: ['ada'] });
  clock.tick(MIN);
  assert.doesNotMatch(brief(a, 'ada') || '', /stalled/);

  clock.tick(13 * 60 * MIN);
  const board = a.waitingBoard();
  assert.equal(board.find((w) => w.on === 'ada').stalled, false, 'a wait on the human never stalls');
  const human = brief(a, 'ada');
  assert.match(human, /5 stalled waits nobody has picked up/);
  assert.match(human, /\+2 more\)/, 'capped at 3 groups');
  assert.equal((human.match(/ in /g) || []).length, 3);
  const { stalledNote, stalledSummary } = await import('../src/format.js');
  const g = board.find((w) => w.project === 'global');
  assert.match(stalledNote(g), /start one in any project/);
  assert.doesNotMatch(stalledNote(g), /in global/);
  assert.equal(stalledSummary([g]), 'fable in any project');

  // agent briefs: no stalled line, and only main's scoped board calls (perf guard)
  const calls = []; const orig = a.waitingBoard.bind(a);
  a.waitingBoard = (opts = {}) => { calls.push(opts); return orig(opts); };
  for (const [me, project, instance] of [['sol', 'o/r', 's1'], ['opus', 'o/r', 'o1'], ['fable', 'x/y', 'f1']]) {
    assert.doesNotMatch(brief(a, me, { project, instance }) || '', /stalled/, `${me} brief`);
  }
  assert.ok(calls.length > 0);
  assert.ok(calls.every((c) => c.on), 'agent briefs never call the unscoped waitingBoard()');
  calls.length = 0; brief(a, 'ada');
  assert.ok(calls.some((c) => !c.on), 'the human brief does');
});

test('one running status thread per agent per project', async () => {
  const { a, clock } = fresh();
  const first = await a.open({ as: 'fable', project: 'o/r', kind: 'status', title: 'Working on task 12', body: 'Started.' });
  const e = await rejects(a.open({ as: 'fable', project: 'o/r', kind: 'status', title: 'Working on task 13', body: 'Started.' }), 'status-thread-exists');
  assert.match(e.message, new RegExp(first.thread));
  assert.match(e.hint, new RegExp(`post your status to ${first.thread}`));

  // a status thread that waits on someone, or mentions them, is not a monologue
  await a.open({ as: 'fable', project: 'o/r', kind: 'status', title: 'Blocked on opus', body: 'Need the schema.', waitingOn: ['opus'] });
  await a.open({ as: 'fable', project: 'o/two', kind: 'status', title: 'Elsewhere', body: 'Started.' });
  await a.open({ as: 'sol', project: 'o/r', kind: 'status', title: 'Sol is also working', body: 'Started.' });
  await a.open({ as: 'ada', project: 'o/r', kind: 'status', title: 'Human status', body: 'Exempt.' });
  await a.open({ as: 'fable', project: 'o/r', kind: 'proposal', title: 'A proposal', body: 'Not a status thread.' });

  // and the next one is allowed once the running thread is closed
  clock.tick(MIN);
  await a.close({ as: 'fable', thread: first.thread, body: 'Task 12 is done.' });
  clock.tick(MIN);
  const next = await a.open({ as: 'fable', project: 'o/r', kind: 'status', title: 'Working on task 13', body: 'Started.' });
  assert.ok(next.thread);
});

test('gc removes expired threads; dry-run writes nothing', async () => {
  const { a, clock } = fresh();
  const { thread } = await a.open({ as: 'fable', title: 'T', body: 'p0' });
  const r = await a.post({ as: 'opus', thread, body: 'x', dryRun: true });
  assert.equal(r.dryRun, true); assert.equal(a.thread(thread).posts.length, 1);
  assert.deepEqual(a.gc(), []);
  clock.tick(73 * 60 * MIN);
  assert.deepEqual(a.gc(), [thread]);
  assert.equal(a.thread(thread), null);
});

// gc decides and deletes under the store lock, so it cannot interleave with a writer.
const RACE_LIMITS = { threadTtlHours: 0.4 / 3600, closedTtlHours: 0.4 / 3600, perThreadPerHour: 1e6, perThreadLifetime: 1e6,
  familyGlobalPerHour: 1e6, openThreadsPerAgent: 1e6, consecutiveGraceMin: 0, threadPostCap: 1e6, pingPongWindow: 1e6 };

test('gc racing posts in other processes never loses a post: it lands and survives, or is cleanly rejected', async () => {
  const { a, home } = fresh();
  a.store.saveConfig({ ...a.config(), limits: { ...a.config().limits, ...RACE_LIMITS } });
  const api = pathToFileURL(path.join(ROOT, 'src', 'api.js')).href;
  const env = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, ...HARNESS_CLEAN, IAC_HOME: home, IAC_PROJECT: 'test/suite' };
  const runMs = process.platform === 'win32' ? 8000 : 5000;
  // The poster keeps four threads alive with irregular gaps around the 0.4 s TTL, and gc runs
  // at irregular intervals, so many posts revive a thread that has expired but is not yet
  // swept, often while gc is sweeping. Right after each
  // accepted post it reads the file: the post must be there (a legitimate sweep needs 0.4 s
  // of silence after it). A swept thread may refuse the post, but only cleanly.
  const poster = `
    import fs from 'node:fs'; import { Agora } from ${JSON.stringify(api)};
    const a = new Agora(process.env.IAC_HOME, { env: { IAC_PROJECT: 'test/suite' } });
    const out = { ok: 0, revived: 0, rejected: 0, opened: 0, lost: [], raw: [], accepted: [] };
    const live = []; const last = new Map();
    const openOne = async () => { const r = await a.open({ as: 'ada', kind: 'status', title: 'race', body: 'go' }); out.opened++; last.set(r.thread, Date.now()); return r.thread; };
    for (let i = 0; i < 4; i++) live.push(await openOne());
    const end = Date.now() + ${runMs};
    while (Date.now() < end) {
      for (let i = 0; i < live.length; i++) {
        const t = live[i]; const gap = Date.now() - last.get(t);
        try {
          const before = Date.now();
          const r = await a.post({ as: 'ada', thread: t, body: 'p' });
          out.accepted.push([t, before, r.post]);
          const text = (() => { try { return fs.readFileSync(a.store.threadPath(t), 'utf8'); } catch { return ''; } })();
          if (!text.includes(r.post)) out.lost.push(t + ' ' + r.post);
          out.ok++; if (gap > 400) out.revived++; last.set(t, Date.now());
        } catch (e) {
          if (e.code === 'swept' || /^no such thread/.test(e.message)) { out.rejected++; live[i] = await openOne(); }
          else out.raw.push(String(e.code) + ' ' + e.message);
        }
      }
      await new Promise((r) => setTimeout(r, 200 + Math.random() * 400));
    }
    console.log(JSON.stringify(out));`;
  const sweeper = `
    import { Agora } from ${JSON.stringify(api)};
    const a = new Agora(process.env.IAC_HOME, { env: { IAC_PROJECT: 'test/suite' } });
    // A slow delete (a busy disk, a virus scanner) widens the gap between gc's decision and
    // its rm; unlocked, posts landed in that gap and were deleted with the thread.
    const pause = new Int32Array(new SharedArrayBuffer(4)); const del = a.store.deleteThread.bind(a.store); const removed = [];
    // What gc decided on: the file as it is when gc calls delete, captured before the slow
    // part, so a post landing in the decision-to-rm gap (the unlocked bug) is not in it. Ids,
    // not clocks, so the check holds when the system clock steps (WSL2's Hyper-V time sync
    // does, under load).
    a.store.deleteThread = (id) => { const seen = [...(a.store.threadText(id) || '').matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]); Atomics.wait(pause, 0, 0, 60); del(id); removed.push([id, Date.now(), seen]); };
    const end = Date.now() + ${runMs + 500};
    while (Date.now() < end) { a.gc(); await new Promise((r) => setTimeout(r, Math.random() * 250)); }
    console.log(JSON.stringify({ removed }));`;
  const run = (program) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', program], { env });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`exit ${code}: ${stderr}`)));
  });
  const [posted, swept] = await Promise.all([run(poster), run(sweeper)]);
  // Every accepted post into a thread gc deleted must be in the file gc held when it decided:
  // one missing was deleted by a decision that predates it. Compared by post id, not by
  // timestamps: the two processes' Date.now() stamps straddle any step of the system clock.
  const unseen = swept.removed.flatMap(([id, at, seen]) => posted.accepted.filter(([t, , post]) => t === id && !seen.includes(post)).map(([, before, post]) => `${id}: ${post} accepted at ${before}, not in the file swept at ${at}`));
  assert.deepEqual(unseen, [], 'an accepted post was deleted by a gc that decided before it landed');
  assert.deepEqual(posted.lost, [], 'an accepted post was gone straight after it was accepted');
  assert.deepEqual(posted.raw, [], 'a post racing gc fails only as a clean rejection');
  // exercised: posts revived threads that had expired, or met threads gc had just swept
  assert.ok(posted.revived > 0 || posted.rejected > 0, `the race was exercised (${JSON.stringify(posted)})`);
  assert.ok(swept.removed.length > 0, 'and gc swept threads meanwhile');
  for (const id of a.store.threadIds()) assert.equal(a.verify(id).ok, true, `${id} still verifies`);
});

test('a post into a thread swept from under it is a clear Rejected and writes nothing', async () => {
  const { a } = fresh();
  for (const how of ['forgotten', 'cached']) {
    const { thread } = await a.open({ as: 'fable', title: `swept ${how}`, body: 'p0' });
    const file = a.store.threadPath(thread);
    // Simulate a deleter that does not take the lock (an older iac, or a hand rm): the file
    // goes after post has read the thread's state, before it appends. 'forgotten' also drops
    // the read cache; 'cached' leaves the pre-delete text cached so the append itself hits ENOENT.
    const threads = a.threads; let gone = false;
    a.threads = function (...args) {
      if (!gone) { gone = true; if (how === 'forgotten') this.store.deleteThread(thread); else fs.rmSync(file); }
      return threads.apply(this, args);
    };
    try {
      const e = await rejects(a.post({ as: 'opus', thread, body: 'too late' }), 'swept');
      assert.equal(e.message, `thread ${thread} expired and was swept; nothing was written`);
    } finally { a.threads = threads; }
    assert.equal(fs.existsSync(file), false, 'the post does not recreate the file');
  }
});

test('gc with a bounded wait skips when the lock is busy; brief never waits on the lock', async () => {
  const { a, clock, home } = fresh();
  const { thread } = await a.open({ as: 'fable', title: 'T', body: 'p0' });
  clock.tick(73 * 60 * MIN);
  const lock = path.join(home, '.lock');
  fs.mkdirSync(lock);   // another process is mid-write
  try {
    let t0 = Date.now();
    assert.equal(a.gc({ waitMs: 50 }), null, 'busy: nothing swept, and it says so');
    assert.ok(Date.now() - t0 < 2000, `gc gave up promptly (${Date.now() - t0} ms)`);
    t0 = Date.now();
    assert.equal(await a.gcAsync({ waitMs: 50 }), null);
    assert.ok(Date.now() - t0 < 2000, `gcAsync gave up promptly (${Date.now() - t0} ms)`);
    assert.ok(fs.existsSync(a.store.threadPath(thread)), 'the expired thread waits for the next gc');
    t0 = Date.now();
    const brief = spawnSync(process.execPath, [binPath('iac.js'), 'brief', '--as', 'opus'],
      { env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, ...HARNESS_CLEAN, IAC_HOME: home, IAC_PROJECT: 'test/suite' }, encoding: 'utf8', timeout: 20_000 });
    const took = Date.now() - t0;
    assert.equal(brief.status, 0, brief.stderr);
    assert.ok(took < 5000, `brief does not wait for the lock (${took} ms; a writer waits up to 10 s)`);
    assert.ok(fs.existsSync(lock), 'and leaves the holder\'s lock alone');
  } finally { fs.rmSync(lock, { recursive: true, force: true }); }
  assert.deepEqual(a.gc({ waitMs: 50 }), [thread], 'free again: the bounded gc sweeps');
  assert.equal(a.thread(thread), null, 'and the read cache forgets the deleted thread');
});

// gc sweeps in batches, so a writer waits at most one batch even on a slow disk.
async function expiredStore(n) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-test-'));
  let t = Date.now() - 100 * 60 * MIN;
  const old = new Agora(home, { now: () => t, env: { IAC_PROJECT: 'test/suite' } });
  old.init({ agents: ['fable', 'opus'], human: 'ada' });
  old.store.saveConfig({ ...old.config(), limits: { ...old.config().limits, openThreadsPerAgent: 1e6, familyGlobalPerHour: 1e6 } });
  const ids = [];
  for (let i = 0; i < n; i++) { ids.push((await old.open({ as: 'ada', kind: 'status', title: `old ${i}`, body: 'x' })).thread); t += 1000; }
  const a = new Agora(home, { env: { IAC_PROJECT: 'test/suite' } });
  return { a, home, ids };
}
// stands in for a WSL /mnt/c store, where one delete costs ~66 ms
function slowDeletes(store, ms) {
  const pause = new Int32Array(new SharedArrayBuffer(4)); const del = store.deleteThread.bind(store);
  store.deleteThread = (id) => { Atomics.wait(pause, 0, 0, ms); del(id); };
}

test('a batched gc on a slow disk lets a concurrent writer through within about a batch', async () => {
  const { a, home, ids } = await expiredStore(60);   // 60 x 66 ms: about 4 s of deletes in all
  const { thread } = await a.open({ as: 'ada', kind: 'status', title: 'live', body: 'x' });
  const api = pathToFileURL(path.join(ROOT, 'src', 'api.js')).href;
  const sweeper = `
    import { Agora } from ${JSON.stringify(api)};
    const a = new Agora(process.env.IAC_HOME, { env: { IAC_PROJECT: 'test/suite' } });
    const pause = new Int32Array(new SharedArrayBuffer(4)); const del = a.store.deleteThread.bind(a.store); let first = true;
    a.store.deleteThread = (id) => { if (first) { first = false; process.stdout.write('deleting\\n'); } Atomics.wait(pause, 0, 0, 66); del(id); };
    const t0 = performance.now(); const r = a.sweep();   // monotonic: WSL2's wall clock steps back under load
    process.stdout.write(JSON.stringify({ removed: r.removed.length, remaining: r.remaining, ms: Math.round(performance.now() - t0) }) + '\\n');`;
  const p = spawn(process.execPath, ['--input-type=module', '-e', program(sweeper)], { env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, ...HARNESS_CLEAN, IAC_HOME: home } });
  function program(s) { return s; }
  let out = ''; let err = ''; p.stderr.on('data', (d) => { err += d; });
  const started = new Promise((resolve) => p.stdout.on('data', (d) => { out += d; if (out.includes('deleting')) resolve(); }));
  const done = new Promise((resolve) => p.on('close', resolve));
  await started;
  const t0 = performance.now();
  await a.post({ as: 'ada', thread, body: 'through' });
  const waited = Math.round(performance.now() - t0);
  assert.equal(await done, 0, err);
  const r = JSON.parse(out.split('\n').filter((l) => l.startsWith('{'))[0]);
  assert.deepEqual([r.removed, r.remaining], [ids.length, 0]);
  assert.ok(r.ms > 3000, `the sweep as a whole was long (${r.ms} ms)`);
  assert.ok(waited < 2000, `the post waited ${waited} ms; at most one batch (~1.3 s here)`);
  console.log(`batched sweep: the concurrent post waited ${waited} ms during a ${r.ms} ms sweep`);
  assert.equal(a.thread(thread).posts.length, 2);
});

test('gc batches respect maxMs and report what remains; gcAsync yields between batches; iac gc --max-ms', async () => {
  const { a, home, ids } = await expiredStore(12);
  slowDeletes(a.store, 40);
  const r = a.sweep({ maxMs: 150, batchMax: 2 });
  assert.ok(r.removed.length >= 2 && r.removed.length < ids.length, JSON.stringify(r));
  assert.equal(r.remaining, ids.length - r.removed.length, 'every candidate not reached is reported');
  let ticks = 0; const tick = setInterval(() => { ticks++; }, 1);
  const rest = await a.gcAsync({ batchMax: 2 });
  clearInterval(tick);
  assert.equal(rest.length, r.remaining);
  assert.ok(ticks >= 3, `the event loop ran between batches (${ticks} ticks)`);
  assert.deepEqual(a.store.threadIds(), []);
  const more = await expiredStore(3);
  const env = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, ...HARNESS_CLEAN, IAC_HOME: more.home };
  const cut = spawnSync(process.execPath, [binPath('iac.js'), 'gc', '--max-ms', '0', '--json'], { env, encoding: 'utf8', timeout: 20_000 });
  assert.equal(cut.status, 0, cut.stderr);
  assert.deepEqual(JSON.parse(cut.stdout).remaining, 3);
  const all = spawnSync(process.execPath, [binPath('iac.js'), 'gc'], { env, encoding: 'utf8', timeout: 20_000 });
  assert.match(all.stdout, /removed 3 expired thread/);
  const bad = spawnSync(process.execPath, [binPath('iac.js'), 'gc', '--max-ms', 'soon'], { env, encoding: 'utf8', timeout: 20_000 });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /--max-ms must be a number/);
  void home;
});

test('an unbounded sweep retries a busy lock, then stops cleanly with what is left instead of failing', async () => {
  const { a, ids } = await expiredStore(4);
  const locked = a.store.withLockSync.bind(a.store); let busyFor = 0; let waits = 0;
  a.store.withLockSync = (fn, o) => { waits++; if (busyFor > 0) { busyFor--; throw Object.assign(new Error('store lock busy'), { code: 'ELOCKBUSY' }); } return locked(fn, o); };
  busyFor = 2;   // a long writer holds it for two whole waits: the sweep waits it out
  const r = a.sweep({ batchMax: 2 });
  assert.deepEqual([r.removed.length, r.remaining, r.busy, waits], [ids.length, 0, false, 4]);
  const more = await expiredStore(3);
  more.a.store.withLockSync = () => { throw Object.assign(new Error('store lock busy'), { code: 'ELOCKBUSY' }); };
  const stuck = more.a.sweep({ busyRetries: 2 });
  assert.deepEqual([stuck.removed, stuck.remaining, stuck.busy, stuck.skipped], [[], 3, true, true]);
  assert.equal(more.a.gc({ busyRetries: 0 }), null, 'gc reports a skipped sweep as null, not an exception');
});

// The store lock is owned (an entry named by the holder's token in .lock) and kept alive by its holder.
function lockPair(home) {
  let t = Date.now();
  const clock = { now: () => t, tick: (ms) => { t += ms; } };
  const mk = () => { const s = new Store(home); s._lockNow = clock.now; const warned = []; s._warn = (m) => warned.push(m); s.warned = warned; return s; };
  return { A: mk(), B: mk(), C: mk(), clock, owner: () => lockOwnerOf(home) };
}
// the token of the one owner entry in .lock (its name carries it); throws when there is none
function lockOwnerOf(home) {
  const owners = fs.readdirSync(path.join(home, '.lock')).filter((n) => n.startsWith('owner-'));
  assert.equal(owners.length, 1, `one owner entry: ${owners}`);
  return owners[0].slice('owner-'.length);
}

test('a heartbeat keeps a live holder from being broken as stale (35 s on a seam clock), sync and async', async () => {
  const { home } = fresh();
  const { A, B, clock, owner } = lockPair(home);
  A.withLockSync(() => {
    const mine = owner();
    for (let i = 0; i < 7; i++) { clock.tick(5_000); A.heartbeat(); }   // 35 s of a long holder that keeps beating
    assert.equal(B._tryLock(Date.now()), false); assert.equal(B._tryLock(Date.now()), false);
    assert.equal(owner(), mine, 'still A\'s lock');
  });
  assert.equal(fs.existsSync(path.join(home, '.lock')), false, 'A released its own lock');
  A._heartbeatMs = 10;
  await A.withLock(async () => {
    const mine = owner();
    for (let i = 0; i < 7; i++) { clock.tick(5_000); await new Promise((r) => setTimeout(r, 30)); }
    assert.equal(B._tryLock(Date.now()), false);
    assert.equal(owner(), mine, 'the async holder\'s timer kept it fresh');
  });
  // a long synchronous holder that never calls heartbeat() itself (a post deriving a big
  // board) is kept fresh by its own thread reads
  const t = fs.readdirSync(path.join(home, 'threads'))[0]?.slice(0, -7) ?? 't-00000000';
  A._heartbeatMs = 0;
  A.withLockSync(() => {
    const mine = owner();
    for (let i = 0; i < 7; i++) { clock.tick(5_000); A.readEvents(t); }
    assert.equal(B._tryLock(Date.now()), false);
    assert.equal(owner(), mine, 'reads under the lock kept it fresh');
  });
  assert.deepEqual([A.warned, B.warned], [[], []]);
  // a dead holder (no heartbeat) is still broken once stale
  assert.equal(A._tryLock(Date.now()), true); A._lockToken = null;   // A "dies" holding it
  clock.tick(35_000);
  assert.equal(B._tryLock(Date.now()), false, 'the stale lock is broken first'); assert.equal(B._tryLock(Date.now()), true);
  B._unlock();
});

test('unlock leaves a lock it does not own; a stolen lock is not released by its old holder', () => {
  const { home } = fresh();
  const { A, B, C, clock, owner } = lockPair(home);
  const lockDir = path.join(home, '.lock');
  // foreign token: A's release must not remove it
  assert.equal(A._tryLock(Date.now()), true);
  const foreign = 'f'.repeat(32);
  fs.unlinkSync(path.join(lockDir, `owner-${A._lockToken}`)); fs.writeFileSync(path.join(lockDir, `owner-${foreign}`), JSON.stringify({ token: foreign, pid: 1, host: 'elsewhere' }));
  A._unlock();
  assert.equal(owner(), foreign, 'left in place');
  assert.match(A.warned.join('\n'), /held by another process; not ours to release/);
  fs.rmSync(lockDir, { recursive: true });
  // A stalls past the stale limit without a heartbeat; B breaks and takes the lock. A's
  // release afterwards must not free B's lock, or C would get in while B still holds it.
  A.warned.length = 0;
  A.withLockSync(() => {
    clock.tick(35_000);
    assert.equal(B._tryLock(Date.now()), false); assert.equal(B._tryLock(Date.now()), true);
    assert.equal(B.heartbeat(), true, 'B holds it (and stamps it on the seam clock)');
    assert.equal(A.heartbeat(), false, 'A can tell it lost the lock');
  });
  assert.equal(owner(), B._lockToken, 'B still holds it after A\'s release');
  assert.match(A.warned.join('\n'), /not ours to release/);
  assert.equal(C._tryLock(Date.now()), false, 'so C stays out');
  B._unlock();
  assert.equal(C._tryLock(Date.now()), true); C._unlock();
  assert.deepEqual([B.warned, C.warned], [[], []]);
  assert.deepEqual(fs.readdirSync(home).filter((f) => f.startsWith('.lock')), [], 'nothing left behind');
});

test('a lock taken over between the stale look and the break is left alone, not deleted', () => {
  const { home } = fresh();
  const { A, B, clock, owner } = lockPair(home);
  assert.equal(A._tryLock(Date.now()), true); A._lockToken = null;   // dead holder
  clock.tick(35_000);
  // between B's look and its rename, the dead lock is cleared and C takes a fresh one
  const look = B._lockOwner.bind(B); let swapped = false; let fresh2;
  B._lockOwner = (dir) => {
    const r = look(dir);
    if (!swapped) { swapped = true; fs.rmSync(path.join(home, '.lock'), { recursive: true }); const C = new Store(home); C._lockNow = clock.now; assert.equal(C._tryLock(Date.now()), true); fresh2 = C; }
    return r;
  };
  assert.equal(B._tryLock(Date.now()), false);
  assert.equal(owner(), fresh2._lockToken, 'the live lock is back in place');
  fresh2._unlock();
});

test('a post swept part-way through its action says the thread and its earlier events are gone (partial)', async () => {
  const { a } = fresh();
  const { thread } = await a.open({ as: 'fable', title: 'T', body: 'p0' });
  const append = a.store.appendEvent.bind(a.store); let n = 0;
  a.store.appendEvent = (id, ev) => { append(id, ev); if (++n === 1) fs.rmSync(a.store.threadPath(id)); };   // swept by a lockless deleter right after the resolution post
  try {
    const e = await rejects(a.close({ as: 'fable', thread, body: 'done' }), 'swept');
    assert.equal(e.partial, true);
    assert.equal(e.message, `thread ${thread} expired and was swept part-way through this action; the thread and the events this action had already written are gone`);
  } finally { a.store.appendEvent = append; }
  const { thread: t2 } = await a.open({ as: 'opus', title: 'T2', body: 'p0' });
  a.store.deleteThread(t2);
  const whole = await a.post({ as: 'fable', thread: t2, body: 'x' }).catch((e) => e);
  assert.match(whole.message, /no such thread/, 'gone before the action began: nothing to call partial');
});

test('the heartbeat also keeps the .lock dir fresh, so a pre-owner-file iac does not break a live holder', () => {
  const { home } = fresh();
  const { A, clock } = lockPair(home);
  const lockDir = path.join(home, '.lock');
  // iac 0.3.x and earlier: stat the dir, break it when its mtime is over 30 s old
  const oldClientWouldBreak = () => clock.now() - fs.statSync(lockDir).mtimeMs > 30_000;
  A.withLockSync(() => {
    for (let i = 0; i < 9; i++) { clock.tick(5_000); A.heartbeat(); }   // 45 s
    assert.equal(oldClientWouldBreak(), false, 'beats refresh the dir, not only the owner file');
    clock.tick(31_000);
    assert.equal(oldClientWouldBreak(), true, 'the check itself does fire on a holder that stops beating');
  });
});

test('a transient mkdir error on the lock dir is busy, retried within the timeout', () => {
  const { home } = fresh();
  const s = new Store(home); s._warn = () => {};
  const lockDir = path.join(home, '.lock');
  const failing = (codes) => (orig, p, ...o) => { if (String(p) === lockDir && codes.length) throw Object.assign(new Error(`${codes[0]}: mkdir`), { code: codes.shift() }); return orig(p, ...o); };
  // ENOENT (a delete-pending .lock on drvfs) on any platform while the store dir exists
  assert.equal(patch45(fs, 'mkdirSync', failing(['ENOENT', 'ENOENT']), () => s.withLockSync(() => 'in')), 'in');
  // EPERM/EACCES/EBUSY: busy on win32 and on a /mnt/<drive> store, a real error elsewhere
  s._fs.platform = 'win32';
  assert.equal(patch45(fs, 'mkdirSync', failing(['EPERM', 'EACCES', 'EBUSY']), () => s.withLockSync(() => 'in')), 'in');
  s._fs.platform = 'linux';
  assert.throws(() => patch45(fs, 'mkdirSync', failing(['EPERM']), () => s.withLockSync(() => 'in')), (e) => e.code === 'EPERM');
  const drv = new Store('/mnt/c/Users/x/iac-store-that-is-not-there'); drv._fs.platform = 'linux';
  assert.equal(drv._transientLockError({ code: 'EACCES' }), true);
  // a busy error that never clears ends as ELOCKBUSY naming it
  assert.throws(() => patch45(fs, 'mkdirSync', failing(Array(1000).fill('ENOENT')), () => s.withLockSync(() => 'in', { timeoutMs: 150 })),
    (e) => e.code === 'ELOCKBUSY' && /last attempt: ENOENT/.test(e.message));
  // ENOENT because the store itself is missing is not busy: it fails at once
  const gone = new Store(path.join(home, 'no-such-store'));
  const t0 = Date.now();
  assert.throws(() => gone.withLockSync(() => 'in'), (e) => e.code === 'ENOENT');
  assert.ok(Date.now() - t0 < 2000);
});

test('lock timeout distinguishes permission-like failures from contention without changing lock state', () => {
  const { home } = fresh();
  const s = new Store(home); s._warn = () => {};
  const lockDir = path.join(home, '.lock');
  const failMkdir = (code) => (orig, p, ...o) => {
    if (String(p) === lockDir) throw Object.assign(new Error(`${code}: mkdir`), { code });
    return orig(p, ...o);
  };
  for (const code of ['EPERM', 'EACCES']) {
    s._fs.platform = 'win32';
    for (const timeoutMs of [0, undefined]) {
      let invoked = false;
      const acquire = () => timeoutMs === undefined
        ? s._tryLock(Date.now() - LOCK_TIMEOUT_MS - 1)
        : s.withLockSync(() => { invoked = true; }, { timeoutMs });
      assert.throws(() => patch45(fs, 'mkdirSync', failMkdir(code), acquire),
        (e) => e.code === 'ELOCKBUSY' && e.message.includes(`last attempt: ${code}`) && e.message.includes('normal scoped filesystem approval may be needed') && e.message.includes('does not distinguish sandbox policy from ACL or sharing restrictions') && !e.message.includes('stale .lock dir?') && (timeoutMs === undefined ? e.message.startsWith('could not acquire store lock') : e.message.includes(`store lock busy for ${timeoutMs} ms`)));
      assert.equal(invoked, false);
      assert.equal(fs.existsSync(lockDir), false);
    }
    const statHome = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-lock-stat-test-'));
    const statStore = new Store(statHome); statStore._fs.platform = 'win32';
    const statLockDir = path.join(statHome, '.lock');
    assert.throws(() => patch45(fs, 'statSync', (orig, p, ...o) => {
      if (String(p) === statLockDir) throw Object.assign(new Error(`${code}: stat`), { code });
      return orig(p, ...o);
    }, () => statStore._tryLock(Date.now() - LOCK_TIMEOUT_MS - 1)),
    (e) => e.code === 'ELOCKBUSY' && e.message.includes(`last attempt: ${code}`) && e.message.includes('normal scoped filesystem approval may be needed') && !e.message.includes('stale .lock dir?'));
    assert.deepEqual(fs.readdirSync(statLockDir), [], 'the injected stat failure leaves the newly made empty dir untouched');
  }
  s._fs.platform = 'win32';
  for (const code of ['EEXIST', 'EBUSY', 'ENOENT']) {
    assert.throws(() => patch45(fs, 'mkdirSync', failMkdir(code), () => s._tryLock(Date.now() - LOCK_TIMEOUT_MS - 1)),
      (e) => e.code === 'ELOCKBUSY' && e.message.includes('stale .lock dir?') && !e.message.includes('filesystem approval') && !e.message.includes('sandbox policy'));
    assert.equal(fs.existsSync(lockDir), false);
  }
  s._fs.platform = 'linux';
  assert.throws(() => patch45(fs, 'mkdirSync', failMkdir('EPERM'), () => s.withLockSync(() => assert.fail('must not enter'), { timeoutMs: 0 })),
    (e) => e.code === 'EPERM', 'permission-like errors outside Windows/drvfs retain their existing behavior');
  assert.equal(fs.existsSync(lockDir), false);
});

test('a stale break leaves a bare fresh dir it did not empty; a lost lock never writes', async () => {
  const { a, home } = fresh();
  const { A, B, clock } = lockPair(home);
  const lockDir = path.join(home, '.lock');
  assert.equal(A._tryLock(Date.now()), true); A._lockToken = null;   // a dead holder
  clock.tick(35_000);
  // between B's look and its rename, the dead lock goes and a taker mkdirs .lock but has not
  // written its owner yet: B moves that empty dir aside and must not put it back
  const look = B._lockOwner.bind(B); let swapped = false;
  B._lockOwner = (dir) => { const r = look(dir); if (!swapped) { swapped = true; fs.rmSync(lockDir, { recursive: true }); fs.mkdirSync(lockDir); } return r; };
  assert.equal(B._tryLock(Date.now()), false);
  // a bare fresh dir is left alone: it may be that taker about to write its entry, or an iac
  // 0.3.x client's whole lock. B unlinked nothing, so it removes nothing.
  assert.equal(fs.existsSync(lockDir), true, 'B unlinked nothing, so it removed nothing: the bare dir is not B\'s to remove');
  // it goes only once stale by its own age (35 s on the seam clock here): a dead taker or a
  // dead 0.3.x holder, judged the way 0.3.x clients judge each other
  B._lockOwner = look;
  assert.equal(B._tryLock(Date.now()), false, 'judged stale by the dir mtime and removed');
  assert.equal(fs.existsSync(lockDir), false);
  assert.equal(B._tryLock(Date.now()), true); B._unlock();
  assert.deepEqual(fs.readdirSync(home).filter((f) => f.startsWith('.lock')), []);
  // a holder that lost its lock mid-action writes nothing: the post fails with ELOCKLOST
  const { thread } = await a.open({ as: 'fable', title: 'T', body: 'p0' });
  const file = a.store.threadPath(thread); const before = fs.readFileSync(file, 'utf8');
  const warned = []; a.store._warn = (m) => warned.push(m);
  const threads = a.threads; let taken = false; const newHolder = 'e'.repeat(32);
  a.threads = function (...args) {
    if (!taken) { taken = true; fs.rmSync(lockDir, { recursive: true }); fs.mkdirSync(lockDir); fs.writeFileSync(path.join(lockDir, `owner-${newHolder}`), JSON.stringify({ token: newHolder })); }
    return threads.apply(this, args);
  };
  try {
    await assert.rejects(a.post({ as: 'opus', thread, body: 'too late' }), (e) => e.code === 'ELOCKLOST' && /no longer held by this process/.test(e.message));
  } finally { a.threads = threads; }
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'nothing was appended');
  assert.match(warned.join('\n'), /not ours to release/, 'and the new holder\'s lock is left alone');
  assert.equal(lockOwnerOf(home), newHolder);
  fs.rmSync(lockDir, { recursive: true });
});

test('a taker clears .lock.stale-* dirs a crashed breaker left once they are old, and only those', () => {
  const { home } = fresh();
  const old = path.join(home, '.lock.stale-deadbeef'); const young = path.join(home, '.lock.stale-cafef00d');
  fs.mkdirSync(old); fs.writeFileSync(path.join(old, 'owner'), '{}'); fs.mkdirSync(young);
  const long = new Date(Date.now() - LOCK_ASIDE_MAX_AGE_MS - 60_000); fs.utimesSync(old, long, long);
  const s = new Store(home);
  s.withLockSync(() => {});
  assert.equal(fs.existsSync(old), false);
  assert.ok(fs.existsSync(young), 'a recent one may belong to a break in progress');
});

// Deterministic interleavings of the lock's release and stale break, with
// the extra acquisition steps the earlier tests left out. No lock is ever renamed or deleted
// recursively now: a release unlinks its own entry by name and removes the dir only if empty.
const lockFiles = (home) => fs.readdirSync(home).filter((f) => f.startsWith('.lock')).sort();

test('unlock: A reads its owner, B breaks stale A and takes the lock, A releases: B keeps it and C stays out', () => {
  const { home } = fresh();
  const { A, B, C, clock, owner } = lockPair(home);
  assert.equal(A._tryLock(Date.now()), true);
  // what happens inside the hook is recorded, not asserted: the look sits in a try/catch
  const look = A._lockOwner.bind(A); let swapped = false; const steps = [];
  A._lockOwner = (dir) => {
    const seen = look(dir);   // A's view before B moves: its own live token
    if (!swapped) {
      swapped = true; clock.tick(35_000);
      steps.push(B._tryLock(Date.now()), B._tryLock(Date.now()), B.heartbeat());   // break, take, stamp the entry on the seam clock as a live holder does
    }
    return seen;
  };
  A._unlock();
  assert.deepEqual(steps, [false, true, true], 'B broke the stale lock and took it');
  assert.equal(fs.existsSync(path.join(home, '.lock')), true, 'A did not delete B\'s lock');
  assert.equal(owner(), B._lockToken, 'B still owns the dir');
  assert.match(A.warned.join('\n'), /held by another process; not ours to release/);
  assert.equal(C._tryLock(Date.now()), false, 'C cannot enter while B holds it');
  assert.equal(B.heartbeat(), true);
  B._unlock();
  assert.equal(C._tryLock(Date.now()), true); C._unlock();
  assert.deepEqual(lockFiles(home), [], 'nothing renamed aside or left behind');
  assert.deepEqual([B.warned, C.warned], [[], []]);
});

test('guard probe: B passes the pre-write check, A\'s delayed release lands mid-write: B\'s write is under B\'s own lock and C never enters', () => {
  const { home } = fresh();
  const { A, B, C, clock } = lockPair(home);
  assert.equal(A._tryLock(Date.now()), true);
  const look = A._lockOwner.bind(A); let armed = false; const steps = [];
  A._lockOwner = (dir) => { const seen = look(dir); if (!armed) { clock.tick(35_000); steps.push(B._tryLock(Date.now()), B._tryLock(Date.now()), B.heartbeat()); armed = true; } return seen; };
  const mine = path.join(home, '.lock', `owner-${A._lockToken}`);
  let written = false; let cEntered = null; let aUnlink = null;
  patch45(fs, 'unlinkSync', function (orig, p, ...o) {
    if (!armed || String(p) !== mine) return orig(p, ...o);   // B's break unlinks the same name: that one is B's, not A's
    // A's release step runs inside B's already-checked mutation; A still gets its outcome
    let outcome;
    B._mutating(['json:probe.json'], () => {
      try { orig(p, ...o); aUnlink = 'removed'; } catch (e) { aUnlink = e.code; outcome = e; }
      cEntered = C._tryLock(Date.now());
      fs.writeFileSync(path.join(home, 'probe.json'), '{"writer":"B"}\n'); written = true;
    });
    if (outcome) throw outcome;
  }, () => A._unlock());
  assert.deepEqual(steps, [false, true, true], 'B broke the stale lock and took it');
  assert.deepEqual({ aUnlink, written, cEntered, bHolds: lockOwnerOf(home) === B._lockToken, bWarned: B.warned },
    { aUnlink: 'ENOENT', written: true, cEntered: false, bHolds: true, bWarned: [] }, 'A\'s entry was long gone, so A touched nothing of B\'s');
  assert.match(A.warned.join('\n'), /not ours to release/);
  B._unlock();
  assert.equal(C._tryLock(Date.now()), true); C._unlock();
  assert.deepEqual(lockFiles(home), []);
});

test('break: C replaces dead A before B acts and D tries during B\'s break: C keeps its lock, nothing is moved aside', () => {
  for (const when of ['before the unlink', 'between the unlink and the rmdir']) {
    const { home } = fresh();
    const { A, B, C, clock, owner } = lockPair(home);
    const D = new Store(home); D._lockNow = clock.now; D._warn = () => {};
    assert.equal(A._tryLock(Date.now()), true); A._lockToken = null;   // A dies holding it
    clock.tick(35_000);
    const lockDir = path.join(home, '.lock'); const stale = `owner-${lockOwnerOf(home)}`;
    // hook results are recorded, not asserted: the break runs inside _tryLock's try/catch
    let cTook = null;
    const replaceWithC = () => { fs.rmSync(lockDir, { recursive: true, force: true }); cTook = [C._tryLock(Date.now()), C.heartbeat()]; };
    const look = B._lockOwner.bind(B); let replaced = false;
    // the unlink hook is armed only for B's own break step (rmSync unlinks through the same function on some Node versions)
    let armed = when === 'between the unlink and the rmdir'; let inHook = false;
    B._lockOwner = (dir) => { const seen = look(dir); if (!replaced && when === 'before the unlink') { replaced = true; replaceWithC(); armed = true; } return seen; };
    let dTried = null; let bUnlinked = null;
    patch45(fs, 'unlinkSync', function (orig, p, ...o) {
      if (!armed || inHook || path.basename(String(p)) !== stale) return orig(p, ...o);
      inHook = true;
      try {
        try { orig(p, ...o); bUnlinked = true; } catch (e) { bUnlinked = e.code; }
        if (when === 'between the unlink and the rmdir') replaceWithC();   // A's empty dir is cleared and C takes the name before B's rmdir
        dTried = D._tryLock(Date.now());   // D arrives while B is mid-break
      } finally { inHook = false; }
    }, () => assert.equal(B._tryLock(Date.now()), false, 'B does not get the lock'));
    assert.deepEqual(cTook, [true, true], `C took a fresh lock (${when})`);
    assert.equal(bUnlinked, when === 'before the unlink' ? 'ENOENT' : true, when);
    assert.equal(dTried, false, `D stays out (${when})`);
    assert.equal(owner(), C._lockToken, `C still holds the lock (${when})`);
    assert.equal(C.heartbeat(), true, 'and can tell so');
    assert.equal(D._lockToken, null);
    assert.deepEqual(lockFiles(home), ['.lock'], `no .lock.stale-* aside (${when})`);
    assert.deepEqual([B.warned, C.warned], [[], []]);
    C._unlock();
    assert.equal(D._tryLock(Date.now()), true); D._unlock();
    assert.deepEqual(lockFiles(home), []);
  }
});

test('two takers whose entries land in one .lock dir: whoever sees the other yields, and the dir is left to the one that was alone', () => {
  const { home } = fresh();
  const { A, B } = lockPair(home);
  const lockDir = path.join(home, '.lock'); const other = 'b'.repeat(32);
  // A's mkdir was undone and redone under it; B's entry lands right after A's own write
  patch45(fs, 'writeFileSync', function (orig, p, ...o) {
    const r = orig(p, ...o);
    if (path.dirname(String(p)) === lockDir && !String(p).endsWith(other)) fs.writeFileSync(path.join(lockDir, `owner-${other}`), '{}');
    return r;
  }, () => assert.equal(A._tryLock(Date.now()), false, 'A sees another entry and yields'));
  assert.equal(A._lockToken, null);
  assert.deepEqual(fs.readdirSync(lockDir), [`owner-${other}`], 'A removed only its own entry; the dir is the other taker\'s');
  assert.equal(B._tryLock(Date.now()), false, 'a fresh lock with an owner is held');
  fs.rmSync(lockDir, { recursive: true });
  assert.equal(A._tryLock(Date.now()), true); A._unlock();
  assert.deepEqual(lockFiles(home), []);
});

test('a write that lands after its lock was lost is reported, and the next write refuses (fencing after the fact)', async () => {
  const { a, home } = fresh();
  const { thread } = await a.open({ as: 'fable', title: 'T', body: 'p0' });
  const lockDir = path.join(home, '.lock'); const taker = 'd'.repeat(32);
  const warned = []; a.store._warn = (m) => warned.push(m);
  const append = a.store.appendEvent.bind(a.store); let n = 0;
  a.store.appendEvent = (id, ev) => {
    // the break lands while the append is in flight: after its pre-write check, before its write returns
    const mut = a.store._mutating.bind(a.store);
    a.store._mutating = (keys, fn) => mut(keys, () => { const r = fn(); if (++n === 1) { fs.rmSync(lockDir, { recursive: true }); fs.mkdirSync(lockDir); fs.writeFileSync(path.join(lockDir, `owner-${taker}`), '{}'); } return r; });
    try { return append(id, ev); } finally { a.store._mutating = mut; }
  };
  const r = await a.post({ as: 'opus', thread, body: 'in flight' });
  assert.ok(r.post, 'the write itself is not undone or failed: a retry would duplicate it');
  assert.match(warned.join('\n'), /store lock .* was lost while writing t:.*run iac verify/);
  assert.match(warned.join('\n'), /not ours to release/);
  assert.equal(lockOwnerOf(home), taker, 'the new holder\'s lock is untouched');
  await assert.rejects(a.store.withLock(async () => {}, { timeoutMs: 100 }), (e) => e.code === 'ELOCKBUSY');
  fs.rmSync(lockDir, { recursive: true });
  assert.equal(a.verify(thread).ok, true);
});

test('maxMs is checked after the inter-batch pause and once the lock is held: no delete starts past the budget (sync and async)', async () => {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const slack = 5; // the test's clock starts before the sweep's, and rounds
  const timed = (a, ms = 10) => { const starts = []; const t0 = performance.now(); const del = a.store.deleteThread.bind(a.store); a.store.deleteThread = (id) => { starts.push(Math.round(performance.now() - t0)); Atomics.wait(pause, 0, 0, ms); del(id); }; return starts; };
  // Reproduction: four expired threads, 10 ms deletes, one per batch, a 100 ms budget;
  // the second batch used to start at ~190 ms, after the 150 ms pause
  let s = await expiredStore(4); let starts = timed(s.a);
  let r = s.a.sweep({ maxMs: 100, batchMax: 1 });
  assert.deepEqual([r.removed.length, r.remaining, starts.length], [1, 3, 1], JSON.stringify({ r, starts }));
  assert.ok(starts.every((t) => t <= 100 + slack), `every delete started inside the budget: ${starts}`);
  s = await expiredStore(4); starts = timed(s.a);
  r = await s.a.sweepAsync({ maxMs: 100, batchMax: 1 });
  assert.deepEqual([r.removed.length, r.remaining, starts.length], [1, 3, 1], JSON.stringify({ r, starts }));
  assert.ok(starts.every((t) => t <= 100 + slack), `async: ${starts}`);
  // the wait for the lock can use the budget up too: a batch that gets the lock late does nothing
  s = await expiredStore(4); starts = timed(s.a);
  const locked = s.a.store.withLockSync.bind(s.a.store);
  s.a.store.withLockSync = (fn, o) => locked(() => { Atomics.wait(pause, 0, 0, 120); return fn(); }, o);
  r = s.a.sweep({ maxMs: 100 });
  assert.deepEqual([r.removed, r.remaining, starts], [[], 4, []], 'sync: the lock came too late');
  s = await expiredStore(4); starts = timed(s.a);
  const lockedAsync = s.a.store.withLock.bind(s.a.store);
  s.a.store.withLock = (fn, o) => lockedAsync(async () => { await new Promise((res) => setTimeout(res, 120)); return fn(); }, o);
  r = await s.a.sweepAsync({ maxMs: 100 });
  assert.deepEqual([r.removed, r.remaining, starts], [[], 4, []], 'async: the lock came too late');
  // and a batch in progress stops at the deadline rather than finishing its batchMax: six
  // 60 ms deletes in one batch would run 360 ms, so a 150 ms budget must cut the batch short
  // (how many got in before the cut depends on the machine; that none starts after it does not)
  s = await expiredStore(6); starts = timed(s.a, 60);
  r = s.a.sweep({ maxMs: 150, batchMax: 20 });
  assert.ok(r.removed.length < 6, `the batch was cut at the deadline: ${JSON.stringify(r)}`);
  assert.ok(starts.every((t) => t < 150 + slack), `no delete starts after the deadline: ${starts}`);
  assert.equal(r.remaining, 6 - r.removed.length);
});

// The legacy fallback, the sole-entry
// check, and the deadline right before a delete.
test('legacy fallback: a stale lock with content iac did not write is cleared name by name, never recursively; a fresh holder that took the name is untouched', () => {
  const legacyLock = (home, { sub = false } = {}) => {
    const lockDir = path.join(home, '.lock');
    fs.mkdirSync(lockDir); fs.writeFileSync(path.join(lockDir, 'owner'), '{"token":"legacy"}');
    if (sub) { fs.mkdirSync(path.join(lockDir, 'sub')); if (sub === 'full') fs.writeFileSync(path.join(lockDir, 'sub', 'f'), 'x'); }
    return lockDir;
  };
  // plain stale legacy content (a file and an empty dir) is removed and the lock is free again
  {
    const { home } = fresh(); const { B, clock } = lockPair(home);
    legacyLock(home, { sub: true }); clock.tick(35_000);
    assert.equal(B._tryLock(Date.now()), false); assert.equal(B.warned.length, 0);
    assert.equal(fs.existsSync(path.join(home, '.lock')), false, 'cleared');
    assert.equal(B._tryLock(Date.now()), true); B._unlock();
  }
  // content that is not a plain file or an empty dir is left for a human, with a warning
  {
    const { home } = fresh(); const { B, clock } = lockPair(home);
    const lockDir = legacyLock(home, { sub: 'full' }); clock.tick(35_000);
    assert.equal(B._tryLock(Date.now()), false);
    assert.match(B.warned.join('\n'), /stale but holds content iac did not write \(sub\); if no iac is running, remove that directory by hand/);
    assert.deepEqual(fs.readdirSync(lockDir), ['sub'], 'the stale file went; the non-empty dir stayed');
  }
  // Sequence: B judges the stale legacy lock; another client clears it and C takes a
  // fresh owner-entry lock before B removes anything. At each point B could act, C survives.
  for (const at of ['the look', 'the entry stat']) {
    const { home } = fresh(); const { B, C, clock, owner } = lockPair(home);
    const D = new Store(home); D._lockNow = clock.now; D._warn = () => {};
    const lockDir = legacyLock(home); clock.tick(35_000);
    let cTook = null;
    const replaceWithC = () => { if (cTook) return; fs.rmSync(lockDir, { recursive: true, force: true }); cTook = [C._tryLock(Date.now()), C.heartbeat()]; };
    const look = B._lockOwner.bind(B); let looked = false;
    B._lockOwner = (dir) => { const r = look(dir); if (!looked && at === 'the look') { looked = true; replaceWithC(); } return r; };
    patch45(fs, 'lstatSync', function (orig, p, ...o) { if (at === 'the entry stat' && path.dirname(String(p)) === lockDir) replaceWithC(); return orig(p, ...o); },
      () => assert.equal(B._tryLock(Date.now()), false, `B does not get the lock (${at})`));
    assert.deepEqual(cTook, [true, true], `C took a fresh lock before B acted (${at})`);
    assert.equal(owner(), C._lockToken, `C still holds it (${at})`);
    assert.equal(C._stillLocked(), true);
    assert.equal(D._tryLock(Date.now()), false, `D stays out (${at})`);
    assert.deepEqual(B.warned, [], 'nothing to warn about');
    C._unlock();
    assert.equal(D._tryLock(Date.now()), true); D._unlock();
    assert.deepEqual(fs.readdirSync(home).filter((f) => f.startsWith('.lock')), []);
  }
  assert.equal(/fs\.rmSync\((lockDir|aside|dir)/.test(fs.readFileSync(path.join(ROOT, 'src', 'store.js'), 'utf8')), false, 'no recursive delete of a lock dir anywhere in the store');
});

test('sole entry: a taker whose entry was broken and replaced while it stalled does not take the replacement for its own; every store write checks the lock', () => {
  const { home } = fresh(); const { A, B, clock, owner } = lockPair(home);
  const lockDir = path.join(home, '.lock');
  // A writes its entry, then stalls past the stale limit; B breaks it and takes the lock;
  // A resumes at its listing and sees one entry, B's
  let steps = null;
  patch45(fs, 'writeFileSync', function (orig, p, ...o) {
    const r = orig(p, ...o);
    if (!steps && path.dirname(String(p)) === lockDir) { steps = []; clock.tick(35_000); steps.push(B._tryLock(Date.now()), B._tryLock(Date.now()), B.heartbeat()); }   // steps set first: B's own entry write re-enters this hook
    return r;
  }, () => assert.equal(A._tryLock(Date.now()), false, 'A does not count B\'s entry as its own'));
  assert.deepEqual(steps, [false, true, true], 'B broke A\'s stale entry and took the lock');
  assert.equal(A._lockToken, null); assert.equal(A._stillLocked(), false);
  assert.equal(owner(), B._lockToken, 'B\'s entry is untouched'); assert.equal(B._stillLocked(), true);
  assert.throws(() => A.withLockSync(() => assert.fail('A must not enter'), { timeoutMs: 150 }), (e) => e.code === 'ELOCKBUSY');
  B._unlock();
  // a private key write is a store write like any other: refused once the lock is lost
  assert.equal(A._tryLock(Date.now()), true);
  fs.unlinkSync(path.join(lockDir, `owner-${A._lockToken}`)); fs.writeFileSync(path.join(lockDir, `owner-${'c'.repeat(32)}`), '{}');
  assert.throws(() => A.writePrivateKey('probe', 'not a key'), (e) => e.code === 'ELOCKLOST');
  assert.equal(fs.existsSync(A.keyPath('probe')), false, 'nothing was written');
  A._unlock(); fs.rmSync(lockDir, { recursive: true });
  assert.equal(path.basename(A.writePrivateKey('probe', 'not a key')), 'probe.pem', 'and works without the lock, as init does');
});

test('the deadline is checked right before the delete, after the read, sync and async', async () => {
  for (const asyncMode of [false, true]) {
    const s = await expiredStore(1);
    const thread = s.a.thread.bind(s.a); const pause = new Int32Array(new SharedArrayBuffer(4)); const starts = [];
    const del = s.a.store.deleteThread.bind(s.a.store); const t0 = performance.now();
    s.a.thread = (id) => { if (s.a.store._lockToken) Atomics.wait(pause, 0, 0, 100); return thread(id); };   // a slow read under the lock
    s.a.store.deleteThread = (id) => { starts.push(Math.round(performance.now() - t0)); return del(id); };
    const r = asyncMode ? await s.a.sweepAsync({ maxMs: 30 }) : s.a.sweep({ maxMs: 30 });
    assert.deepEqual([r.removed, r.remaining, starts], [[], 1, []], `${asyncMode ? 'async' : 'sync'}: no delete started past the budget, the candidate is still counted`);
    assert.deepEqual(s.a.store.threadIds(), s.ids, 'the thread is still there for the next sweep');
    assert.deepEqual(s.a.sweep().removed, s.ids);
  }
});

// With an iac 0.3.x client (a bare `.lock` dir is its whole lock)
// running alongside, a non-recursive rmdir is still a check-then-act. The dir is removed only
// by the process that emptied it (its unlink refreshes the dir mtime, so nobody else judges it
// stale for 30 s), or, for a bare dir judged stale, only while a last look still finds it stale.
const bareLock = (home) => { const d = path.join(home, '.lock'); fs.mkdirSync(d); return fs.statSync(d); };   // iac 0.3.x acquiring
const sameDir = (home, st) => { try { const now = fs.statSync(path.join(home, '.lock')); return now.ino === st.ino && now.mtimeMs === st.mtimeMs; } catch { return false; } };   // ext4 reuses inodes at once: the mtime stamp tells a recreated dir apart

test('an entry that vanishes between the listing and its stat is change, not staleness; a 0.3.x client\'s fresh lock taken meanwhile is left alone', () => {
  const { home } = fresh(); const { A, B, C } = lockPair(home);
  const lockDir = path.join(home, '.lock');
  assert.equal(A._tryLock(Date.now()), true);
  // A releases and a 0.3.x client takes the name between B's readdir and B's stat of A's entry
  let oldLock = null;
  let fired = false;
  patch45(fs, 'readdirSync', function (orig, p, ...o) { const names = orig(p, ...o); if (!fired && String(p) === lockDir) { fired = true; A._unlock(); oldLock = bareLock(home); } return names; },
    () => assert.equal(B._tryLock(Date.now()), false, 'B does not get the lock'));
  assert.ok(oldLock, 'the interleaving happened');
  assert.equal(sameDir(home, oldLock), true, 'the 0.3.x client\'s fresh lock is still there');
  assert.equal(C._tryLock(Date.now()), false, 'and keeps everyone out');
  assert.deepEqual([A.warned, B.warned, C.warned], [[], [], []]);
  // what B saw: an owner entry that was gone by its stat is reported as fresh (Infinity), never -Infinity
  assert.equal(A._tryLock(Date.now()), false, 'the bare dir is a live 0.3.x lock');
  fs.rmdirSync(lockDir);
  assert.equal(A._tryLock(Date.now()), true);
  let seen;
  fired = false;
  patch45(fs, 'readdirSync', function (orig, p, ...o) { const names = orig(p, ...o); if (!fired && String(p) === lockDir && names.length) { fired = true; A._unlock(); fs.mkdirSync(lockDir); } return names; }, () => { seen = B._lockOwner(lockDir); });
  assert.equal(seen.mtimeMs, Infinity, 'judged as changing');
  fs.rmdirSync(lockDir);
});

test('a second breaker whose unlink finds the stale entry already gone does not rmdir; a 0.3.x client\'s fresh lock survives (entry-bearing and bare stale locks)', () => {
  for (const kind of ['dead entry', 'bare stale dir']) {
    const { home } = fresh(); const { A, B, C } = lockPair(home);   // A, B: two waiters that both judged the lock stale
    const lockDir = path.join(home, '.lock');
    const dead = `owner-${'d'.repeat(32)}`; const old = new Date(Date.now() - 35_000);   // the holder died 35 s ago (real clock: the 0.3.x lock below must look fresh)
    fs.mkdirSync(lockDir); if (kind === 'dead entry') { fs.writeFileSync(path.join(lockDir, dead), '{}'); fs.utimesSync(path.join(lockDir, dead), old, old); }
    fs.utimesSync(lockDir, old, old);
    // B is about to act on what it judged; A completes the same break first, then a 0.3.x
    // client takes the name: at B's unlink of the entry, or (bare dir) just before B's final
    // look at which directory it is about to remove
    let oldLock = null; let fired = false;
    const interleave = () => { if (fired) return; fired = true; A._breakStale(lockDir); oldLock = bareLock(home); };
    if (kind === 'dead entry') {
      patch45(fs, 'unlinkSync', function (orig, p, ...o) { if (path.basename(String(p)) === dead) interleave(); return orig(p, ...o); }, () => B._breakStale(lockDir));
    } else {
      const rm = B._rmdirIfEmpty.bind(B); B._rmdirIfEmpty = (d, o) => { interleave(); return rm(d, o); };
      B._breakStale(lockDir);
    }
    assert.ok(oldLock, `the interleaving happened (${kind})`);
    assert.equal(fs.existsSync(lockDir), true, `the 0.3.x client's fresh lock was not removed (${kind})`);
    assert.equal(sameDir(home, oldLock), true, `and it is the same directory (${kind})`);
    assert.equal(C._tryLock(Date.now()), false, `a new client stays out while the 0.3.x client holds it (${kind})`);
    assert.equal(sameDir(home, oldLock), true, `and left it alone (${kind})`);
    assert.deepEqual([A.warned, B.warned, C.warned], [[], [], []]);
    fs.rmdirSync(lockDir);
    assert.equal(C._tryLock(Date.now()), true); C._unlock();
  }
});

test('a clock stepped backwards does not move a thread\'s activity (or expiry) earlier', async () => {
  const { a, clock } = fresh();
  const { thread } = await a.open({ as: 'fable', title: 'T', body: 'p0' });
  clock.tick(10 * MIN);
  await a.post({ as: 'opus', thread, body: 'later' });
  const latest = a.thread(thread).lastActivity;
  clock.tick(-1000);   // WSL2's time sync steps the wall clock back by up to ~0.7 s
  await a.post({ as: 'sol', thread, body: 'stamped earlier' });
  const s = a.thread(thread);
  assert.equal(s.posts.length, 3);
  assert.equal(s.lastActivity, latest, 'the latest timestamp, not the last line');
  assert.equal(Date.parse(s.expiresAt), Date.parse(latest) + 72 * 60 * MIN);
});

test('concurrent writers serialize under the lock and all chains stay valid', async () => {
  const { a } = fresh();
  const { thread } = await a.open({ as: 'ada', title: 'T', body: 'p0' });
  // human is exempt from rate rules, so 20 parallel human posts exercise the lock
  await Promise.all(Array.from({ length: 20 }, (_, i) => a.post({ as: 'ada', thread, body: `c${i}` })));
  const s = a.thread(thread);
  assert.equal(s.posts.length, 21);
  assert.equal(a.verify(thread).ok, true);
});

test('brief is one line or nothing; compact truncates; mcp tool table is built per identity', async () => {
  const { brief, compact } = await import('../src/format.js');
  const { buildTools } = await import('../src/mcp.js');
  const { a, clock } = fresh();
  assert.equal(brief(a, 'astra'), '');
  const { thread } = await a.open({ as: 'fable', title: 'Need schema', kind: 'status', waitingOn: ['astra'], body: 'x'.repeat(500) });
  const line = brief(a, 'astra');
  assert.ok(!line.includes('\n')); assert.ok(line.length < 200, line); assert.match(line, /waiting on astra for this task: fable/);
  const c = compact(a.threadWithVerification(thread));
  assert.equal(c.split('\n').length, 2); assert.match(c, /\(500c\)/); assert.ok(c.length < 340, `compact grew to ${c.length}`);
  const tools = buildTools(a, 'astra');
  assert.ok(Object.keys(tools).includes('iac_brief') && Object.keys(tools).includes('iac_post'));
  assert.ok(Object.keys(tools).includes('iac_clear_wait'));
  clock.tick(MIN);
  assert.match(await tools.iac_ack.run({ thread }), /acked/);
  assert.equal(a.waitingBoard()[0].acked, true);
  clock.tick(MIN);
  const r = await tools.iac_post.run({ thread, body: 'here you go' });
  assert.match(r, /posted/);
  assert.equal(a.waitingBoard().length, 0);
});

test('bound MCP can clear its sole wait; read-only MCP does not expose cleanup', async () => {
  const { buildTools } = await import('../src/mcp.js');
  const { a } = fresh();
  const opened = await a.open({ as: 'sol', project: 'o/r', title: 'MCP cleanup', body: 'Need Fable.', waitingOn: ['fable'] });
  const bound = buildTools(a, 'sol');
  assert.match(await bound.iac_clear_wait.run({ thread: opened.thread, reason: 'Dependency removed.' }), /cleared wait/);
  assert.equal(a.waitingBoard().length, 0);
  assert.equal(buildTools(a, '').iac_clear_wait, undefined);
});

test('project: derived from git remote, overridable, filters lists and boards', async () => {
  const { slugFromRemote, detectProject } = await import('../src/project.js');
  assert.equal(slugFromRemote('https://github.com/acme/widgets.git'), 'acme/widgets');
  assert.equal(slugFromRemote('git@github.com:acme/gadgets.git'), 'acme/gadgets');
  assert.equal(slugFromRemote('https://gitlab.com/grp/sub/proj'), 'gitlab.com/grp/sub/proj');
  assert.equal(detectProject({ explicit: 'x/y' }), 'x/y');
  assert.equal(detectProject({ env: { IAC_PROJECT: 'global' }, cwd: os.tmpdir() }), 'global');
  assert.match(detectProject({ env: {}, cwd: os.tmpdir() }), /^local:/);
  const { a } = fresh();
  const t1 = (await a.open({ as: 'fable', title: 'A', body: 'b', project: 'o/one', waitingOn: ['sol'] })).thread;
  const t2 = (await a.open({ as: 'fable', title: 'B', body: 'b', project: 'o/two' })).thread;
  assert.equal(a.thread(t1).project, 'o/one');
  assert.deepEqual(a.threads({ project: 'o/two' }).map((s) => s.id), [t2]);
  assert.equal(a.threads().length, 2);
  assert.equal(a.waitingBoard({ project: 'o/two' }).length, 0);
  assert.equal(a.waitingBoard({ project: 'o/one' })[0].project, 'o/one');
  assert.equal(a.inbox({ as: 'sol', project: 'o/two' }).length, 0);
  assert.equal(a.inbox({ as: 'sol' }).length, 1);
  await rejects(a.open({ as: 'opus', title: 'C', body: 'b', project: '../etc' }), 'bad-project');
});

test('mcp with no bound identity exposes read-only tools only', async () => {
  const { buildTools } = await import('../src/mcp.js');
  const { a } = fresh();
  const tools = buildTools(a, '');
  assert.deepEqual(Object.keys(tools).sort(), ['iac_doctor', 'iac_list', 'iac_show', 'iac_verify', 'iac_waiting']);
});

test('MCP declares its local-only scope: instructions in both modes, write-tool descriptions', async () => {
  // A harness permission classifier reads this text; if it stops saying the board
  // is local, an agora write starts looking like publishing to an external service.
  const { spawn } = await import('node:child_process');
  const { home } = fresh();
  const bin = path.join(import.meta.dirname, '..', 'bin', 'iac-mcp.js');
  const rpc = (agent, parentEnv = process.env) => new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [bin], { env: { ...parentEnv, ...HARNESS_CLEAN, IAC_HOME: home, IAC_AGENT: agent } });
    let buf = ''; const msgs = [];
    proc.stderr.resume();
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (l) msgs.push(JSON.parse(l)); }
      if (msgs.length >= 2) { proc.kill(); resolve(msgs); }
    });
    proc.on('error', reject);
    proc.on('exit', () => { if (msgs.length < 2) reject(new Error(`mcp exited early: ${JSON.stringify(msgs)}`)); });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
  });

  const [init, list] = await rpc('fable');
  assert.match(init.result.instructions, /local/i);
  const desc = Object.fromEntries(list.result.tools.map((t) => [t.name, t.description]));
  for (const name of ['iac_post', 'iac_open', 'iac_ack', 'iac_close', 'iac_clear_wait']) {
    assert.match(desc[name], /local board only; nothing leaves the machine/i, name);
  }
  assert.ok(!/nothing leaves the machine/i.test(desc.iac_show), 'read tools stay lean');

  const [unbound] = await rpc('');
  assert.match(unbound.result.instructions, /local/i);

  const [, inheritedList] = await rpc('fable', { ...process.env, CODEX_THREAD_ID: 'outer-task', CODEX_SESSION_ID: 'outer-root', CLAUDE_CODE_SESSION_ID: 'outer-claude', IAC_INSTANCE: 'outer-instance' });
  // rpc applies HARNESS_CLEAN after parentEnv, so this checks the explicit binding in a clean environment.
  assert.ok(inheritedList.result.tools.some((t) => t.name === 'iac_post'), 'rpc clears inherited harness ids; the explicit launcher binding remains writable in a clean environment');
});

test('legacy unscoped threads can be tagged once by opener/mentioned/human; brief is project-scoped', async () => {
  const { brief } = await import('../src/format.js');
  const { a, clock } = fresh();
  const { thread } = await a.open({ as: 'sol', title: 'old', body: 'hi @fable', project: 'unscoped' });
  await rejects(a.setProject({ as: 'opus', thread, project: 'o/r' }), 'forbidden');
  await rejects(a.setProject({ as: 'fable', thread, project: '../x' }), 'bad-project');
  await a.setProject({ as: 'fable', thread, project: 'o/r' });
  assert.equal(a.thread(thread).project, 'o/r');
  await rejects(a.setProject({ as: 'fable', thread, project: 'o/other' }), 'already');
  await a.setProject({ as: 'ada', thread, project: 'o/other' });        // human may re-tag
  assert.equal(a.thread(thread).project, 'o/other');
  assert.equal(a.verify(thread).ok, true);
  // scoped brief: waits here in full, waits elsewhere as a count, new posts here only
  clock.tick(MIN);
  await a.open({ as: 'sol', title: 'here', body: 'need you', project: 'p/here', waitingOn: ['fable'] });
  await a.open({ as: 'astra', title: 'there', body: 'need you too', project: 'p/there', waitingOn: ['fable'] });
  const line = brief(a, 'fable', { project: 'p/here' });
  assert.match(line, /@ p\/here/); assert.match(line, /waiting on fable for this task: sol/); assert.doesNotMatch(line, /astra/);
  assert.match(line, /1 wait for other fable instances \(p\/there/);
  assert.match(brief(a, 'fable'), /astra/);
});

test('instances: a wait names a family in a project; first instance to ack claims it; others stop seeing it', async () => {
  const { brief } = await import('../src/format.js');
  const { a, clock } = fresh();
  const { thread } = await a.open({ as: 'sol', title: 'need fable', body: 'x', project: 'o/r', waitingOn: ['fable'] });
  assert.equal(a.thread(thread).posts[0].instance, 'sol@o/r');
  const A = { project: 'o/r', instance: 'fable-aaaa' }, B = { project: 'o/r', instance: 'fable-bbbb' };
  assert.match(brief(a, 'fable', A), /waiting on fable for this task: sol/);
  assert.match(brief(a, 'fable', B), /waiting on fable for this task: sol/);
  clock.tick(MIN);
  await a.post({ as: 'fable', thread, kind: 'ack', body: 'on it', instance: 'fable-aaaa' });
  const w = a.waitingBoard()[0];
  assert.equal(w.claimedBy, 'fable-aaaa'); assert.equal(w.acked, true);
  assert.match(brief(a, 'fable', A), /you acked/);
  assert.match(brief(a, 'fable', B), /1 claimed by another fable instance/);
  assert.doesNotMatch(brief(a, 'fable', B), /waiting on fable for this task/);
  assert.doesNotMatch(brief(a, 'fable', B), /new:/, 'claimed work must not reappear through the family inbox');
  await rejects(a.post({ as: 'fable', thread, kind: 'ack', body: 'also on it', instance: 'fable-bbbb' }), 'claimed');
  clock.tick(MIN);
  await a.post({ as: 'fable', thread, body: 'unrelated note', instance: 'fable-bbbb' });
  assert.equal(a.waitingBoard()[0].claimedBy, 'fable-aaaa', 'another instance cannot clear the claimant wait');
  // a fable in another project has nothing to do here: silence, zero tokens
  assert.equal(brief(a, 'fable', { project: 'p/q', instance: 'fable-cccc' }), '');
  clock.tick(MIN);
  await a.post({ as: 'fable', thread, body: 'done: see abc123', instance: 'fable-aaaa' });
  assert.equal(a.waitingBoard().length, 0);
  assert.equal(a.verify(thread).ok, true);
  await rejects(a.post({ as: 'sol', thread, body: 'x', instance: 'bad label with spaces' }), 'bad-instance');
});

test('global waits and waits on a task-owned thread remain visible across project scope', async () => {
  const { brief } = await import('../src/format.js');
  const { a, clock } = fresh();
  await a.open({ as: 'sol', instance: 'sol-a', title: 'global need', body: 'x', project: 'global', waitingOn: ['fable'] });
  const owned = await a.open({ as: 'fable', instance: 'fable-a', title: 'owned elsewhere', body: 'x', project: 'o/other' });
  clock.tick(MIN);
  await a.post({ as: 'sol', instance: 'sol-b', thread: owned.thread, body: 'need owner', waitingOn: ['fable'] });
  const line = brief(a, 'fable', { project: 'o/current', instance: 'fable-a' });
  assert.match(line, /\[global\]/);
  assert.match(line, /\[o\/other\]/);
  assert.doesNotMatch(line, /other fable instances/);
  const inbox = a.inbox({ as: 'fable', project: 'o/current', instance: 'fable-a', includeGlobal: true });
  assert.deepEqual(new Set(inbox.map((x) => x.project)), new Set(['global', 'o/other']));
});

test('harness task ids are resume-stable instance ids and isolate same-project quotas', async () => {
  const { resolveInstance } = await import('../src/api.js');
  assert.equal(resolveInstance({ agent: 'sol', project: 'o/r', env: { CODEX_SESSION_ID: 'root-123', CODEX_THREAD_ID: 'task-123' } }), 'sol-task-123');
  assert.equal(resolveInstance({ agent: 'sol', project: 'o/r', env: { CODEX_SESSION_ID: 'root-123' } }), 'sol@o/r', 'a root-only SESSION names no task');
  assert.equal(resolveInstance({ agent: 'fable', project: 'o/r', env: { CLAUDE_SESSION_ID: 'session_abc' } }), 'fable-session_abc');
  const { a } = fresh();
  for (let k = 0; k < 3; k++) await a.open({ as: 'astra', instance: 'astra-task-a', title: `A${k}`, body: 'b', project: 'o/r' });
  await rejects(a.open({ as: 'astra', instance: 'astra-task-a', title: 'A4', body: 'b', project: 'o/r' }), 'open-cap');
  await a.open({ as: 'astra', instance: 'astra-task-b', title: 'B1', body: 'b', project: 'o/r' });
});

test('launch commands live in config, separate from the agent roster; paths render for this install', async () => {
  const { a } = fresh();
  assert.deepEqual(a.config().launch, {});
  assert.equal(a.config().limits.globalPerHour, undefined, 'retired key must not reappear');
  assert.throws(() => a.setLaunch('nobody', ['x']), /not a registered agent/);
  assert.throws(() => a.setLaunch('fable', []), /after --/);
  a.setLaunch('Fable', ['claude', '--model', 'opus']);
  assert.deepEqual(a.config().launch.fable, ['claude', '--model', 'opus']);
  const p = a.paths();
  assert.ok(p.cli.endsWith('iac.js')); assert.equal(p.store, a.store.home);
  const { toWin } = await import('../src/api.js');
  assert.equal(toWin('/mnt/c/Users/x/.agora'), 'C:\\Users\\x\\.agora');
  assert.equal(toWin('/home/x/.agora'), '/home/x/.agora');
});

test('iac paths prints a complete Codex install: hook, config.toml MCP block, skill, family', async () => {
  const { renderPaths } = await import('../src/cli.js');
  const { toWin } = await import('../src/api.js');
  const root = `/mnt/c/Users/o'neil "q" $HOME/agora`; // ' " $ and space all have to survive quoting
  const p = { cli: `${root}/bin/iac.js`, mcp: `${root}/bin/iac-mcp.js`, skill: `${root}/skills/inter-agent-comms/SKILL.md`, root, store: '/mnt/c/Users/x/.agora' };
  for (const k of ['cli', 'mcp', 'skill', 'store', 'root']) p[`win${k[0].toUpperCase()}${k.slice(1)}`] = toWin(p[k]);
  const out = renderPaths(p);
  const plugin = out.slice(out.indexOf('Codex (recommended)'), out.indexOf('Codex manual fallback'));
  const codex = out.slice(out.indexOf('Codex manual fallback'));
  assert.ok(out.indexOf('Codex (recommended)') > 0 && plugin.length > 0 && codex.length > 0 && codex.length < out.length, 'a Codex section is printed');
  const sh = (cmd) => shellCommand(`set -- ${cmd}; printf '%s\\n' "$@"`, { env: { HOME: '/nope', PATH: process.env.PATH } }).stdout.split('\n').filter(Boolean);

  // Plugin first: GitHub marketplace, or this install as a local one (quoted), then the one /hooks trust step.
  const lines = plugin.split('\n').map((l) => l.trim());
  assert.ok(lines.includes('codex plugin marketplace add mitchjablonski/interAgentCommunications'));
  assert.ok(lines.includes('codex plugin add inter-agent-comms@inter-agent-comms'));
  const local = lines.find((l) => l.startsWith('codex plugin marketplace add \''));
  if (process.platform === 'win32') {
    const windowsLocal = lines.find((l) => l.startsWith('# codex plugin marketplace add ')).slice(2);
    const parsed = shellCommand(`function codex { ConvertTo-Json -Compress -InputObject @($args) }; ${windowsLocal}`).stdout;
    assert.deepEqual(JSON.parse(parsed), ['plugin', 'marketplace', 'add', p.winRoot], 'the native marketplace path survives PowerShell');
  } else {
    assert.deepEqual(sh(local), ['codex', 'plugin', 'marketplace', 'add', root], 'the local marketplace path survives the shell');
  }
  assert.ok(plugin.includes(`# codex plugin marketplace add '${p.winRoot.replace(/'/g, "''")}'`), 'a native Windows Codex gets the C:\\ path, PowerShell-quoted');
  assert.match(plugin, /\/hooks[^\n]*trust/, 'the one manual step is named');
  assert.match(plugin, /Access is denied, run it again/); assert.match(plugin, /PowerShell 5\.1: a \$ or backtick/);
  assert.match(plugin, /reads only: iac_list, iac_show, iac_waiting, iac_verify, iac_doctor/);
  assert.match(plugin, /remove any hand-written hook/);
  assert.ok(out.indexOf('codex plugin add inter-agent-comms@inter-agent-comms') < out.indexOf('[mcp_servers.iac]'), 'the plugin leads; hand wiring is the fallback');
  assert.ok(out.indexOf('iac add-agent <name>') < out.indexOf('Codex manual fallback'), 'family registration applies to both paths');

  // Hook: valid JSON for ~/.codex/hooks.json; the POSIX command is one shell word per path, the Windows one a C:\ path.
  const hookLine = codex.split('\n').find((l) => l.includes('codex-hook') && l.trim().startsWith('{"type"'));
  const hook = JSON.parse(hookLine);
  assert.equal(hook.type, 'command');
  if (process.platform !== 'win32') assert.deepEqual(sh(hook.command), ['node', p.cli, 'codex-hook'], 'the POSIX hook command quotes the path exactly');
  assert.equal(hook.commandWindows, `node "${p.winCli}" codex-hook`);
  assert.match(hook.commandWindows, /^node "C:\\/);
  assert.equal(hook.timeout, 10);
  assert.match(codex, /~\/\.codex\/hooks\.json[\s\S]*UserPromptSubmit/);
  assert.match(codex, /%USERPROFILE%\\\.codex/, 'a native Windows Codex is told where ~/.codex is');

  // MCP: a [mcp_servers.iac] table with absolute paths; a quote in the path forces an escaped basic string.
  assert.match(codex, /~\/\.codex\/config\.toml/);
  assert.match(codex, /^ {2}\[mcp_servers\.iac\]$/m);
  assert.match(codex, /^ {2}command = "node"$/m);
  const args = /^ {2}args = \[(.*)\]$/m.exec(codex)[1];
  assert.equal(JSON.parse(args), p.mcp, 'args holds the absolute iac-mcp.js path, escaped');
  assert.match(codex, /^ {2}env_vars = \["CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_HOME"\]$/m);
  assert.match(codex, /^ {2}\[mcp_servers\.iac\.env\]\n {2}IAC_HOME = '\/mnt\/c\/Users\/x\/\.agora'$/m);
  assert.ok(codex.includes(`IAC_HOME = 'C:\\Users\\x\\.agora'`), 'the native Windows variant keeps backslashes in a literal string');
  assert.match(codex, /reads only[^\n]*iac_list, iac_show, iac_waiting, iac_verify, iac_doctor/, 'MCP is for reads, and only the tools a Codex server exposes');
  assert.match(plugin, /iac brief, iac inbox[^\n]*post with the CLI/);
  assert.doesNotMatch(plugin + codex, /iac_brief|iac_inbox|iac_post/);

  // Skill: POSIX cp quotes the source; PowerShell copies into the native Windows profile.
  const cpLine = codex.split('\n').find((l) => l.includes('cp ') && l.includes('SKILL.md'));
  if (process.platform !== 'win32') assert.deepEqual(sh(cpLine.trim().split(' && ')[1]), ['cp', p.skill, '/nope/.codex/skills/inter-agent-comms/SKILL.md']);
  assert.ok(codex.includes(`Copy-Item -LiteralPath '${p.winSkill.replace(/'/g, "''")}' -Destination "$env:USERPROFILE\\.codex\\skills\\inter-agent-comms\\SKILL.md"`));
  assert.ok(codex.includes('New-Item -ItemType Directory -Force "$env:USERPROFILE\\.codex\\skills\\inter-agent-comms"'));

  if (process.platform === 'win32') {
    // Windows paths cannot contain the double quote in the POSIX fixture above.
    // Execute commandWindows with a real native path containing spaces and an apostrophe.
    const nativeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agora user's cache "));
    const nativeCli = path.join(nativeRoot, 'iac.js');
    fs.writeFileSync(nativeCli, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
    try {
      const native = renderPaths({ ...p, winCli: nativeCli });
      const nativeHook = JSON.parse(native.split('\n').find((l) => l.includes('codex-hook') && l.trim().startsWith('{"type"')));
      assert.deepEqual(JSON.parse(shellCommand(nativeHook.commandWindows).stdout), ['codex-hook'], 'the emitted native hook command executes the quoted path');
    } finally {
      fs.rmSync(nativeRoot, { recursive: true, force: true });
    }
  }

  // Family registration.
  assert.match(plugin, /iac add-agent <name> --models 'gpt-6-<name>,gpt-6\.\*-<name>' --harness codex/);
  assert.match(plugin, /iac set-models <agent> --harness codex/);
  assert.match(plugin, /iac whoami/);

  // Off WSL there is one path form, so no Windows variant is printed.
  const plain = renderPaths({ ...p, winCli: p.cli, winMcp: p.mcp, winSkill: p.skill, winStore: p.store, winRoot: p.root });
  assert.doesNotMatch(plain, /commandWindows|native Windows|USERPROFILE/);

  // Run from a harness's versioned plugin cache, a local marketplace path would vanish on upgrade.
  for (const cache of ['/home/u/.claude/plugins/cache/agora/agora/0.2.2', 'C:\\Users\\u\\.codex\\plugins\\cache\\agora\\agora\\0.2.2']) {
    const fromCache = renderPaths({ ...p, root: cache, winRoot: cache });
    assert.ok(fromCache.includes('codex plugin marketplace add mitchjablonski/interAgentCommunications'), 'the GitHub marketplace is still offered');
    assert.doesNotMatch(fromCache, /or from this install|codex plugin marketplace add '/, `no local marketplace inside ${cache}`);
  }
});

test('renderPaths: a control character in a path forces an escaped TOML basic string', async () => {
  const { renderPaths } = await import('../src/cli.js');
  for (const ch of ['\t', '\x01', '\x7f', '\n']) {
    const mcp = `/opt/a${ch}b/iac-mcp.js`;
    const out = renderPaths({ cli: '/opt/agora.js', mcp, skill: '/opt/SKILL.md', store: '/s', winCli: '/opt/agora.js', winMcp: mcp, winSkill: '/opt/SKILL.md', winStore: '/s' });
    const args = /^ {2}args = \[(.*)\]$/m.exec(out)[1];
    assert.ok(args.startsWith('"'), `basic string for ${JSON.stringify(ch)}`);
    assert.doesNotMatch(args, /[\x00-\x1f\x7f]/, 'TOML basic strings may not hold raw control characters');
    assert.equal(JSON.parse(args), mcp);
  }
});

test('the CLI actually loads and runs: help, paths, set-launch, open/post round trip', async () => {
  // Guards a real break: a syntax error in cli.js passed the suite because
  // nothing imported it. Exercise the binary the way a user does.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const { home } = fresh();
  const bin = path.join(import.meta.dirname, '..', 'bin', 'iac.js');
  const env = { ...process.env, IAC_HOME: home, IAC_AGENT: 'fable', IAC_PROJECT: 'o/r',
    CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '' };
  const cli = (...args) => run(process.execPath, [bin, ...args], { env });

  assert.match((await cli('--help')).stdout, /set-launch/);
  const paths = (await cli('paths')).stdout;
  assert.match(paths, /store:/);
  assert.match(paths, /"mcp__iac"/);
  assert.match(paths, /"mcp__plugin_inter-agent-comms_iac"/);
  assert.ok(paths.indexOf('/plugin install inter-agent-comms@inter-agent-comms') < paths.indexOf('claude mcp add'), 'the plugin leads; manual wiring is the fallback');
  assert.match(paths, /"command": "iac brief --hook"/, 'manual Claude hooks run brief --hook');
  assert.match(paths, /~\/\.codex\/hooks\.json[\s\S]*codex-hook/, 'Codex is wired with codex-hook');
  assert.ok(paths.indexOf('codex plugin add inter-agent-comms@inter-agent-comms') < paths.indexOf('~/.codex/hooks.json'), 'the Codex plugin leads; hand wiring is the fallback');
  assert.doesNotMatch(paths, /deferred|not yet supported/i, 'Codex wiring is printed, not deferred');
  assert.match(paths, /"Bash\(iac \*\)"/);
  assert.match(paths, /"Bash\(node .*iac\.js \*\)"/);
  assert.match((await cli('set-launch', 'opus', '--', 'claude', '--model', 'opus')).stdout, /iac-launch opus runs: claude --model opus/);
  const opened = JSON.parse((await cli('open', '--title', 'cli smoke', '--kind', 'status', '--body', 'hello', '--json')).stdout);
  assert.equal(opened.project, 'o/r');
  // bound to fable: posting as opus must be refused (exit 2), and posting as fable works
  await assert.rejects(cli('post', opened.thread, '--as', 'opus', '--body', 'not me'), (e) => /identity-override/.test(e.stderr));
  await run(process.execPath, [bin, 'post', opened.thread, '--as', 'opus', '--body', 'ack from opus'],
    { env: { ...env, IAC_AGENT: 'opus' } });
  assert.match((await cli('verify')).stdout, /✓/);
  assert.match((await cli('show', opened.thread, '--compact')).stdout, /cli smoke/);
});

test('the CLI delivers every byte of large piped output (exit waits for stdout to flush)', async () => {
  const { a, home } = fresh();
  const bin = path.join(import.meta.dirname, '..', 'bin', 'iac.js');
  const env = { ...process.env, IAC_HOME: home, IAC_AGENT: 'fable', IAC_PROJECT: 'o/r',
    CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '' };
  const cli = (args) => spawnSync(process.execPath, [bin, ...args], { env, maxBuffer: 64 << 20 });
  const opened = await a.open({ as: 'ada', title: 'big', body: 'y'.repeat(1400), project: 'o/r' });
  for (let i = 0; i < 250; i++) await a.post({ as: 'ada', thread: opened.thread, body: String(i).padStart(3, '0') + 'y'.repeat(1400) });
  const r = cli(['show', opened.thread, '--json']); // spawnSync captures stdout through a pipe
  assert.equal(r.status, 0, String(r.stderr));
  assert.ok(r.stdout.length > 300 * 1024, `all output arrives, got ${r.stdout.length} bytes`);
  assert.ok(JSON.stringify(JSON.parse(r.stdout)).includes('249' + 'y'.repeat(1400)), 'the full JSON parses and holds the last post');
});

test('init hints when a registered agent matches no family, and stays quiet when all do', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const bin = path.join(import.meta.dirname, '..', 'bin', 'iac.js');
  const init = (agents) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-init-'));
    return run(process.execPath, [bin, 'init', '--human', 'ada', '--agents', agents, '--json'],
      { env: { ...process.env, IAC_HOME: home } }).then((r) => JSON.parse(r.stdout));
  };
  assert.deepEqual((await init('alpha,opus')).unmatched, ['alpha']);
  assert.deepEqual((await init('opus,fable')).unmatched, []);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-init-'));
  const text = (await run(process.execPath, [bin, 'init', '--human', 'ada', '--agents', 'alpha'], { env: { ...process.env, IAC_HOME: home } })).stdout;
  assert.match(text, /hint: alpha matches no family/);
  assert.match(text, /read-only unless bound with iac-launch/, 'a launcher binding can still write as it');
  assert.match(text, /iac set-models alpha --models '<glob>' --harness claude-code\|codex/);
});

test('CLI unwait infers one owned wait and requires selectors when ambiguous', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const { a, home } = fresh();
  const bin = path.join(import.meta.dirname, '..', 'bin', 'iac.js');
  const env = { ...process.env, IAC_HOME: home, IAC_AGENT: 'sol', IAC_PROJECT: 'o/r',
    CODEX_THREAD_ID: '', CODEX_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '', IAC_INSTANCE: '' };
  const cli = (...args) => run(process.execPath, [bin, ...args], { env });

  const one = await a.open({ as: 'sol', project: 'o/r', title: 'One wait', body: 'x', waitingOn: ['fable'] });
  assert.match((await cli('unwait', one.thread)).stdout, /cleared wait .*\/fable/);
  assert.equal(a.waitingBoard().length, 0);

  const two = await a.open({ as: 'sol', project: 'o/r', title: 'Two waits', body: 'x', waitingOn: ['fable', 'opus'] });
  await assert.rejects(cli('unwait', two.thread), (e) => /ambiguous-wait/.test(e.stderr));
  assert.match((await cli('unwait', two.thread, '--post', two.post, '--on', 'opus')).stdout, /cleared wait .*\/opus/);
  assert.deepEqual(a.waitingBoard().map((w) => w.on), ['fable']);
});

test('CLI waiting hides expired waits and --all shows them marked expired', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const { a, home } = fresh();
  a.store.saveConfig({ ...a.config(), limits: { ...a.config().limits, waitTtlHours: 1e-6 } });
  const bin = path.join(import.meta.dirname, '..', 'bin', 'iac.js');
  const env = { ...process.env, IAC_HOME: home, IAC_AGENT: 'sol', IAC_PROJECT: 'o/r',
    CODEX_THREAD_ID: '', CODEX_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '', IAC_INSTANCE: '' };
  const cli = (...args) => run(process.execPath, [bin, ...args], { env });

  // Written on the fixture clock (weeks in the past), so expiry never rests on a 3.6ms gap between
  // two processes' wall clocks, which a WSL2/VM clock step can close (the test flaked once).
  const opened = await a.open({ as: 'sol', project: 'o/r', title: 'stale ask', kind: 'status', body: 'need fable', waitingOn: ['fable'] });
  assert.ok(Date.now() - Date.parse(a.thread(opened.thread).posts[0].ts) > 3_600_000, 'the wait is well past its TTL');
  assert.match((await cli('waiting')).stdout, /nobody is waiting on anybody/);
  const all = (await cli('waiting', '--all')).stdout;
  assert.match(all, /\(expired\)/);
  assert.match(all, new RegExp(opened.thread));
  assert.match((await cli('show', opened.thread, '--compact')).stdout, /⏳fable/, 'the thread still carries the wait');
});

// Same flake class as the git-timeout/stdin tests above, different mechanism: this used
// a near-zero stallHours (1e-6) and opened the wait via a real CLI subprocess, then relied on
// the real wall-clock gap to the next CLI subprocess being "small" — both to cross the ~0
// threshold reliably and to still round to "0h" in the display. Under machine load that gap is
// not reliably small (process start + scheduling overhead). Fixed by opening the wait at a
// known, real-clock-anchored point far in the past instead of near "now": with the default
// stallHours=12/waitTtlHours=72, a wait opened 13 real hours ago is comfortably past "stalled"
// (1h of margin) and comfortably short of "expired" (59h of margin) — seconds, or even many
// minutes, of scheduling delay before the CLI calls below run cannot change either verdict or
// move the displayed/one-decimal ageHours out of a generous tolerance band.
test('CLI waiting marks stalled waits; --json carries stalled and ageHours', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const { home } = fresh(); // registers sol/opus (and others) + human ada; default limits apply
  // Opened via the API with a real-clock-anchored (not the fixture-clock) `now`, 13 real hours
  // in the past: the CLI calls below are real subprocesses computing age from the real
  // Date.now(), so `since` must be anchored to real time, not the fixture clock's fixed test
  // date (which is weeks away from today — see the "brief runs on the wall clock" note
  // elsewhere in this file).
  const since = Date.now() - 13 * 3_600_000;
  const past = new Agora(home, { env: {}, now: () => since });
  const opened = await past.open({ as: 'sol', project: 'o/r', title: 'need opus', kind: 'status', body: 'need opus', waitingOn: ['opus'] });
  const bin = path.join(import.meta.dirname, '..', 'bin', 'iac.js');
  const env = { ...process.env, IAC_HOME: home, IAC_AGENT: 'sol', IAC_PROJECT: 'o/r',
    CODEX_THREAD_ID: '', CODEX_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '', IAC_INSTANCE: '' };
  const cli = (...args) => run(process.execPath, [bin, ...args], { env });
  const out = (await cli('waiting')).stdout;
  assert.match(out, /1 stalled/);
  assert.match(out, /\(stalled 1[3-9]h — no opus session has picked this up in o\/r; start one there\)/);
  const j = JSON.parse((await cli('waiting', '--json')).stdout);
  assert.equal(j[0].thread, opened.thread);
  assert.equal(j[0].stalled, true);
  assert.equal(typeof j[0].ageHours, 'number');
  assert.ok(j[0].ageHours >= 12.9 && j[0].ageHours < 20, `ageHours should be about 13 (got ${j[0].ageHours})`);
  assert.doesNotMatch((await cli('brief')).stdout, /stalled/, 'the waiting agent is not told');
});

test('viewer state carries stalled waits and the page renders a stalled marker', async () => {
  const { serve } = await import('../src/server.js');
  const { a, clock } = fresh();
  await a.open({ as: 'sol', project: 'o/r', title: 'Need opus', kind: 'status', body: 'Need opus.', waitingOn: ['opus'] });
  clock.tick(13 * 60 * MIN);
  const srv = await serve(a, 0);
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const st = await (await fetch(base + '/api/state')).json();
    assert.equal(st.waiting[0].stalled, true);
    assert.equal(st.waiting[0].ageHours, 13);
    assert.equal(st.limits.stallHours, 12);
    const html = await (await fetch(base + '/')).text();
    assert.match(html, /is-stalled/);
    assert.match(html, /stalled \$\{Math\.floor\(w\.ageHours\)\}h/);
  } finally { srv.close(); }
});

test('CLI announces a self-declared instance label on every write', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const { home } = fresh();
  const bin = path.join(import.meta.dirname, '..', 'bin', 'iac.js');
  const env = { ...process.env, IAC_HOME: home, IAC_AGENT: 'sol', IAC_PROJECT: 'o/r',
    CODEX_THREAD_ID: '', CODEX_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '', IAC_INSTANCE: '' };
  const cli = (...args) => run(process.execPath, [bin, ...args], { env });

  const quiet = await cli('open', '--title', 'no label', '--body', 'x', '--json');
  assert.doesNotMatch(quiet.stderr, /instance/, 'the default label is not an assertion');

  const loud = await cli('open', '--title', 'labelled', '--body', 'x', '--instance', 'sol-adhoc', '--json');
  assert.match(loud.stderr, /instance 'sol-adhoc' is self-declared/);
  const opened = JSON.parse(loud.stdout);
  const unwait = await cli('unwait', opened.thread, '--instance', 'sol-adhoc').catch((e) => e);
  assert.match(unwait.stderr, /instance 'sol-adhoc' is self-declared/);
});

test('viewer refuses cross-origin, rebound-host, and nonce-less writes', async () => {
  const { serve } = await import('../src/server.js');
  const { a } = fresh();
  const srv = await serve(a, 0);
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const page = await fetch(base + '/');
    const html = await page.text();
    const nonce = /const NONCE = '([0-9a-f]{32})'/.exec(html)?.[1];
    assert.ok(nonce, 'server must inject a per-start nonce into the page');
    assert.match(html, /<details class="waits"/);
    assert.match(html, /iac\.waiting\.open/);
    assert.match(html, /data-unwait/);
    assert.match(html, /action:'unwait'/);

    const post = (headers) => fetch(base + '/api/open', { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ title: 'drive-by', kind: 'status', body: 'posted by a website' }) });

    assert.equal((await post({})).status, 403, 'no nonce');
    assert.equal((await post({ 'x-iac-nonce': 'f'.repeat(32) })).status, 403, 'wrong nonce');
    assert.equal((await post({ 'x-iac-nonce': nonce, origin: 'https://evil.example' })).status, 403, 'cross-origin');
    // fetch() refuses to set Host, so drive a raw request for the rebinding case
    const http = await import('node:http');
    const rebound = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ title: 'rebound', kind: 'status', body: 'x' });
      const rq = http.request({ host: '127.0.0.1', port, path: '/api/open', method: 'POST',
        headers: { 'content-type': 'application/json', 'x-iac-nonce': nonce, host: 'attacker.example', 'content-length': Buffer.byteLength(body) } },
        (rs) => { rs.resume(); resolve(rs.statusCode); });
      rq.on('error', reject); rq.end(body);
    });
    assert.equal(rebound, 403, 'rebound host');
    assert.equal(a.threads().length, 0, 'no refused request may write');

    const ok = await post({ 'x-iac-nonce': nonce, origin: base });
    assert.equal(ok.status, 200);
    assert.equal(a.threads().length, 1);
  } finally { srv.close(); }
});

test('identity source is recorded, and a bound session cannot post as someone else', async () => {
  const { resolveIdentity } = await import('../src/api.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-id-'));
  const env = { IAC_AGENT: 'fable' };
  const a = new Agora(home, { env });
  a.init({ agents: ['fable', 'opus'], human: 'ada' });
  const reg = a.registry(); const config = a.config();

  assert.equal(resolveIdentity({ env, config, registry: reg }).source, 'launcher');
  assert.equal(resolveIdentity({ env, config, registry: reg }).agent, 'fable');
  assert.equal(resolveIdentity({ explicit: 'opus', env: {}, config, registry: reg }).source, 'self');
  assert.equal(resolveIdentity({ env: {}, config, registry: reg }).agent, null);

  const { thread } = await a.open({ as: 'fable', title: 'bound', body: 'x', project: 'o/r' });
  assert.equal(a.thread(thread).posts[0].idSource, 'launcher');

  // the mis-attribution case: bound to fable, posting as opus
  const e = await rejects(a.post({ as: 'opus', thread, body: 'not me' }), 'identity-override');
  assert.match(e.hint, /iac-launch opus/);
  // A bound agent cannot use the human identity either. A real human CLI or
  // viewer is unbound and therefore remains able to post as the human.
  await rejects(a.post({ as: 'ada', thread, body: 'not the human' }), 'identity-override');

  // with nothing bound, a hand-picked identity is allowed but recorded honestly
  const b = new Agora(home, { env: {} });
  await b.post({ as: 'ada', thread, body: 'human may' });
  assert.equal(b.thread(thread).posts.at(-1).idSource, 'self');
  await b.post({ as: 'opus', thread, body: 'self-declared' });
  assert.equal(b.thread(thread).posts.at(-1).idSource, 'self');
  assert.equal(b.verify(thread).ok, true, 'idSource is inside the signed event');
});

test('escalate writes the handoff and the close under one lock: no post lands between them', async () => {
  const { a } = fresh();
  const { thread } = await a.open({ as: 'fable', title: 'T', body: 'p0' });
  let sneak = null; let delayNext = false;
  // Give the concurrent writer every chance: any lock taken after the handoff (other than
  // its own) waits long enough for it to get in first. With one lock there is no such take.
  const lock = a.store.withLock.bind(a.store);
  a.store.withLock = async (fn) => {
    if (delayNext) { delayNext = false; await new Promise((r) => setTimeout(r, 400)); }
    return lock(fn);
  };
  const fin = a._finalize.bind(a);
  a._finalize = (id, ev, author) => {
    const out = fin(id, ev, author);
    // the moment the handoff is on disk, another writer tries to post
    if (ev.kind === 'handoff' && !sneak) {
      sneak = a.post({ as: 'sol', thread, body: 'sneaking in' }).then(() => 'posted', (e) => e.code);
      delayNext = true;
    }
    return out;
  };
  await a.escalate({ as: 'opus', thread, repo: 'o/r', createIssue: async () => 'https://github.com/o/r/issues/9' });
  assert.equal(await sneak, 'closed', 'the concurrent post sees a closed thread');
  const evs = a.store.readEvents(thread);
  assert.deepEqual(evs.slice(-2).map((e) => e.type === 'post' ? e.kind : e.type), ['handoff', 'close']);
  assert.equal(evs.at(-1).reason, 'escalated');
  assert.equal(a.verify(thread).ok, true);
});

test('bound sessions cannot change thread controls or escalate under another identity', async () => {
  const { a: human, home } = fresh();
  const bound = new Agora(home, { env: { IAC_AGENT: 'fable' } });
  const { thread } = await bound.open({ as: 'fable', title: 'bound controls', body: 'x', project: 'o/r' });
  const before = human.store.readEvents(thread);
  await rejects(bound.open({ as: 'ada', title: 'not human', body: 'x', project: 'o/r' }), 'identity-override');
  await rejects(bound.close({ as: 'ada', thread }), 'identity-override');
  await rejects(bound.lock({ as: 'ada', thread }), 'identity-override');
  await rejects(bound.setProject({ as: 'ada', thread, project: 'o/other' }), 'identity-override');
  let issueCalls = 0;
  await rejects(bound.escalate({ as: 'ada', thread, repo: 'o/r', createIssue: async () => {
    issueCalls++;
    return 'https://github.com/o/r/issues/1';
  } }), 'identity-override');
  assert.equal(issueCalls, 0, 'identity must be checked before creating an external issue');
  assert.deepEqual(human.store.readEvents(thread), before, 'rejected overrides must leave the signed events unchanged');
  assert.equal(human.threads().length, 1);

  await bound.lock({ as: 'fable', thread });
  const locked = human.store.readEvents(thread);
  await rejects(bound.unlock({ as: 'ada', thread }), 'identity-override');
  assert.deepEqual(human.store.readEvents(thread), locked);
  await human.unlock({ as: 'ada', thread });
  await human.setProject({ as: 'ada', thread, project: 'o/other' });
  await human.close({ as: 'ada', thread });
  assert.equal(human.thread(thread).closed, true);
  assert.equal(human.thread(thread).project, 'o/other');
  assert.equal(human.verify(thread).ok, true);
});

// ---- harness-derived identity ------------------------------------------------
//
// Claude Code exports CLAUDE_CODE_SESSION_ID into every child and keeps a JSONL
// transcript per session. These tests build a fake one under a temp HOME.

function fakeSession({ models = [], id = `sess-${Math.random().toString(16).slice(2)}`, slug = '-tmp-project' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-harness-'));
  const dir = path.join(home, '.claude', 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const append = (model, extra = {}) => fs.appendFileSync(file, JSON.stringify({
    type: 'assistant', timestamp: new Date().toISOString(), sessionId: id, message: { role: 'assistant', model }, ...extra,
  }) + '\n');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'hi' } }) + '\n');
  for (const m of models) append(m);
  return { home, id, file, append, env: { HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: id } };
}

function throwsRejected(fn, code) {
  try { fn(); } catch (e) { assert.ok(e instanceof Rejected, `expected Rejected, got ${e}`); assert.equal(e.code, code); return e; }
  assert.fail(`expected rejection ${code}`);
}

test('identity is read from the harness session record; the last assistant turn wins', async () => {
  const { resolveIdentity } = await import('../src/api.js');
  const { a, home } = fresh();
  const s = fakeSession({ models: ['claude-fable-5-1'] });
  const session = new Agora(home, { env: s.env });

  let id = session.identity();
  assert.equal(id.agent, 'fable');
  assert.equal(id.source, 'harness');
  assert.equal(id.model, 'claude-fable-5-1');
  assert.equal(id.session, s.id);

  // /model mid-session: the newest assistant turn is the live model
  s.append('claude-opus-5');
  assert.equal(session.identity().agent, 'opus');
  // a sub-agent's turn is not the session's own model
  s.append('claude-fable-5-1', { isSidechain: true });
  assert.equal(session.identity().agent, 'opus');

  // a model nobody claims leaves the session read-only, and says why
  s.append('claude-unknown');
  id = session.identity();
  assert.equal(id.agent, null);
  assert.equal(id.source, null);
  assert.match(id.reason, /model 'claude-unknown' matches no family/);

  // a family that is not a registered agent is inert, and says so
  const unregistered = resolveIdentity({ env: s.env, registry: a.registry(), config: { families: { unknown: ['claude-unknown'] } } });
  assert.equal(unregistered.agent, null);
  assert.match(unregistered.reason, /not a registered agent/);
});

test('a harness-named session writes with idSource harness, inside the signature', async () => {
  const { a, home } = fresh();
  const s = fakeSession({ models: ['claude-fable-5-1'] });
  const session = new Agora(home, { env: s.env });
  const { thread } = await session.open({ as: 'fable', title: 'harness id', body: 'x', project: 'o/r' });
  const post = a.thread(thread).posts[0];
  assert.equal(post.idSource, 'harness');
  assert.equal(post.instance, `fable-${s.id}`, 'CLAUDE_CODE_SESSION_ID is the instance id');
  assert.equal(a.verify(thread).ok, true, 'idSource is inside the signed event');
  const { compact } = await import('../src/format.js');
  assert.doesNotMatch(compact(a.threadWithVerification(thread)), /self-id/, 'harness-attested identity carries no self-id badge');
  const { renderMarkdown } = await import('../src/api.js');
  assert.doesNotMatch(renderMarkdown(a.thread(thread)), /self-declared/);
});

test('a launcher binding that disagrees with the live model is refused as stale, not resolved', async () => {
  const { a, home } = fresh();
  const s = fakeSession({ models: ['claude-fable-5-1'] });
  const stale = new Agora(home, { env: { ...s.env, IAC_AGENT: 'opus' } });
  const e = throwsRejected(() => stale.identity(), 'stale-binding');
  assert.match(e.hint, /empty both IAC_AGENT and AGORA_AGENT/);
  assert.match(e.message, /^IAC_AGENT binds this session to 'opus'/);
  // the message names the variable that actually bound the session
  const legacyBound = throwsRejected(() => new Agora(home, { env: { ...s.env, AGORA_AGENT: 'opus' } }).identity(), 'stale-binding');
  assert.match(legacyBound.message, /^AGORA_AGENT binds this session to 'opus', but it is running claude-fable-5-1/);
  await rejects(stale.open({ as: 'opus', title: 'stale', body: 'x', project: 'o/r' }), 'stale-binding');
  await rejects(stale.open({ as: 'fable', title: 'stale', body: 'x', project: 'o/r' }), 'stale-binding');
  assert.equal(a.threads().length, 0, 'a refused write appends nothing');

  // agreeing binding is fine, and still records itself as the launcher's choice
  const agreed = new Agora(home, { env: { ...s.env, IAC_AGENT: 'fable' } });
  const { thread } = await agreed.open({ as: 'fable', title: 'agreed', body: 'x', project: 'o/r' });
  assert.equal(a.thread(thread).posts[0].idSource, 'launcher');
});

test('--as cannot override a harness identity, not even to write as the human', async () => {
  const { resolveIdentity } = await import('../src/api.js');
  const { a, home } = fresh();
  const s = fakeSession({ models: ['claude-fable-5-1'] });
  const session = new Agora(home, { env: s.env });
  const { thread } = await session.open({ as: 'fable', title: 'mine', body: 'x', project: 'o/r' });

  await rejects(session.post({ as: 'opus', thread, body: 'not me' }), 'identity-override');
  await rejects(session.post({ as: 'ada', thread, body: 'not the human' }), 'identity-override');
  const asHuman = throwsRejected(
    () => resolveIdentity({ explicit: 'ada', env: s.env, config: a.config(), registry: a.registry() }), 'identity-override');
  assert.match(asHuman.hint, /may not write as the human/);
  assert.equal(a.thread(thread).posts.length, 1);

  // a plain human shell — no harness, no binding — is untouched: --as still works
  const shell = new Agora(home, { env: {} });
  await shell.post({ as: 'ada', thread, body: 'the human, at the terminal' });
  assert.equal(a.thread(thread).posts.at(-1).idSource, 'self');
});

test('CLAUDE_CODE_SESSION_ID is the Claude harness task id (the variable Claude Code actually sets)', async () => {
  const { resolveInstance, harnessTaskId } = await import('../src/api.js');
  assert.equal(resolveInstance({ agent: 'fable', project: 'o/r', env: { CLAUDE_CODE_SESSION_ID: 'sess_abc' } }), 'fable-sess_abc');
  assert.equal(resolveInstance({ agent: 'fable', project: 'o/r', env: { CLAUDE_SESSION_ID: 'legacy' } }), 'fable-legacy', 'old name stays as an alias');
  assert.equal(harnessTaskId({ CODEX_THREAD_ID: 'task', CLAUDE_CODE_SESSION_ID: 's' }), null, 'THREAD alone also detects nested harness ambiguity');
  assert.equal(harnessTaskId({ CODEX_SESSION_ID: 'c', CLAUDE_CODE_SESSION_ID: 's' }), null, 'nested harness ambiguity has no authoritative instance');
  assert.equal(harnessTaskId({}), null);

  // and it scopes wait ownership: a sibling Claude task may not clear this one's wait
  const { a, home, clock } = fresh();
  const mine = new Agora(home, { now: clock.now, env: { CLAUDE_CODE_SESSION_ID: 'task-a' } });
  const opened = await mine.open({ as: 'sol', project: 'o/r', title: 'w', body: 'x', waitingOn: ['fable'] });
  assert.equal(a.thread(opened.thread).posts[0].instance, 'sol-task-a');
  const sibling = new Agora(home, { now: clock.now, env: { CLAUDE_CODE_SESSION_ID: 'task-b' } });
  await rejects(sibling.clearWait({ as: 'sol', thread: opened.thread }), 'not-wait-owner');
  await rejects(sibling.clearWait({ as: 'sol', thread: opened.thread, instance: 'sol-task-a' }), 'instance-override');
});

test('families map model ids to agents: seeded for Claude, extended per deployment, registered agents only', async () => {
  const { familyForModel } = await import('../src/api.js');
  const { a } = fresh();
  assert.deepEqual(a.config().families.fable, ['claude-fable-*']);
  assert.equal(familyForModel('claude-opus-5[1m]', a.config()), 'opus');
  assert.equal(familyForModel('claude-fable-5-1', a.config()), 'fable');
  assert.equal(familyForModel('o3-mini', a.config()), null);

  assert.throws(() => a.setFamilyModels('nobody', ['x-*']), /not a registered agent/);
  assert.throws(() => a.setFamilyModels('fable', []), /model glob/);
  a.addAgent('ripley', 'agent', { models: ['acme-ripley-*', 'acme-ripley'] });
  assert.deepEqual(a.config().families.ripley, ['acme-ripley-*', 'acme-ripley']);
  assert.equal(familyForModel('acme-ripley-2', a.config()), 'ripley');
  a.setFamilyModels('fable', ['claude-fable-*', 'claude-fable-next']);
  assert.equal(familyForModel('claude-fable-next', a.config()), 'fable');
});

test('CLI: whoami explains the identity or why there is none; brief stays silent without one', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const { home } = fresh();
  const bin = path.join(import.meta.dirname, '..', 'bin', 'iac.js');
  const s = fakeSession({ models: ['claude-fable-5-1'] });
  const env = { ...process.env, ...s.env, IAC_HOME: home, IAC_PROJECT: 'o/r',
    IAC_AGENT: '', IAC_INSTANCE: '', CODEX_THREAD_ID: '', CODEX_SESSION_ID: '', CLAUDE_SESSION_ID: '' };
  const cli = (extra, ...args) => run(process.execPath, [bin, ...args], { env: { ...env, ...extra } });

  const me = (await cli({}, 'whoami')).stdout;
  assert.match(me, /^fable \(agent\) · identity from harness/);
  assert.match(me, /model claude-fable-5-1/);
  assert.match(me, new RegExp(`instance fable-${s.id}`));
  const json = JSON.parse((await cli({}, 'whoami', '--json')).stdout);
  assert.deepEqual([json.name, json.source, json.model], ['fable', 'harness', 'claude-fable-5-1']);

  // a write needs no --as now, and is not announced as self-declared
  const opened = await cli({}, 'open', '--title', 'no --as needed', '--kind', 'status', '--body', 'x', '--json');
  assert.doesNotMatch(opened.stderr, /self-declared/);

  // unknown model: read-only, with the reason and the fix
  s.append('claude-unknown');
  const none = (await cli({}, 'whoami')).stdout;
  assert.match(none, /no identity — iac is read-only/);
  assert.match(none, /why: model 'claude-unknown' matches no family/);
  assert.match(none, /fix: iac set-models/);
  const quiet = await cli({}, 'brief');
  assert.equal(quiet.stdout, '', 'a hook on every prompt must print nothing without an identity');
  await assert.rejects(cli({}, 'post', JSON.parse(opened.stdout).thread, '--body', 'x'), (e) => /no identity/.test(e.stderr));
});

test('plugin manifests: version tracks package.json, hooks run brief --hook, nothing baked in, no permissions', () => {
  const root = path.join(import.meta.dirname, '..');
  const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
  const pkg = read('package.json'); const plugin = read('.claude-plugin/plugin.json'); const market = read('.claude-plugin/marketplace.json');
  assert.equal(plugin.name, 'inter-agent-comms');
  assert.equal(pkg.name, 'inter-agent-comms');
  assert.equal(plugin.version, pkg.version);
  for (const x of market.plugins) if (x.version !== undefined) assert.equal(x.version, pkg.version, 'marketplace.json plugin version tracks package.json');
  assert.equal(market.name, 'inter-agent-comms', 'install id: inter-agent-comms@inter-agent-comms');
  assert.equal(market.metadata.version, pkg.version, 'marketplace metadata version tracks package.json');
  assert.deepEqual(market.plugins.map((x) => [x.name, x.source]), [['inter-agent-comms', './']]);
  // the server key is the <server> in mcp__plugin_<plugin>_<server>__<tool>: mcp__plugin_inter-agent-comms_iac__*
  assert.deepEqual(Object.keys(plugin.mcpServers), ['iac']);
  const server = plugin.mcpServers.iac;
  assert.deepEqual([server.command, server.args], ['node', ['${CLAUDE_PLUGIN_ROOT}/bin/iac-mcp.js']]);
  assert.equal(server.env, undefined, 'no IAC_AGENT or IAC_HOME baked in; the environment supplies them');
  const hooks = read('hooks/hooks.json').hooks;
  for (const ev of ['SessionStart', 'UserPromptSubmit']) {
    const [h] = hooks[ev][0].hooks;
    assert.equal(h.command, 'node "${CLAUDE_PLUGIN_ROOT}/bin/iac.js" brief --hook');
    assert.ok(h.timeout > 0 && h.timeout <= 15);
  }
  const keys = []; const walk = (v) => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); } };
  walk([plugin, market, hooks]);
  assert.ok(!keys.some((k) => /permission|allow|settings/i.test(k)), 'installing the plugin must not widen what an agent may do');
  // private, deployment-specific files never ship, and the public archive drops them too
  const exportIgnored = fs.readFileSync(path.join(root, '.gitattributes'), 'utf8').split('\n').filter((l) => /\bexport-ignore\b/.test(l)).map((l) => l.split(/\s+/)[0]);
  // (they all live under private/, so neither this test nor .gitattributes names them)
  assert.ok(exportIgnored.includes('/private'), 'private/ must be export-ignored');
  assert.ok(!pkg.files.some((f) => /^\/?private\b/.test(f)), 'private/ must not ship');
  assert.ok(!pkg.files.some((f) => /\*/.test(f) || f === '.' || f === './'), 'the files list names what ships; no wildcard that could pull private/ in');
  for (const f of ['RELEASING.md', 'CONTRIBUTING.md', 'SECURITY.md']) assert.ok(pkg.files.includes(f), `${f} ships (README links it)`);
  for (const f of ['.claude-plugin/', 'hooks/']) assert.ok(pkg.files.includes(f), `${f} ships`);
});

// Codex 0.160.1 reads .codex-plugin/plugin.json before .claude-plugin/plugin.json, so this manifest
// also keeps Codex from falling back to hooks/hooks.json (brief --hook, the Claude handler).
// It substitutes ${PLUGIN_ROOT} in hook commands but passes MCP args verbatim; MCP `cwd: "."` is
// the installed plugin root. The Codex MCP read tools never consult the server's cwd.
test('Codex plugin manifest: codex-hook on UserPromptSubmit only, read-only MCP from the plugin root, the shared skill', async () => {
  const root = path.join(import.meta.dirname, '..');
  const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
  const pkg = read('package.json'); const plugin = read('.codex-plugin/plugin.json'); const market = read('.claude-plugin/marketplace.json');
  assert.equal(plugin.name, 'inter-agent-comms');
  assert.equal(plugin.name, market.plugins[0].name, 'one marketplace entry serves both harnesses: inter-agent-comms@inter-agent-comms');
  assert.equal(plugin.version, pkg.version);
  assert.equal(plugin.version, read('.claude-plugin/plugin.json').version, 'both plugin manifests carry one version');
  assert.ok(pkg.files.includes('.codex-plugin/'), '.codex-plugin/ ships');

  assert.equal(plugin.skills, './skills/');
  assert.ok(fs.statSync(path.join(root, 'skills', 'inter-agent-comms', 'SKILL.md')).isFile(), 'the skill is the shared one, not a copy');

  assert.deepEqual(Object.keys(plugin.mcpServers), ['iac']);
  const server = plugin.mcpServers.iac;
  assert.deepEqual([server.command, server.args, server.cwd], ['node', ['./bin/iac-mcp.js'], '.']);
  assert.ok(fs.statSync(path.join(root, server.cwd, server.args[0])).isFile());
  assert.equal(server.env, undefined, 'no IAC_AGENT or IAC_HOME baked in');
  assert.deepEqual(server.env_vars, ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_HOME', 'IAC_HOME', 'AGORA_HOME'], 'Codex forwards only what is named; IAC_AGENT/AGORA_AGENT never');

  const events = plugin.hooks.hooks;
  assert.deepEqual(Object.keys(events), ['UserPromptSubmit'], 'codex-hook ignores every other event');
  assert.equal(events.UserPromptSubmit.length, 1); assert.equal(events.UserPromptSubmit[0].hooks.length, 1);
  const [h] = events.UserPromptSubmit[0].hooks;
  assert.equal(h.type, 'command');
  assert.equal(h.command, 'node "${PLUGIN_ROOT}/bin/iac.js" codex-hook');
  assert.equal(h.commandWindows, h.command, 'cmd.exe and PowerShell run the same double-quoted form');
  assert.equal(h.timeout, 10);

  const keys = []; const walk = (v) => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); } };
  walk(plugin);
  assert.ok(!keys.some((k) => /permission|allow|settings|trust/i.test(k)), 'installing the plugin must not widen what an agent may do');

  // Run the hook as Codex would after substituting the installed root: it briefs the attested task.
  const { home } = fresh(); const pin = new Agora(home); pin.setFamilyModels('sol', ['gpt-6-sol']); pin.setFamilyHarness('sol', 'codex');
  await new Agora(home, { env: { IAC_PROJECT: 'global' } }).open({ as: 'ada', title: 'plugin hook', body: 'x', waitingOn: ['sol'], project: 'global' });
  const s = fakeCodexSession({ model: 'gpt-6-sol' });
  const env = { ...process.env, ...s.env, IAC_HOME: home, IAC_AGENT: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '' };
  const command = (process.platform === 'win32' ? h.commandWindows : h.command).replaceAll('${PLUGIN_ROOT}', root);
  const run = (input, e = env) => shellCommand(command, { env: e, input });
  // Codex gives hooks no ids of their own (any in env are inherited): stdin session + transcript name the task.
  const prompt = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: s.id, transcript_path: s.file, cwd: process.cwd() });
  const ok = run(prompt, { ...env, CODEX_THREAD_ID: '', CODEX_SESSION_ID: '' });
  assert.equal(ok.status, 0); assert.match(ok.stdout, /^iac\[sol[^\]]*\]: waiting on sol/);
  assert.deepEqual([run(JSON.stringify({ hook_event_name: 'SessionStart' })).stdout, run('not json').stdout], ['', ''], 'other events and junk stdin print nothing');
  const noTranscript = run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: s.id, cwd: process.cwd() }));
  assert.deepEqual([noTranscript.status, noTranscript.stdout], [0, ''], 'env ids alone brief nothing: they are inherited');
});

// A Claude Code hook gets its session on stdin as JSON; `brief --hook` reads it there.
function hookRun(env, input, ...args) {
  const bin = path.join(import.meta.dirname, '..', 'bin', 'iac.js');
  return spawnSync(process.execPath, [bin, 'brief', '--hook', ...args], { env, input, encoding: 'utf8', timeout: 20_000 });
}
const HOOK_CLEAN = HARNESS_CLEAN;

test('brief --hook: the stdin payload supplies the session when the environment has none', async () => {
  const { home } = fresh();
  // brief runs in a subprocess on the wall clock, so open the thread on the wall clock too;
  // on the fixture clock it would be weeks old, past the new-thread floor, and not news.
  const live = new Agora(home, { env: {} });
  const { thread } = await live.open({ as: 'ada', title: 'need fable', kind: 'question', body: 'over to @fable', waitingOn: ['fable'], project: 'o/r' });
  const s = fakeSession({ models: ['claude-fable-5-1'] });
  const env = { ...process.env, ...HOOK_CLEAN, HOME: s.home, USERPROFILE: s.home, IAC_HOME: home, IAC_PROJECT: 'o/r' };

  // with an empty payload and no session in env, there is no identity: silent
  assert.equal(hookRun(env, '').stdout, '');

  // session_id from the payload, transcript found under HOME
  let r = hookRun(env, JSON.stringify({ session_id: s.id, hook_event_name: 'UserPromptSubmit' }));
  assert.equal(r.status, 0); assert.equal(r.stderr, '');
  assert.match(r.stdout, new RegExp(`^iac\\[fable.*${thread}`));
  assert.match(r.stdout, new RegExp(`fable-${s.id}`), 'the payload session is the instance id too');

  // the environment's own session wins over the payload
  const opus = fakeSession({ models: ['claude-opus-5'] });
  r = hookRun({ ...env, CLAUDE_CODE_SESSION_ID: s.id }, JSON.stringify({ session_id: opus.id, transcript_path: opus.file }));
  assert.match(r.stdout, /^iac\[fable/);

  // inside Codex the payload is never adopted as a Claude session, even if its id matches a transcript
  const payload = JSON.stringify({ session_id: s.id, hook_event_name: 'UserPromptSubmit' });
  assert.equal(hookRun({ ...env, CODEX_THREAD_ID: 'codex-t1' }, payload).stdout, '', 'Codex env');
  assert.equal(hookRun(env, JSON.stringify({ session_id: s.id, transcript_path: path.join(s.home, '.codex', 'sessions', `rollout-${s.id}.jsonl`) })).stdout, '', 'Codex transcript path');
});

test('brief --hook: Claude started from a Codex shell is ambiguous, not the parent Codex agent', async () => {
  const { a, home } = fresh(); a.setFamilyModels('sol', ['gpt-6-sol']);
  const live = new Agora(home, { env: {} });
  const { thread } = await live.open({ as: 'ada', title: 'need sol', kind: 'question', body: 'over to @sol', waitingOn: ['sol'], project: 'o/r' });
  const codex = fakeCodexSession({ model: 'gpt-6-sol' });
  const claude = fakeSession({ models: ['claude-fable-5-1'] });
  // the Claude hook inherits the parent Codex ids; its own id arrives only on stdin
  const env = { ...process.env, ...HOOK_CLEAN, ...codex.env, IAC_HOME: home, IAC_PROJECT: 'o/r' };
  const claudePayload = JSON.stringify({ session_id: claude.id, transcript_path: claude.file, hook_event_name: 'UserPromptSubmit' });
  // control: the Codex identity itself still briefs through `brief --hook` (a Codex-shaped payload is not adopted)
  const own = hookRun(env, JSON.stringify({ session_id: codex.id, hook_event_name: 'UserPromptSubmit' }));
  assert.match(own.stdout, new RegExp(`^iac\\[sol.*${thread}`));
  // a verifiable Claude payload is adopted, both ids are present, and agora refuses to guess between inherited Claude and Codex ids: silent
  const r = hookRun({ ...env, CLAUDE_CONFIG_DIR: path.join(claude.home, '.claude') }, claudePayload);
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], 'never brief the parent Codex agent into a Claude session');
});

test('brief --hook in a Codex env: only a Codex-shaped payload falls through to the Codex brief', async () => {
  const { a, home } = fresh(); a.setFamilyModels('sol', ['gpt-6-sol']);
  const live = new Agora(home, { env: {} });
  const { thread } = await live.open({ as: 'ada', title: 'need sol', kind: 'question', body: 'over to @sol', waitingOn: ['sol'], project: 'o/r' });
  const codex = fakeCodexSession({ model: 'gpt-6-sol' });
  const env = { ...process.env, ...HOOK_CLEAN, ...codex.env, CODEX_SESSION_ID: 'root-session', IAC_HOME: home, IAC_PROJECT: 'o/r' };
  const silent = (e, input, msg) => assert.deepEqual((({ status, stdout, stderr }) => [status, stdout, stderr])(hookRun(e, input)), [0, '', ''], msg);

  // a fresh Claude SessionStart: the transcript is named but not on disk yet
  const fresh1 = 'claude-fresh-1';
  const notYet = path.join(codex.home, '.claude', 'projects', '-tmp-project', `${fresh1}.jsonl`);
  silent(env, JSON.stringify({ session_id: fresh1, transcript_path: notYet, hook_event_name: 'SessionStart' }), 'Claude transcript not yet on disk');
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-claudecfg-'));
  silent({ ...env, CLAUDE_CONFIG_DIR: cfg }, JSON.stringify({ session_id: fresh1, transcript_path: path.join(cfg, 'projects', 'x', `${fresh1}.jsonl`) }), 'under CLAUDE_CONFIG_DIR, not on disk');
  // even a Codex id is not enough when the transcript is under the Claude config dir
  silent(env, JSON.stringify({ session_id: codex.id, transcript_path: notYet }), 'Codex id with a Claude transcript path');
  // no payload at all, or unreadable
  silent(env, '', 'empty stdin');
  silent(env, 'not json', 'unparseable stdin');
  // a session id that is neither Codex id, with no transcript
  silent(env, JSON.stringify({ session_id: 'someone-else' }), 'sid differs from the Codex ids');

  // Codex-shaped payloads still get the Codex brief
  const want = new RegExp(`^iac\\[sol.*${thread}`);
  assert.match(hookRun(env, JSON.stringify({ session_id: codex.id })).stdout, want, 'sid = CODEX_THREAD_ID');
  assert.match(hookRun(env, JSON.stringify({ session_id: 'root-session' })).stdout, want, 'sid = CODEX_SESSION_ID remains advisory; the task rollout selects identity');
  assert.match(hookRun(env, JSON.stringify({ session_id: 'x', transcript_path: codex.file })).stdout, want, 'transcript under CODEX_HOME');
});

test('brief --hook: payload transcript_path is a fallback, and only inside ~/.claude/projects', async () => {
  const { harnessIdentity, HOOK_TRANSCRIPT } = await import('../src/api.js');
  const s = fakeSession({ models: ['claude-fable-5-1'] });
  // a same-named file outside ~/.claude/projects, naming another model
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-outside-'));
  const fake = path.join(outside, `${s.id}.jsonl`);
  fs.writeFileSync(fake, JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5' } }) + '\n');

  // the real transcript under HOME wins over the payload's path
  assert.equal(harnessIdentity({ ...s.env, [HOOK_TRANSCRIPT]: fake }).model, 'claude-fable-5-1');
  // with no real transcript, a same-named file elsewhere is still ignored
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-nohome-'));
  fs.mkdirSync(path.join(empty, '.claude', 'projects'), { recursive: true });
  const noHome = { HOME: empty, USERPROFILE: empty, CLAUDE_CODE_SESSION_ID: s.id };
  assert.equal(harnessIdentity({ ...noHome, [HOOK_TRANSCRIPT]: fake }).transcript, null);
  // ...including through a symlink that sits under projects but resolves outside
  // (nested, so the HOME scan, which looks one level deep, does not find it by name)
  const linkDir = path.join(empty, '.claude', 'projects', 'a', 'linked');
  fs.mkdirSync(path.dirname(linkDir), { recursive: true });
  let linked = true; try { fs.symlinkSync(outside, linkDir, 'dir'); } catch { linked = false; }
  if (linked) assert.equal(harnessIdentity({ ...noHome, [HOOK_TRANSCRIPT]: path.join(linkDir, `${s.id}.jsonl`) }).transcript, null);
  // a payload path inside projects, for this session, is accepted when the HOME scan misses it
  const nested = path.join(empty, '.claude', 'projects', 'a', 'b');
  fs.mkdirSync(nested, { recursive: true });
  const deep = path.join(nested, `${s.id}.jsonl`);
  fs.copyFileSync(s.file, deep);
  assert.equal(harnessIdentity({ ...noHome, [HOOK_TRANSCRIPT]: deep }).model, 'claude-fable-5-1');
  // ...but never one named for another session
  const other = fakeSession({ models: ['claude-opus-5'] });
  assert.equal(harnessIdentity({ ...noHome, [HOOK_TRANSCRIPT]: other.file }).transcript, null);
});

test('brief --hook: empty, invalid, or oversized stdin and a broken store print nothing and exit 0', async () => {
  const { home } = fresh();
  const env = { ...process.env, ...HOOK_CLEAN, IAC_HOME: home, IAC_PROJECT: 'o/r' };
  const s = fakeSession({ models: ['claude-fable-5-1'] });
  // valid JSON naming a real session, but over the 1 MiB bound: dropped as a whole
  const oversize = JSON.stringify({ session_id: s.id, pad: 'x'.repeat(2 << 20) });
  for (const input of ['', 'not json', '[1,2]', 'null', '{"session_id": 42}', '{"session_id":"../../etc/passwd"}', oversize]) {
    const r = hookRun({ ...env, HOME: s.home, USERPROFILE: s.home }, input);
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], `input ${input.slice(0, 20)}`);
  }
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-broken-'));
  fs.writeFileSync(path.join(broken, 'config.json'), '{ not json');
  const r = hookRun({ ...env, IAC_HOME: broken, HOME: s.home }, JSON.stringify({ session_id: s.id }), '--no-such-flag');
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
  const r2 = hookRun({ ...env, IAC_HOME: broken, HOME: s.home }, JSON.stringify({ session_id: s.id }));
  assert.deepEqual([r2.status, r2.stdout, r2.stderr], [0, '', '']);
  // --hook=1 is still hook mode: no stack trace, exit 0
  const bin = path.join(import.meta.dirname, '..', 'bin', 'iac.js');
  const r3 = spawnSync(process.execPath, [bin, 'brief', '--hook=1'], { env, input: '', encoding: 'utf8', timeout: 20_000 });
  assert.deepEqual([r3.status, r3.stdout, r3.stderr], [0, '', '']);
});

// A second flake of the same class as the git-timeout tests above: this test pins
// IAC_PROJECT, so it never touches git, but it still spawned a real subprocess and measured a
// tight wall-clock window (3000ms / 1500ms) around readHookPayload's internal stdin-wait timer
// — process start + scheduling overhead under machine load pushed it over. The two tests below
// make the logic deterministic via readHookPayload's `schedule` seam (a stand-in for
// `setTimeout`, exactly like `now`/`spawn` in src/project.js probe()): no real timer, no real
// subprocess, no wall-clock assertion. One real end-to-end subprocess check remains further
// down, with a bound tied to the actual HOOK_STDIN_MS constant and generous headroom.

// A stdin that never emits anything at all: the only way a read of it resolves is via the
// injected `schedule` callback (simulating the real timer firing) or by the test calling a
// method on it directly. It never ends on its own, so a bug that stops calling `schedule`
// would hang the test instead of silently passing.
function idleStdin() {
  const e = new EventEmitter();
  e.isTTY = false;
  e.pause = () => {};
  return e;
}

test('readHookPayload: gives up after exactly its configured stdin budget, deterministically', async () => {
  const { readHookPayload, HOOK_STDIN_MS } = await import('../src/cli.js');
  // Pinned to a literal, not just "whatever the constant says": comparing `scheduled` to
  // `HOOK_STDIN_MS` alone would still pass if the constant itself were mutated to something
  // huge (e.g. 12000ms — a 12s stall on every prompt). A hook runs on every prompt, so this
  // budget must stay short.
  assert.equal(HOOK_STDIN_MS, 1500, 'the stdin-wait budget must be pinned; a hook runs on every prompt');
  const scheduled = [];
  // Deferred (not synchronous): readHookPayload still has to finish assigning its own `timer`
  // variable before anything may call back into `finish`, exactly as the real setTimeout would.
  const schedule = (fn, ms) => { scheduled.push(ms); queueMicrotask(fn); return 0; };
  const v = await readHookPayload(idleStdin(), { schedule });
  assert.equal(v, null, 'stdin that never answers yields no payload');
  assert.deepEqual(scheduled, [HOOK_STDIN_MS], 'the real stdin-wait budget was used, not some other value');
});

test('readHookPayload: a complete payload resolves without the timer ever firing', { timeout: 5000 }, async () => {
  const { readHookPayload } = await import('../src/cli.js');
  const schedule = () => 0; // never invokes its callback: resolving via this would hang the test
  const stdin = idleStdin();
  const payload = { session_id: 'abc123' };
  queueMicrotask(() => stdin.emit('data', Buffer.from(JSON.stringify(payload))));
  const v = await readHookPayload(stdin, { schedule });
  assert.deepEqual(v, payload, 'a complete object on stdin resolves the read, stdin left open and no timer needed');
});

test('brief --hook: stdin left open returns promptly on its own, without hanging', { timeout: 60_000 }, async () => {
  const { spawn } = await import('node:child_process');
  const { HOOK_STDIN_MS } = await import('../src/cli.js');
  const BOUND = HOOK_STDIN_MS + 15_000;
  const KILL = HOOK_STDIN_MS + 25_000;
  const { home } = fresh();
  const s = fakeSession({ models: ['claude-fable-5-1'] });
  const env = { ...process.env, ...HOOK_CLEAN, HOME: s.home, USERPROFILE: s.home, IAC_HOME: home, IAC_PROJECT: 'o/r' };
  const bin = path.join(import.meta.dirname, '..', 'bin', 'iac.js');
  const t0 = Date.now();
  const r = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [bin, 'brief', '--hook'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
    const kill = setTimeout(() => { p.kill(); reject(new Error('hook hung on open stdin')); }, KILL);
    p.on('exit', (code) => { clearTimeout(kill); p.stdin.destroy(); resolve({ code, out, err }); });
    // stdin is never written to and never ended: the "nothing ever arrives" case, the one
    // actually bounded by HOOK_STDIN_MS. (A complete payload on an open stdin is covered,
    // deterministically, above.)
  });
  assert.deepEqual([r.code, r.out, r.err], [0, '', '']);
  assert.ok(Date.now() - t0 < BOUND, `hook took ${Date.now() - t0}ms (bound ${BOUND}ms, tied to HOOK_STDIN_MS=${HOOK_STDIN_MS})`);
});

test('brief --hook: an identity conflict prints one line instead of hiding it', async () => {
  const { home } = fresh();
  const s = fakeSession({ models: ['claude-fable-5-1'] });
  const env = { ...process.env, ...HOOK_CLEAN, ...s.env, IAC_HOME: home, IAC_PROJECT: 'o/r' };
  let r = hookRun({ ...env, IAC_AGENT: 'opus' }, '');
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, 'iac: identity conflict (stale-binding) — run iac whoami\n', '']);
  r = hookRun(env, '', '--as', 'opus');
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, 'iac: identity conflict (identity-override) — run iac whoami\n', '']);
});

test('a fresh session names its model before any assistant turn; the latest entry by position wins', async () => {
  const { lastSessionModel } = await import('../src/api.js');
  const s = fakeSession();
  const attach = (modelId, extra = {}) => fs.appendFileSync(s.file, JSON.stringify({
    type: 'attachment', isSidechain: false, attachment: { type: 'model', identity: { modelId } }, ...extra }) + '\n');
  assert.equal(lastSessionModel(s.file), null);
  // first prompt of a new session: only the model attachment exists yet
  attach('claude-haiku-4-5-20251001');
  assert.equal(lastSessionModel(s.file), 'claude-haiku-4-5-20251001');
  s.append('claude-haiku-4-5-20251001');
  // /model: the next prompt's attachment lands before the new model's first assistant entry
  attach('claude-opus-5');
  assert.equal(lastSessionModel(s.file), 'claude-opus-5');
  s.append('claude-opus-5');
  // a sub-agent's attachment or turn is not the session's model; later entries still win by position
  attach('claude-fable-5-1', { isSidechain: true });
  s.append('claude-fable-5-1', { isSidechain: true });
  assert.equal(lastSessionModel(s.file), 'claude-opus-5');
  fs.appendFileSync(s.file, JSON.stringify({ type: 'attachment', attachment: { type: 'date', identity: { modelId: 'x' } } }) + '\n');
  assert.equal(lastSessionModel(s.file), 'claude-opus-5', 'only model attachments count');
  attach('claude-fable-5-1');
  assert.equal(new Agora(fresh().home, { env: s.env }).identity().agent, 'fable');
});

test('/model makes the model unknown until the new model is announced; a kept model or a quoted command does not', async () => {
  const { lastSessionModel } = await import('../src/api.js');
  const s = fakeSession({ models: ['claude-opus-5'] });
  const line = (e) => fs.appendFileSync(s.file, JSON.stringify({ isSidechain: false, ...e }) + '\n');
  const user = (content, extra = {}) => line({ type: 'user', message: { role: 'user', content }, ...extra });
  const prompt = (content) => user(content, { permissionMode: 'auto', origin: { kind: 'human' }, promptSource: 'human' });
  const command = (args) => user(`<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>${args}</command-args>`);
  const attach = (modelId) => line({ type: 'attachment', attachment: { type: 'model', identity: { modelId } } });
  const agent = () => new Agora(fresh().home, { env: s.env }).identity().agent;
  assert.equal(agent(), 'opus');
  // the shapes Claude Code writes for `/model fable`: caveat (isMeta), command, stdout
  user('<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>', { isMeta: true });
  command('fable');
  assert.equal(lastSessionModel(s.file), 'claude-opus-5', 'the command alone is not a switch');
  user('<local-command-stdout>Set model to `Fable 5.1` and saved as your default for new sessions</local-command-stdout>');
  assert.equal(lastSessionModel(s.file), null, 'switched, new model not announced yet');
  assert.equal(agent(), null);
  // the next prompt (its UserPromptSubmit hook already ran) and then the attachment
  prompt('next prompt');
  assert.equal(lastSessionModel(s.file), null);
  attach('claude-fable-5-1');
  assert.equal(lastSessionModel(s.file), 'claude-fable-5-1');
  assert.equal(agent(), 'fable');
  // older Claude Code: no attachment, the first assistant entry restores resolution
  user('<local-command-stdout>Set model to \u001b[1mOpus 5\u001b[22m and saved as your default for new sessions</local-command-stdout>');
  assert.equal(lastSessionModel(s.file), null);
  s.append('claude-opus-5');
  assert.equal(lastSessionModel(s.file), 'claude-opus-5');
  // picker closed without a change: written as a system local_command entry, "Kept model as"
  for (const content of ['<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>',
    '<local-command-stdout>Kept model as `Opus 5`</local-command-stdout>']) line({ type: 'system', subtype: 'local_command', content, level: 'info', isMeta: false });
  assert.equal(lastSessionModel(s.file), 'claude-opus-5', 'a kept model is not a switch');
  // a typed prompt quoting the harness's tags is not a switch, even at the start of the prompt
  prompt('why does <command-name>/model</command-name> then <local-command-stdout>Set model to `Fable 5.1`</local-command-stdout> lag?');
  prompt('<local-command-stdout>Set model to `Fable 5.1` and saved as your default for new sessions</local-command-stdout>');
  user([{ type: 'tool_result', content: '<local-command-stdout>Set model to `Fable 5.1`</local-command-stdout>' }]);
  assert.equal(lastSessionModel(s.file), 'claude-opus-5');
  // a sub-agent's switch is not the session's
  user('<local-command-stdout>Set model to `Fable 5.1`</local-command-stdout>', { isSidechain: true });
  assert.equal(lastSessionModel(s.file), 'claude-opus-5');
});

test('during a /model switch --as is refused, the human included; a fresh session may still self-declare', async () => {
  const { sessionModelState } = await import('../src/api.js');
  const { home } = fresh();
  const s = fakeSession({ models: ['claude-opus-5'] });
  const switchTo = () => fs.appendFileSync(s.file, JSON.stringify({ type: 'user', isSidechain: false,
    message: { role: 'user', content: '<local-command-stdout>Set model to `Fable 5.1`</local-command-stdout>' } }) + '\n');
  const session = () => new Agora(home, { env: s.env });
  switchTo();
  assert.deepEqual(sessionModelState(s.file), { model: null, switching: true, unknown: false });
  const id = session().identity();
  assert.deepEqual([id.agent, id.source, id.switching], [null, null, true]);
  assert.match(id.reason, /switching models/);
  assert.match(id.todo, /the harness is switching models; retry after the next prompt/);
  for (const who of ['ada', 'sol', 'fable']) {
    const e = throwsRejected(() => session().identity({ explicit: who }), 'model-switching');
    assert.match(e.hint, /retry after the next prompt/);
  }
  // the API refuses a write too, whoever it names
  await rejects(session().open({ as: 'ada', title: 'x', body: 'x' }), 'model-switching');
  // a launcher binding is unaffected: the switch hides no conflict with it
  assert.equal(new Agora(home, { env: { ...s.env, IAC_AGENT: 'opus' } }).identity().source, 'launcher');
  // the announcement ends the window
  s.append('claude-fable-5-1');
  assert.deepEqual([session().identity().agent, session().identity().switching], ['fable', undefined]);
  // a fresh session with no model evidence at all keeps the self-declared path
  const blank = fakeSession();
  assert.deepEqual(sessionModelState(blank.file), { model: null, switching: false, unknown: false });
  const self = new Agora(home, { env: blank.env }).identity({ explicit: 'sol' });
  assert.deepEqual([self.agent, self.source, self.switching], ['sol', 'self', undefined]);
});

test('CLI and brief --hook during a /model switch: whoami says why, --as is refused, the hook stays silent', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const { home } = fresh();
  const bin = path.join(import.meta.dirname, '..', 'bin', 'iac.js');
  const s = fakeSession({ models: ['claude-opus-5'] });
  fs.appendFileSync(s.file, JSON.stringify({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Set model to `Fable 5.1`</local-command-stdout>' } }) + '\n');
  const env = { ...process.env, ...HOOK_CLEAN, ...s.env, IAC_HOME: home, IAC_PROJECT: 'o/r' };
  const cli = (...args) => run(process.execPath, [bin, ...args], { env });
  const me = (await cli('whoami')).stdout;
  assert.match(me, /no identity — iac is read-only/);
  assert.match(me, /why: session .* is switching models/);
  assert.match(me, /fix: the harness is switching models; retry after the next prompt/);
  assert.equal(JSON.parse((await cli('whoami', '--json')).stdout).switching, true);
  await assert.rejects(cli('whoami', '--as', 'ada'), (e) => /model-switching/.test(e.stderr) && /retry after the next prompt/.test(e.stderr));
  await assert.rejects(cli('open', '--as', 'ada', '--title', 't', '--body', 'x'), (e) => /model-switching/.test(e.stderr));
  const r = hookRun(env, JSON.stringify({ session_id: s.id, hook_event_name: 'UserPromptSubmit' }));
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
});

test('model evidence beyond the first tail window is still found; past the cap the model is unknown', async () => {
  const { sessionModelState } = await import('../src/api.js');
  const { home } = fresh();
  const filler = (s, n, size) => {
    const pad = 'x'.repeat(size);
    for (let i = 0; i < n; i++) fs.appendFileSync(s.file, JSON.stringify({ type: 'attachment', isSidechain: false, attachment: { type: 'image', data: pad } }) + '\n');
  };
  const sw = (s) => fs.appendFileSync(s.file, JSON.stringify({ type: 'user', isSidechain: false,
    message: { role: 'user', content: '<local-command-stdout>Set model to `Fable 5.1`</local-command-stdout>' } }) + '\n');
  // a switch followed by more than a 256KB tail of non-model entries is still a switch
  const a = fakeSession({ models: ['claude-opus-5'] });
  sw(a); filler(a, 30, 10 * 1024);
  assert.ok(fs.statSync(a.file).size > 256 * 1024);
  assert.equal(sessionModelState(a.file).switching, true);
  throwsRejected(() => new Agora(home, { env: a.env }).identity({ explicit: 'ada' }), 'model-switching');
  // a model followed by 300KB of non-model entries is still that model
  const b = fakeSession({ models: ['claude-opus-5'] });
  filler(b, 30, 10 * 1024);
  assert.equal(sessionModelState(b.file).model, 'claude-opus-5');
  assert.equal(new Agora(home, { env: b.env }).identity().agent, 'opus');
  // past the cap with no evidence: unknown, not fresh
  const c = fakeSession({ models: ['claude-opus-5'] });
  filler(c, 4, 4 * 1024);
  assert.deepEqual(sessionModelState(c.file, { tail: 1024, cap: 8 * 1024 }), { model: null, switching: false, unknown: true });
  assert.equal(sessionModelState(c.file, { tail: 1024, cap: 1024 * 1024 }).model, 'claude-opus-5');
  // a whole record with no evidence, however large, is fresh
  const d = fakeSession(); filler(d, 30, 10 * 1024);
  assert.deepEqual(sessionModelState(d.file), { model: null, switching: false, unknown: false });
});

test('MCP during a /model switch is read-only and keeps the retry hint', async () => {
  const { home } = fresh();
  const bin = path.join(import.meta.dirname, '..', 'bin', 'iac-mcp.js');
  const s = fakeSession({ models: ['claude-opus-5'] });
  fs.appendFileSync(s.file, JSON.stringify({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Set model to `Fable 5.1`</local-command-stdout>' } }) + '\n');
  const input = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n';
  const r = spawnSync(process.execPath, [bin], { input, encoding: 'utf8', timeout: 20_000, env: { ...process.env, ...HOOK_CLEAN, ...s.env, IAC_HOME: home } });
  const init = JSON.parse(r.stdout.split('\n').find((l) => l.includes('"id":1')));
  assert.match(init.result.instructions, /READ-ONLY/);
  assert.match(init.result.instructions, /switching models; retry after the next prompt/);
});

test('familyHarness keys match case-insensitively: a hand-edited "Sol" pins sol; set-models replaces the variant', async () => {
  const { declaredHarness } = await import('../src/api.js');
  assert.equal(declaredHarness('sol', { familyHarness: { Sol: 'codex' } }), 'codex');
  assert.equal(declaredHarness('sol', { familyHarness: { Sol: 'codex', sol: 'claude-code' } }), 'invalid', 'disagreeing spellings fail closed');
  const { a, home } = fresh();
  a.setFamilyModels('opus', ['claude-opus-*']);
  const cfgPath = path.join(home, 'config.json');
  const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); delete raw.familyHarness.opus; raw.familyHarness.Opus = 'codex';
  fs.writeFileSync(cfgPath, JSON.stringify(raw)); a.store.invalidate();
  assert.equal(declaredHarness('opus', a.config()), 'codex', 'the hand-edit overrides the seeded default');
  const claude = fakeSession({ models: ['claude-opus-5'] });
  assert.equal(new Agora(home, { env: claude.env }).identity().agent, null, 'pinned to codex, so Claude Code may not attest opus');
  a.setFamilyHarness('opus', 'claude-code');
  const after = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).familyHarness;
  assert.deepEqual([after.Opus, after.opus], [undefined, 'claude-code']);
  assert.equal(new Agora(home, { env: claude.env }).identity().agent, 'opus');
});

test('MCP resolves identity per call, so a model switch moves the bound identity', async () => {
  const { spawn } = await import('node:child_process');
  const { home } = fresh();
  const bin = path.join(import.meta.dirname, '..', 'bin', 'iac-mcp.js');
  const s = fakeSession({ models: ['claude-fable-5-1'] });
  const proc = spawn(process.execPath, [bin], { env: { ...process.env, ...s.env, IAC_HOME: home,
    IAC_AGENT: '', IAC_INSTANCE: '', CODEX_THREAD_ID: '', CODEX_SESSION_ID: '', CLAUDE_SESSION_ID: '' } });
  let buf = ''; const waiting = new Map(); const notes = []; let n = 0;
  proc.stderr.resume();
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!l) continue;
      const m = JSON.parse(l);
      if (m.id === undefined) { notes.push(m.method); continue; }
      const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); }
    }
  });
  const call = (method, params = {}) => new Promise((res) => { const id = ++n; waiting.set(id, res); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  try {
    const init = await call('initialize', {});
    assert.match(init.result.instructions, /You are 'fable'/);
    assert.match(init.result.instructions, /harness record|model switch/);
    const first = await call('tools/list');
    assert.match(first.result.tools.find((t) => t.name === 'iac_post').description, /as fable/);

    s.append('claude-opus-5');                       // the user ran /model mid-session
    const second = await call('tools/list');
    assert.match(second.result.tools.find((t) => t.name === 'iac_post').description, /as opus/);
    assert.ok(notes.includes('notifications/tools/list_changed'), 'a client caching the old list is told it moved');
    assert.match((await call('initialize', {})).result.instructions, /You are 'opus'/);

    s.append('gpt-5-turbo');                          // nothing claims this model
    const third = await call('tools/list');
    assert.deepEqual(third.result.tools.map((t) => t.name).sort(), ['iac_doctor', 'iac_list', 'iac_show', 'iac_verify', 'iac_waiting']);
    const denied = await call('tools/call', { name: 'iac_post', arguments: { thread: 't-000000', body: 'x' } });
    assert.match(denied.error.message, /needs an identity/);
  } finally { proc.kill(); }
});

function fakeCodexSession({ model = 'gpt-6-sol', id = `codex-${Math.random().toString(16).slice(2)}`, root } = {}) {
  const home = root || fs.mkdtempSync(path.join(os.tmpdir(), 'iac-codex-'));
  const codex = path.join(home, '.codex'); const dir = path.join(codex, 'sessions', '2026', '09', '26');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-26T12-00-00-${id}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id, session_id: id, cwd: process.cwd() } }) + '\n');
  const append = (next) => fs.appendFileSync(file, JSON.stringify({ type: 'turn_context', payload: { model: next, cwd: process.cwd() } }) + '\n');
  append(model);
  return { home, codex, id, file, append, env: { HOME: home, USERPROFILE: home, CODEX_HOME: codex, CODEX_SESSION_ID: id, CODEX_THREAD_ID: id } };
}

function codexHookRun(env, input, ...args) {
  const bin = path.join(import.meta.dirname, '..', 'bin', 'iac.js');
  return spawnSync(process.execPath, [bin, 'codex-hook', ...args], { env, input, encoding: 'utf8', timeout: 10_000 });
}

test('Codex MCP is read-only by design: its ids are the server env, not the calling task', async () => {
  const { a, home } = fresh(); a.setFamilyModels('sol', ['gpt-6-sol']); a.setFamilyModels('astra', ['gpt-6-astra']);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-codex-mcp-'));
  const parent = fakeCodexSession({ id: 'parent', model: 'gpt-6-astra', root });
  const child = fakeCodexSession({ id: 'child', model: 'gpt-6-sol', root });
  const rootOnly = { ...parent.env, CODEX_THREAD_ID: '' };
  assert.equal(new Agora(home, { env: rootOnly }).identity().agent, null, 'the CLI/API has no root SESSION fallback either');
  const cases = [
    { env: rootOnly },
    { env: { ...rootOnly, IAC_AGENT: 'astra' } },
    { env: rootOnly, forced: 'astra' },
    { env: { ...rootOnly, CODEX_SESSION_ID: '' }, plain: true },
    // Even a THREAD with a valid, attesting rollout: a Codex started inside another Codex shell
    // forwards the outer process's ids to this server, so they cannot prove the caller.
    { env: { ...child.env, CODEX_SESSION_ID: parent.id }, threaded: true },
    { env: { ...child.env, CODEX_SESSION_ID: '' }, threaded: true },
    { env: { ...child.env, IAC_AGENT: 'sol' }, threaded: true },
    { env: child.env, forced: 'sol', threaded: true },
  ];
  for (const entry of cases) {
    const module = new URL('../src/mcp.js', import.meta.url).href;
    const program = `import { startMcp } from ${JSON.stringify(module)}; startMcp({ home: process.env.IAC_HOME, agent: ${JSON.stringify(entry.forced)} });`;
    const proc = spawn(process.execPath, ['--input-type=module', '-e', program], { env: { ...process.env,
      IAC_AGENT: '', IAC_INSTANCE: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '', ...entry.env, IAC_HOME: home } });
    let buffer = ''; let n = 0; const pending = new Map(); proc.stderr.resume(); proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buffer += chunk; let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue;
        const message = JSON.parse(line); const done = pending.get(message.id);
        if (done) { pending.delete(message.id); done(message); }
      }
    });
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++n; const timeout = setTimeout(() => reject(new Error('Codex MCP regression timed out')), 10_000);
      pending.set(id, (result) => { clearTimeout(timeout); resolve(result); });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    try {
      const initialized = await call('initialize'); const listed = await call('tools/list');
      {
        const instructions = initialized.result.instructions;
        assert.doesNotMatch(instructions, /You are '/);
        if (!entry.plain) {
          assert.match(instructions, /READ-ONLY for Codex by design/);
          assert.ok(instructions.includes(`node "${a.paths().cli}" --home "${home}" post <thread>`), 'names the exact absolute CLI write command');
        }
        if (entry.threaded) assert.match(instructions, /MCP server's own environment/);
        // anchored on content, not a character offset: install paths vary in length (CI vs local)
        assert.match(instructions, /^inter-agent-comms MCP is READ-ONLY/);
        assert.match(instructions, /READ-ONLY.*whoami --json.*exact task and current model/s);
        assert.doesNotMatch(instructions, /pass --as/);
        assert.ok(instructions.includes(a.paths().cli), 'MCP names its actual CLI install');
        assert.ok(instructions.includes(`--home "${home}"`), 'MCP names its actual store');
        if (entry.env.CODEX_SESSION_ID && !entry.threaded) assert.match(instructions, /no current CODEX_THREAD_ID/);
        assert.deepEqual(listed.result.tools.map((tool) => tool.name).sort(), ['iac_doctor', 'iac_list', 'iac_show', 'iac_verify', 'iac_waiting']);
        for (const name of ['iac_open', 'iac_post', 'iac_ack', 'iac_clear_wait', 'iac_close', 'iac_brief', 'iac_inbox']) {
          const denied = await call('tools/call', { name, arguments: { title: 'root impersonation', thread: 't-000000', body: 'x', project: 'o/r' } });
          assert.equal(denied.error.code, -32602, name); assert.match(denied.error.message, /whoami --json/);
          assert.doesNotMatch(denied.error.message, /pass --as/);
          assert.ok(denied.error.message.includes(a.paths().cli)); assert.ok(denied.error.message.includes(`--home "${home}"`));
          if (!entry.plain) {
            assert.match(denied.error.message, /not available over Codex MCP, which is read-only by design/);
            assert.ok(denied.error.message.includes(`node "${a.paths().cli}" --home "${home}" post <thread>`), 'the refusal names the CLI write command');
          }
        }
        const read = await call('tools/call', { name: 'iac_list', arguments: {} });
        assert.equal(read.result.content[0].text, '(no threads)', 'reads keep working');
      }
    } finally { proc.kill(); }
  }
  assert.equal(a.threads().length, 0, 'no Codex MCP transport can create posts');
  // The CLI route the refusal points at still works: its shell env is the task's own.
  const bin = path.join(import.meta.dirname, '..', 'bin', 'iac.js');
  const cli = spawnSync(process.execPath, [bin, '--home', home, 'open', '--title', 'via CLI', '--body', 'x', '--project', 'o/r', '--json'],
    { env: { PATH: process.env.PATH, ...child.env, CODEX_SESSION_ID: parent.id }, encoding: 'utf8', timeout: 10_000 });
  assert.equal(cli.status, 0, cli.stderr);
  a.store.invalidate();   // the CLI wrote in another process
  const [only] = a.threads();
  assert.deepEqual([only.posts[0].author, only.posts[0].instance], ['sol', 'sol-child'], 'CLI writes as the shell task');
});

function mcpClient(env, forced) {
  const module = new URL('../src/mcp.js', import.meta.url).href;
  const program = `import { startMcp } from ${JSON.stringify(module)}; startMcp({ home: process.env.IAC_HOME, agent: ${JSON.stringify(forced)} });`;
  const proc = spawn(process.execPath, ['--input-type=module', '-e', program], { env: { PATH: process.env.PATH, ...env } });
  let buffer = ''; let n = 0; const pending = new Map(); proc.stderr.resume(); proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buffer += chunk; let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue;
      const message = JSON.parse(line); const done = pending.get(message.id);
      if (done) { pending.delete(message.id); done(message); }
    }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++n; const timeout = setTimeout(() => reject(new Error(`MCP ${method} timed out`)), 10_000);
    pending.set(id, (result) => { clearTimeout(timeout); resolve(result); });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { call, kill: () => proc.kill() };
}

test('a Codex MCP client is read-only whatever its env; Claude Code clients are unchanged', async () => {
  const { a, home } = fresh(); a.setFamilyModels('sol', ['gpt-6-sol']);
  const opened = await new Agora(home, { env: {} }).open({ as: 'ada', project: 'o/r', title: 'need sol', body: 'please review', waitingOn: ['sol'] }); // real clock: a live wait
  const claude = fakeSession({ models: ['claude-fable-5-1'] });
  const codex = fakeCodexSession({ id: 'outer', model: 'gpt-6-sol' });
  const codexInit = { protocolVersion: '2025-06-18', clientInfo: { name: 'codex-mcp-client', version: '0.160.1' } };
  const claudeInit = { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code', version: '2.1.0' } };
  const base = { IAC_HOME: home, IAC_PROJECT: 'o/r' };
  const cases = [
    { name: 'Codex client, no env_vars, static IAC_AGENT', env: { ...base, HOME: claude.home, IAC_AGENT: 'sol' }, init: codexInit, writable: false },
    { name: 'Codex client, forced --agent', env: { ...base, HOME: claude.home }, forced: 'sol', init: codexInit, writable: false },
    { name: 'Codex client, Claude + Codex ids + IAC_AGENT', env: { ...base, ...claude.env, CODEX_THREAD_ID: codex.id, CODEX_HOME: codex.codex, IAC_AGENT: 'sol' }, init: codexInit, writable: false },
    { name: 'Codex client, Claude ids only', env: { ...base, ...claude.env }, init: { clientInfo: { name: 'Codex' } }, writable: false },
    { name: 'Claude Code client, Claude ids', env: { ...base, ...claude.env }, init: claudeInit, writable: 'fable' },
    { name: 'no clientInfo, Claude ids', env: { ...base, ...claude.env }, init: {}, writable: 'fable' },
    { name: 'Claude Code client, ambiguous env + IAC_AGENT (unchanged)', env: { ...base, ...claude.env, CODEX_THREAD_ID: codex.id, CODEX_HOME: codex.codex, IAC_AGENT: 'sol' }, init: claudeInit, writable: 'sol' },
    { name: 'Claude Code client, no identity', env: { ...base, HOME: codex.home }, init: claudeInit, writable: false, plain: true },
  ];
  for (const entry of cases) {
    const c = mcpClient(entry.env, entry.forced);
    try {
      const init = await c.call('initialize', entry.init); const names = (await c.call('tools/list')).result.tools.map((t) => t.name).sort();
      const waiting = await c.call('tools/call', { name: 'iac_waiting', arguments: {} });
      assert.match(waiting.result.content[0].text, new RegExp(`ada → sol in o/r \\(unclaimed\\) · ${opened.thread}`), `${entry.name}: waiting needs no identity`);
      if (entry.writable) {
        assert.match(init.result.instructions, new RegExp(`You are '${entry.writable}'`), entry.name);
        assert.ok(names.includes('iac_post') && names.includes('iac_waiting'), entry.name);
        continue;
      }
      assert.deepEqual(names, ['iac_doctor', 'iac_list', 'iac_show', 'iac_verify', 'iac_waiting'], entry.name);
      const denied = await c.call('tools/call', { name: 'iac_post', arguments: { thread: opened.thread, body: 'x' } });
      assert.equal(denied.error.code, -32602, entry.name);
      if (entry.plain) { assert.match(denied.error.message, /needs an identity/); continue; }
      const instructions = init.result.instructions;
      assert.match(instructions, /^inter-agent-comms MCP is READ-ONLY for Codex by design/, entry.name);
      assert.ok(instructions.indexOf(`node "${a.paths().cli}" --home "${home}" brief first`) < instructions.indexOf('whoami --json'), `${entry.name}: brief comes first`);
      assert.match(instructions, /identifies as Codex/, entry.name);
      assert.match(denied.error.message, /not available over Codex MCP/, entry.name);
      assert.ok(denied.error.message.includes(`node "${a.paths().cli}" --home "${home}" post <thread>`), entry.name);
      // A later initialize naming a different client cannot make the transport writable again.
      await c.call('initialize', claudeInit);
      assert.ok(!(await c.call('tools/list')).result.tools.some((t) => t.name === 'iac_post'), `${entry.name}: Codex is sticky`);
    } finally { c.kill(); }
  }
  assert.equal(a.thread(opened.thread).posts.length, 1, 'no Codex client wrote');
});

// Codex 0.160.1 runs hooks with no CODEX_THREAD_ID/CODEX_SESSION_ID; stdin carries session_id and
// transcript_path. The hook brief adopts that session only when it is the one contained
// rollout and transcript_path is that file, and only for the brief: it never makes a write possible.
test('codex-hook: Codex ids in a hook env are inherited and ignored; only a stdin session that is its own contained rollout drives the read-only brief', async () => {
  const { codexHookSession } = await import('../src/codex-hook.js');
  const { home } = fresh(); const pin = new Agora(home); pin.setFamilyModels('sol', ['gpt-6-sol']); pin.setFamilyHarness('sol', 'codex');
  const opened = await new Agora(home, { env: { IAC_PROJECT: 'global' } }).open({ as: 'ada', title: 'hook env', body: 'x', waitingOn: ['sol'], project: 'global' });
  const s = fakeCodexSession({ model: 'gpt-6-sol' });
  const noIds = { ...process.env, HOME: s.home, USERPROFILE: s.home, CODEX_HOME: s.codex, IAC_HOME: home,
    CODEX_THREAD_ID: '', CODEX_SESSION_ID: '', IAC_AGENT: '', IAC_INSTANCE: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '' };
  const payload = (over = {}) => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: s.id, transcript_path: s.file, cwd: process.cwd(), prompt: 'hi', ...over });

  // The reviewer's captured hook environment: no ids, stdin session + transcript.
  const ok = codexHookRun(noIds, payload());
  assert.equal(ok.status, 0); assert.match(ok.stdout, new RegExp(`^iac\\[sol#sol-${s.id} [^\\]]*\\]: waiting on sol`), 'brief printed, instance from the hook session');
  assert.equal(codexHookSession(JSON.parse(payload()), noIds), s.id);

  // transcript_path must be that same rollout: another file, a missing one, or none is silent.
  const other = fakeCodexSession({ model: 'gpt-6-sol', root: s.home });
  const decoy = path.join(s.home, 'decoy.jsonl'); fs.copyFileSync(s.file, decoy);
  for (const transcript_path of [other.file, decoy, path.join(s.codex, 'nope.jsonl'), undefined, 7]) {
    const r = codexHookRun(noIds, payload({ transcript_path }));
    assert.deepEqual([r.status, r.stdout], [0, ''], `transcript_path ${transcript_path} is not the session's rollout`);
  }
  // A session id with two rollouts cannot say which is live.
  const dup = path.join(s.codex, 'sessions', '2026', '09', '27'); fs.mkdirSync(dup, { recursive: true });
  const twin = path.join(dup, path.basename(s.file).replace('2026-09-26', '2026-09-27')); fs.copyFileSync(s.file, twin);
  assert.deepEqual([codexHookRun(noIds, payload()).stdout, codexHookRun(noIds, payload({ transcript_path: twin })).stdout], ['', ''], 'duplicate rollouts: silent');
  fs.rmSync(twin);
  assert.match(codexHookRun(noIds, payload()).stdout, /waiting on sol/, 'unique again: briefs again');

  // A relative CODEX_HOME attests nothing, whatever stdin says.
  // a literal relative path: path.relative across drives (Windows CI: D: checkout, C: temp) is absolute
  const rel = path.join('relative', '.codex');
  assert.equal(codexHookRun({ ...noIds, CODEX_HOME: rel }, payload()).stdout, '', 'relative CODEX_HOME: silent');
  assert.equal(codexHookSession(JSON.parse(payload()), { ...noIds, CODEX_HOME: rel }), null);

  // Codex ids in a hook's env are inherited (Codex sets none for hooks): ignored either way.
  // The hook's own valid stdin session briefs; an invalid one is silent even with env ids.
  for (const inherited of [{ CODEX_THREAD_ID: other.id }, { CODEX_SESSION_ID: other.id }, { CODEX_THREAD_ID: other.id, CODEX_SESSION_ID: other.id }, { CODEX_SESSION_ID: s.id }]) {
    assert.equal(codexHookSession(JSON.parse(payload()), { ...noIds, ...inherited }), s.id);
    const r = codexHookRun({ ...noIds, ...inherited }, payload());
    assert.equal(r.status, 0); assert.match(r.stdout, new RegExp(`^iac\\[sol#sol-${s.id} `), `inherited ${JSON.stringify(inherited)} ignored; stdin session briefs`);
    for (const bad of [{ transcript_path: other.file }, { session_id: 'nope', transcript_path: undefined }, { session_id: undefined, transcript_path: undefined }]) {
      assert.deepEqual([codexHookRun({ ...noIds, ...inherited, CODEX_THREAD_ID: inherited.CODEX_THREAD_ID || s.id }, payload(bad)).stdout], [''], `invalid stdin ${JSON.stringify(bad)}: silent despite env ids`);
    }
  }

  // The nested case: Codex started from an outer sol task's shell inherits CODEX_THREAD_ID=outer.
  // The inner luna task's hook must brief luna from its own stdin session, never the outer sol.
  { const luna = new Agora(home); luna.addAgent('luna', 'agent', { models: ['gpt-6-luna'], harness: 'codex' });
    await new Agora(home, { env: { IAC_PROJECT: 'global' } }).open({ as: 'ada', title: 'for luna', body: 'x', waitingOn: ['luna'], project: 'global' });
    const inner = fakeCodexSession({ model: 'gpt-6-luna', root: s.home });
    const nested = codexHookRun({ ...noIds, CODEX_THREAD_ID: s.id, CODEX_SESSION_ID: s.id }, payload({ session_id: inner.id, transcript_path: inner.file }));
    assert.equal(nested.status, 0);
    assert.match(nested.stdout, new RegExp(`^iac\\[luna#luna-${inner.id} [^\\]]*\\]: waiting on luna`), 'the inner task is briefed as itself');
    assert.doesNotMatch(nested.stdout, /sol/, 'never as the outer task'); }

  // Only the brief: the same environment still has no identity, and the CLI refuses to write.
  assert.equal(new Agora(home, { env: noIds }).identity().agent, null, 'the hook adoption is not an identity');
  const post = spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'bin', 'iac.js'), 'post', opened.thread, '--body', 'x'], { env: noIds, input: payload(), encoding: 'utf8', timeout: 10_000 });
  assert.notEqual(post.status, 0); assert.match(post.stderr, /no identity/);
  assert.equal(new Agora(home).thread(opened.thread).posts.length, 1, 'nothing was written');
});

test('Codex identity comes from its contained rollout; hook JSON cannot select a family (H1)', async () => {
  const { a, home } = fresh(); a.setFamilyModels('sol', ['gpt-6-sol']); a.setFamilyModels('astra', ['gpt-6-astra']);
  const s = fakeCodexSession({ model: 'gpt-6-sol' });
  const env = { ...process.env, ...s.env, IAC_HOME: home, IAC_AGENT: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '' };
  let id = new Agora(home, { env }).identity();
  assert.deepEqual([id.agent, id.model, id.session, id.source], ['sol', 'gpt-6-sol', s.id, 'harness']);
  const forged = codexHookRun(env, JSON.stringify({ session_id: 'victim', hook_event_name: 'UserPromptSubmit', model: 'claude-opus-5', cwd: process.cwd() }));
  assert.deepEqual([forged.status, forged.stderr], [0, '']);
  id = new Agora(home, { env }).identity();
  assert.deepEqual([id.agent, id.model, id.session], ['sol', 'gpt-6-sol', s.id], 'stdin never becomes identity authority');
  s.append('gpt-6-astra');
  assert.equal(new Agora(home, { env }).identity().agent, 'astra', 'the next rollout turn follows /model');
  const stale = codexHookRun({ ...env, IAC_AGENT: 'sol' }, JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: s.id, transcript_path: s.file, cwd: process.cwd() }));
  assert.deepEqual([stale.status, stale.stdout, stale.stderr], [0, 'iac: identity conflict (stale-binding) — run iac whoami\n', '']);

  const mismatched = fakeCodexSession({ id: 'filename-id', model: 'gpt-6-astra' });
  fs.writeFileSync(mismatched.file, JSON.stringify({ type: 'session_meta', payload: { id: 'different-id' } }) + '\n'
    + JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-astra' } }) + '\n');
  assert.equal(new Agora(home, { env: mismatched.env }).identity().agent, null, 'filename alone cannot attest a rollout for another session');
});

test('forged hook session cannot change wait ownership or bypass instance-override (H2)', async () => {
  const { a, home } = fresh(); a.setFamilyModels('sol', ['gpt-6-sol']);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-codex-shared-'));
  const victim = fakeCodexSession({ id: 'victim', root }); const attacker = fakeCodexSession({ id: 'attacker', root });
  const mine = new Agora(home, { env: victim.env });
  const opened = await mine.open({ as: 'sol', project: 'o/r', title: 'owned by victim', body: 'x', waitingOn: ['fable'] });
  const attackerEnv = { ...process.env, ...attacker.env, IAC_HOME: home, IAC_AGENT: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '' };
  codexHookRun(attackerEnv, JSON.stringify({ session_id: 'victim', hook_event_name: 'UserPromptSubmit', model: 'gpt-6-sol' }));
  const other = new Agora(home, { env: attackerEnv });
  assert.equal(other.identity().session, 'attacker');
  await rejects(other.clearWait({ as: 'sol', thread: opened.thread }), 'not-wait-owner');
  await rejects(other.clearWait({ as: 'sol', thread: opened.thread, instance: 'sol-victim' }), 'instance-override');
});

// This open-stdin kill timer is the same risk as the brief --hook one above (a real
// subprocess, bounded by codex-hook's own internal stdin-wait timer plus real process
// start/scheduling overhead), so it is tied to CODEX_HOOK_STDIN_MS with the same generous
// headroom rather than a bare number.
test('Codex hook is bounded, fail-open, silent on bad input, and never creates a store (H3/M1)', { timeout: 60_000 }, async () => {
  const { CODEX_HOOK_STDIN_MS } = await import('../src/codex-hook.js');
  const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'iac-hook-missing-')), 'store');
  const env = { ...process.env, IAC_HOME: missing, IAC_AGENT: '', CODEX_SESSION_ID: '', CODEX_THREAD_ID: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '' };
  for (const input of ['', '{', 'x'.repeat(70 * 1024), JSON.stringify({ hook_event_name: 'Nope', model: 'gpt-6-sol' })]) {
    const r = codexHookRun(env, input, '--unknown-flag');
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
  }
  assert.equal(fs.existsSync(missing), false, 'advisory hook does not initialise IAC_HOME');

  const bin = path.join(import.meta.dirname, '..', 'bin', 'iac.js');
  const result = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [bin, 'codex-hook'], { env, stdio: ['pipe', 'pipe', 'pipe'] }); let out = ''; let err = '';
    p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
    const kill = setTimeout(() => { p.kill(); reject(new Error('hook hung on open stdin')); }, CODEX_HOOK_STDIN_MS + 25_000);
    p.on('exit', (code) => { clearTimeout(kill); p.stdin.destroy(); resolve({ code, out, err }); });
    p.stdin.write('{');
  });
  assert.deepEqual(result, { code: 0, out: '', err: '' });
});

test('Codex uses its own CODEX_THREAD_ID rollout; root session cannot take over a child (H4)', () => {
  const { a, home } = fresh(); a.setFamilyModels('sol', ['gpt-6-sol']); a.setFamilyModels('astra', ['gpt-6-astra']);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-codex-nested-'));
  const parent = fakeCodexSession({ model: 'gpt-6-astra', id: 'parent', root });
  const child = fakeCodexSession({ model: 'gpt-6-sol', id: 'child', root });
  const nested = new Agora(home, { env: { ...child.env, CODEX_SESSION_ID: parent.id } });
  assert.deepEqual([nested.identity().agent, nested.identity().session], ['sol', 'child']);
  const noChild = new Agora(home, { env: { ...child.env, CODEX_THREAD_ID: 'missing', CODEX_SESSION_ID: parent.id } });
  assert.equal(noChild.identity().agent, null, 'no fallback to the parent thread rollout');
  assert.equal(noChild.identity().session, 'missing');
  // A child that only had the root SESSION would otherwise resolve as the root: no fallback.
  const rootOnly = new Agora(home, { env: { ...parent.env, CODEX_THREAD_ID: '' } });
  assert.deepEqual([rootOnly.identity().agent, rootOnly.identity().session, rootOnly.identity().rootOnly], [null, null, true]);
});

test('a Codex child cannot withdraw its root task wait, even in the same family', async () => {
  const { a, home } = fresh(); a.setFamilyModels('sol', ['gpt-6-sol']);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-codex-root-wait-'));
  const parentSession = fakeCodexSession({ id: 'parent', root });
  const childSession = fakeCodexSession({ id: 'child', root });
  const parent = new Agora(home, { env: parentSession.env });
  const child = new Agora(home, { env: { ...childSession.env, CODEX_SESSION_ID: parentSession.id } });
  const opened = await parent.open({ as: 'sol', project: 'o/r', title: 'root-owned wait', body: 'need review', waitingOn: ['fable'] });
  assert.equal(a.thread(opened.thread).posts[0].instance, 'sol-parent');
  await rejects(child.clearWait({ as: 'sol', thread: opened.thread }), 'not-wait-owner');
  await rejects(child.clearWait({ as: 'sol', thread: opened.thread, instance: 'sol-parent' }), 'instance-override');
  assert.equal(a.waitingBoard({ on: 'fable' }).length, 1);
  await parent.clearWait({ as: 'sol', thread: opened.thread });
  assert.equal(a.waitingBoard({ on: 'fable' }).length, 0);
});

test('Codex model switches survive long turns, oversized lines and chunk boundaries', async () => {
  const { lastCodexModel } = await import('../src/codex-hook.js');
  const { a, home } = fresh(); a.setFamilyModels('sol', ['gpt-6-sol']); a.setFamilyModels('astra', ['gpt-6-astra']);
  const s = fakeCodexSession();
  fs.appendFileSync(s.file, JSON.stringify({ type: 'response_item', payload: 'x'.repeat(700 * 1024) }) + '\n');
  assert.equal(new Agora(home, { env: s.env }).identity().agent, 'sol', 'an initial long turn still has a model');
  s.append('gpt-6-astra');
  fs.appendFileSync(s.file, JSON.stringify({ type: 'response_item', payload: '🙂'.repeat(300 * 1024) }) + '\r\n');
  // A context larger than a scan chunk must be reassembled; response models are irrelevant.
  fs.appendFileSync(s.file, JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-astra', padding: 'x'.repeat(90 * 1024) } }) + '\r\n');
  const response = JSON.stringify({ type: 'response_item', payload: { model: 'gpt-6-sol', text: 'x'.repeat(4096) } }) + '\n';
  fs.appendFileSync(s.file, response.repeat(160));
  fs.appendFileSync(s.file, '\n\r\n');
  assert.equal(lastCodexModel(s.file), 'gpt-6-astra');
  assert.deepEqual([new Agora(home, { env: s.env }).identity().agent, new Agora(home, { env: s.env }).identity().model], ['astra', 'gpt-6-astra']);
  const first = path.join(s.home, 'first-line.jsonl');
  fs.writeFileSync(first, JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-sol' } }));
  assert.equal(lastCodexModel(first), null, 'a lone record with no newline is still being appended');
  fs.appendFileSync(first, '\n');
  assert.equal(lastCodexModel(first), 'gpt-6-sol', 'a newline-terminated first record is supported');
});

test('a newline-terminated malformed latest Codex record cannot revive an older model', async () => {
  const { lastCodexModel } = await import('../src/codex-hook.js');
  const { a, home } = fresh(); a.setFamilyModels('sol', ['gpt-6-sol']); a.setFamilyModels('astra', ['gpt-6-astra']);
  const s = fakeCodexSession(); const initial = fs.readFileSync(s.file);
  for (const latest of ['{"type":"turn_context","payload":{"model":"gpt-6-astra"\n', '{broken}\n', '{"type":"turn_context","payload":{"model":42}}\n']) {
    fs.writeFileSync(s.file, initial); fs.appendFileSync(s.file, latest);
    assert.equal(lastCodexModel(s.file), null);
    const id = new Agora(home, { env: s.env }).identity();
    assert.equal(id.agent, null);
    assert.match(id.reason, /newest complete record .* is unparseable or names an invalid model.*fail closed/, 'the reason says why, not "names no model yet"');
    assert.doesNotMatch(id.reason, /names no model yet/);
    assert.match(id.todo, /retry after the next prompt/);
    await rejects(new Agora(home, { env: s.env }).open({ as: 'sol', project: 'o/r', title: 't', body: 'x' }), 'unattested-identity');
  }
});

test('an in-flight final Codex fragment (no trailing newline) is skipped, not fatal', async () => {
  const { lastCodexModel, scanCodexModel } = await import('../src/codex-hook.js');
  const { a, home } = fresh(); a.setFamilyModels('sol', ['gpt-6-sol']); a.setFamilyModels('astra', ['gpt-6-astra']);
  const s = fakeCodexSession({ model: 'gpt-6-sol' }); const initial = fs.readFileSync(s.file);
  const response = JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(200) } });
  const fragments = [
    response.slice(0, 50),                                                     // a small record part-way out
    '{"type":"response_item","payload":"' + 'y'.repeat(300 * 1024),          // a large record, past MAX_RECORD and many chunks
    '{"type":"turn_context","payload":{"model":"gpt-6-astra"',                 // the next context itself, half-written
    response,                                                                  // complete JSON, newline not yet written
    '{broken',
  ];
  for (const fragment of fragments) {
    fs.writeFileSync(s.file, initial); fs.appendFileSync(s.file, response + '\n'); fs.appendFileSync(s.file, fragment);
    assert.deepEqual(scanCodexModel(s.file), { model: 'gpt-6-sol', problem: null }, `fragment of ${fragment.length} bytes`);
    const id = new Agora(home, { env: s.env }).identity();
    assert.deepEqual([id.agent, id.model], ['sol', 'gpt-6-sol'], 'identity survives the append window');
  }
  // Once the record lands with its newline, it is read normally.
  fs.writeFileSync(s.file, initial); fs.appendFileSync(s.file, '{"type":"turn_context","payload":{"model":"gpt-6-astra"');
  assert.equal(lastCodexModel(s.file), 'gpt-6-sol');
  fs.appendFileSync(s.file, ',"cwd":"/x"}}\n');
  assert.equal(lastCodexModel(s.file), 'gpt-6-astra');
  // A fragment never hides a newline-terminated invalid record behind it.
  fs.writeFileSync(s.file, initial); fs.appendFileSync(s.file, '{broken}\n' + response.slice(0, 50));
  assert.deepEqual(scanCodexModel(s.file), { model: null, problem: 'invalid-record' });
  // An only-fragment rollout (Codex has written nothing complete) names no model yet.
  fs.writeFileSync(s.file, initial.subarray(0, initial.indexOf(10)));
  assert.deepEqual(scanCodexModel(s.file), { model: null, problem: null });
  const none = new Agora(home, { env: s.env }).identity();
  assert.equal(none.agent, null);
});

test('the latest complete Codex context fails read-only for invalid models instead of reviving an old family', async () => {
  const { lastCodexModel } = await import('../src/codex-hook.js');
  const { a, home } = fresh(); a.setFamilyModels('sol', ['gpt-6-sol']);
  const s = fakeCodexSession(); const initial = fs.readFileSync(s.file);
  for (const model of [undefined, null, 42, '', ' ', 'gpt-6-sol\n', 'x'.repeat(257), 'x'.repeat(300 * 1024)]) {
    fs.writeFileSync(s.file, initial);
    fs.appendFileSync(s.file, JSON.stringify({ type: 'turn_context', payload: { model } }) + '\n');
    assert.equal(lastCodexModel(s.file), null, `invalid latest model ${typeof model}`);
    assert.equal(new Agora(home, { env: s.env }).identity().agent, null);
  }
  fs.writeFileSync(s.file, initial); s.append('gpt-unknown');
  assert.equal(lastCodexModel(s.file), 'gpt-unknown', 'unknown strings remain the current model');
  assert.equal(new Agora(home, { env: s.env }).identity().agent, null);
  fs.writeFileSync(s.file, initial);
  fs.appendFileSync(s.file, JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-sol', padding: 'x'.repeat(300 * 1024) } }) + '\n');
  assert.equal(lastCodexModel(s.file), 'gpt-6-sol', 'oversized contexts are classified without retaining their padding');
  // JSON duplicate keys follow the final value, including when a huge response masks a context.
  fs.appendFileSync(s.file, '{"type":"response_item","payload":{"padding":"' + 'x'.repeat(300 * 1024)
    + '","model":42},"type":"turn_context"}\n');
  assert.equal(lastCodexModel(s.file), null);
});

test('Codex scan stops read-only at its 64 MiB bound and on unclassifiable oversized records', async () => {
  const { lastCodexModel } = await import('../src/codex-hook.js');
  const s = fakeCodexSession();
  fs.appendFileSync(s.file, '{"type":"response_item","payload":"' + 'x'.repeat(300 * 1024) + '\n');
  assert.equal(lastCodexModel(s.file), null, 'an incomplete large record might be a context');
  const fd = fs.openSync(s.file, 'w');
  try {
    const context = JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-sol' } }) + '\n';
    fs.writeSync(fd, context, 0, 'utf8');
    fs.ftruncateSync(fd, context.length + 64 * 1024 * 1024 + 1);
  } finally { fs.closeSync(fd); }
  assert.equal(lastCodexModel(s.file), null, 'a context outside the bounded scan cannot attest identity');
});

test('Codex rejects missing, malformed, mismatched and duplicate task records without root fallback', async () => {
  const { a, home } = fresh(); a.setFamilyModels('sol', ['gpt-6-sol']);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-codex-bad-id-'));
  const parent = fakeCodexSession({ id: 'root', root }); const child = fakeCodexSession({ id: 'child', root });
  const childEnv = { ...child.env, CODEX_SESSION_ID: parent.id };
  for (const task of ['absent', '../../root', ' ', 42]) {
    const env = { ...childEnv, CODEX_THREAD_ID: task };
    const unknown = new Agora(home, { env });
    assert.equal(unknown.identity().agent, null);
    await rejects(unknown.open({ as: 'sol', project: 'o/r', title: 'invalid child', body: 'x' }), 'unattested-identity');
  }
  const meta = (payload) => JSON.stringify({ type: 'session_meta', payload }) + '\n'
    + JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-sol' } }) + '\n';
  for (const payload of [{ session_id: child.id }, { id: parent.id, session_id: child.id }, { id: 42 }, null]) {
    fs.writeFileSync(child.file, meta(payload));
    assert.equal(new Agora(home, { env: childEnv }).identity().agent, null, 'session_meta.id alone establishes task ownership');
  }
  fs.writeFileSync(child.file, '{"type":"session_meta","payload":\n');
  assert.equal(new Agora(home, { env: childEnv }).identity().agent, null);
  fs.writeFileSync(child.file, meta({ id: child.id, session_id: parent.id }));
  assert.equal(new Agora(home, { env: childEnv }).identity().agent, 'sol', 'a differing metadata session_id is the root, not a mismatch');
  const duplicate = path.join(path.dirname(child.file), `rollout-other-${child.id}.jsonl`);
  fs.copyFileSync(child.file, duplicate);
  assert.equal(new Agora(home, { env: childEnv }).identity().agent, null, 'a second matching rollout invalidates even a previously resolved path');
});

test('harness attestation never maps a model from the other provider, including broad configured globs', () => {
  const { a, home } = fresh(); a.setFamilyModels('sol', ['*']);
  const codex = fakeCodexSession({ model: 'claude-fable-5-1' });
  const claude = fakeSession({ models: ['gpt-6-sol'] });
  for (const env of [codex.env, claude.env]) {
    const id = new Agora(home, { env }).identity();
    assert.deepEqual([id.agent, id.family, id.source], [null, null, null]);
    assert.match(id.reason, /cannot be attested/);
  }
  const ambiguous = new Agora(home, { env: { ...claude.env, CODEX_THREAD_ID: codex.id, CODEX_HOME: codex.codex } }).identity();
  assert.equal(ambiguous.harness, 'ambiguous', 'THREAD alone detects a nested Codex harness');
});

test('an unattested Codex session is read-only; --as cannot replace a missing or unknown rollout identity', async () => {
  const { resolveIdentity } = await import('../src/api.js');
  const { a, home } = fresh(); a.setFamilyModels('sol', ['gpt-6-sol']);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-codex-empty-'));
  const missingEnv = { HOME: empty, USERPROFILE: empty, CODEX_HOME: path.join(empty, '.codex'), CODEX_SESSION_ID: 'missing', CODEX_THREAD_ID: 'missing' };
  const missing = new Agora(home, { env: missingEnv });
  assert.equal(missing.identity().agent, null);
  throwsRejected(() => resolveIdentity({ explicit: 'sol', env: missingEnv, config: a.config(), registry: a.registry() }), 'identity-override');
  await rejects(missing.open({ as: 'sol', project: 'o/r', title: 'forged fallback', body: 'x' }), 'unattested-identity');

  const unknownSession = fakeCodexSession({ model: 'gpt-unknown' });
  const unknown = new Agora(home, { env: unknownSession.env });
  assert.match(unknown.identity().reason, /matches no family/);
  throwsRejected(() => resolveIdentity({ explicit: 'sol', env: unknownSession.env, config: a.config(), registry: a.registry() }), 'identity-override');
  await rejects(unknown.open({ as: 'sol', project: 'o/r', title: 'unknown fallback', body: 'x' }), 'unattested-identity');
  assert.equal(a.threads().length, 0);

  const launched = new Agora(home, { env: { ...missingEnv, IAC_AGENT: 'sol', IAC_INSTANCE: 'sol-launched' } });
  const opened = await launched.open({ as: 'sol', project: 'o/r', title: 'trusted launcher', body: 'x' });
  assert.equal(a.thread(opened.thread).posts[0].idSource, 'launcher');
});

test('Codex tasks cannot forge sibling instances on open, ack, or resolution posts', async () => {
  const { a, home } = fresh(); a.setFamilyModels('sol', ['gpt-6-sol']);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-codex-instances-'));
  const victimSession = fakeCodexSession({ id: 'victim', root });
  const siblingSession = fakeCodexSession({ id: 'sibling', root });
  const victim = new Agora(home, { env: victimSession.env });
  const sibling = new Agora(home, { env: siblingSession.env });
  const owned = await victim.open({ as: 'sol', project: 'o/r', title: 'victim thread', body: 'x' });

  await rejects(sibling.open({ as: 'sol', project: 'o/r', title: 'quota bypass', body: 'x', instance: 'sol-victim' }), 'instance-override');
  await rejects(sibling.post({ as: 'sol', thread: owned.thread, kind: 'resolution', body: 'forged close', instance: 'sol-victim' }), 'instance-override');
  assert.equal(a.thread(owned.thread).closed, false);

  const asked = await a.open({ as: 'fable', project: 'o/r', title: 'wait claim', body: 'need sol', waitingOn: ['sol'] });
  await rejects(sibling.post({ as: 'sol', thread: asked.thread, kind: 'ack', body: 'forged claim', instance: 'sol-victim' }), 'instance-override');
  assert.equal(a.waitingBoard({ on: 'sol' }).find((w) => w.thread === asked.thread).claimedBy, null);
});

test('Codex started from a Claude shell is ambiguous and read-only (H5)', async () => {
  const { a, home } = fresh(); a.setFamilyModels('sol', ['gpt-6-sol']);
  const codex = fakeCodexSession({ model: 'gpt-6-sol' }); const claude = fakeSession({ models: ['claude-fable-5-1'] });
  const env = { ...codex.env, ...claude.env, CODEX_HOME: codex.codex, CODEX_SESSION_ID: codex.id };
  const nested = new Agora(home, { env }); const id = nested.identity();
  assert.equal(id.agent, null); assert.equal(id.harness, 'ambiguous'); assert.match(id.reason, /both Claude and Codex/);
  await rejects(nested.open({ as: 'fable', project: 'o/r', title: 'wrong parent', body: 'x' }), 'identity-conflict');
  assert.equal(a.threads().length, 0);
  const bound = new Agora(home, { env: { ...env, IAC_AGENT: 'sol' } });
  await bound.open({ as: 'sol', project: 'o/r', title: 'explicit launcher resolves ambiguity', body: 'x' });
  assert.equal(a.threads().length, 1);
});

test('CLI Codex UserPromptSubmit hook prints a rollout-derived scoped brief', async () => {
  const { a, home } = fresh(); a.setFamilyModels('sol', ['gpt-6-sol']);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-codex-cwd-')); const project = `local:${path.basename(cwd)}`;
  const live = new Agora(home, { env: {} });
  const opened = await live.open({ as: 'fable', project, title: 'Need Codex', body: 'please inspect', waitingOn: ['sol'] });
  const s = fakeCodexSession({ model: 'gpt-6-sol' });
  const env = { ...process.env, ...s.env, IAC_HOME: home, IAC_AGENT: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '' };
  const forged = codexHookRun(env, JSON.stringify({ session_id: 'forged', hook_event_name: 'UserPromptSubmit', model: 'gpt-unknown', cwd }));
  assert.deepEqual([forged.status, forged.stdout, forged.stderr], [0, '', ''], 'a session with no rollout of its own briefs nothing, whatever env ids say');
  const r = codexHookRun(env, JSON.stringify({ session_id: s.id, transcript_path: s.file, hook_event_name: 'UserPromptSubmit', model: 'gpt-unknown', cwd }));
  assert.deepEqual([r.status, r.stderr], [0, '']); assert.match(r.stdout, new RegExp(`^iac\\[sol#sol-${s.id}.*${opened.thread}`), 'the stdin model field is ignored; the rollout names it');
});

test('quoteWinArg quotes for cmd.exe + MSVCRT so args with spaces survive', () => {
  assert.equal(quoteWinArg('exec'), '^"exec^"');
  assert.equal(quoteWinArg('Sol review: long text'), '^"Sol^ review:^ long^ text^"');
  assert.equal(quoteWinArg('say "hi"'), '^"say^ \\^"hi\\^"^"');
  assert.equal(quoteWinArg('a\\"b'), '^"a\\\\\\^"b^"');            // a\"b -> "a\\\"b"
  assert.equal(quoteWinArg('C:\\dir\\'), '^"C:\\dir\\\\^"');        // trailing backslash doubled
  assert.equal(quoteWinArg('a&b|c<d>e'), '^"a^&b^|c^<d^>e^"');
  assert.equal(quoteWinArg('%PATH%!x!^'), '^"^%%cd:~,%PATH^%%cd:~,%^!x^!^^^"');   // percent guard
  assert.equal(quoteWinArg(''), '^"^"');
  assert.equal(quoteWinArg('a&b', true), '^^^"a^^^&b^^^"');         // .cmd shims re-parse %*
});

test('winCommandLine double-escapes only for batch shims', () => {
  const env = { PATH: 'C:\\bin', PATHEXT: '.EXE;.CMD' };
  const exists = (f) => f.toLowerCase() === 'c:\\bin\\codex.cmd';      // Windows FS is case-insensitive
  assert.equal(isWinBatch('codex', env, exists), true);
  assert.equal(isWinBatch('node.exe', env, exists), false);
  assert.equal(winCommandLine(['codex', 'exec', 'a b'], { env, exists }), 'codex ^^^"exec^^^" ^^^"a^^^ b^^^"');
  assert.equal(winCommandLine(['node.exe', 'a b'], { env, exists }), 'node.exe ^"a^ b^"');
});

test('isWinBatch unquotes PATH entries so a shim in a quoted dir is still found', () => {
  const env = { PATH: '"C:\\dir with space";C:\\bin', PATHEXT: '.EXE;.CMD' };
  const exists = (f) => f === 'C:\\dir with space\\codex.CMD';
  assert.equal(isWinBatch('codex', env, exists), true);
  // the injection payload stays double-escaped, so the shim's %* re-parse sees no bare &
  assert.equal(winCommandLine(['codex', 'a"&echo PWNED&"'], { env, exists }), 'codex ^^^"a\\^^^"^^^&echo^^^ PWNED^^^&\\^^^"^^^"');
  const exe = (f) => f === 'C:\\dir with space\\node.EXE';
  assert.equal(isWinBatch('node', env, exe), false);
});

test('isWinBatch tries lower-case PATHEXT variants and treats unresolved commands as batch', () => {
  const env = { PATH: 'C:\\bin', PATHEXT: '.EXE;.CMD' };
  assert.equal(isWinBatch('codex', env, (f) => f === 'C:\\bin\\codex.cmd'), true);   // case-sensitive dir
  assert.equal(isWinBatch('node', env, (f) => f === 'C:\\bin\\node.exe'), false);
  assert.equal(isWinBatch('ghost', env, () => false), true);                          // unknown -> safer double escape
  assert.equal(isWinBatch('tool', { ...env, PATHEXT: '.EXE;.JS' }, (f) => f === 'C:\\bin\\tool.JS'), true);
  assert.equal(winCommandLine(['ghost', 'a&b'], { env, exists: () => false }), 'ghost ^^^"a^^^&b^^^"');
});

test('isWinBatch only treats PATHEXT extensions as explicit (python3.11 is looked up)', () => {
  const env = { PATH: 'C:\\py', PATHEXT: '.EXE;.CMD' };
  assert.equal(isWinBatch('python3.11', env, (f) => f === 'C:\\py\\python3.11.EXE'), false);
  assert.equal(isWinBatch('python3.11', env, (f) => f === 'C:\\py\\python3.11.cmd'), true);
  assert.equal(isWinBatch('Codex.CMD', env, () => false), true);                      // explicit, case-insensitive
  assert.equal(isWinBatch('node.Exe', env, () => false), false);
});

test('winCommandLine refuses CR/LF arguments that cmd.exe would truncate', () => {
  const env = { PATH: 'C:\\bin', PATHEXT: '.EXE' };
  const exists = (f) => f === 'C:\\bin\\node.EXE';
  for (const arg of ['line1\nline2', 'a\r\nb', 'x\r']) {
    assert.throws(() => winCommandLine(['node', 'ok', arg], { env, exists }),
      (e) => e instanceof WinArgError && e.code === 'newline' && /line break/.test(e.message) && /file or stdin/.test(e.message));
  }
  assert.equal(winCommandLine(['node', 'ok'], { env, exists }), 'node ^"ok^"');
});

test('winExe quotes only where the caret form fails on real cmd.exe, and only whole-token', () => {
  // native .exe/.com: whitespace or '=' needs quotes (the child would split an unquoted path)
  assert.equal(winExe('C:\\Program Files\\nodejs\\node.exe', false), '"C:\\Program Files\\nodejs\\node.exe"');
  assert.equal(winExe('C:\\Program Files (x86)\\a&b^c\\node.exe', false), '"C:\\Program Files (x86)\\a&b^c\\node.exe"');
  assert.equal(winExe('C:\\eq=ual\\t.exe', false), '"C:\\eq=ual\\t.exe"');
  assert.equal(winExe('C:\\c,omma;semi\\t.exe', false), 'C:\\c^,omma^;semi\\t.exe');          // , ; are fine escaped
  assert.equal(winExe('C:\\bin\\node.exe', false), 'C:\\bin\\node.exe');
  assert.equal(winExe('C:\\%X%\\!X!\\node.exe', false), 'C:\\^%%cd:~,%X^%%cd:~,%\\^!X^!\\node.exe');  // caret form, % guarded
  // batch shims (and anything unresolved): spaces work in the caret form, %~dp0 included; only '=' needs quotes
  assert.equal(winExe('C:\\sp ace (x86)\\%X%\\tool.cmd'), 'C:\\sp^ ace^ ^(x86^)\\^%%cd:~,%X^%%cd:~,%\\tool.cmd');
  assert.equal(winExe('C:\\eq=ual (x86)\\tool.cmd', true), '"C:\\eq=ual (x86)\\tool.cmd"');
  // bare names stay unquoted: a quoted PATH-searched .cmd sees a wrong %~dp0 (npm shims break)
  assert.equal(winExe('codex'), 'codex');
  assert.equal(winExe('a&b%X%'), 'a^&b^%%cd:~,%X^%%cd:~,%');      // % guard
  // never a quote toggle inside the token: needs-quoting + % or ! is refused
  for (const [exe, batch] of [['C:\\sp ace\\%X%\\node.exe', false], ['C:\\sp ace\\!X!\\node.exe', false], ['C:\\eq=ual\\%X%\\tool.cmd', true]]) {
    assert.throws(() => winExe(exe, batch), (e) => e instanceof WinArgError && e.code === 'percent-in-path' && /without % or !/.test(e.message));
  }
  assert.throws(() => winExe('C:\\a"&calc&"\\x.exe'), (e) => e instanceof WinArgError && e.code === 'quote');
});

test("winExe refuses a run of ';;' in the command path: cmd.exe collapses it to a single ';'", () => {
  // measured on real cmd.exe (winExe's caret form AND a whole-token quote): 'a;;b' and 'a;;;b'
  // both land on the sibling 'a;b', quoted or not, so neither escaping can carry it intact
  for (const exe of ['C:\\a;;b\\node.exe', 'C:\\a;;;b\\node.exe', 'C:\\dir;;\\tool.cmd', 'a;;b', ';;', 'C:\\sp ace;;\\node.exe']) {
    for (const batch of [false, true]) {
      assert.throws(() => winExe(exe, batch), (e) => e instanceof WinArgError && e.code === 'semicolons-in-path' && /collapses/.test(e.message) && /;'/.test(e.message), exe);
    }
  }
  assert.throws(() => winCommandLine(['C:\\a;;b\\node.exe'], { env: { PATH: '', PATHEXT: '.EXE' }, exists: () => false }),
    (e) => e instanceof WinArgError && e.code === 'semicolons-in-path');
  // single ';' (any count that isn't a run of 2+) still works, as does ',,' or '==' (measured:
  // they do not collapse) and a path with no ';' at all
  assert.equal(winExe('C:\\a;b\\node.exe', false), 'C:\\a^;b\\node.exe');
  assert.equal(winExe('C:\\a,,b\\node.exe', false), 'C:\\a^,^,b\\node.exe');
  assert.equal(winExe('C:\\a==b\\node.exe', false), '"C:\\a==b\\node.exe"');
});

// Non-ASCII whitespace cmd.exe also treats as a command-name delimiter (measured on real
// cmd.exe): the Unicode "space separator" code points, the two Unicode line separators, NEL
// and the Mongolian vowel separator. Most are inside JS's \s (so a native .exe with one of
// them already gets quoted); NEL (U+0085) and the Mongolian vowel separator (U+180E) are not,
// so only the caret form protects them for a native path.
const WIDE_CMD_WS_CODES = [0x00A0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
  0x2007, 0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0x0085, 0x180E];

test('winExe caret-escapes Unicode whitespace cmd.exe also treats as a command-name delimiter', () => {
  for (const code of WIDE_CMD_WS_CODES) {
    const ch = String.fromCodePoint(code);
    // batch (.cmd): no '=' or ASCII whitespace/'=' trigger, so the caret branch is always taken;
    // the Unicode char must come out caret-prefixed or it would delimit the name early
    assert.equal(winExe(`C:\\a${ch}b\\tool.cmd`), `C:\\a^${ch}b\\tool.cmd`, `batch U+${code.toString(16)}`);
    // native: U+0085/U+180E are not in JS \s, so (unlike the rest) they take the caret branch
    // too rather than being quoted; either way the char must survive caret-escaped
    const native = winExe(`C:\\a${ch}b\\node.exe`, false);
    if (/\s/.test(ch)) assert.equal(native, `"C:\\a${ch}b\\node.exe"`, `native (quoted) U+${code.toString(16)}`);
    else assert.equal(native, `C:\\a^${ch}b\\node.exe`, `native (caret) U+${code.toString(16)}`);
  }
  // plain ASCII space is unaffected by this change
  assert.equal(winExe('C:\\sp ace\\tool.cmd'), 'C:\\sp^ ace\\tool.cmd');
});

// A '/' in a RELATIVE command path is read as a switch by cmd.exe, not a path separator
// (measured on real cmd.exe): 'sub/tool.cmd' resolves 'sub' via PATHEXT and runs a
// sibling 'sub.com'/'sub.bat', never 'sub\tool.cmd'. winExe normalises '/' to '\' up front so
// the line it builds never has this problem, for relative, drive-absolute and UNC forms alike.
test("winExe normalises '/' to '\\' in the command path", () => {
  assert.equal(winExe('sub/tool.cmd', true, 'C:\\w'), 'C:\\w\\sub\\tool.cmd');
  assert.equal(winExe('.\\sub/tool.cmd', true, 'C:\\w'), 'C:\\w\\sub\\tool.cmd');
  assert.equal(winExe('C:/Program Files/nodejs/node.exe', false), '"C:\\Program Files\\nodejs\\node.exe"');
  assert.equal(winExe('//server/share/tool.cmd', true, 'C:\\w'), '\\\\server\\share\\tool.cmd');
  // already-backslash forms are untouched
  assert.equal(winExe('C:\\bin\\node.exe', false), 'C:\\bin\\node.exe');
  assert.equal(winCommandLine(['sub/tool.cmd', 'a b'], { env: { PATH: '', PATHEXT: '.CMD' }, exists: () => false, cwd: 'C:\\w' }),
    'C:\\w\\sub\\tool.cmd ^^^"a^^^ b^^^"');
});

// Win32 strips a trailing '.' or ' ' from every path component other than '.'/'..' (even
// through a '\\.\' device-namespace prefix), and that stripping happens underneath cmd.exe
// too (measured on real cmd.exe): 'a.\tool.cmd' and 'a \tool.cmd' both silently resolve
// to the sibling 'a\tool.cmd'. '\\?\' skips the stripping but cmd.exe cannot run a '\\?\'
// path at all ('the system cannot find the path specified', measured). Both are refused.
test("winExe refuses a trailing '.' or space in any path component, and a '\\\\.\\' or '\\\\?\\' device prefix", () => {
  for (const exe of ['C:\\a.\\tool.cmd', 'C:\\a \\tool.cmd', 'C:\\a\\tool.cmd ', 'C:\\a. .\\tool.cmd',
    'C:\\a\\b.\\tool.cmd', 'tool.cmd ', 'a.', '\\\\server\\share\\a.\\tool.cmd', 'C:/a./tool.cmd']) {
    assert.throws(() => winExe(exe), (e) => e instanceof WinArgError && e.code === 'trailing-dot-or-space', exe);
  }
  for (const exe of ['\\\\.\\C:\\a\\tool.cmd', '\\\\?\\C:\\a\\tool.cmd', '//./C:/a/tool.cmd', '//?/C:/a/tool.cmd']) {
    assert.throws(() => winExe(exe), (e) => e instanceof WinArgError && e.code === 'device-path', exe);
  }
  // '.'/'..' components themselves are fine, as is a path with no trailing '.'/' ' anywhere
  assert.equal(winExe('C:\\a\\.\\tool.cmd'), 'C:\\a\\.\\tool.cmd');
  assert.equal(winExe('..\\a\\tool.cmd', true, 'C:\\w\\x'), 'C:\\w\\a\\tool.cmd');
  assert.equal(winExe('C:\\a\\tool.cmd'), 'C:\\a\\tool.cmd');
  assert.throws(() => winCommandLine(['C:\\a.\\tool.cmd'], { env: { PATH: '', PATHEXT: '.CMD' }, exists: () => false }),
    (e) => e instanceof WinArgError && e.code === 'trailing-dot-or-space');
});

// cmd.exe cuts a RELATIVE command name at a caret-escaped delimiter (measured: 'my dir\\tool.cmd'
// ran a sibling 'my.bat'; ';', ',' and Unicode spaces likewise). Relative paths holding a
// backslash are resolved against the child's cwd; bare names with a delimiter are refused.
test('winExe resolves relative paths against cwd and refuses delimiters in bare names', () => {
  const cwd = 'C:\\work dir';
  assert.equal(winExe('my dir\\tool.cmd', true, cwd), 'C:\\work^ dir\\my^ dir\\tool.cmd');
  assert.equal(winExe('sub\\a b\\tool.cmd', true, 'C:\\w'), 'C:\\w\\sub\\a^ b\\tool.cmd');
  assert.equal(winExe('a;b\\tool.cmd', true, 'C:\\w'), 'C:\\w\\a^;b\\tool.cmd');
  assert.equal(winExe('a,b\\tool.cmd', true, 'C:\\w'), 'C:\\w\\a^,b\\tool.cmd');
  assert.equal(winExe('a\u00A0b\\tool.cmd', true, 'C:\\w'), 'C:\\w\\a^\u00A0b\\tool.cmd');
  assert.equal(winExe('a;b\\node.exe', false, 'C:\\w'), 'C:\\w\\a^;b\\node.exe');
  assert.equal(winExe('\\rooted\\t.cmd', true, 'D:\\w'), 'D:\\rooted\\t.cmd');
  // drive-prefixed, drive-relative and UNC paths are not touched
  assert.equal(winExe('C:a b\\x.cmd', true, 'D:\\w'), 'C:a^ b\\x.cmd');
  assert.equal(winExe('\\\\srv\\sh are\\t.cmd', true, 'D:\\w'), '"\\\\srv\\sh are\\t.cmd"');
  // a UNC path with a delimiter is one whole quoted token (cmd.exe cuts caret-escaped UNC names)
  assert.equal(winExe('\\\\localhost\\C$\\my dir\\tool.cmd', true, 'C:\\w'), '"\\\\localhost\\C$\\my dir\\tool.cmd"');
  assert.equal(winExe('\\\\h\\s\\a;b\\node.exe', false, 'C:\\w'), '"\\\\h\\s\\a;b\\node.exe"');
  assert.equal(winExe('\\\\h\\s\\a\u0085b\\t.cmd', true, 'C:\\w'), '"\\\\h\\s\\a\u0085b\\t.cmd"');
  assert.equal(winExe('\\\\h\\s\\plain\\t.cmd', true, 'C:\\w'), '\\\\h\\s\\plain\\t.cmd');
  assert.throws(() => winExe('\\\\h\\s\\a b%X%\\t.cmd', true, 'C:\\w'), (e) => e.code === 'percent-in-path');
  // relative path from a UNC cwd resolves to a UNC path and is quoted
  assert.equal(winExe('my dir\\t.cmd', true, '\\\\h\\s\\w'), '"\\\\h\\s\\w\\my dir\\t.cmd"');
  // refusals re-run on the resolved path (a bad cwd component)
  assert.throws(() => winExe('x\\t.cmd', true, 'C:\\w.'), (e) => e.code === 'trailing-dot-or-space');
  assert.throws(() => winExe('x\\t.cmd', true, '\\\\?\\C:\\w'), (e) => e.code === 'device-path');
  // bare names without a delimiter are untouched
  assert.equal(winExe('codex', true, 'C:\\w'), 'codex');
  for (const bare of ['a b.cmd', 'a;b.cmd', 'a,b.cmd', 'a\u00A0b.cmd', 'a\tb.cmd']) {
    assert.throws(() => winExe(bare, true, 'C:\\w'), (e) => e instanceof WinArgError && e.code === 'delimiter-in-name', bare);
  }
  assert.throws(() => winCommandLine(['a b.cmd'], { env: { PATH: '', PATHEXT: '.CMD' }, exists: () => false, cwd: 'C:\\w' }),
    (e) => e instanceof WinArgError && e.code === 'delimiter-in-name');
  assert.throws(() => winExe('x\\t.cmd', true, 'C:\\a;;b'), (e) => e instanceof WinArgError && e.code === 'semicolons-in-path');
});

// Every '%' cmd.exe sees must be one of ours, followed by the guard '%cd:~,%': then phase-1
// percent expansion never takes argument text as a variable name.
const PCT_SAFE = '%%cd:~,%';
const pctGuarded = (line) => line.split(PCT_SAFE).every((p) => !p.includes('%'));
const HOSTILE_PCT = ['%EVIL%', '%EVIL:zz=q%', '%EVIL:*zz=q%', '%EVIL:zz=%', '%EVIL:~0%', '%EVIL:~0,60%', '%EVIL:~-60%',
  '%^EVIL%', '%EVIL^%', '%"EVIL%', '%EVIL"%', '%^"%', '%%', '%', '100%', 'a%b%c%d', '%~0', '%~dp0', '%*', '%1', '%CD%',
  '%=C:%', '%=ExitCode%', '%RANDOM%', '%ERRORLEVEL%', '%CMDCMDLINE%', '%__CD__%', '%cd:~,%', '%%cd:~,%', '"%EVIL:zz=q%"',
  '!EVIL!', '!EVIL:zz=q!', '^%EVIL^%', '%EVIL', ':zz=q%'];

test('quoteWinArg neutralises every %...% form: %VAR:a=b% no longer splices a value into the line', () => {
  // the repro: the caret used to land only in the replacement text ('^%EVIL:zz=q^%')
  assert.equal(quoteWinArg('%EVIL:zz=q%'), '^"^%%cd:~,%EVIL:zz=q^%%cd:~,%^"');
  assert.equal(quoteWinArg('%EVIL:zz=q%', true), '^^^"^^^%%cd:~,%EVIL:zz=q^^^%%cd:~,%^^^"');  // guard once: %* is not rescanned
  assert.equal(quoteWinArg('100%'), '^"100^%%cd:~,%^"');
  for (const batch of [false, true]) for (const a of HOSTILE_PCT) {
    const q = quoteWinArg(a, batch);
    assert.ok(pctGuarded(q), `unguarded % in ${q}`);
    // removing the guard gives back the plain caret escaping, so non-% behaviour is unchanged
    const plain = `"${a.replace(/(\\*)"/g, '$1$1\\"')}"`.replace(/([()\][%!^"`<>&|;, *?])/g, '^$1');
    assert.equal(q.replaceAll(PCT_SAFE, '%'), batch ? plain.replace(/([()\][%!^"`<>&|;, *?])/g, '^$1') : plain);
  }
  // a %-form split across arguments (and the executable) is guarded too: the whole line is
  for (const exe of ['codex', 'node.exe', 'C:\\a %EVIL% b\\x.cmd', 'C:\\e%X%\\node.exe', 'a%b']) {
    const line = winCommandLine([exe, ...HOSTILE_PCT, '%EVIL', ':zz=q%'], { env: { PATH: '', PATHEXT: '.EXE;.CMD' }, exists: () => false });
    assert.ok(pctGuarded(line), line);
  }
});

test('winShell runs the line like shell: true, pinning /e:on (guard needs extensions) and /v:off', () => {
  assert.deepEqual(winShell('a ^"b^"', { ComSpec: 'C:\\Windows\\system32\\cmd.exe' }),
    ['C:\\Windows\\system32\\cmd.exe', ['/d', '/e:on', '/v:off', '/s', '/c', '"a ^"b^""']]);
  assert.equal(winShell('x', {})[0], 'cmd.exe');
});

test('winCommandLine quotes a spaced native executable and keeps argument escaping', () => {
  const env = { PATH: 'C:\\bin', PATHEXT: '.EXE;.CMD' };
  assert.equal(winCommandLine(['C:\\Program Files\\nodejs\\node.exe', 'x.mjs', 'a b', 'a&b'], { env, exists: () => false }),
    '"C:\\Program Files\\nodejs\\node.exe" ^"x.mjs^" ^"a^ b^" ^"a^&b^"');
  assert.equal(winCommandLine(['C:\\Program Files (x86)\\t\\codex.cmd', 'a&b'], { env, exists: () => false }),
    'C:\\Program^ Files^ ^(x86^)\\t\\codex.cmd ^^^"a^^^&b^^^"');
  const node = 'C:\\Program Files\\nodejs\\node';                                         // extensionless, resolves to .EXE
  assert.equal(winCommandLine([node, 'a b'], { env, exists: (f) => f === `${node}.EXE` }), `"${node}" ^"a^ b^"`);
  assert.throws(() => winCommandLine(['C:\\a"b\\x.exe'], { env, exists: () => false }), (e) => e instanceof WinArgError && e.code === 'quote');
  assert.throws(() => winCommandLine(['C:\\sp ace\\%X%\\x.exe'], { env, exists: () => false }), (e) => e instanceof WinArgError && e.code === 'percent-in-path');
});

const LAUNCH_ARGS = ['safe', 'a b', 'say "hi"', 'a&b|c<d>e', '%PATH%!x!^', '', 'C:\\dir\\', 'x"&echo PWNED&"', '(paren) ;,=', 'Program Files (x86)'];
function launcher(home, extraEnv = {}, name = 'iac-launch.js') {
  const bin = path.join(import.meta.dirname, '..', 'bin', name);
  const env = { ...process.env, ...HARNESS_CLEAN, IAC_HOME: home, ...extraEnv };
  return (cmd) => spawnSync(process.execPath, [bin, 'fable', '--', ...cmd], { env, encoding: 'utf8' });
}

test('iac-launch runs process.execPath (C:\\Program Files on Windows) with hostile args intact', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-launch-'));
  const fixture = path.join(home, 'argv.mjs');
  fs.writeFileSync(fixture, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
  const launch = launcher(home);
  const r = launch([process.execPath, fixture, ...LAUNCH_ARGS]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), LAUNCH_ARGS);
  const x = launch([process.execPath, '-e', 'process.exit(7)']);                       // exit status still forwarded
  assert.equal(x.status, 7, x.stderr);
  // the deprecated agora-launch alias routes through the same quoting
  const alias = launcher(home, {}, 'agora-launch.js')([process.execPath, fixture, ...LAUNCH_ARGS]);
  assert.equal(alias.status, 0, alias.stderr);
  assert.deepEqual(JSON.parse(alias.stdout), LAUNCH_ARGS);
});

test('iac-launch runs npm-style %~dp0 shims by full path from hostile directories', { skip: process.platform !== 'win32' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-launch-'));
  const marker = path.join(home, 'marker.txt');
  // X expands to an injection: if any %X% / !X! in a path were expanded, the marker file appears
  const launch = launcher(home, { X: `BAD&echo MARK>"${marker}"&`, PATH: `${path.dirname(process.execPath)};${process.env.PATH}` });
  const shimIn = (name) => {
    const dir = path.join(home, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'argv.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)));\n');
    fs.writeFileSync(path.join(dir, 'tool.cmd'), '@node "%~dp0argv.mjs" %*\r\n');      // the npm shim shape
    return path.join(dir, 'tool.cmd');
  };
  for (const name of ['sp ace', '%X%', '!X!', '%!%!', 'sp ace %X%', 'sp ace !X!', '(x86)', 'Program Files (x86)', 'a&b^c ;,', 'eq=ual (x86)']) {
    const r = launch([shimIn(name), ...LAUNCH_ARGS]);
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout), LAUNCH_ARGS, name);
    assert.equal(fs.existsSync(marker), false, `${name}: a path variable expanded`);
  }
  // needs quoting ('=') and holds %: refused up front, nothing runs
  const r = launch([shimIn('eq=ual %X%'), 'safe']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /must be quoted for cmd\.exe.*without % or !/);
  assert.equal(r.stdout, '');
  assert.equal(fs.existsSync(marker), false);
});

test("iac-launch refuses a ';;' run in the executable path instead of running a sibling", { skip: process.platform !== 'win32' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-launch-'));
  const launch = launcher(home);
  const shimIn = (name, label) => {
    const dir = path.join(home, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'tool.cmd'), `@echo RAN:${label}\r\n`);
    return path.join(dir, 'tool.cmd');
  };
  // the sibling cmd.exe's collapse would land on: if iac-launch ran it instead of refusing,
  // this test would see 'RAN:sibling' rather than a refusal
  shimIn('a;b', 'sibling');
  for (const name of ['a;;b', 'a;;;b', 'dir;;']) {
    const shim = shimIn(name, name);
    const r = launch([shim]);
    assert.equal(r.status, 64, `${name}: ${r.stderr}`);
    assert.match(r.stderr, /collapses.*single ';'/, name);
    assert.equal(r.stdout, '', name);
  }
  // doubled separators measured NOT to collapse on real cmd.exe still run their own path
  for (const name of ['a,,b', 'a==b']) {
    const shim = shimIn(name, name);
    const r = launch([shim]);
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.equal(r.stdout.trim(), `RAN:${name}`, name);
  }
});

test('iac-launch runs a Unicode-whitespace directory correctly instead of a truncated sibling', { skip: process.platform !== 'win32' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-launch-'));
  const launch = launcher(home);
  const shimIn = (name, label) => {
    const dir = path.join(home, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'tool.cmd'), `@echo RAN:${label}\r\n`);
    return path.join(dir, 'tool.cmd');
  };
  // if the Unicode char were read as a delimiter, cmd.exe would resolve only as far as 'a',
  // landing here instead of the intended 'a<char>b' directory
  shimIn('a', 'sibling');
  for (const code of WIDE_CMD_WS_CODES) {
    const ch = String.fromCodePoint(code);
    const shim = shimIn(`a${ch}b`, `U+${code.toString(16)}`);
    const r = launch([shim]);
    assert.equal(r.status, 0, `U+${code.toString(16)}: ${r.stderr}`);
    assert.equal(r.stdout.trim(), `RAN:U+${code.toString(16)}`, `U+${code.toString(16)}`);
  }
});

test("iac-launch runs a relative '/' path from its own directory instead of a PATHEXT sibling", { skip: process.platform !== 'win32' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-launch-'));
  fs.mkdirSync(path.join(home, 'sub'));
  fs.writeFileSync(path.join(home, 'sub', 'tool.cmd'), '@echo RAN:intended\r\n');
  // PATHEXT puts .COM before .BAT before .CMD: if 'sub/tool.cmd' were read as 'sub' + a
  // switch, cmd.exe would run one of these two instead of the real 'sub\tool.cmd'
  fs.writeFileSync(path.join(home, 'sub.com'), '@echo RAN:sibling-com\r\n');
  fs.writeFileSync(path.join(home, 'sub.bat'), '@echo RAN:sibling-bat\r\n');
  const bin = path.join(import.meta.dirname, '..', 'bin', 'iac-launch.js');
  const env = { ...process.env, ...HARNESS_CLEAN, IAC_HOME: home };
  const run = (cmd) => spawnSync(process.execPath, [bin, 'fable', '--', ...cmd], { env, encoding: 'utf8', cwd: home });
  for (const rel of ['sub/tool.cmd', '.\\sub/tool.cmd']) {
    const r = run([rel]);
    assert.equal(r.status, 0, `${rel}: ${r.stderr}`);
    assert.equal(r.stdout.trim(), 'RAN:intended', rel);
  }
});

test('iac-launch runs relative paths with delimiters from the cwd, never a truncated sibling; refuses bare delimited names', { skip: process.platform !== 'win32' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-launch-'));
  const bin = path.join(import.meta.dirname, '..', 'bin', 'iac-launch.js');
  const env = { ...process.env, ...HARNESS_CLEAN, IAC_HOME: home };
  const run = (cmd) => spawnSync(process.execPath, [bin, 'fable', '--', ...cmd], { env, encoding: 'utf8', cwd: home });
  const put = (rel, body) => { fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true }); fs.writeFileSync(path.join(home, rel), body); };
  const cases = [
    ['my dir\\tool.cmd', ['my.bat']],
    ['sub\\a b\\tool.cmd', ['sub\\a.cmd']],
    ['a;b\\tool.cmd', ['a.cmd']],
    ['a,b\\tool.cmd', ['a.cmd']],
    ['a\u00A0b\\tool.cmd', ['a.cmd', 'a.com']],
  ];
  for (const [rel, siblings] of cases) {
    put(rel, '@echo RAN:intended\r\n');
    for (const sib of siblings) put(sib, '@echo RAN:sibling\r\n');
    const r = run([rel]);
    assert.equal(r.status, 0, `${rel}: ${r.stderr}`);
    assert.equal(r.stdout.trim(), 'RAN:intended', rel);
  }
  // native exe in a semicolon directory, with a planted a.exe sibling
  fs.mkdirSync(path.join(home, 'a;b'), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(home, 'a;b', 'node.exe'));
  fs.writeFileSync(path.join(home, 'a.exe'), 'not a program');
  const n = run(['a;b\\node.exe', '-p', '"native-ok"']);
  assert.equal(n.status, 0, n.stderr);
  assert.match(n.stdout, /native-ok/);
  // a bare delimited name is refused, never run
  put('a b.cmd', '@echo RAN:bare\r\n'); put('a.cmd', '@echo RAN:sibling\r\n');
  const b = run(['a b.cmd']);
  assert.equal(b.status, 64, b.stderr);
  assert.match(b.stderr, /delimiter/);
  assert.equal(b.stdout, '');
});

const UNC_ADMIN = process.platform === 'win32' ? (() => {
  const t = os.tmpdir();
  const m = /^([A-Za-z]):\\(.*)$/.exec(t);
  if (!m) return null;
  const unc = `\\\\localhost\\${m[1]}$\\${m[2]}`;
  try { fs.accessSync(unc); return unc; } catch { return null; }
})() : null;

test('iac-launch runs UNC paths and UNC-cwd relative paths with delimiters, never a truncated sibling',
  { skip: process.platform !== 'win32' ? 'win32 only' : !UNC_ADMIN ? '\\\\localhost\\<drive>$ admin share not reachable' : false }, () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-launch-unc-'));
  const unc = path.win32.join(UNC_ADMIN, path.basename(local));
  const bin = path.join(import.meta.dirname, '..', 'bin', 'iac-launch.js');
  const env = { ...process.env, ...HARNESS_CLEAN, IAC_HOME: local };
  const run = (cmd, cwd = local) => spawnSync(process.execPath, [bin, 'fable', '--', ...cmd], { env, encoding: 'utf8', cwd });
  const put = (rel, body) => { fs.mkdirSync(path.dirname(path.join(local, rel)), { recursive: true }); fs.writeFileSync(path.join(local, rel), body); };
  const cmds = [['my dir', 'my.bat'], ['a;b', 'a.bat'], ['a,b', 'a.bat'], ['a\u00A0b', 'a.bat'], ['a\u0085b', 'a.bat']];
  for (const [dir, sib] of cmds) {
    put(`${dir}\\tool.cmd`, '@echo RAN:intended\r\n');
    put(sib, '@echo RAN:sibling\r\n');
    const r = run([path.win32.join(unc, dir, 'tool.cmd')]);
    assert.equal(r.status, 0, `${dir}: ${r.stderr}`);
    assert.equal(r.stdout.trim(), 'RAN:intended', dir);
    // relative path launched from a UNC cwd
    const rc = run([`${dir}\\tool.cmd`], unc);
    assert.equal(rc.status, 0, `cwd ${dir}: ${rc.stderr}`);
    assert.equal(rc.stdout.trim(), 'RAN:intended', `cwd ${dir}`);
  }
  for (const dir of ['a;b', 'a,b', 'a\u0085b']) {
    fs.mkdirSync(path.join(local, dir), { recursive: true });
    fs.copyFileSync(process.execPath, path.join(local, dir, 'node.exe'));
    fs.writeFileSync(path.join(local, 'a.exe'), 'not a program');
    fs.writeFileSync(path.join(local, 'a.com'), 'not a program');
    const n = run([path.win32.join(unc, dir, 'node.exe'), '-p', '"native-ok"']);
    assert.equal(n.status, 0, `${dir}: ${n.stderr}`);
    assert.match(n.stdout, /native-ok/, dir);
  }
});

test("iac-launch refuses a trailing '.'/space path component or a device prefix instead of running a sibling", { skip: process.platform !== 'win32' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-launch-'));
  const launch = launcher(home);
  const dir = path.join(home, 'a');
  fs.mkdirSync(dir);
  const tool = path.join(dir, 'tool.cmd');
  fs.writeFileSync(tool, '@echo RAN:sibling\r\n');
  for (const [mangled, code] of [
    [dir + '.\\tool.cmd', 'trailing-dot-or-space'],
    [dir + ' \\tool.cmd', 'trailing-dot-or-space'],
    [tool + ' ', 'trailing-dot-or-space'],
    ['\\\\.\\' + tool, 'device-path'],
    ['\\\\?\\' + tool, 'device-path'],
  ]) {
    const r = launch([mangled]);
    assert.equal(r.status, 64, `${mangled}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(code === 'trailing-dot-or-space' ? 'silently strips' : 'device-namespace prefix'), mangled);
    assert.equal(r.stdout, '', mangled);
  }
  // the real, unmangled path still runs
  const r = launch([tool]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'RAN:sibling');
});

test('iac-launch: no %...% form in an argument expands, even with metacharacter-laden env values', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-launch-'));
  const fixture = path.join(home, 'argv.mjs');
  fs.writeFileSync(fixture, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
  const marker = path.join(home, 'marker');
  // each value, spliced raw into the cmd.exe line, would run 'echo x>marker'
  const evil = `zz&echo x>"${marker}"&rem `;
  const hostileEnv = { EVIL: evil, '^EVIL': evil, 'EVIL^': evil, '"EVIL': evil, 'EVIL"': evil, '^"': evil, CD: evil,
    X: `zz|echo x>"${marker}"|rem ` };
  const env = { ...process.env, ...hostileEnv };
  const args = [...HOSTILE_PCT, '%X:zz=q%', '%X%', 'a%EVIL:zz=q%b %X:*zz=q% c'];
  const launch = launcher(home, hostileEnv);
  const check = (r, what) => {
    assert.equal(fs.existsSync(marker), false, `${what}: an env value ran as a command`);
    assert.equal(r.status, 0, `${what}: ${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout), args, what);
  };
  check(launch([process.execPath, fixture, ...args]), 'node.exe');
  // one argument at a time too, so a broken neighbour cannot mask a failure
  for (const a of ['%EVIL:zz=q%', '%^"EVIL:zz=q%', '%X:zz=q%']) {
    const r = launch([process.execPath, fixture, a]);
    assert.equal(fs.existsSync(marker), false, a);
    assert.deepEqual(JSON.parse(r.stdout), [a]);
  }
  if (process.platform === 'win32') {
    // through a .cmd shim whose %* re-parses the arguments, in a %-laden directory (winExe)
    const dir = path.join(home, 'sh %EVIL% %^EVIL% %EVIL^% (x) & ;,');
    fs.mkdirSync(dir);
    const shim = path.join(dir, 'tool.cmd');
    fs.writeFileSync(shim, `@"${process.execPath}" "${fixture}" %*\r\n`);
    check(launch([shim, ...args]), '.cmd shim');
    // the line alone is safe under plain shell: true (cmd /d /s /c) and under /v:on, too
    for (const [pre, label] of [[[process.execPath, fixture], 'node.exe'], [[shim], '.cmd shim']]) {
      const pctArgs = args.filter((a) => !a.includes('!'));        // /v:on expands !X! (data, never a command)
      const line = winCommandLine([...pre, ...pctArgs], { env });
      for (const [run, how] of [
        [() => spawnSync(line, { env, encoding: 'utf8', shell: true }), 'shell: true'],
        [() => spawnSync('cmd.exe', ['/d', '/v:on', '/s', '/c', `"${line}"`], { env, encoding: 'utf8', windowsVerbatimArguments: true }), '/v:on'],
      ]) {
        const r = run();
        assert.equal(fs.existsSync(marker), false, `${label} ${how}: an env value ran as a command`);
        assert.deepEqual(JSON.parse(r.stdout), pctArgs, `${label} ${how}: ${r.stderr}`);
      }
    }
  }
});

test('iac-launch with an empty command after -- exits 64 with usage, no stack trace', async () => {
  const { spawnSync } = await import('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-launch-'));
  const bin = path.join(import.meta.dirname, '..', 'bin', 'iac-launch.js');
  const r = spawnSync(process.execPath, [bin, 'fable', '--'], { env: { ...process.env, IAC_HOME: home }, encoding: 'utf8' });
  assert.equal(r.status, 64);
  assert.match(r.stderr, /usage: iac-launch <agent>/);
  assert.doesNotMatch(r.stderr, /TypeError|at .*iac-launch\.js/);
});

test('winargs present() counts an lstat-only entry (reparse-point alias) as found', async (t) => {
  const { present } = await import('../src/winargs.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-alias-'));
  // WindowsApps aliases have this shape, but creating a dangling symlink needs
  // Developer Mode or elevated privileges on Windows CI.
  const alias = path.join(dir, 'winget.EXE');
  const lstatSync = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (f, ...args) => f === alias ? {} : lstatSync(f, ...args));
  assert.equal(fs.existsSync(alias), false);
  assert.equal(present(alias), true, 'alias counts as found, so it resolves as a native .exe');
  assert.equal(present(path.join(dir, 'absent.EXE')), false);
});

test('harness identity honours CLAUDE_CONFIG_DIR for the transcript root', async () => {
  const { harnessIdentity, HOOK_TRANSCRIPT } = await import('../src/api.js');
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-cfg-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-home-'));
  const id = 'sess-cfg-1';
  fs.mkdirSync(path.join(cfg, 'projects', 'x'), { recursive: true });
  const file = path.join(cfg, 'projects', 'x', `${id}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5' } }) + '\n');
  const env = { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_SESSION_ID: id };
  assert.equal(harnessIdentity(env).model, 'claude-opus-5', 'scan finds it under CLAUDE_CONFIG_DIR/projects');
  assert.equal(harnessIdentity({ ...env, CLAUDE_CONFIG_DIR: undefined }).transcript, null, 'not under ~/.claude');
  // the payload fallback is contained by the same root
  const nested = path.join(cfg, 'projects', 'x', 'y');
  fs.mkdirSync(nested, { recursive: true });
  fs.renameSync(file, path.join(nested, `${id}.jsonl`));
  assert.equal(harnessIdentity({ ...env, [HOOK_TRANSCRIPT]: path.join(nested, `${id}.jsonl`) }).model, 'claude-opus-5');
});

test('harness-scoped families: a family pinned to claude-code is never attested by Codex, whatever the glob', () => {
  const { a, home } = fresh();
  // the reviewer's repro: an operator glob broad enough to match a provider-prefixed slug
  a.setFamilyModels('opus', ['*claude-opus-*']);
  assert.equal(a.config().familyHarness.opus, 'claude-code', 'default Claude families are seeded as claude-code');
  const codex = fakeCodexSession({ model: 'anthropic/claude-opus-5' });
  let id = new Agora(home, { env: codex.env }).identity();
  assert.deepEqual([id.agent, id.family, id.source], [null, null, null]);
  assert.match(id.reason, /cannot (be )?attest/, 'refused by the provider-prefix guard or the pin');
  // a slug with no provider prefix at all is refused by the pin alone
  a.setFamilyModels('opus', ['*opus*']);
  id = new Agora(home, { env: fakeCodexSession({ model: 'my-opus-5' }).env }).identity();
  assert.equal(id.agent, null);
  assert.match(id.reason, /matches family 'opus', which codex cannot attest \(familyHarness: claude-code\)/);
  assert.match(id.todo, /cross-harness/);
  a.setFamilyModels('opus', ['*claude-opus-*']);
  // the same model in Claude Code still attests opus
  const claude = fakeSession({ models: ['anthropic/claude-opus-5'] });
  id = new Agora(home, { env: claude.env }).identity();
  assert.deepEqual([id.agent, id.source, id.familyHarness], ['opus', 'harness', 'claude-code']);
});

test('harness-scoped families: a malformed familyHarness value fails closed; provider-prefixed ids hit the prefix guard', async () => {
  const { declaredHarness, familyForModel } = await import('../src/api.js');
  for (const bad of ['Claude', 'claude', ['claude-code'], null, 42, '']) {
    const cfg = { families: { opus: ['*opus*'] }, familyHarness: { opus: bad } };
    assert.equal(declaredHarness('opus', cfg), 'invalid', JSON.stringify(bad));
    assert.equal(familyForModel('my-opus-5', cfg, { harness: 'codex' }), null, `codex, ${JSON.stringify(bad)}`);
    assert.equal(familyForModel('my-opus-5', cfg, { harness: 'claude-code' }), null, `claude-code, ${JSON.stringify(bad)}`);
  }
  assert.equal(declaredHarness('opus', { familyHarness: { opus: ' Claude-Code ' } }), 'claude-code', 'trimmed and lowercased');
  assert.equal(declaredHarness('sol', { familyHarness: {} }), null, 'only an absent key is undeclared');
  const und = { families: { x: ['*'] } };
  for (const m of ['anthropic/claude-opus-5', 'us.anthropic.claude-opus-5', 'bedrock:claude-opus-5'])
    assert.equal(familyForModel(m, und, { harness: 'codex' }), null, m);
  assert.equal(familyForModel('openai/gpt-6', und, { harness: 'claude-code' }), null);
});

test('an invalid familyHarness names the config fix in todo, and set-models flags it rather than echoing it', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const { a, home } = fresh();
  a.setFamilyModels('sol', ['*sol*']);
  const cfgPath = path.join(home, 'config.json');
  const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); raw.familyHarness.sol = 'Codexx'; fs.writeFileSync(cfgPath, JSON.stringify(raw)); a.store.invalidate();
  const id = new Agora(home, { env: fakeCodexSession({ model: 'my-sol-6' }).env }).identity();
  assert.equal(id.agent, null);
  assert.match(id.reason, /familyHarness: invalid/);
  assert.equal(id.todo, 'fix config.json familyHarness.sol (iac set-models sol --harness claude-code|codex)');
  // a valid foreign pin keeps the cross-harness wording
  raw.familyHarness.sol = 'claude-code'; fs.writeFileSync(cfgPath, JSON.stringify(raw)); a.store.invalidate();
  assert.match(new Agora(home, { env: fakeCodexSession({ model: 'my-sol-6' }).env }).identity().todo, /cross-harness/);
  raw.familyHarness.sol = 'Codexx'; fs.writeFileSync(cfgPath, JSON.stringify(raw)); a.store.invalidate();
  const bin = path.join(import.meta.dirname, '..', 'bin', 'iac.js');
  const env = { ...process.env, IAC_HOME: home, IAC_AGENT: '', IAC_INSTANCE: '', CODEX_THREAD_ID: '', CODEX_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '' };
  const out = (await run(process.execPath, [bin, 'set-models', 'sol', '--models', '*sol*'], { env })).stdout;
  assert.match(out, /config\.json familyHarness\.sol is invalid \("Codexx"\)/);
  assert.match(out, /iac set-models sol --harness claude-code\|codex/);
  assert.doesNotMatch(out, /only Codexx may attest/);
  const json = JSON.parse((await run(process.execPath, [bin, 'set-models', 'sol', '--models', '*sol*', '--json'], { env })).stdout);
  assert.deepEqual([json.harness, json.harnessRaw], ['invalid', 'Codexx']);
  // setting a valid harness repairs it
  assert.match((await run(process.execPath, [bin, 'set-models', 'sol', '--harness', 'codex'], { env })).stdout, /only codex may attest sol/);
});

test('harness-scoped families: a Claude transcript naming a Codex-pinned family model is refused', () => {
  const { a, home } = fresh();
  a.setFamilyModels('sol', ['*sol*']); a.setFamilyHarness('sol', 'codex');
  // no gpt- prefix, so the legacy prefix rule alone would have let Claude Code attest sol
  const claude = fakeSession({ models: ['openai/sol-6'] });
  const id = new Agora(home, { env: claude.env }).identity();
  assert.deepEqual([id.agent, id.family], [null, null]);
  assert.match(id.reason, /which claude-code cannot attest \(familyHarness: codex\)/);
  const codex = fakeCodexSession({ model: 'openai/sol-6' });
  assert.equal(new Agora(home, { env: codex.env }).identity().agent, 'sol');
  // a family declared for one harness does not shadow a later family the harness may attest
  a.setFamilyModels('astra', ['openai/*']); a.setFamilyHarness('astra', 'claude-code');
  assert.equal(new Agora(home, { env: claude.env }).identity().agent, 'astra');
  assert.equal(new Agora(home, { env: codex.env }).identity().agent, 'sol');
});

test('harness-scoped families: an undeclared family falls back to the prefix rule, which stays as defence in depth', async () => {
  const { declaredHarness } = await import('../src/api.js');
  const { a, home } = fresh();
  a.setFamilyModels('sol', ['gpt-6-sol', 'sol-*']);
  assert.equal(declaredHarness('sol', a.config()), null);
  assert.equal(new Agora(home, { env: fakeCodexSession({ model: 'gpt-6-sol' }).env }).identity().agent, 'sol');
  const claudeGpt = new Agora(home, { env: fakeSession({ models: ['gpt-6-sol'] }).env }).identity();
  assert.equal(claudeGpt.agent, null); assert.match(claudeGpt.reason, /cannot be attested by claude-code/);
  // undeclared and no provider prefix: the legacy rule cannot tell, so it attests (hence the whoami hint)
  const id = new Agora(home, { env: fakeSession({ models: ['sol-x'] }).env }).identity();
  assert.deepEqual([id.agent, id.familyHarness], ['sol', null]);
  // a declaration never overrides the prefix denylist
  a.setFamilyHarness('sol', 'claude-code');
  assert.equal(new Agora(home, { env: fakeSession({ models: ['gpt-6-sol'] }).env }).identity().agent, null);
});

test('CLI: set-models --harness round-trips, validates, and whoami hints when a family declares none', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const { a, home } = fresh();
  const bin = path.join(import.meta.dirname, '..', 'bin', 'iac.js');
  const base = { ...process.env, IAC_HOME: home, IAC_AGENT: '', IAC_INSTANCE: '', CODEX_THREAD_ID: '', CODEX_SESSION_ID: '',
    CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '' };
  // each CLI run writes from another process; drop this process's read cache afterwards
  const cli = (env, ...args) => run(process.execPath, [bin, ...args], { env: { ...base, ...env } }).finally(() => a.store.invalidate());

  const set = JSON.parse((await cli({}, 'set-models', 'sol', '--models', 'gpt-6-sol', '--json')).stdout);
  assert.deepEqual([set.agent, set.models, set.harness], ['sol', ['gpt-6-sol'], null]);
  const s = fakeCodexSession({ model: 'gpt-6-sol' });
  const hinted = (await cli(s.env, 'whoami')).stdout;
  assert.match(hinted, /^sol \(agent\) · identity from harness \(codex\)/);
  assert.match(hinted, /hint: family 'sol' declares no harness.*iac set-models sol --harness codex/);
  assert.equal(JSON.parse((await cli(s.env, 'whoami', '--json')).stdout).familyHarness, null);

  const pinned = (await cli({}, 'set-models', 'sol', '--harness', 'codex')).stdout;
  assert.match(pinned, /a session running gpt-6-sol writes as sol/); assert.match(pinned, /only codex may attest sol/);
  a.store.invalidate();   // set-models ran in another process
  assert.equal(a.config().familyHarness.sol, 'codex');
  assert.deepEqual(a.config().families.sol, ['gpt-6-sol'], '--harness alone keeps the model globs');
  assert.doesNotMatch((await cli(s.env, 'whoami')).stdout, /hint:/);
  assert.equal(JSON.parse((await cli(s.env, 'whoami', '--json')).stdout).familyHarness, 'codex');

  await assert.rejects(cli({}, 'set-models', 'sol', '--harness', 'vim'), (e) => /--harness must be one of claude-code, codex/.test(e.stderr));
  await assert.rejects(cli({}, 'set-models', 'sol'), (e) => /usage: iac set-models/.test(e.stderr));
  await assert.rejects(cli({}, 'add-agent', 'luna', '--harness', 'vim'), (e) => /--harness must be one of/.test(e.stderr));
  assert.equal(a.registry().luna, undefined, 'an invalid --harness registers nothing');
  await cli({}, 'add-agent', 'luna', '--models', 'gpt-6-luna', '--harness', 'codex');
  // a glob an earlier family already covers can never take effect: warn, name the winner
  await cli({}, 'add-agent', 'alpha');
  const shadowed = await cli({}, 'set-models', 'alpha', '--models', 'claude-opus-*,acme-alpha-*', '--harness', 'claude-code', '--json');
  assert.match(shadowed.stderr, /warning: alpha's 'claude-opus-\*' overlaps opus's 'claude-opus-\*'; opus is earlier in families and wins/);
  assert.deepEqual(JSON.parse(shadowed.stdout).overlaps.map((x) => [x.glob, x.family, x.winner]), [['claude-opus-*', 'opus', 'opus']]);
  const human = await cli({}, 'set-models', 'alpha', '--models', 'claude-opus-*,acme-alpha-*');
  assert.match(human.stdout, /a session running acme-alpha-\* writes as alpha/);
  assert.doesNotMatch(human.stdout, /claude-opus-\* .*writes as alpha/, 'never claims a shadowed glob takes effect');
  const { familyForModel } = await import('../src/api.js');
  assert.equal(familyForModel('claude-opus-5-5', a.config(), { harness: 'claude-code' }), 'opus', 'the warning tells the truth');
  const broad = await cli({}, 'add-agent', 'nova', '--models', 'gpt-6-*', '--harness', 'codex');
  assert.match(broad.stderr, /nova's 'gpt-6-\*' overlaps (sol|luna)'s/);
  const clean = await cli({}, 'add-agent', 'vega', '--models', 'acme-vega-*', '--harness', 'claude-code');
  assert.equal(clean.stderr, '', 'no overlap, no warning');
  const pinnedApart = await cli({}, 'add-agent', 'orion', '--models', 'acme-vega-*', '--harness', 'codex');
  assert.equal(pinnedApart.stderr, '', 'families pinned to different harnesses never compete');
  assert.deepEqual([a.config().families.luna, a.config().familyHarness.luna], [['gpt-6-luna'], 'codex']);
  // an existing config.json written before familyHarness existed still gets the Claude defaults
  const cfgPath = path.join(home, 'config.json');
  const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); delete raw.familyHarness; fs.writeFileSync(cfgPath, JSON.stringify(raw)); a.store.invalidate();
  assert.deepEqual(a.config().familyHarness, { fable: 'claude-code', opus: 'claude-code', sonnet: 'claude-code', haiku: 'claude-code' });
});

test('brief and inbox never describe this instance\'s own claimed waits elsewhere as another instance\'s', async () => {
  const { brief } = await import('../src/format.js');
  const { a, clock } = fresh();
  const mineT = await a.open({ as: 'sol', title: 'acked by me', body: 'x', project: 'p/other', waitingOn: ['fable'] });
  clock.tick(MIN);
  await a.post({ as: 'fable', thread: mineT.thread, kind: 'ack', body: 'on it', instance: 'fable-a' });
  clock.tick(MIN);
  await a.open({ as: 'astra', title: 'unclaimed', body: 'x', project: 'p/third', waitingOn: ['fable'] });
  const line = brief(a, 'fable', { project: 'p/here', instance: 'fable-a' });
  assert.match(line, /1 wait you acked in other projects \(p\/other\)/);
  assert.match(line, /1 wait for other fable instances \(p\/third\), not yours/);
  assert.doesNotMatch(line, /other fable instances \([^)]*p\/other/);
  // another instance sees the claimed wait as claimed, not as its own
  assert.doesNotMatch(brief(a, 'fable', { project: 'p/here', instance: 'fable-b' }), /you acked/);
});

// A git that does not answer must not silently file a new thread under local:<dir>.
function slowGitShim() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-slowgit-'));
  fs.writeFileSync(path.join(dir, 'git'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  return dir;
}

// A fake clock for the deadline-arithmetic tests below: `now()` reads a counter that only
// `advance()` moves, so elapsed "time" is exact and never depends on real wall time or
// scheduling. See src/project.js probe(), which accepts `now`/`spawn` for exactly this.
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

// A fake `spawn` standing in for a git invocation that would (if ever let run to completion)
// take `durationMs` of wall time to answer — i.e. "git never answers" when durationMs is huge.
// It advances `clock` by exactly what a real spawnSync would have burned waiting on it: the
// smaller of `durationMs` and the timeout it was given, then reports a timeout if that budget
// was the binding constraint. No real process, no real sleep, no real elapsed time.
function fakeGit(durationMs, clock) {
  return (cmd, args, opts) => {
    const elapsed = Math.min(durationMs, opts.timeout);
    clock.advance(elapsed);
    if (durationMs > opts.timeout) return { error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) };
    return { status: 1, stdout: '', stderr: '' }; // git ran and said no (e.g. "no such key")
  };
}

// hookBrief/codexHook (src/cli.js) read process.env directly — they are a real hook's real
// environment — so testing them in-process means temporarily overriding process.env for the
// call, then restoring exactly what was there (including "absent"), the same way `withPath`
// used to scope PATH for the old shim-based test above.
async function withProcessEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) saved[k] = process.env[k];
  Object.assign(process.env, overrides);
  try { return await fn(); }
  finally {
    for (const k of Object.keys(overrides)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

// A fake stdin for readHookPayload/readCodexHookPayload (src/cli.js, src/codex-hook.js): ends
// at once, with `text` if given, so a hook's stdin read resolves on the next microtask instead
// of waiting out its real (bounded, but real-time) ~1500ms timer.
function fakeStdin(text = '') {
  const e = new EventEmitter();
  e.isTTY = false;
  e.pause = () => {};
  queueMicrotask(() => { if (text) e.emit('data', Buffer.from(text)); e.emit('end'); });
  return e;
}

test('detectProject: no remote or no repo is local:<dir>; a git that never answers is unknown, and only writes refuse', async () => {
  const { detectProject, clearProjectCache } = await import('../src/project.js');
  clearProjectCache();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-noremote-'));
  assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0);
  const sub = path.join(repo, 'sub'); fs.mkdirSync(sub);
  assert.equal(detectProject({ cwd: sub, env: {}, write: true }), `local:${path.basename(repo)}`, 'no remote: the repo top-level, as before');
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-norepo-'));
  assert.equal(detectProject({ cwd: plain, env: {}, write: true }), `local:${path.basename(plain)}`, 'not a repo: the directory, as before');
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-remote-'));
  spawnSync('git', ['init', '-q', remote]); spawnSync('git', ['-C', remote, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git']);
  assert.equal(detectProject({ cwd: remote, env: {} }), 'acme/widgets');

  // a remote added mid-process is seen at once: the cache never answers while git does
  assert.equal(detectProject({ cwd: sub, env: {} }), `local:${path.basename(repo)}`);
  spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/late.git']);
  assert.equal(detectProject({ cwd: sub, env: {}, write: true }), 'acme/late', 'a write sees the new remote');
  assert.equal(detectProject({ cwd: sub, env: {} }), 'acme/late', 'so does a read');

  // explicit and IAC_PROJECT still win without asking git at all: a spawn that throws proves it.
  const noGit = () => { throw new Error('git must not be asked'); };
  assert.equal(detectProject({ explicit: 'x/y', cwd: os.tmpdir(), write: true, spawn: noGit }), 'x/y');
  assert.equal(detectProject({ env: { IAC_PROJECT: 'o/r' }, cwd: os.tmpdir(), write: true, spawn: noGit }), 'o/r');

  // Below: a git that never answers, with an injected clock/spawn standing in for the real
  // subprocess and the real passage of time, so the deadline arithmetic is exact regardless of
  // machine load (no real sleeping child process, no wall-clock assertion).
  const slow = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-slowcwd-'));

  // a read whose git does not answer falls back to git's last answer for that cwd
  const c1 = fakeClock();
  assert.equal(detectProject({ cwd: remote, env: {}, timeout: 300, now: c1.now, spawn: fakeGit(60_000, c1) }), 'acme/widgets', 'cache hit');
  assert.equal(c1.now(), 300, 'the one git call spent exactly its budget, nothing more');

  // a write never trusts the cache
  const c2 = fakeClock();
  assert.throws(() => detectProject({ cwd: remote, env: {}, write: true, timeout: 300, now: c2.now, spawn: fakeGit(60_000, c2) }),
    (e) => e.code === 'project-unknown', 'a write never trusts the cache');

  // a read whose git never answers, and has no cache to fall back on, falls back to local:<dir>
  const c3 = fakeClock();
  assert.equal(detectProject({ cwd: slow, env: {}, timeout: 300, now: c3.now, spawn: fakeGit(60_000, c3) }),
    `local:${path.basename(slow)}`, 'a read falls back quietly');
  assert.equal(c3.now(), 300, 'one deadline, one call: not a fresh budget for a second attempt');

  // the same, for a write: it refuses rather than filing under local:<dir>
  const c4 = fakeClock();
  assert.throws(() => detectProject({ cwd: slow, env: {}, write: true, timeout: 300, now: c4.now, spawn: fakeGit(60_000, c4) }),
    (e) => e instanceof Rejected && e.code === 'project-unknown' && /--project owner\/repo or set IAC_PROJECT/.test(e.hint),
    'an unanswered git is not cached as local:<dir>, and a write refuses');
  assert.equal(c4.now(), 300);

  // the deadline is one shared budget across BOTH git calls, not a fresh one for each: a first
  // call that answers quickly (git says "no such key") leaves only what remains for the second.
  const c5 = fakeClock();
  const calls = [];
  const firstFastSecondHangs = (cmd, args, opts) => {
    calls.push({ args: [...args], timeout: opts.timeout });
    if (args.includes('config')) { c5.advance(50); return { status: 1, stdout: '', stderr: '' }; }
    const elapsed = Math.min(60_000, opts.timeout); // rev-parse: would take far longer than any budget left
    c5.advance(elapsed);
    return { error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) };
  };
  assert.throws(() => detectProject({ cwd: slow, env: {}, write: true, timeout: 300, now: c5.now, spawn: firstFastSecondHangs }),
    (e) => e.code === 'project-unknown');
  assert.equal(calls.length, 2, 'both git calls happened');
  assert.equal(calls[0].timeout, 300, 'the first call gets the full budget');
  assert.equal(calls[1].timeout, 250, 'the second call gets only what is left (300 - 50), not a fresh 300ms');
  assert.equal(c5.now(), 300, 'total elapsed is bounded by one deadline, not the sum of two');
});

// The real e2e test below widened its wall-clock bound for stability, which means it would
// no longer catch the read path accidentally using WRITE_TIMEOUT_MS (10s) instead of its own
// READ_TIMEOUT_MS (3s) — 10s still fits comfortably under the widened bound. These two tests
// close that gap deterministically, by calling the actual functions a hook runs
// (hookBrief/codexHook, exported from src/cli.js for exactly this) with an injected spawn, and
// asserting the exact timeout handed to git — not just "fast enough".
test('brief --hook hands detectProject a READ budget, never a WRITE one, and the deadline stays shared', async () => {
  const { hookBrief } = await import('../src/cli.js');
  const { READ_TIMEOUT_MS, WRITE_TIMEOUT_MS } = await import('../src/project.js');
  assert.notEqual(READ_TIMEOUT_MS, WRITE_TIMEOUT_MS, 'the two budgets must differ for this test to mean anything');
  const { home } = fresh(); // registers fable
  const calls = [];
  const c = fakeClock();
  const firstFastSecondHangs = (cmd, args, opts) => {
    calls.push({ args: [...args], timeout: opts.timeout });
    if (args.includes('config')) { c.advance(10); return { status: 1, stdout: '', stderr: '' }; }
    c.advance(Math.min(60_000, opts.timeout)); // rev-parse: would hang far longer than any budget left
    return { error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) };
  };
  const env = { ...HARNESS_CLEAN, IAC_HOME: home, IAC_AGENT: 'fable', IAC_PROJECT: '', AGORA_PROJECT: '' };
  const log = console.log; console.log = () => {}; // hookBrief prints the brief; not under test here
  try {
    await withProcessEnv(env, () => hookBrief({}, { now: c.now, spawn: firstFastSecondHangs, stdin: fakeStdin() }));
  } finally { console.log = log; }
  assert.equal(calls.length, 2, 'brief --hook actually asked git, both calls');
  assert.equal(calls[0].timeout, READ_TIMEOUT_MS, 'brief --hook probes with the READ budget, not WRITE_TIMEOUT_MS');
  assert.equal(calls[1].timeout, READ_TIMEOUT_MS - 10, 'one shared READ deadline, not a fresh READ_TIMEOUT_MS for the second call');
});

test('codex-hook hands detectProject a READ budget too', async () => {
  const { codexHook } = await import('../src/cli.js');
  const { READ_TIMEOUT_MS } = await import('../src/project.js');
  const { a, home } = fresh(); a.setFamilyModels('sol', ['gpt-6-sol']);
  const s = fakeCodexSession({ model: 'gpt-6-sol' });
  const calls = [];
  const c = fakeClock();
  const neverAnswers = (cmd, args, opts) => {
    calls.push({ args: [...args], timeout: opts.timeout });
    c.advance(Math.min(60_000, opts.timeout));
    return { error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) };
  };
  const payload = JSON.stringify({ session_id: s.id, transcript_path: s.file, hook_event_name: 'UserPromptSubmit', cwd: process.cwd() });
  const env = { ...HARNESS_CLEAN, ...s.env, IAC_HOME: home, IAC_PROJECT: '', AGORA_PROJECT: '' };
  const log = console.log; console.log = () => {};
  try {
    await withProcessEnv(env, () => codexHook([], { now: c.now, spawn: neverAnswers, stdin: fakeStdin(payload) }));
  } finally { console.log = log; }
  assert.equal(calls.length, 1, 'codex-hook asked git once (the first call already exhausts the deadline)');
  assert.equal(calls[0].timeout, READ_TIMEOUT_MS, 'codex-hook probes with the READ budget, not WRITE_TIMEOUT_MS');
});

// Mutation gap: comparing a hook's scheduled ms to the HOOK_STDIN_MS/CODEX_HOOK_STDIN_MS
// constant proves nothing if the constant itself is wrong — the two tests above (the first by
// pinning HOOK_STDIN_MS to a literal) and the two below (by pinning the literal directly) close
// that: a mutant that inflates either constant, or one that has hookBrief/codexHook pass their
// own `ms` override to the stdin reader, must fail one of these.
test('brief --hook uses its real stdin-wait budget: pinned to a literal, not an override', async () => {
  const { hookBrief } = await import('../src/cli.js');
  const { home } = fresh();
  const scheduled = [];
  const schedule = (fn, ms) => { scheduled.push(ms); queueMicrotask(fn); return 0; };
  const fastGit = () => ({ status: 1, stdout: '', stderr: '' }); // answers "no such key" at once
  const env = { ...HARNESS_CLEAN, IAC_HOME: home, IAC_AGENT: 'fable', IAC_PROJECT: '', AGORA_PROJECT: '' };
  const log = console.log; console.log = () => {};
  try {
    await withProcessEnv(env, () => hookBrief({}, { stdin: idleStdin(), schedule, spawn: fastGit }));
  } finally { console.log = log; }
  assert.deepEqual(scheduled, [1500], 'hookBrief must use the real (short) stdin-wait budget, not an override');
});

test('codex-hook uses its real stdin-wait budget: pinned to a literal, not an override', async () => {
  const { codexHook } = await import('../src/cli.js');
  const { CODEX_HOOK_STDIN_MS } = await import('../src/codex-hook.js');
  assert.equal(CODEX_HOOK_STDIN_MS, 1500, 'the stdin-wait budget must be pinned; this hook runs on every prompt too');
  const scheduled = [];
  const schedule = (fn, ms) => { scheduled.push(ms); queueMicrotask(fn); return 0; };
  await codexHook([], { stdin: idleStdin(), schedule });
  assert.deepEqual(scheduled, [1500], 'codex-hook must use the real (short) stdin-wait budget, not an override');
});

test('detectProject: a .git that git refuses to read (dubious ownership) makes writes refuse', { skip: process.platform === 'win32' }, async () => {
  const { detectProject } = await import('../src/project.js');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-dubious-'));
  spawnSync('git', ['init', '-q', repo]); spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:acme/owned.git']);
  const sub = path.join(repo, 'sub'); fs.mkdirSync(sub);
  const old = process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER; process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';
  try {
    if (spawnSync('git', ['-C', sub, 'rev-parse', '--show-toplevel']).status === 0) return;  // this git ignores the knob
    assert.throws(() => detectProject({ cwd: sub, env: {}, write: true }),
      (e) => e.code === 'project-unknown' && /has a \.git/.test(e.message), 'not filed under local:sub');
    assert.equal(detectProject({ cwd: sub, env: {} }), 'local:sub', 'a read may still fall back');
    assert.equal(detectProject({ cwd: sub, env: { IAC_PROJECT: 'acme/owned' }, write: true }), 'acme/owned');
  } finally { if (old === undefined) delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER; else process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = old; }
});

// The one real end-to-end test for the git timeout: a genuinely hanging external git, through the
// actual CLI process. Its bounds are generous multiples of the real timeouts detectProject()
// uses (project.js READ_TIMEOUT_MS / WRITE_TIMEOUT_MS), not arbitrary numbers, so they track
// those constants if they change and leave ample headroom for a loaded machine. Everything
// timing-sensitive beyond this one test is covered deterministically above with a fake clock.
test('iac open refuses project-unknown when git hangs; brief --hook stays silent and fast', { skip: process.platform === 'win32', timeout: 120_000 }, async () => {
  const { READ_TIMEOUT_MS, WRITE_TIMEOUT_MS } = await import('../src/project.js');
  const HOOK_SPAWN_TIMEOUT = READ_TIMEOUT_MS + 20_000;
  const HOOK_BOUND = READ_TIMEOUT_MS + 15_000;
  const OPEN_SPAWN_TIMEOUT = WRITE_TIMEOUT_MS + 20_000;
  const { home } = fresh();
  const shim = slowGitShim();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-slowcwd-'));
  const bin = path.join(import.meta.dirname, '..', 'bin', 'iac.js');
  const env = { PATH: `${shim}${path.delimiter}${process.env.PATH}`, HOME: home, IAC_HOME: home, IAC_AGENT: 'fable' };
  let t0 = Date.now();
  const hook = spawnSync(process.execPath, [bin, 'brief', '--hook'], { env, cwd, input: '', encoding: 'utf8', timeout: HOOK_SPAWN_TIMEOUT });
  assert.equal(hook.status, 0); assert.equal(hook.stderr, '');
  assert.ok(Date.now() - t0 < HOOK_BOUND, `hook took ${Date.now() - t0} ms (bound ${HOOK_BOUND} ms, tied to READ_TIMEOUT_MS=${READ_TIMEOUT_MS})`);
  const open = spawnSync(process.execPath, [bin, 'open', '--title', 'T', '--body', 'b'], { env, cwd, encoding: 'utf8', timeout: OPEN_SPAWN_TIMEOUT });
  assert.equal(open.status, 2, open.stderr);
  assert.match(open.stderr, /REJECTED \(project-unknown\)/);
  assert.match(open.stderr, /--project owner\/repo or set IAC_PROJECT/);
  assert.equal(new Agora(home, { env: {} }).threads().length, 0, 'nothing was filed under local:<dir>');
  const ok = spawnSync(process.execPath, [bin, 'open', '--title', 'T', '--body', 'b', '--project', 'o/r'], { env, cwd, encoding: 'utf8', timeout: OPEN_SPAWN_TIMEOUT });
  assert.equal(ok.status, 0, ok.stderr);
});

test('declaredHarness: two spellings that agree once normalised are one pin', async () => {
  const { declaredHarness } = await import('../src/api.js');
  assert.equal(declaredHarness('opus', { familyHarness: { opus: 'claude-code', OPUS: 'Claude-Code' } }), 'claude-code');
  assert.equal(declaredHarness('opus', { familyHarness: { opus: ' claude-code', Opus: 'CLAUDE-CODE ' } }), 'claude-code');
  assert.equal(declaredHarness('opus', { familyHarness: { opus: 'claude-code', OPUS: 'codex' } }), 'invalid');
  assert.equal(declaredHarness('opus', { familyHarness: { opus: 'claude-code', OPUS: ['claude-code'] } }), 'invalid');
});

test('a root-only CODEX_SESSION_ID is read-only in the CLI, even with a launcher binding', async () => {
  const { resolveIdentity, harnessTaskId } = await import('../src/api.js');
  const { a, home } = fresh(); a.setFamilyModels('sol', ['gpt-6-sol']);
  // the root's own rollout exists and attests: still not proof, a child inherits the same SESSION
  const root = fakeCodexSession({ id: 'root', model: 'gpt-6-sol' });
  const env = { ...root.env, CODEX_THREAD_ID: '' };
  const id = new Agora(home, { env }).identity();
  assert.equal(id.agent, null); assert.equal(id.harness, 'codex'); assert.equal(id.rootOnly, true);
  assert.match(id.reason, /only the root session id .*cannot tell which task is writing/);
  assert.match(id.todo, /CODEX_THREAD_ID/);
  assert.equal(harnessTaskId(env), null);
  throwsRejected(() => resolveIdentity({ explicit: 'sol', env, config: a.config(), registry: a.registry() }), 'identity-override');
  await rejects(new Agora(home, { env }).open({ as: 'sol', project: 'o/r', title: 'root-only', body: 'x' }), 'unattested-identity');
  const bound = new Agora(home, { env: { ...env, IAC_AGENT: 'sol', IAC_INSTANCE: 'sol-launched' } });
  assert.equal(bound.identity().agent, 'sol', 'reads still name the launcher binding');
  await rejects(bound.open({ as: 'sol', project: 'o/r', title: 'root-only bound', body: 'x' }), 'unattested-identity');
  assert.equal(a.threads().length, 0);
  // with Claude ids too, it remains the nested-harness ambiguity, not a Claude session
  assert.equal(new Agora(home, { env: { ...env, CLAUDE_CODE_SESSION_ID: 'c1' } }).identity().harness, 'ambiguous');
  // the task id, when exposed, still attests
  assert.equal(new Agora(home, { env: root.env }).identity().agent, 'sol');
});

test('an archived Codex session attests nothing: Codex will not resume one until unarchived', async () => {
  const { codexRolloutPath } = await import('../src/codex-hook.js');
  const { a, home } = fresh(); a.setFamilyModels('sol', ['gpt-6-sol']);
  const s = fakeCodexSession({ id: 'archived-1', model: 'gpt-6-sol' });
  const archive = path.join(s.codex, 'archived_sessions'); fs.mkdirSync(archive);
  const moved = path.join(archive, path.basename(s.file)); fs.renameSync(s.file, moved); // Codex keeps archives flat
  assert.equal(codexRolloutPath(s.id, s.env), null, 'archived_sessions is never searched');
  const id = new Agora(home, { env: s.env }).identity();
  assert.equal(id.agent, null); assert.match(id.reason, /no session record found/);
  await rejects(new Agora(home, { env: s.env }).open({ as: 'sol', project: 'o/r', title: 'archived', body: 'x' }), 'unattested-identity');
  fs.renameSync(moved, s.file); // codex unarchive moves it back into sessions/
  assert.equal(new Agora(home, { env: s.env }).identity().agent, 'sol');
});

test('a relative CODEX_HOME gives no Codex attestation, whatever the cwd', async () => {
  const { codexRolloutPath, codexHomeIsAbsolute } = await import('../src/codex-hook.js');
  const { a, home } = fresh(); a.setFamilyModels('sol', ['gpt-6-sol']);
  const s = fakeCodexSession({ id: 'rel-1', model: 'gpt-6-sol' });
  // Run from the rollout's parent so the relative path really resolves here: on Windows CI the
  // checkout (D:) and the temp dir (C:) differ, and path.relative across drives is absolute.
  const cwd = process.cwd(); process.chdir(path.dirname(s.codex));
  try {
    const rel = path.relative(process.cwd(), s.codex);
    assert.ok(!path.isAbsolute(rel), rel);
    const env = { ...s.env, CODEX_HOME: rel };
    assert.equal(codexRolloutPath(s.id, env), null, 'not resolved against this process cwd, though it would be found there');
    const id = new Agora(home, { env }).identity();
    assert.equal(id.agent, null); assert.match(id.reason, /CODEX_HOME is a relative path/); assert.match(id.todo, /absolute path/);
    await rejects(new Agora(home, { env }).open({ as: 'sol', project: 'o/r', title: 'relative home', body: 'x' }), 'unattested-identity');
  } finally { process.chdir(cwd); }
  const env = { ...s.env };
  assert.equal(new Agora(home, { env: { ...env, CODEX_HOME: '' } }).identity().agent, 'sol', 'empty CODEX_HOME is unset: HOME/.codex');
  assert.equal(new Agora(home, { env: s.env }).identity().agent, 'sol');
  for (const [v, plat, want] of [['/x', 'linux', true], ['x', 'linux', false], ['./x', 'linux', false], ['C:\\x', 'win32', true],
    ['C:/x', 'win32', true], ['\\\\srv\\share', 'win32', true], ['\\x', 'win32', false], ['C:x', 'win32', false], ['x', 'win32', false]]) {
    assert.equal(codexHomeIsAbsolute(v, plat), want, `${plat} ${v}`);
  }
});

test('whoami says a root-only Codex session is read-only even under a launcher binding', () => {
  const { a, home } = fresh(); a.setFamilyModels('sol', ['gpt-6-sol']);
  const root = fakeCodexSession({ id: 'root', model: 'gpt-6-sol' });
  const bin = path.join(import.meta.dirname, '..', 'bin', 'iac.js');
  const env = { PATH: process.env.PATH, ...root.env, CODEX_THREAD_ID: '', IAC_HOME: home, IAC_AGENT: 'astra', IAC_PROJECT: 'o/r' };
  const run = (...args) => spawnSync(process.execPath, [bin, 'whoami', ...args], { env, encoding: 'utf8', timeout: 10_000 });
  const j = JSON.parse(run('--json').stdout);
  assert.equal(j.name, 'astra'); assert.equal(j.source, 'launcher'); assert.equal(j.rootOnly, true);
  assert.match(j.readOnly, /only the root session id .*cannot tell which task is writing/);
  const text = run().stdout;
  assert.match(text, /^astra \(agent\) · identity from IAC_AGENT \(launcher\)/);
  assert.match(text, /^read-only: Codex exposed only the root session id/m);
  assert.match(text, /^fix: run iac from a Codex task shell, which exports CODEX_THREAD_ID/m);
  // a normal launcher binding has no read-only line
  const plain = spawnSync(process.execPath, [bin, 'whoami', '--json'], { env: { ...env, CODEX_SESSION_ID: '' }, encoding: 'utf8', timeout: 10_000 });
  const pj = JSON.parse(plain.stdout); assert.equal(pj.readOnly, undefined); assert.equal(pj.rootOnly, undefined);
});

// ---- read-cache correctness -------------------------------------------

/** Rewrite this store's config/registry from a separate Node process, the way another agent's CLI would. */
function otherProcess(home, js) {
  const storeUrl = new URL('../src/store.js', import.meta.url).href;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { Store } from ${JSON.stringify(storeUrl)}; const st = new Store(process.argv[1]); ${js}`, home],
    { env: { PATH: process.env.PATH || '' }, encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.status, 0, r.stderr);
}

test('cache: write guards read config and registry inside the lock, not from a pre-lock cached copy', async () => {
  const { a, home } = fresh();
  const t = (await a.open({ as: 'fable', title: 'primed', body: 'x', mentions: ['sol'] })).thread;
  a.config(); a.registry(); a.threads();   // prime this process's cache
  otherProcess(home, 'const c = st.config(); c.limits.titleMax = 1; c.limits.postBodyMax = 1; st.saveConfig(c);');
  await rejects(a.open({ as: 'opus', title: 'Long title', body: 'x' }), 'too-long');
  await rejects(a.post({ as: 'opus', thread: t, body: 'longer than one' }), 'too-long');
  assert.equal(a.config().limits.titleMax, 1);
  otherProcess(home, 'const c = st.config(); c.limits.titleMax = 80; c.limits.postBodyMax = 1500; st.saveConfig(c);');
  assert.ok(a.registry().astra); a.config();   // re-prime: astra is registered
  otherProcess(home, 'const r = st.registry(); delete r.astra; st.saveRegistry(r);');
  await rejects(a.post({ as: 'opus', thread: t, body: 'ping @astra' }), 'unknown-mention');
  await rejects(a.open({ as: 'opus', title: 'ping', body: 'x', waitingOn: ['astra'] }), 'unknown-mention');
  await rejects(a.lock({ as: 'astra', thread: t }), 'unknown-author');
  await rejects(a.setProject({ as: 'astra', thread: t, project: 'o/r' }), 'unknown-author');
  await rejects(a.clearWait({ as: 'astra', thread: t }), 'unknown-author');
  // a config read-modify-write outside the lock starts from disk too, so it cannot undo another process's change
  a.config();
  otherProcess(home, 'const c = st.config(); c.limits.titleMax = 7; st.saveConfig(c);');
  a.setLaunch('sol', ['codex']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).limits.titleMax, 7);
});

test('cache: store spellings fold to one key where no physical id is available', () => {
  const fail = () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); };
  const win = (p, realpath = fail) => storeCacheKey(p, { platform: 'win32', realpath, stat: fail });
  const want = 'c:\\Users\\u\\.agora';
  for (const v of ['C:\\Users\\u\\.agora', 'c:\\Users\\u\\.agora', 'C:/Users/u/.agora', 'C:\\Users\\u\\.agora\\', '\\\\?\\C:\\Users\\u\\.agora',
    '\\\\?\\c:\\Users\\u\\.agora', '//?/C:/Users/u/.agora', 'C:\\Users\\u\\x\\..\\.agora']) {
    assert.deepEqual(win(v), { key: want, id: null, found: false }, `unresolved ${v}`);
    // an existing directory resolves through realpath, which may itself answer with the \\?\ spelling
    assert.equal(win(v, () => '\\\\?\\C:\\Users\\u\\.agora').key, want, `realpath ${v}`);
  }
  assert.equal(win('\\\\?\\UNC\\srv\\share\\agora').key, win('\\\\srv\\share\\agora').key);
  assert.equal(win('\\\\wsl$\\Ubuntu\\home\\u\\.agora').key, win('\\\\wsl.localhost\\Ubuntu\\home\\u\\.agora').key);
  assert.notEqual(win('C:\\Users\\u\\.agora').key, win('D:\\Users\\u\\.agora').key);
  assert.equal(storeCacheKey('/x/./y/../z', { platform: 'linux', realpath: fail, stat: fail }).key, '/x/z');
});

test('cache: physical identity joins every alias of one directory, and only a usable one', () => {
  const dir = (dev, ino) => () => ({ dev, ino, isDirectory: () => true });
  const real = () => { throw new Error('realpath must not be needed when the directory has an id'); };
  const k = (p, stat, platform = 'linux') => storeCacheKey(p, { platform, realpath: real, stat });
  // WSL drvfs folds case and Windows UNC/admin-share spellings reach the same NTFS directory: one id, distinct keys
  assert.deepEqual(k('/mnt/c/Users/x/Store', dir(67n, 11n)), { key: '/mnt/c/Users/x/Store', id: '67:11', found: true });
  assert.equal(k('/mnt/c/users/x/STORE', dir(67n, 11n)).id, '67:11');
  for (const v of ['C:\\x\\store', '\\\\localhost\\C$\\x\\store', '\\\\?\\UNC\\localhost\\C$\\x\\store', 'C:\\X\\STORE']) {
    assert.equal(k(v, dir(1321925182n, 99n), 'win32').id, '1321925182:99', v);
  }
  // dev or ino 0 (Windows reports dev 0 for \\wsl.localhost) is no identity: fall back to the folded realpath key
  const fallback = storeCacheKey('\\\\wsl$\\Ubuntu\\s', { platform: 'win32', stat: dir(0n, 5n), realpath: () => { throw new Error('x'); } });
  assert.deepEqual(fallback, { key: '\\\\wsl.localhost\\Ubuntu\\s', id: null, found: true });
  assert.equal(storeCacheKey('/s', { platform: 'linux', stat: dir(5n, 0n), realpath: () => '/real/s' }).id, null);
  assert.equal(storeCacheKey('/s', { platform: 'linux', stat: () => ({ dev: 5n, ino: 6n, isDirectory: () => false }), realpath: () => '/s' }).id, null);
});

/** Start the thread file, or append to it once it exists (appendEvent never creates one). */
function putEvent(st, id, ev) { try { st.createThread(id, ev); } catch (e) { if (e.code !== 'EEXIST') throw e; st.appendEvent(id, ev); } }

/** A reader primed through `home` must see a write made through `alt`, and the other way round. */
function assertAliasInvalidates(home, alt) {
  for (const [r, w] of [[home, alt], [alt, home]]) {
    const reader = new Store(r);
    reader.writeJson('config.json', E({ label: 'before' }));
    assert.equal(reader.readJson('config.json', {}).label, 'before');   // primed
    new Store(w).writeJson('config.json', E({ label: 'after' }));
    assert.equal(reader.readJson('config.json', {}).label, 'after', `a write through ${w} invalidates a reader on ${r}`);
    putEvent(reader, 't-aaaaaa', E({ v: 1 })); const n = reader.readEvents('t-aaaaaa').length;
    new Store(w).appendEvent('t-aaaaaa', E({ v: 2 }));
    assert.equal(reader.readEvents('t-aaaaaa').length, n + 1, `events through ${w}`);
  }
}

test('cache: real aliases of one store share invalidation (symlink; drvfs case; Windows UNC, \\\\?\\, junction, case)', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-alias-'));
  try {
    const home = path.join(base, 'store'); new Store(home).ensureDirs();
    if (process.platform === 'win32') {
      const abs = path.resolve(home);
      assertAliasInvalidates(home, `\\\\?\\${abs}`);
      assertAliasInvalidates(home, abs.replace(/\\/g, '/'));
      assertAliasInvalidates(home, abs.toUpperCase());
      assertAliasInvalidates(home, abs[0].toLowerCase() + abs.slice(1));
      assertAliasInvalidates(home, `\\\\localhost\\${abs[0]}$${abs.slice(2)}`);
      assertAliasInvalidates(home, `\\\\?\\UNC\\localhost\\${abs[0]}$${abs.slice(2)}`);
      const jn = path.join(base, 'jn'); fs.symlinkSync(home, jn, 'junction');
      assertAliasInvalidates(home, jn);
    } else {
      const link = path.join(base, 'link'); fs.symlinkSync(home, link);
      assertAliasInvalidates(home, link);
      assertAliasInvalidates(home, path.join(base, 'link', '.', ''));
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
  // WSL: drvfs on /mnt/c is case-insensitive, which Linux realpath does not fold
  let user = ''; try { user = os.userInfo().username; } catch {}
  const winTmp = `/mnt/c/Users/${user}/AppData/Local/Temp`;
  if (process.platform !== 'linux' || !user || !fs.existsSync(winTmp)) { t.diagnostic('no WSL drvfs here: drvfs case alias not exercised'); return; }
  const dbase = fs.mkdtempSync(path.join(winTmp, 'iac-alias-'));
  try {
    const dhome = path.join(dbase, 'Store'); new Store(dhome).ensureDirs();
    assertAliasInvalidates(dhome, path.join(dbase.replace('/AppData/Local/Temp/', '/appdata/local/temp/'), 'STORE'));
  } finally { fs.rmSync(dbase, { recursive: true, force: true }); }
});

test('cache: a retargeted symlinked home is followed at the next invalidate, and a reused inode never serves another store', () => {
  // Windows: a junction, which needs no privileges, stands in for the symlink
  const link_ = (target, at) => fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-retarget-'));
  try {
    const one = path.join(base, 'one'); const two = path.join(base, 'two'); const link = path.join(base, 'home');
    new Store(one).ensureDirs(); new Store(two).ensureDirs();
    new Store(one).writeJson('config.json', E({ label: 'one' })); new Store(two).writeJson('config.json', E({ label: 'two' }));
    link_(one, link);
    const reader = new Store(link);
    assert.equal(reader.readJson('config.json', {}).label, 'one');
    fs.unlinkSync(link); link_(two, link);
    reader.invalidate();   // what a lock or an MCP request does
    assert.equal(reader.readJson('config.json', {}).label, 'two');
    new Store(two).writeJson('config.json', E({ label: 'two-after' }));
    assert.equal(reader.readJson('config.json', {}).label, 'two-after', 'writes through the new target now invalidate the link reader');

    // delete a store and create another elsewhere: ext4 hands the next directory the freed inode at once
    const gone = path.join(base, 'gone'); const old = new Store(gone); old.ensureDirs();
    old.writeJson('config.json', E({ label: 'gone' })); assert.equal(old.readJson('config.json', {}).label, 'gone');
    fs.rmSync(gone, { recursive: true, force: true });
    const fresh2 = path.join(base, 'fresh'); fs.mkdirSync(fresh2);
    fs.writeFileSync(path.join(fresh2, 'config.json'), JSON.stringify(E({ label: 'fresh' })));
    assert.equal(new Store(fresh2).readJson('config.json', {}).label, 'fresh');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('cache: a write that fails part-way leaves no stale cached copy behind', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-partial-'));
  const st = new Store(home); st.ensureDirs();
  const patch = (name, impl, body) => {
    const orig = fs[name]; fs[name] = (...args) => impl(orig, ...args);
    try { body(); } finally { fs[name] = orig; }
  };
  const enospc = () => Object.assign(new Error('simulated disk full'), { code: 'ENOSPC' });

  // append: four bytes land, then ENOSPC. The reader must see the torn disk, as an uncached read would.
  st.createThread('t-aaaaaa', E({ v: 1 }));
  assert.deepEqual(st.readEvents('t-aaaaaa'), [E({ v: 1 })]);
  patch('appendFileSync', (orig, file, text) => { orig(file, text.slice(0, 4)); throw enospc(); },
    () => assert.throws(() => st.appendEvent('t-aaaaaa', E({ v: 2 })), /disk full/));
  assert.equal(fs.readFileSync(st.threadPath('t-aaaaaa'), 'utf8'), JSON.stringify(E({ v: 1 })) + '\n' + JSON.stringify(E({ v: 2 })).slice(0, 4));
  assert.deepEqual(st.readEvents('t-aaaaaa'), [E({ v: 1 })], 'the torn line is skipped, not thrown');
  assert.deepEqual(st.readEventsDetailed('t-aaaaaa').damaged, [{ thread: 't-aaaaaa', line: 2, kind: 'unparseable' }]);

  // writeJson: the rename lands, then the call throws
  st.writeJson('config.json', E({ label: 'before' }));
  assert.equal(st.readJson('config.json', {}).label, 'before');
  patch('renameSync', (orig, ...args) => { orig(...args); throw enospc(); },
    () => assert.throws(() => st.writeJson('config.json', E({ label: 'after' })), /disk full/));
  assert.equal(st.readJson('config.json', {}).label, 'after');

  // deleteThread: the file goes, then the call throws
  st.createThread('t-bbbbbb', E({ v: 1 }));
  assert.ok(st.threadIds().includes('t-bbbbbb')); assert.ok(st.readEvents('t-bbbbbb'));
  patch('rmSync', (orig, ...args) => { orig(...args); throw enospc(); },
    () => assert.throws(() => st.deleteThread('t-bbbbbb'), /disk full/));
  assert.equal(st.readEvents('t-bbbbbb'), null);
  assert.ok(!st.threadIds().includes('t-bbbbbb'));
});

test('cache: the cache key is resolved once per invalidate or write, not per read, even with no usable id', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-keycost-'));
  try {
    let stats = 0; let reals = 0; let exists = false;
    // what native Windows reports for a \\wsl.localhost share: a directory, dev 0
    const cacheKey = {
      stat: () => { stats++; if (!exists) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return { dev: 0n, ino: 42n, isDirectory: () => true }; },
      realpath: (p) => { reals++; if (!exists) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return p; },
    };
    const st = new Store(home, { cacheKey });
    st.readJson('config.json', {}); st.readJson('config.json', {});
    assert.equal(stats, 2, 'until the directory exists, every use re-resolves');
    exists = true; stats = 0; reals = 0;
    for (let i = 0; i < 50; i++) { st.readJson('config.json', {}); st.threadIds(); st.readEvents('t-aaaaaa'); st.exists(); }
    assert.equal(stats, 1, 'one stat for 200 reads'); assert.equal(reals, 1, 'one realpath for 200 reads');
    for (let n = 1; n <= 3; n++) {
      st.invalidate();
      for (let i = 0; i < 20; i++) st.readJson('config.json', {});
      assert.equal(stats, 1 + n, `invalidate cycle ${n}: one more resolve`); assert.equal(reals, 1 + n);
    }
    st.ensureDirs(); st.writeJson('config.json', { a: 1 }); st.createThread('t-aaaaaa', E({ v: 1 }));
    for (let i = 0; i < 20; i++) { st.readJson('config.json', {}); st.readEvents('t-aaaaaa'); }
    assert.equal(stats, 8, 'two resolves per write (before and after it), none per read');
    assert.equal(st.readJson('config.json', {}).a, 1);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('cache: a retargeted junction or symlink never serves its previous target, even to a new Store or mid-write', () => {
  const linkTo = (target, at) => fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-retarget2-'));
  try {
    const one = path.join(base, 'one'); const two = path.join(base, 'two'); const link = path.join(base, 'home');
    for (const [dir, label] of [[one, 'one'], [two, 'two']]) { const st = new Store(dir); st.ensureDirs(); st.writeJson('config.json', { label }); }

    // (1) prime through the link, retarget it, and read through a NEW Store on the same spelling
    linkTo(one, link);
    assert.equal(new Store(link).readJson('config.json', {}).label, 'one');
    fs.unlinkSync(link); linkTo(two, link);
    assert.notEqual(storeCacheKey(one).id, storeCacheKey(two).id);
    assert.equal(new Store(link).readJson('config.json', {}).label, 'two', 'an entry read under the old target is a miss');

    // (2) the link is retargeted between the write's own identity lookup and the append itself
    const peer = new Store(two);
    new Store(one).createThread('t-aaaaaa', E({ label: 'one' }));
    peer.createThread('t-aaaaaa', E({ label: 'two' }));
    assert.equal(peer.readEvents('t-aaaaaa').length, 1);
    fs.unlinkSync(link); linkTo(one, link);
    const writer = new Store(link); writer.readEvents('t-aaaaaa');
    const append = fs.appendFileSync;
    fs.appendFileSync = (file, text) => { fs.unlinkSync(link); linkTo(two, link); append(file, text); };
    try { writer.appendEvent('t-aaaaaa', E({ label: 'retargeted append' })); } finally { fs.appendFileSync = append; }
    assert.equal(fs.readFileSync(peer.threadPath('t-aaaaaa'), 'utf8').trim().split('\n').length, 2);
    assert.equal(peer.readEvents('t-aaaaaa').length, 2, 'the directory actually written is invalidated');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ---- rename to inter-agent-comms (0.3.0): aliases, legacy env and stores, old signed logs ----

const ROOT = path.join(import.meta.dirname, '..');
const binPath = (name) => path.join(ROOT, 'bin', name);
const runBin = (name, args, { env = {}, input } = {}) => spawnSync(process.execPath, [binPath(name), ...args],
  { env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, ...HARNESS_CLEAN, ...env }, input, encoding: 'utf8', timeout: 20_000 });

test('package bins: iac and inter-agent-comms share one entry; agora, agora-mcp, agora-launch remain as aliases', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.3.2');
  assert.deepEqual(pkg.bin, {
    iac: 'bin/iac.js', 'inter-agent-comms': 'bin/iac.js', 'iac-mcp': 'bin/iac-mcp.js', 'iac-launch': 'bin/iac-launch.js',
    agora: 'bin/agora.js', 'agora-mcp': 'bin/agora-mcp.js', 'agora-launch': 'bin/agora-launch.js',
  });
  for (const f of Object.values(pkg.bin)) assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), /^#!\/usr\/bin\/env node\n/, f);
  for (const f of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')).version, pkg.version, f);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin/marketplace.json'), 'utf8')).metadata.version, pkg.version);
});

test('the agora alias runs the same CLI against the same store; a non-interactive run prints no notice', async () => {
  const { a, home } = fresh(); noIdle(a);
  const { thread } = await a.open({ as: 'fable', title: 'alias', body: 'hello' });
  for (const name of ['iac.js', 'agora.js']) {
    const r = runBin(name, ['list', '--home', home]);
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, new RegExp(thread)); assert.equal(r.stderr, '', `${name}: stderr is not a TTY, so no notice`);
  }
  assert.match(runBin('agora.js', ['--help']).stdout, /^iac \(inter-agent-comms\)/);
  for (const name of ['iac.js', 'agora.js']) assert.equal(runBin(name, ['--version']).stdout, '0.3.2\n', `${name} --version`);
});

test('deprecation notice: interactive agora only, never in hook or MCP modes', async () => {
  const { deprecationNotice } = await import('../src/env.js');
  const tty = () => { const s = { isTTY: true, out: '', write: (x) => { s.out += x; } }; return s; };
  for (const argv of [['brief', '--hook'], ['brief', '--hook=1'], ['codex-hook'], ['mcp']]) {
    const s = tty(); assert.equal(deprecationNotice('agora', 'iac', argv, s), false, argv.join(' ')); assert.equal(s.out, '');
  }
  const s = tty(); assert.equal(deprecationNotice('agora', 'iac', ['list'], s), true); assert.match(s.out, /^agora: deprecated; use iac/);
  for (const argv of [['list', '--json'], ['whoami', '--json=true']]) {
    const t = tty(); assert.equal(deprecationNotice('agora', 'iac', argv, t), false, argv.join(' ')); assert.equal(t.out, '', '--json output stays clean');
  }
  const pipe = { isTTY: false, write: () => assert.fail('no notice to a pipe') };
  assert.equal(deprecationNotice('agora', 'iac', ['list'], pipe), false);
});

test('hooks through the agora alias stay silent and exit 0, whatever the input', () => {
  const { home } = fresh();
  for (const input of ['', 'not json', JSON.stringify({ session_id: 'x', transcript_path: '/nope' })]) {
    const claude = runBin('agora.js', ['brief', '--hook'], { env: { IAC_HOME: home }, input });
    assert.deepEqual([claude.status, claude.stdout, claude.stderr], [0, '', ''], `brief --hook ${JSON.stringify(input)}`);
    const codex = runBin('agora.js', ['codex-hook'], { env: { IAC_HOME: home }, input });
    assert.deepEqual([codex.status, codex.stdout, codex.stderr], [0, '', ''], `codex-hook ${JSON.stringify(input)}`);
  }
  const bad = runBin('agora.js', ['brief', '--hook', '--no-such-flag'], { env: { IAC_HOME: home } });
  assert.deepEqual([bad.status, bad.stdout, bad.stderr], [0, '', '']);
});

test('iac-launch and agora-launch set IAC_* and, for one release, AGORA_* in the child', () => {
  const { home } = fresh();
  // a script file, not -e: on Windows the launcher hands one quoted line to cmd.exe
  const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'iac-probe-')), 'probe.mjs');
  fs.writeFileSync(script, "for (const k of ['IAC_AGENT','IAC_HOME','IAC_INSTANCE','AGORA_AGENT','AGORA_HOME','AGORA_INSTANCE']) console.log(k + '=' + (process.env[k] || ''));\n");
  const probe = ['--', process.execPath, script];
  for (const name of ['iac-launch.js', 'agora-launch.js']) {
    const r = runBin(name, ['opus', ...probe], { env: { IAC_HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    const env = Object.fromEntries(r.stdout.trim().split(/\r?\n/).map((l) => l.split(/=(.*)/s).slice(0, 2)));
    assert.equal(env.IAC_AGENT, 'opus'); assert.equal(env.AGORA_AGENT, 'opus');
    assert.equal(env.IAC_HOME, home); assert.equal(env.AGORA_HOME, home);
    assert.match(env.IAC_INSTANCE, /^opus-[0-9a-f]{4}$/); assert.equal(env.AGORA_INSTANCE, env.IAC_INSTANCE);
    assert.match(r.stderr, /^iac-launch: opus/m, name);
  }
  // an instance inherited under the legacy name is kept
  const r = runBin('iac-launch.js', ['opus', ...probe], { env: { AGORA_HOME: home, AGORA_INSTANCE: 'opus-legacy' } });
  assert.match(r.stdout, /^IAC_INSTANCE=opus-legacy$/m); assert.match(r.stdout, /^IAC_HOME=/m);
});

test('AGORA_* is a fallback for IAC_*; when both are set and differ, IAC_* wins and whoami says so', async () => {
  const { envVar, envConflicts } = await import('../src/env.js');
  assert.equal(envVar({ AGORA_HOME: '/old' }, 'HOME'), '/old');
  assert.equal(envVar({ AGORA_HOME: '/old', IAC_HOME: '/new' }, 'HOME'), '/new');
  assert.equal(envVar({ AGORA_HOME: '/old', IAC_HOME: '' }, 'HOME'), '/old', 'an emptied IAC_* is unset');
  assert.equal(envVar({ AGORA_AGENT: '' }, 'AGENT'), undefined);
  assert.deepEqual(envConflicts({ IAC_AGENT: 'opus', AGORA_AGENT: 'fable', IAC_HOME: '/x', AGORA_HOME: '/x' }), [{ name: 'AGENT', iac: 'opus', agora: 'fable' }]);

  const { a, home } = fresh(); noIdle(a);
  const { thread } = await a.open({ as: 'fable', title: 'legacy env', body: 'x' });
  // AGORA_HOME alone finds the store; AGORA_AGENT alone binds; AGORA_PROJECT alone scopes
  const legacy = runBin('iac.js', ['whoami', '--json'], { env: { AGORA_HOME: home, AGORA_AGENT: 'opus', AGORA_PROJECT: 'o/legacy' } });
  const j = JSON.parse(legacy.stdout);
  assert.deepEqual([j.name, j.source, j.home, j.homeSource, j.instance], ['opus', 'launcher', home, 'AGORA_HOME', 'opus@o/legacy']);
  assert.match(runBin('iac.js', ['list'], { env: { AGORA_HOME: home } }).stdout, new RegExp(thread));
  assert.equal(new Agora(home, { env: { AGORA_INSTANCE: 'opus-x' } }).env.AGORA_INSTANCE, 'opus-x');
  const { resolveInstance } = await import('../src/api.js');
  assert.equal(resolveInstance({ agent: 'opus', project: 'p', env: { AGORA_INSTANCE: 'opus-old' } }), 'opus-old');
  assert.equal(resolveInstance({ agent: 'opus', project: 'p', env: { AGORA_INSTANCE: 'opus-old', IAC_INSTANCE: 'opus-new' } }), 'opus-new');
  const { detectProject } = await import('../src/project.js');
  assert.equal(detectProject({ env: { AGORA_PROJECT: 'o/old' } }), 'o/old');
  assert.equal(detectProject({ env: { AGORA_PROJECT: 'o/old', IAC_PROJECT: 'o/new' } }), 'o/new');

  // both set, different: IAC_* wins, and whoami names the disagreement
  const other = fresh();
  const both = { IAC_HOME: home, AGORA_HOME: other.home, IAC_AGENT: 'opus', AGORA_AGENT: 'fable' };
  const w = JSON.parse(runBin('iac.js', ['whoami', '--json'], { env: both }).stdout);
  assert.deepEqual([w.name, w.home, w.homeSource], ['opus', home, 'IAC_HOME']);
  assert.deepEqual(w.envConflicts.map((c) => c.name).sort(), ['AGENT', 'HOME']);
  const text = runBin('iac.js', ['whoami'], { env: both }).stdout;
  assert.match(text, /^opus .*identity from IAC_AGENT \(launcher\).*store .* \(IAC_HOME\)$/m);
  assert.match(text, /^note: IAC_AGENT=opus and AGORA_AGENT=fable differ; IAC_AGENT wins/m);
  assert.match(text, /^note: IAC_HOME=.* and AGORA_HOME=.* differ; IAC_HOME wins/m);
  assert.match(runBin('iac.js', ['whoami'], { env: { AGORA_HOME: home, AGORA_AGENT: 'opus' } }).stdout, /identity from AGORA_AGENT \(launcher\)/);
});

test('store resolution: --home, IAC_HOME, AGORA_HOME, ~/.inter-agent-comms, legacy ~/.agora, WSL Windows-side, default; nothing moves', async () => {
  const { resolveHomeWhy } = await import('../src/store.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-resolve-'));
  const homedir = path.join(base, 'home'); const wslUsers = path.join(base, 'Users');
  fs.mkdirSync(homedir); fs.mkdirSync(path.join(wslUsers, 'u'), { recursive: true });
  const init = (d) => { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'config.json'), '{}\n'); };
  const r = (explicit, env = {}) => resolveHomeWhy(explicit, env, { homedir, wslUsers, username: 'u' });
  const local = path.join(homedir, '.inter-agent-comms'); const legacy = path.join(homedir, '.agora');
  const winNew = path.posix.join(wslUsers, 'u', '.inter-agent-comms'); const winOld = path.posix.join(wslUsers, 'u', '.agora');

  assert.deepEqual(r(), { home: local, why: 'default (no store initialised yet)' });
  init(winOld);
  assert.deepEqual(r(), { home: winOld, why: 'initialised legacy Windows-side store (WSL), used in place' });
  init(winNew);
  assert.equal(r().home, winNew, 'the new Windows-side store beats the legacy one');
  init(legacy);
  assert.deepEqual(r(), { home: legacy, why: 'initialised legacy ~/.agora (used in place)' }, 'a local store beats any Windows-side one');
  init(local);
  assert.deepEqual(r(), { home: local, why: 'initialised ~/.inter-agent-comms' }, 'both initialised: the new one wins');
  assert.deepEqual(r(undefined, { AGORA_HOME: '/old' }), { home: '/old', why: 'AGORA_HOME' });
  assert.deepEqual(r(undefined, { AGORA_HOME: '/old', IAC_HOME: '/new' }), { home: '/new', why: 'IAC_HOME' });
  assert.deepEqual(r('/flag', { AGORA_HOME: '/old', IAC_HOME: '/new' }), { home: '/flag', why: '--home' });
  // a legacy store is read in place, never copied or moved
  fs.rmSync(local, { recursive: true });
  assert.equal(r().home, legacy); assert.ok(fs.existsSync(path.join(legacy, 'config.json'))); assert.ok(!fs.existsSync(local));

  // end to end through the CLI: HOME with only a legacy ~/.agora initialised (no WSL step: --home-less, IAC_*-less)
  const h2 = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-legacyhome-'));
  const old = new Agora(path.join(h2, '.agora'), { env: {} }); old.init({ agents: ['fable'], human: 'ada' });
  const p = JSON.parse(runBin('iac.js', ['paths', '--json'], { env: { HOME: h2, USERPROFILE: h2 } }).stdout);
  assert.deepEqual([p.store, p.storeSource], [path.join(h2, '.agora'), 'initialised legacy ~/.agora (used in place)']);
  assert.match(runBin('iac.js', ['paths'], { env: { HOME: h2, USERPROFILE: h2 } }).stdout, /^store: .*\.agora {3}\(initialised legacy ~\/\.agora \(used in place\)\)$/m);
  assert.ok(!fs.existsSync(path.join(h2, '.inter-agent-comms')), 'reading a legacy store creates no new one');
  // the read cache keys the resolved (legacy) store by its physical directory: spellings of it share entries
  const { Store, storeCacheKey } = await import('../src/store.js');
  const d = path.join(h2, '.agora');
  assert.equal(storeCacheKey(d + path.sep).key, storeCacheKey(d).key); assert.equal(storeCacheKey(path.join(d, '..', '.agora')).key, storeCacheKey(d).key);
  const s1 = new Store(d); s1.registry();
  fs.writeFileSync(path.join(d, 'agents.json'), '{"x":{"role":"agent"}}\n');   // another process's write
  new Store(d + path.sep).invalidate();
  assert.deepEqual(Object.keys(s1.registry()), ['x'], 'invalidate through one spelling clears the other');
});

test('a store and signed log written by agora 0.2.3 verifies, reads and takes new posts unchanged', async () => {
  // test/fixtures/legacy-0.2.3-store was written by the 0.2.3 code (origin/main before the rename):
  // init, open/ack/answer with a wait, a second thread with unwait + close. Private keys are not
  // committed, so new posts come from an agent registered now.
  const src = path.join(ROOT, 'test', 'fixtures', 'legacy-0.2.3-store');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-legacy-'));
  fs.cpSync(src, home, { recursive: true });
  const before = Object.fromEntries(fs.readdirSync(path.join(home, 'threads')).map((f) => [f, fs.readFileSync(path.join(home, 'threads', f), 'utf8')]));
  const env = { IAC_HOME: home, IAC_PROJECT: 'o/r' };
  const verify = runBin('iac.js', ['verify'], { env });
  assert.equal(verify.status, 0, verify.stdout + verify.stderr);
  assert.match(verify.stdout, /^t-d8fc70 {2}✓ {2}3 events$/m); assert.match(verify.stdout, /^t-238f36 {2}✓ {2}4 events$/m);
  assert.equal(runBin('agora.js', ['verify'], { env: { AGORA_HOME: home } }).status, 0, 'the alias and legacy env verify it too');
  // The fixture's events are dated, and the CLI reads the real clock: once they are older than
  // the default idle horizon the thread derives as idle. This test is about reading 0.2.3 data,
  // not about idling (which has its own tests), so turn idling off on the temporary copy only,
  // after the original config has been verified above. The committed fixture is untouched.
  noIdle(new Agora(home, { env: {} }));
  const list = runBin('iac.js', ['list', '--all'], { env });
  assert.match(list.stdout, /t-d8fc70 {2}\[open\] {2}legacy thread/); assert.match(list.stdout, /t-238f36 {2}\[closed\] {2}legacy two/);
  const show = runBin('iac.js', ['show', 't-d8fc70'], { env });
  assert.equal(show.status, 0); assert.match(show.stdout, /\*\*opus\*\* · answer · .* ✓\nanswer from legacy/); assert.doesNotMatch(show.stdout, /UNVERIFIED/);
  assert.equal(runBin('iac.js', ['brief', '--as', 'fable'], { env }).status, 0);

  // append: a new agent's post chains onto the 0.2.3 events and the whole thread still verifies
  assert.equal(runBin('iac.js', ['add-agent', 'newbie'], { env }).status, 0);
  const post = runBin('iac.js', ['post', 't-d8fc70', '--as', 'newbie', '--kind', 'status', '--body', 'appended by 0.3.0'], { env });
  assert.equal(post.status, 0, post.stderr);
  const after = fs.readFileSync(path.join(home, 'threads', 't-d8fc70.ndjson'), 'utf8');
  assert.ok(after.startsWith(before['t-d8fc70.ndjson']), 'old events are byte-for-byte untouched');
  const v = new Agora(home, { env: {} }).verify('t-d8fc70');
  assert.deepEqual([v.ok, v.events], [true, 4]);
  assert.equal(runBin('iac.js', ['verify'], { env }).status, 0);
  assert.equal(fs.readFileSync(path.join(home, 'threads', 't-238f36.ndjson'), 'utf8'), before['t-238f36.ndjson']);
});

test('MCP: tools are iac_*, the server names itself inter-agent-comms, and the instructions use the new names', async () => {
  const { home } = fresh();
  const { buildTools } = await import('../src/mcp.js');
  const all = Object.keys(buildTools(new Agora(home, { env: {} }), 'fable'));
  assert.deepEqual(all.sort(), ['iac_ack', 'iac_brief', 'iac_clear_wait', 'iac_close', 'iac_doctor', 'iac_inbox', 'iac_list', 'iac_open', 'iac_post', 'iac_show', 'iac_verify', 'iac_waiting']);
  assert.deepEqual(Object.keys(buildTools(new Agora(home, { env: {} }), '')).sort(), ['iac_doctor', 'iac_list', 'iac_show', 'iac_verify', 'iac_waiting']);
  for (const bin of ['iac-mcp.js', 'agora-mcp.js']) {
    const proc = spawn(process.execPath, [binPath(bin)], { env: { PATH: process.env.PATH, ...HARNESS_CLEAN, IAC_HOME: home, IAC_AGENT: 'fable' } });
    let out = ''; let err = ''; proc.stdout.on('data', (c) => { out += c; }); proc.stderr.on('data', (c) => { err += c; });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } } }) + '\n');
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    proc.stdin.end();
    await new Promise((resolve) => proc.on('close', resolve));
    const [init, list] = out.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(init.result.serverInfo.name, 'inter-agent-comms', bin);
    assert.equal(init.result.serverInfo.version, '0.3.2');
    assert.match(init.result.instructions, /Call iac_brief first/);
    assert.doesNotMatch(init.result.instructions, /agora/i);
    assert.ok(list.result.tools.every((t) => t.name.startsWith('iac_')), bin);
    assert.equal(err, '', `${bin}: an identity resolved, so nothing on stderr and no deprecation notice`);
  }
});

// ---- init and add-agent validate every name before writing anything, and undo only
// the paths a later failure (key generation, simulated disk error) left this call holding ---

function emptyHome45() { return fs.mkdtempSync(path.join(os.tmpdir(), 'iac-init45-')); }

/** No config/registry/keys/seen/threads were ever written; the pre-existing empty dir is untouched. */
function assertNoStore45(home) {
  assert.equal(fs.existsSync(path.join(home, 'config.json')), false, 'config.json');
  assert.equal(fs.existsSync(path.join(home, 'agents.json')), false, 'agents.json');
  assert.equal(fs.existsSync(path.join(home, 'keys')), false, 'keys/');
  assert.equal(fs.existsSync(path.join(home, 'seen')), false, 'seen/');
  assert.equal(fs.existsSync(path.join(home, 'threads')), false, 'threads/');
  assert.deepEqual(fs.readdirSync(home), []);
}

test('init: an invalid human name errors before any store file is created', () => {
  const home = emptyHome45();
  const a = new Agora(home, { env: {} });
  assert.throws(() => a.init({ human: 'H' }), /name must match/);
  assertNoStore45(home);
  // nothing was left behind to make a later, valid init think it is already initialised
  a.init({ human: 'ada' });
  assert.deepEqual(Object.keys(a.registry()), ['ada']);
});

test('init: an invalid agent name errors before any store file is created', () => {
  const home = emptyHome45();
  const a = new Agora(home, { env: {} });
  assert.throws(() => a.init({ agents: ['BAD'], human: 'ada' }), /name must match/);
  assertNoStore45(home);
});

test('init: duplicate names (within agents, or an agent repeating the human) error before any store file is created', () => {
  const home = emptyHome45();
  const a = new Agora(home, { env: {} });
  assert.throws(() => a.init({ agents: ['fable', 'fable'], human: 'ada' }), /duplicate name/);
  assertNoStore45(home);
  assert.throws(() => a.init({ agents: ['ada'], human: 'ada' }), /duplicate name/);
  assertNoStore45(home);
});

test('init: a valid init still works', () => {
  const home = emptyHome45();
  const a = new Agora(home, { env: {} });
  const r = a.init({ agents: ['fable', 'opus'], human: 'ada' });
  assert.deepEqual(Object.keys(r.registry).sort(), ['ada', 'fable', 'opus']);
  assert.ok(fs.existsSync(path.join(home, 'config.json')));
  assert.ok(fs.existsSync(path.join(home, 'keys', 'fable.pem')));
});

test('init: re-init on an existing store still refuses without modifying it', () => {
  const home = emptyHome45();
  const a = new Agora(home, { env: {} });
  a.init({ agents: ['fable'], human: 'ada' });
  const before = {
    config: fs.readFileSync(path.join(home, 'config.json')),
    registry: fs.readFileSync(path.join(home, 'agents.json')),
    key: fs.readFileSync(path.join(home, 'keys', 'fable.pem')),
  };
  assert.throws(() => a.init({ agents: ['fable'], human: 'ada' }), /already initialised/);
  assert.deepEqual(fs.readFileSync(path.join(home, 'config.json')), before.config);
  assert.deepEqual(fs.readFileSync(path.join(home, 'agents.json')), before.registry);
  assert.deepEqual(fs.readFileSync(path.join(home, 'keys', 'fable.pem')), before.key);
});

test('init: a simulated mid-init failure (writePrivateKey throws) rolls back to no store, on a fresh init', () => {
  const home = emptyHome45();
  const a = new Agora(home, { env: {} });
  const orig = Store.prototype.writePrivateKey;
  Store.prototype.writePrivateKey = function () { throw new Error('simulated disk error'); };
  try {
    assert.throws(() => a.init({ agents: ['fable', 'opus'], human: 'ada' }), /simulated disk error/);
  } finally { Store.prototype.writePrivateKey = orig; }
  assertNoStore45(home);
  // the store is usable afterwards, exactly as if the failed call had never run
  a.init({ agents: ['fable'], human: 'ada' });
  assert.deepEqual(Object.keys(a.registry()).sort(), ['ada', 'fable']);
});

test('init: a simulated mid-init failure on an existing store (--force, adding a missing agent) leaves it byte-identical', () => {
  const home = emptyHome45();
  const a = new Agora(home, { env: {} });
  a.init({ agents: ['fable'], human: 'ada' });
  const snapshotDir = (dir) => Object.fromEntries(fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f))]));
  const before = {
    config: fs.readFileSync(path.join(home, 'config.json')),
    registry: fs.readFileSync(path.join(home, 'agents.json')),
    keys: snapshotDir(path.join(home, 'keys')),
  };
  const orig = Store.prototype.writePrivateKey;
  Store.prototype.writePrivateKey = function () { throw new Error('simulated disk error'); };
  try {
    assert.throws(() => a.init({ agents: ['fable', 'opus'], human: 'ada', force: true }), /simulated disk error/);
  } finally { Store.prototype.writePrivateKey = orig; }
  assert.deepEqual(fs.readFileSync(path.join(home, 'config.json')), before.config);
  assert.deepEqual(fs.readFileSync(path.join(home, 'agents.json')), before.registry);
  assert.deepEqual(snapshotDir(path.join(home, 'keys')), before.keys);
  assert.deepEqual(Object.keys(a.registry()).sort(), ['ada', 'fable']);
});

test('add-agent: an invalid name errors before any key or directory is created', () => {
  const home = emptyHome45();
  const a = new Agora(home, { env: {} });
  assert.throws(() => a.addAgent('BAD'), /name must match/);
  assertNoStore45(home);
});

test('add-agent: a duplicate name errors without touching the existing key or registry entry', () => {
  const { a, home } = fresh();
  const before = {
    registry: fs.readFileSync(path.join(home, 'agents.json')),
    key: fs.readFileSync(path.join(home, 'keys', 'fable.pem')),
  };
  assert.throws(() => a.addAgent('fable'), /already registered/);
  assert.deepEqual(fs.readFileSync(path.join(home, 'agents.json')), before.registry);
  assert.deepEqual(fs.readFileSync(path.join(home, 'keys', 'fable.pem')), before.key);
});

test('add-agent: a simulated key-write failure rolls back the new key, leaving the pre-existing store untouched', () => {
  const { a, home } = fresh();
  const before = { registry: fs.readFileSync(path.join(home, 'agents.json')) };
  const orig = Store.prototype.writePrivateKey;
  Store.prototype.writePrivateKey = function () { throw new Error('simulated disk error'); };
  try {
    assert.throws(() => a.addAgent('newagent'), /simulated disk error/);
  } finally { Store.prototype.writePrivateKey = orig; }
  assert.deepEqual(fs.readFileSync(path.join(home, 'agents.json')), before.registry);
  assert.equal(fs.existsSync(path.join(home, 'keys', 'newagent.pem')), false);
  assert.ok(!('newagent' in a.registry()));
});

// ---- Redesign: no snapshot/rollback. Validate everything first; a fresh init is built
// beside home and renamed into place; writes into an existing store are exclusive or atomic
// under the lock, and a failure removes only the exact paths this call created. -----------

const posix45 = process.platform !== 'win32';
const listTree45 = (dir) => {
  const out = {};
  const walk = (d, rel) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); const r = rel ? `${rel}/${f}` : f; if (fs.statSync(p).isDirectory()) walk(p, r); else out[r] = fs.readFileSync(p); } };
  walk(dir, ''); return out;
};
const statSig45 = (p) => { const s = fs.statSync(p); return { ino: s.ino, mtimeMs: s.mtimeMs, mode: s.mode & 0o777 }; };
const noDebris45 = (dir) => {
  const bad = [];
  const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (/\.tmp$|\.init-|^\.lock$/.test(f)) bad.push(p); if (fs.lstatSync(p).isDirectory()) walk(p); } };
  walk(dir); assert.deepEqual(bad, [], 'no temp files, init dirs or lock left behind');
};
const patch45 = (obj, name, impl, body) => {
  const orig = obj[name]; obj[name] = function (...args) { return impl.call(this, orig, ...args); };
  try { return body(); } finally { obj[name] = orig; }
};
/**
 * A child node process running `code` against src/api.js once every child is ready (a start
 * barrier). Portable: the script is a .mjs file importing file:// URLs (a bare C:\ path is not
 * an ESM specifier on Windows), and readiness is a file each child creates, polled by the parent.
 */
function child45(code, gate, env = {}) {
  const url = (f) => JSON.stringify(pathToFileURL(path.join(ROOT, 'src', f)).href);
  const script = path.join(path.dirname(gate), `child-${Math.random().toString(16).slice(2)}.mjs`);
  fs.writeFileSync(script, `import fs from 'node:fs'; import { Agora } from ${url('api.js')}; import { Store } from ${url('store.js')};
const gate = ${JSON.stringify(gate)};
fs.writeFileSync(gate + '.ready.' + process.pid, '');
const z = new Int32Array(new SharedArrayBuffer(4)); const until = Date.now() + 60000;
while (!fs.existsSync(gate)) { if (Date.now() > until) { console.log('ERR no go'); process.exit(4); } Atomics.wait(z, 0, 0, 5); }
try { ${code}; console.log('OK'); } catch (e) { console.log('ERR ' + e.message); process.exitCode = 3; }
`);
  const p = spawn(process.execPath, [script], { env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, ...HARNESS_CLEAN, ...env } });
  let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  const kid = { pid: p.pid, exited: null };
  kid.done = new Promise((r) => p.on('close', (status) => { kid.exited = { status, out: out.trim() }; r(kid.exited); }));
  return kid;
}
async function race45(gate, kids) {
  const deadline = Date.now() + 60_000;
  const ready = () => fs.readdirSync(path.dirname(gate)).filter((f) => f.startsWith(path.basename(gate) + '.ready.')).length;
  while (ready() < kids.length) {
    const dead = kids.find((k) => k.exited);
    if (dead) { fs.writeFileSync(gate, ''); throw new Error(`a child exited before the start barrier: ${JSON.stringify(dead.exited)}`); }
    if (Date.now() > deadline) { fs.writeFileSync(gate, ''); throw new Error(`children never became ready (${ready()}/${kids.length})`); }
    await new Promise((r) => setTimeout(r, 10));
  }
  fs.writeFileSync(gate, '');
  return Promise.all(kids.map((k) => k.done));
}

test('Windows device names (any case, with an extension) are refused before anything is written', () => {
  for (const n of ['con', 'prn', 'aux', 'nul', 'com0', 'com1', 'com9', 'lpt0', 'lpt1', 'lpt9']) {
    const home = emptyHome45();
    const a = new Agora(home, { env: {} });
    assert.throws(() => a.init({ human: n }), /reserved Windows device name/, n);
    assert.throws(() => a.init({ human: 'ada', agents: [n] }), /reserved Windows device name/, n);
    assertNoStore45(home);
  }
  const { a, home } = fresh();
  const before = listTree45(home);
  assert.throws(() => a.addAgent('con'), /reserved Windows device name/);
  assert.throws(() => a.addAgent('lpt3'), /reserved Windows device name/);
  assert.deepEqual(listTree45(home), before);
  // a seen marker for an instance subject that spells a device name is not seen/con.json
  a.store.saveSeen('con', { x: 1 });
  assert.equal(fs.existsSync(path.join(home, 'seen', 'con.json')), false);
  assert.deepEqual(a.store.seen('con'), { x: 1 });
});

test('nameProblem rejects device names case-insensitively, with or without an extension', async () => {
  const { nameProblem, WIN_RESERVED_RE } = await import('../src/store.js');
  for (const n of ['CON', 'Con.txt', 'nul.json', 'COM1.pem', 'lpt9.x.y', 'aux', 'conin$', 'CONOUT$']) assert.ok(WIN_RESERVED_RE.test(n), n);
  for (const n of ['cons', 'console', 'com10', 'lpt', 'nuls', 'auxy', 'fable']) assert.ok(!WIN_RESERVED_RE.test(n), n);
  assert.match(nameProblem('com7'), /reserved/); assert.equal(nameProblem('compass'), null);
});

test('init --force refuses to make a registered agent the human, or the human an agent, and writes nothing', () => {
  const { a, home } = fresh();
  const before = listTree45(home); const sig = { c: statSig45(path.join(home, 'config.json')), r: statSig45(path.join(home, 'agents.json')) };
  assert.throws(() => a.init({ human: 'fable', force: true }), /'fable' is registered as an agent/);
  assert.throws(() => a.init({ human: 'zed', agents: ['ada'], force: true }), /'ada' is registered as the human/);
  assert.deepEqual(listTree45(home), before);
  assert.deepEqual(statSig45(path.join(home, 'config.json')), sig.c); assert.deepEqual(statSig45(path.join(home, 'agents.json')), sig.r);
  assert.equal(a.registry().fable.role, 'agent'); assert.equal(a.config().human, 'ada');
});

test('a concurrent writer\'s key and registry entry survive another add-agent failing', () => {
  const { a, home } = fresh();
  const intruder = () => {   // what another process lands while this call is between its key and registry writes
    fs.writeFileSync(path.join(home, 'keys', 'zed.pem'), 'zed key', { mode: 0o600 });
    const reg = JSON.parse(fs.readFileSync(path.join(home, 'agents.json'), 'utf8')); reg.zed = { role: 'agent', publicKey: 'zed-pub', added: 'x' };
    fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify(reg));
  };
  patch45(Store.prototype, 'saveRegistry', function (orig, r) { intruder(); throw Object.assign(new Error('simulated disk full'), { code: 'ENOSPC' }); },
    () => assert.throws(() => a.addAgent('newbie'), /simulated disk full/));
  a.store.invalidate();
  assert.equal(fs.readFileSync(path.join(home, 'keys', 'zed.pem'), 'utf8'), 'zed key', 'the other writer\'s key is untouched');
  assert.equal(a.registry().zed.publicKey, 'zed-pub', 'the other writer\'s registry entry is untouched');
  assert.equal(fs.existsSync(path.join(home, 'keys', 'newbie.pem')), false, 'only this call\'s own key was removed');
  assert.equal(a.registry().newbie, undefined);
  noDebris45(home);
});

test('concurrent add-agents across processes, one failing at its registry write, lose nobody', async () => {
  const { home } = fresh();
  const gate = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'iac-gate-')), 'go');
  const names = ['wa', 'wb', 'wc', 'wd', 'we'];
  const kids = names.map((n) => child45(n === 'wc'
    ? `Store.prototype.saveRegistry = function () { throw new Error('simulated disk full'); }; new Agora(${JSON.stringify(home)}).addAgent('${n}')`
    : `new Agora(${JSON.stringify(home)}).addAgent('${n}')`, gate));
  const res = await race45(gate, kids);
  res.forEach((r, i) => assert.equal(r.out, names[i] === 'wc' ? 'ERR simulated disk full' : 'OK', `${names[i]}: ${r.out}`));
  const reg = new Agora(home).registry();
  for (const n of names.filter((x) => x !== 'wc')) {
    assert.ok(reg[n], `${n} registered`); assert.ok(fs.existsSync(path.join(home, 'keys', `${n}.pem`)), `${n} key`);
  }
  assert.equal(reg.wc, undefined); assert.equal(fs.existsSync(path.join(home, 'keys', 'wc.pem')), false);
  noDebris45(home);
});

test('a fresh init that loses the race removes only its own temp dir; the winner is untouched', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-race-'));
  const home = path.join(base, 'store');
  const a = new Agora(home, { env: {} });
  let fired = false;
  const r = patch45(fs, 'renameSync', function (orig, from, to) {
    if (!fired && String(from).includes('.init-')) { fired = true; new Agora(home, { env: {} }).init({ human: 'bob', agents: ['sol'] }); }
    return orig(from, to);
  }, () => { try { a.init({ human: 'ada', agents: ['fable'] }); return null; } catch (e) { return e; } });
  assert.ok(fired); assert.match(String(r?.message), /already initialised/);
  const reg = new Agora(home).registry();
  assert.deepEqual(Object.keys(reg).sort(), ['bob', 'sol'], 'the winner\'s store is the one in place');
  assert.ok(fs.existsSync(path.join(home, 'keys', 'sol.pem'))); assert.equal(fs.existsSync(path.join(home, 'keys', 'fable.pem')), false);
  assert.deepEqual(fs.readdirSync(base), ['store'], 'no temp dir left beside the store');
  noDebris45(home);
});

test('data another process put in a just-created home survives a fresh init failing', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-race-'));
  const home = path.join(base, 'store');
  let fired = false;
  const r = patch45(fs, 'renameSync', function (orig, from, to) {
    if (!fired && String(from).includes('.init-')) { fired = true; fs.mkdirSync(path.join(home, 'threads'), { recursive: true }); fs.writeFileSync(path.join(home, 'threads', 't-abcdef.ndjson'), '{"other":"process"}\n'); }
    return orig(from, to);
  }, () => { try { new Agora(home, { env: {} }).init({ human: 'ada', agents: ['fable'] }); return null; } catch (e) { return e; } });
  assert.match(String(r?.message), /created by another process/);
  assert.equal(fs.readFileSync(path.join(home, 'threads', 't-abcdef.ndjson'), 'utf8'), '{"other":"process"}\n');
  assert.deepEqual(fs.readdirSync(home), ['threads']); assert.deepEqual(fs.readdirSync(base), ['store']);
});

test('init race between processes: two inits race for one absent home; exactly one wins and the loser leaves nothing', async () => {
  for (let round = 0; round < 3; round++) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-race-'));
    const home = path.join(base, 'store');
    const gate = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'iac-gate-')), 'go');
    const kids = [['ada', 'fable'], ['bob', 'opus']].map(([h, ag]) => child45(`new Agora(${JSON.stringify(home)}).init({ human: '${h}', agents: ['${ag}'] })`, gate));
    const res = await race45(gate, kids);
    const wins = res.filter((x) => x.out === 'OK');
    assert.equal(wins.length, 1, JSON.stringify(res));
    const loser = res.find((x) => x.out !== 'OK'); assert.match(loser.out, /already initialised|created by another process/);
    const reg = new Agora(home).registry(); const names = Object.keys(reg).sort();
    assert.ok(JSON.stringify(names) === '["ada","fable"]' || JSON.stringify(names) === '["bob","opus"]', names.join());
    for (const n of names) assert.ok(fs.existsSync(path.join(home, 'keys', `${n}.pem`)));
    assert.equal(fs.readdirSync(path.join(home, 'keys')).length, 2, 'no key from the loser');
    assert.deepEqual(fs.readdirSync(base), ['store']);
    noDebris45(home);
  }
});

test('a home that is a dangling symlink is refused, not created through or removed', { skip: !posix45 }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-link-'));
  const target = path.join(base, 'gone'); const link = path.join(base, 'link'); fs.symlinkSync(target, link);
  const a = new Agora(link, { env: {} });
  assert.throws(() => a.init({ human: 'ada', agents: ['fable'] }), /link to a missing target/);
  patch45(Store.prototype, 'writePrivateKey', () => { throw new Error('simulated'); },
    () => assert.throws(() => a.init({ human: 'ada', agents: ['fable'] }), /link to a missing target/));
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link is still there'); assert.equal(fs.existsSync(target), false);
  assert.throws(() => a.addAgent('fable'), /link to a missing target/);
  assert.deepEqual(fs.readdirSync(base).sort(), ['link']);
});

test('a transient read error (EBUSY) is not "absent": nothing is written or deleted', () => {
  const { a, home } = fresh();
  const cfg = path.join(home, 'config.json'); const before = listTree45(home);
  for (const run of [() => a.init({ human: 'ada', agents: ['fable', 'newbie'], force: true }), () => a.addAgent('newbie')]) {
    let hit = false;
    patch45(fs, 'readFileSync', function (orig, p, ...r) {
      if (!hit && String(p) === cfg) { hit = true; throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }); }
      return orig(p, ...r);
    }, () => assert.throws(run, /EBUSY/));
    assert.ok(hit);
    assert.deepEqual(listTree45(home), before, 'config.json and everything else byte-identical');
  }
});

test('a failed init --force leaves non-UTF-8 config bytes and 0600 modes exactly as they were', () => {
  const { a, home } = fresh();
  const cfg = path.join(home, 'config.json'); const reg = path.join(home, 'agents.json');
  const txt = fs.readFileSync(cfg); const i = txt.lastIndexOf('}');
  const bytes = Buffer.concat([txt.subarray(0, i), Buffer.from(',"note":"caf'), Buffer.from([0xe9]), Buffer.from('"}\n')]);
  fs.writeFileSync(cfg, bytes); fs.chmodSync(cfg, 0o600); fs.chmodSync(reg, 0o600);
  const before = listTree45(home);
  patch45(Store.prototype, 'writePrivateKey', () => { throw new Error('simulated disk error'); },
    () => assert.throws(() => a.init({ human: 'zed', agents: ['newbie'], force: true, replaceHuman: true }), /simulated disk error/));
  assert.ok(fs.readFileSync(cfg).equals(bytes), 'config.json byte-identical');
  assert.deepEqual(listTree45(home), before);
  if (posix45) { assert.equal(fs.statSync(cfg).mode & 0o777, 0o600); assert.equal(fs.statSync(reg).mode & 0o777, 0o600); }
});

test('atomic replaces keep the file mode (0600 stays 0600) on success too', { skip: !posix45 }, () => {
  const { a, home } = fresh();
  const cfg = path.join(home, 'config.json'); const reg = path.join(home, 'agents.json');
  fs.chmodSync(cfg, 0o600); fs.chmodSync(reg, 0o600);
  a.init({ human: 'zed', agents: ['newbie'], force: true, replaceHuman: true });   // changes the human: rewrites both
  assert.equal(a.config().human, 'zed'); assert.equal(a.registry().zed.role, 'human'); assert.equal(a.registry().newbie.role, 'agent');
  assert.equal(fs.statSync(cfg).mode & 0o777, 0o600); assert.equal(fs.statSync(reg).mode & 0o777, 0o600);
  a.addAgent('later', 'agent', { models: ['acme-later-*'], harness: 'codex' });
  assert.equal(fs.statSync(cfg).mode & 0o777, 0o600); assert.equal(fs.statSync(reg).mode & 0o777, 0o600);
  assert.deepEqual(a.config().families.later, ['acme-later-*']); assert.equal(a.config().familyHarness.later, 'codex');
  assert.equal(fs.statSync(path.join(home, 'keys', 'later.pem')).mode & 0o777, 0o600);
  noDebris45(home);
});

test('"already registered" (add-agent) and a no-op init --force rewrite nothing', () => {
  const { a, home } = fresh();
  const files = ['config.json', 'agents.json', 'keys/fable.pem'].map((f) => path.join(home, f));
  const sig = files.map(statSig45); const before = listTree45(home);
  assert.throws(() => a.addAgent('fable'), /already registered/);
  const r = a.init({ human: 'ada', agents: ['fable', 'opus'], force: true });
  assert.deepEqual(r.created, []);
  assert.deepEqual(files.map(statSig45), sig, 'same inode and mtime: not rewritten');
  assert.deepEqual(listTree45(home), before);
  noDebris45(home);
});

test('a failed rename leaves no .tmp debris, and a failed init into an empty dir leaves it empty', () => {
  const home = emptyHome45();
  patch45(fs, 'renameSync', function (orig, from, to) { if (String(to).endsWith('agents.json')) throw Object.assign(new Error('simulated rename'), { code: 'EIO' }); return orig(from, to); },
    () => assert.throws(() => new Agora(home, { env: {} }).init({ human: 'ada', agents: ['fable'] }), /simulated rename/));
  assert.deepEqual(fs.readdirSync(home), []);
  const { a, home: h2 } = fresh(); const before = listTree45(h2);
  patch45(fs, 'renameSync', function (orig, from, to) { if (String(to).endsWith('agents.json')) throw Object.assign(new Error('simulated rename'), { code: 'EIO' }); return orig(from, to); },
    () => assert.throws(() => a.addAgent('newbie'), /simulated rename/));
  assert.deepEqual(listTree45(h2), before); noDebris45(h2);
});

test('a fresh init that fails part-way leaves no home, no temp dir, and no parent dirs it created', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-freshfail-'));
  const home = path.join(base, 'a', 'b', 'store');
  patch45(Store.prototype, 'writePrivateKey', () => { throw new Error('simulated disk error'); },
    () => assert.throws(() => new Agora(home, { env: {} }).init({ human: 'ada', agents: ['fable'] }), /simulated disk error/));
  // the dirs this call created (a, a/b) are gone; base, which existed before, is not touched
  assert.equal(fs.existsSync(path.join(base, 'a')), false, 'created parents removed');
  assert.ok(fs.statSync(base).isDirectory(), 'a pre-existing (empty) ancestor is never removed');
  assert.ok(!fs.readdirSync(path.dirname(base)).some((f) => f.startsWith(path.basename(base) + '.')), 'no temp dir beside it');
  const r = new Agora(home, { env: {} }).init({ human: 'ada', agents: ['fable'] });
  assert.deepEqual(r.created, ['fable', 'ada']); assert.deepEqual(fs.readdirSync(path.dirname(home)), ['store']);
  if (posix45) assert.equal(fs.statSync(path.join(home, 'keys', 'fable.pem')).mode & 0o777, 0o600);
});

test('a stray key file is never overwritten; add-agent refuses and leaves it and the registry alone', () => {
  const { a, home } = fresh();
  const stray = path.join(home, 'keys', 'newbie.pem'); fs.writeFileSync(stray, 'someone else\'s key');
  const before = listTree45(home);
  assert.throws(() => a.addAgent('newbie'), /key file already exists/);
  assert.deepEqual(listTree45(home), before);
});

test('add-agent validates --role and --models before any write, and needs an initialised store', () => {
  const { a, home } = fresh(); const before = listTree45(home);
  assert.throws(() => a.addAgent('newbie', 'boss'), /--role must be agent or human/);
  assert.throws(() => a.addAgent('newbie', 'agent', { models: [' ', ''] }), /at least one model glob/);
  assert.throws(() => a.addAgent('newbie', 'agent', { harness: 'vim' }), /--harness must be one of/);
  assert.deepEqual(listTree45(home), before);
  const empty = emptyHome45();
  assert.throws(() => new Agora(empty, { env: {} }).addAgent('newbie'), /not initialised/);
  assert.deepEqual(fs.readdirSync(empty), []);
});

test('an agent named like an Object.prototype member (constructor) is a name, not "already registered"', () => {
  const { a } = fresh();
  assert.equal(a.addAgent('constructor'), true);
  assert.equal(a.registry().constructor.role, 'agent');
});

test('init --force keeps the existing human; --human that differs needs --replace-human', async () => {
  const { a, home } = fresh();   // human is ada
  const before = listTree45(home);
  // the CLI no longer defaults --human: `iac init --force --agents newbie` keeps ada
  const r = runBin('iac.js', ['init', '--force', '--agents', 'newbie', '--json'], { env: { IAC_HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  a.store.invalidate();
  assert.equal(a.config().human, 'ada'); assert.equal(a.registry().human, undefined, 'no second human named "human"');
  assert.equal(a.registry().newbie.role, 'agent');
  const mid = listTree45(home);
  // a different --human is refused, naming the flag, and writes nothing
  const refused = runBin('iac.js', ['init', '--force', '--human', 'zed'], { env: { IAC_HOME: home } });
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /the human at .* is 'ada'; --human zed would replace it\. Pass --replace-human/);
  assert.throws(() => a.init({ human: 'zed', force: true }), /--replace-human/);
  assert.deepEqual(listTree45(home), mid);
  assert.ok(Object.keys(before).length < Object.keys(mid).length);
  // the same --human is fine; --replace-human switches
  a.init({ human: 'ada', force: true });
  const sw = runBin('iac.js', ['init', '--force', '--human', 'zed', '--replace-human'], { env: { IAC_HOME: home } });
  assert.equal(sw.status, 0, sw.stderr);
  a.store.invalidate();
  assert.equal(a.config().human, 'zed'); assert.equal(a.registry().zed.role, 'human');
  // a fresh store with no --human still gets 'human'
  const h2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'iac-h-')), 'store');
  assert.equal(new Agora(h2, { env: {} }).init({ agents: ['fable'] }).registry.human.role, 'human');
});

test('a UTF-8 BOM at the start of config.json / agents.json is ignored by both readers', () => {
  const { a, home } = fresh();
  for (const f of ['config.json', 'agents.json']) {
    const p = path.join(home, f); fs.writeFileSync(p, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fs.readFileSync(p)]));
  }
  a.store.invalidate();
  assert.equal(a.config().human, 'ada', 'readJson');
  assert.equal(a.store.readJsonStrict('config.json').human, 'ada', 'readJsonStrict');
  assert.equal(a.store.readJsonStrict('agents.json').fable.role, 'agent');
  assert.equal(a.addAgent('newbie'), true, 'a read-modify-write through the strict reader works');
  assert.equal(a.registry().fable.role, 'agent');
});

test('a fresh init retries a transient EPERM rename, and surfaces the original error when it persists', () => {
  const eperm = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
  // fails twice, then succeeds
  { const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-eperm-')); const home = path.join(base, 'store'); let n = 0;
    const r = patch45(fs, 'renameSync', function (orig, from, to) { if (String(from).includes('.init-') && ++n <= 2) throw eperm(); return orig(from, to); },
      () => new Agora(home, { env: {} }).init({ human: 'ada', agents: ['fable'] }));
    assert.equal(n, 3); assert.deepEqual(Object.keys(r.registry).sort(), ['ada', 'fable']);
    assert.deepEqual(fs.readdirSync(base), ['store']); }
  // always fails: the EPERM is what the caller sees, and the temp dir is gone
  { const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-eperm-')); const home = path.join(base, 'store'); let n = 0;
    patch45(fs, 'renameSync', function (orig, from, to) { if (String(from).includes('.init-')) { n++; throw eperm(); } return orig(from, to); },
      () => assert.throws(() => new Agora(home, { env: {} }).init({ human: 'ada' }), /EPERM/));
    assert.ok(n > 2, `retried (${n})`); assert.deepEqual(fs.readdirSync(base), []); }
  // always fails and the cleanup fails too: still the original EPERM
  { const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-eperm-')); const home = path.join(base, 'store');
    patch45(fs, 'renameSync', function (orig, from, to) { if (String(from).includes('.init-')) throw eperm(); return orig(from, to); },
      () => patch45(fs, 'rmSync', function (orig, p, ...o) { if (String(p).includes('.init-')) throw Object.assign(new Error('EBUSY cleanup'), { code: 'EBUSY' }); return orig(p, ...o); },
        () => assert.throws(() => new Agora(home, { env: {} }).init({ human: 'ada' }), (e) => {
          assert.equal(e.code, 'EPERM'); assert.match(e.message, /^EPERM: operation not permitted, rename/);
          const left = fs.readdirSync(base); assert.equal(left.length, 1); assert.match(left[0], /^store\.init-/);
          assert.ok(e.message.includes(path.join(base, left[0])), 'names the leftover temp dir');
          assert.match(e.message, /holds private keys .*delete it by hand/);
          return true;
        })));
    assert.equal(fs.existsSync(home), false);
    fs.rmSync(base, { recursive: true, force: true }); }
});

test('a dangling link given as `link/` is reported as a dangling link, also if one appears mid-init', { skip: !posix45 }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-link-'));
  const link = path.join(base, 'link'); fs.symlinkSync(path.join(base, 'gone'), link);
  assert.throws(() => new Agora(link + '/', { env: {} }).init({ human: 'ada' }), /link to a missing target/);
  assert.deepEqual(fs.readdirSync(base), ['link']);
  // a dangling link that appears at home while the store is being built
  const home = path.join(base, 'store');
  const err = patch45(fs, 'renameSync', function (orig, from, to) {
    if (String(from).includes('.init-')) { fs.symlinkSync(path.join(base, 'nowhere'), home); return orig(from, to); }
    return orig(from, to);
  }, () => { try { new Agora(home, { env: {} }).init({ human: 'ada' }); return null; } catch (e) { return e; } });
  assert.match(String(err?.message), /link to a missing target/);
  assert.deepEqual(fs.readdirSync(base).sort(), ['link', 'store']); assert.ok(fs.lstatSync(home).isSymbolicLink());
});

test('an invalid hand-edited config.human makes init --force say how to fix it', () => {
  for (const bad of ['Bad Name', 42, 'con']) {
    const { a, home } = fresh();
    const p = path.join(home, 'config.json'); const cfg = JSON.parse(fs.readFileSync(p, 'utf8')); cfg.human = bad; fs.writeFileSync(p, JSON.stringify(cfg));
    a.store.invalidate(); const before = listTree45(home);
    assert.throws(() => a.init({ agents: ['newbie'], force: true }), /names the human .*not a valid name.*iac init --force --human <name> --replace-human/);
    assert.throws(() => a.init({ human: 'ada', force: true }), /--replace-human/);
    assert.deepEqual(listTree45(home), before);
    a.init({ human: 'ada', force: true, replaceHuman: true });
    assert.equal(a.config().human, 'ada');
  }
});

test('after --replace-human, config.human is the human for @human, waits, the viewer and humanName', async () => {
  const { serve } = await import('../src/server.js');
  const { a } = fresh();   // human ada
  const old = await a.open({ as: 'ada', project: 'o/r', title: 'Before', kind: 'question', body: 'From ada, signed.', waitingOn: ['fable'] });
  a.init({ human: 'zed', force: true, replaceHuman: true });
  assert.equal(a.config().human, 'zed'); assert.equal(a.humanName(), 'zed');
  // the replaced human stays registered as it was, so its signed posts verify and history derives as before
  assert.equal(a.registry().ada.role, 'human'); assert.equal(a.verify(old.thread).ok, true);
  const t = await a.open({ as: 'sol', project: 'o/r', title: 'Ask the human', kind: 'question', body: 'Need @human here.', waitingOn: ['human'] });
  const opener = a.store.readEvents(t.thread)[0];
  assert.deepEqual(opener.waitingOn, ['zed'], '@human waits route to the configured human');
  assert.ok(!opener.mentions?.includes('ada'));
  const srv = await serve(a, 0);
  try {
    const st = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/state`)).json();
    assert.equal(st.human, 'zed', 'the viewer posts and marks "(you)" as the configured human');
    a.init({ human: 'ada', force: true, replaceHuman: true });   // switching back is seen without a restart
    const st2 = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/state`)).json();
    assert.equal(st2.human, 'ada');
  } finally { srv.close(); }
  const html = fs.readFileSync(path.join(ROOT, 'src', 'viewer.html'), 'utf8');
  assert.match(html, /k===state\.human \? `\$\{k\} \(you\)`/);
});

test('a store-lock release failure does not mask the mutation error (sync and async)', async () => {
  const { a, home } = fresh();
  const busy = () => Object.assign(new Error('EBUSY: resource busy or locked, rmdir .lock'), { code: 'EBUSY' });
  const lockDir = path.join(home, '.lock');
  const realRm = fs.rmSync; const realRmdir = fs.rmdirSync;
  // the release's rmdir fails for good (a non-transient code): a Linux EBUSY stands in
  a.store._fs.platform = 'linux';
  const withBusyUnlock = (body) => patch45(fs, 'rmdirSync', function (orig, p, ...o) { if (String(p) === lockDir) throw busy(); return orig(p, ...o); }, body);
  withBusyUnlock(() => patch45(Store.prototype, 'saveRegistry', () => { throw Object.assign(new Error('simulated disk full'), { code: 'ENOSPC' }); },
    () => assert.throws(() => a.addAgent('newbie'), (e) => {
      assert.equal(e.code, 'ENOSPC'); assert.match(e.message, /^simulated disk full \(and releasing the store lock .* failed: EBUSY\)$/);
      assert.equal(e.lockReleaseError.code, 'EBUSY'); return true;
    })));
  realRm(lockDir, { recursive: true, force: true });
  // async: keep the patch in place until the lock is released (patch45 restores synchronously)
  fs.rmdirSync = function (p, ...o) { if (String(p) === lockDir) throw busy(); return realRmdir(p, ...o); };
  let err;
  try { err = await a.store.withLock(async () => { throw Object.assign(new Error('primary'), { code: 'EPRIMARY' }); }).then(() => null, (e) => e); } finally { fs.rmdirSync = realRmdir; }
  assert.equal(err.code, 'EPRIMARY'); assert.equal(err.lockReleaseError.code, 'EBUSY');
  realRm(lockDir, { recursive: true, force: true });
  // with no primary error, a release failure is still reported
  assert.throws(() => withBusyUnlock(() => a.store.withLockSync(() => 1)), /EBUSY/);
  realRm(lockDir, { recursive: true, force: true });
  assert.equal(a.store.withLockSync(() => 7), 7);
});

test('a key write whose exclusive open failed never deletes a file another writer created there', () => {
  const { a, home } = fresh();
  const st = a.store; const peer = path.join(home, 'keys', 'beta.pem');
  // the open fails before creating anything; meanwhile a direct Store writer lands beta.pem
  patch45(fs, 'openSync', function (orig, p, ...o) {
    if (String(p) === peer) { const fd = orig(p, 'wx', 0o600); fs.writeSync(fd, 'peer key'); fs.closeSync(fd); throw Object.assign(new Error('EIO: i/o error, open'), { code: 'EIO' }); }
    return orig(p, ...o);
  }, () => assert.throws(() => st.writePrivateKey('beta', 'mine'), /EIO/));
  assert.equal(fs.readFileSync(peer, 'utf8'), 'peer key', 'the peer key survives');
  // a write that fails after this call's own exclusive open removes only its own torn file
  const mine = path.join(home, 'keys', 'gamma.pem');
  patch45(fs, 'writeFileSync', function (orig, f, ...o) { if (typeof f === 'number') { fs.writeSync(f, 'tor'); throw Object.assign(new Error('ENOSPC: no space'), { code: 'ENOSPC' }); } return orig(f, ...o); },
    () => assert.throws(() => st.writePrivateKey('gamma', 'full key'), /ENOSPC/));
  assert.equal(fs.existsSync(mine), false, 'the torn key this call created is removed');
  assert.equal(fs.readFileSync(st.writePrivateKey('gamma', 'full key'), 'utf8'), 'full key');
  if (posix45) assert.equal(fs.statSync(mine).mode & 0o777, 0o600);
});

// ---- config writers are strict read-modify-write under the store lock ----

test('set-models/set-harness/set-launch: a transient EBUSY on config.json writes nothing', () => {
  const { a, home } = fresh();
  const cfg = path.join(home, 'config.json'); const before = fs.readFileSync(cfg);
  const runs = [() => a.setFamilyModels('fable', ['x-*']), () => a.setFamilyHarness('fable', 'codex'), () => a.setLaunch('fable', ['claude'])];
  for (const run of runs) {
    let hit = false;
    patch45(fs, 'readFileSync', function (orig, p, ...r) {
      if (!hit && String(p) === cfg) { hit = true; throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }); }
      return orig(p, ...r);
    }, () => assert.throws(run, /EBUSY/));
    assert.ok(hit);
    assert.deepEqual(fs.readFileSync(cfg), before, 'config.json byte-identical');
    noDebris45(home);
  }
  // a damaged config is refused, not replaced by defaults
  fs.writeFileSync(cfg, '{ not json');
  assert.throws(() => a.setLaunch('fable', ['claude']), /not valid JSON/);
  assert.equal(fs.readFileSync(cfg, 'utf8'), '{ not json');
});

test('config writers keep the file mode and reject unregistered agents', { skip: !posix45 }, () => {
  const { a, home } = fresh();
  const cfg = path.join(home, 'config.json'); fs.chmodSync(cfg, 0o600);
  a.setFamilyModels('fable', ['x-*']); a.setFamilyHarness('fable', 'codex'); a.setLaunch('fable', ['claude']);
  assert.equal(fs.statSync(cfg).mode & 0o777, 0o600);
  const c = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  assert.deepEqual(c.families.fable, ['x-*']); assert.equal(c.familyHarness.fable, 'codex'); assert.deepEqual(c.launch.fable, ['claude']);
  assert.throws(() => a.setLaunch('nobody', ['x']), /not a registered agent/);
});

test('concurrent set-models for different agents both land', async () => {
  const { home } = fresh();
  const gate = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'iac-gate-')), 'go');
  const names = ['fable', 'opus', 'sol', 'astra'];
  const kids = names.map((n) => child45(`new Agora(${JSON.stringify(home)}).setFamilyModels('${n}', ['m-${n}-*'])`, gate));
  const res = await race45(gate, kids);
  res.forEach((r, i) => assert.equal(r.out, 'OK', `${names[i]}: ${r.out}`));
  const c = new Agora(home).config();
  for (const n of names) assert.deepEqual(c.families[n], [`m-${n}-*`], n);
  noDebris45(home);
});

test('init --force without --human keeps the registry human when config.human is absent', () => {
  const { a, home } = fresh();
  const cfgPath = path.join(home, 'config.json');
  for (const mut of [(c) => { delete c.human; }, (c) => { c.human = null; }]) {
    const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); mut(c); fs.writeFileSync(cfgPath, JSON.stringify(c));
    a.init({ agents: ['newbie' + Math.random().toString(16).slice(2, 6)], force: true });
    a.store.invalidate();
    assert.equal(a.config().human, 'ada');
    assert.equal(a.registry().human, undefined, 'no second human named "human"');
    assert.deepEqual(Object.keys(a.registry()).filter((k) => a.registry()[k].role === 'human'), ['ada']);
  }
});

test('a new role=human is refused while the registry has one, unless --replace-human', () => {
  const { a, home } = fresh();
  const c = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')); delete c.human;
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(c));
  const before = listTree45(home);
  assert.throws(() => a.init({ human: 'zed', force: true }), /second human.*--replace-human/);
  assert.deepEqual(listTree45(home), before);
  a.init({ human: 'zed', force: true, replaceHuman: true });
  a.store.invalidate();
  assert.equal(a.config().human, 'zed');
});

test('agents.json without config.json: refused without --force; --force --human rebuilds a default config', () => {
  const { a, home } = fresh();
  fs.rmSync(path.join(home, 'config.json'));
  const before = listTree45(home);
  assert.throws(() => a.init({ agents: ['newbie'] }), /agents\.json but no config\.json.*iac init --force --human ada/);
  assert.throws(() => a.init({ agents: ['newbie'], force: true, human: 'fable' }), /name a registered human/);
  assert.throws(() => a.init({ force: true, human: 'zed' }), /name a registered human/);
  assert.deepEqual(listTree45(home), before);
  a.init({ agents: ['newbie'], force: true, human: 'ada' });
  a.store.invalidate();
  assert.equal(a.config().human, 'ada'); assert.ok(a.registry().newbie);
  assert.deepEqual(Object.keys(a.registry()).filter((k) => a.registry()[k].role === 'human'), ['ada']);
  // the registry's only human is enough without --human
  fs.rmSync(path.join(home, 'config.json')); a.store.invalidate();
  a.init({ force: true }); a.store.invalidate();
  assert.equal(a.config().human, 'ada');
});

test('config writers refuse a missing config.json or home with "not initialised", writing nothing', () => {
  const { a, home } = fresh();
  fs.rmSync(path.join(home, 'config.json'));
  const before = listTree45(home);
  assert.throws(() => a.setFamilyModels('opus', ['x']), /not initialised at .* \(run: iac init\)/);
  assert.throws(() => a.setLaunch('opus', ['x']), /not initialised/);
  assert.deepEqual(listTree45(home), before);
  const gone = path.join(os.tmpdir(), 'iac-54-nohome-' + process.pid);
  assert.throws(() => new Agora(gone, { env: {} }).setFamilyHarness('opus', 'codex'), /not initialised at .* \(run: iac init\)/);
  assert.equal(fs.existsSync(gone), false);
});

test('stale config.human with one registered human: init --force without --human repairs it', () => {
  const { a, home } = fresh();
  const cfgPath = path.join(home, 'config.json');
  const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); c.human = 'human'; fs.writeFileSync(cfgPath, JSON.stringify(c));
  a.init({ agents: ['newbot'], force: true }); a.store.invalidate();
  assert.equal(a.config().human, 'ada'); assert.equal(a.registry().human, undefined);
  // explicit --human naming the registered human also repairs, without --replace-human
  c.human = 'human'; fs.writeFileSync(cfgPath, JSON.stringify(c)); a.store.invalidate();
  a.init({ human: 'ada', force: true }); a.store.invalidate();
  assert.equal(a.config().human, 'ada');
  // but a new name over a stale one still needs --replace-human
  c.human = 'human'; fs.writeFileSync(cfgPath, JSON.stringify(c)); a.store.invalidate();
  assert.throws(() => a.init({ human: 'zed', force: true }), /not a registered human.*--replace-human/);
});

test('stale config.human with several registered humans: refused with the exact command', () => {
  const { a, home } = fresh();
  const regPath = path.join(home, 'agents.json');
  const r = JSON.parse(fs.readFileSync(regPath, 'utf8')); r.fable.role = 'human'; fs.writeFileSync(regPath, JSON.stringify(r));
  const cfgPath = path.join(home, 'config.json');
  const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); c.human = 'human'; fs.writeFileSync(cfgPath, JSON.stringify(c));
  a.store.invalidate();
  const before = listTree45(home);
  assert.throws(() => a.init({ agents: ['newbot'], force: true }), /several humans \(fable, ada\).*iac init --force --human <name> --replace-human/);
  assert.deepEqual(listTree45(home), before);
});

test('verify: a thread file copied under another id fails, naming both ids; show marks it unverified', async () => {
  const { a, home } = fresh();
  const { thread } = await a.open({ as: 'fable', title: 'Original', kind: 'question', body: 'Which shape? @astra' });
  await a.post({ as: 'astra', thread, body: 'See commit abc123.' });
  assert.equal(a.verify(thread).ok, true, 'a normal store verifies');
  const copy = 't-abcdef12';
  fs.copyFileSync(path.join(home, 'threads', `${thread}.ndjson`), path.join(home, 'threads', `${copy}.ndjson`));
  const b = new Agora(home, { env: { IAC_PROJECT: 'test/suite' } });
  const v = b.verify(copy);
  assert.equal(v.ok, false);
  const m = v.problems.filter((x) => x.problem === 'thread-mismatch');
  assert.equal(m.length, 2);
  assert.ok(m[0].message.includes(thread) && m[0].message.includes(copy), m[0].message);
  assert.equal(b.verify(thread).ok, true, 'the original still verifies');
  assert.equal(b.verifyAll().filter((r) => !r.ok).length, 1);
  // treated like a bad signature: still readable, but every post is flagged unverified
  const shown = b.threadWithVerification(copy);
  assert.equal(shown.verified, false);
  assert.ok(shown.posts.every((p) => p.verified === false));
  const cli = spawnSync(process.execPath, [binPath('iac.js'), 'verify'], { encoding: 'utf8', env: { PATH: process.env.PATH, ...HARNESS_CLEAN, IAC_HOME: home } });
  assert.equal(cli.status, 2);
  assert.ok(cli.stdout.includes(thread) && cli.stdout.includes(`stored under ${copy}`), cli.stdout);
});

test('add-agent will not register a second human', () => {
  const { a, home } = fresh();
  const before = listTree45(home);
  assert.throws(() => a.addAgent('bob', 'human'), /will not register a second human.*iac init --force --human bob --replace-human/);
  assert.deepEqual(listTree45(home), before);
  a.addAgent('ada', 'human', { quiet: true });   // already registered: unchanged path
  a.addAgent('bot2'); assert.equal(a.registry().bot2.role, 'agent');
});

test('writeJson retries a transient EPERM/EBUSY on the replace-rename, and cleans up when it never succeeds', () => {
  const { a, home } = fresh();
  let fails = 2;
  patch45(fs, 'renameSync', function (orig, from, to) {
    if (String(to).endsWith('config.json') && fails-- > 0) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    return orig(from, to);
  }, () => a.setLaunch('fable', ['claude']));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).launch.fable, ['claude']);
  const before = fs.readFileSync(path.join(home, 'config.json'));
  patch45(fs, 'renameSync', function (orig, from, to) {
    if (String(to).endsWith('config.json')) throw Object.assign(new Error('EBUSY: busy'), { code: 'EBUSY' });
    return orig(from, to);
  }, () => assert.throws(() => a.setLaunch('fable', ['codex']), /EBUSY/));
  assert.deepEqual(fs.readFileSync(path.join(home, 'config.json')), before);
  noDebris45(home);
});

test('with several humans and a stale config.human, --human <registered> still needs --replace-human', () => {
  const { a, home } = fresh();
  const regPath = path.join(home, 'agents.json');
  const r = JSON.parse(fs.readFileSync(regPath, 'utf8')); r.fable.role = 'human'; fs.writeFileSync(regPath, JSON.stringify(r));
  const cfgPath = path.join(home, 'config.json');
  const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); c.human = 'human'; fs.writeFileSync(cfgPath, JSON.stringify(c));
  a.store.invalidate();
  const before = listTree45(home);
  assert.throws(() => a.init({ human: 'ada', force: true }), /--replace-human/);
  assert.deepEqual(listTree45(home), before);
  a.init({ human: 'ada', force: true, replaceHuman: true }); a.store.invalidate();
  assert.equal(a.config().human, 'ada');
});

test('rebuilding a default config says so (api flag and CLI note)', () => {
  const { a, home } = fresh();
  fs.rmSync(path.join(home, 'config.json'));
  const r = runBin('iac.js', ['init', '--force', '--human', 'ada'], { env: { IAC_HOME: home } });
  assert.match(r.stdout, /config\.json was rebuilt; launch, families, familyHarness and limits were reset to defaults/);
});

test('table: the effective human only changes with --replace-human', () => {
  let n = 0; let kept = 0;
  for (const literal of [false, true]) for (const cfgState of ['absent', 'stale', 'registered']) for (const nHumans of [0, 1, 2]) {
    if (literal && !nHumans) continue;
    for (const pick of ['none', 'effective', 'other', 'new']) for (const replace of [false, true]) {
      const { a, home } = fresh();
      const regPath = path.join(home, 'agents.json'); const cfgPath = path.join(home, 'config.json');
      const r = JSON.parse(fs.readFileSync(regPath, 'utf8'));
      const names = Object.keys(r);   // ada (human) among agents
      for (const k of names) r[k].role = 'agent';
      const hs = names.filter((k) => k !== 'sol').slice(0, literal ? nHumans - 1 : nHumans);
      for (const k of hs) r[k].role = 'human';
      if (literal) { r.human = { ...r.sol, role: 'human' }; hs.push('human'); }   // a registered human literally named 'human'
      fs.writeFileSync(regPath, JSON.stringify(r));
      const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (cfgState === 'absent') delete c.human; else if (cfgState === 'stale') c.human = 'ghost'; else c.human = hs[0] ?? 'ghost';
      fs.writeFileSync(cfgPath, JSON.stringify(c)); a.store.invalidate();
      const label = `${literal ? 'literal' : 'named'}/${cfgState}/${nHumans}/${pick}/${replace ? 'replace' : 'plain'}`;
      const before = a.humanName();
      const human = pick === 'none' ? undefined : pick === 'effective' ? before : pick === 'other' ? (hs.find((k) => k !== before) ?? 'fable') : 'zed';
      const tree = listTree45(home);
      try { a.init({ force: true, human, agents: ['newbot'], replaceHuman: replace }); n++; } catch (e) {
        assert.deepEqual(listTree45(home), tree, `${label}: refused, nothing written`);
        const m = /the human at .* is '([^']+)'/.exec(e.message);
        if (m) assert.equal(m[1], before, `${label}: the gate's idea of the human is what readers see`);
        // a refusal that offers to keep the human: running that advice must work and keep it
        const adv = /pass --human (\S+) to keep|drop --human to keep/.exec(e.message);
        if (adv) {
          a.init({ force: true, ...(adv[1] ? { human: adv[1] } : {}), agents: ['newbot'] }); a.store.invalidate();
          assert.equal(a.humanName(), before, `${label}: the keep advice keeps '${before}'`);
          assert.deepEqual(Object.keys(a.registry()).filter((k) => a.registry()[k].role === 'human'), hs, `${label}: keep advice adds no human`);
          kept++;
        }
        continue;
      }
      a.store.invalidate();
      if (nHumans > 0 && !replace) assert.equal(a.humanName(), before, `${label}: effective human unchanged`);
      const after = Object.keys(a.registry()).filter((k) => a.registry()[k].role === 'human');
      if (nHumans > 0 && !replace) assert.deepEqual(after, hs, `${label}: no second human`);
    }
  }
  assert.ok(n > 20, 'some combinations succeed'); assert.ok(kept > 10, `keep advice was exercised (${kept})`);
});

test('config.human absent + several humans: --human <registered other than the first> needs --replace-human', () => {
  const { a, home } = fresh();
  const regPath = path.join(home, 'agents.json'); const cfgPath = path.join(home, 'config.json');
  const r = JSON.parse(fs.readFileSync(regPath, 'utf8')); r.fable.role = 'human'; fs.writeFileSync(regPath, JSON.stringify(r));
  const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); delete c.human; fs.writeFileSync(cfgPath, JSON.stringify(c)); a.store.invalidate();
  const eff = a.humanName(); const other = eff === 'ada' ? 'fable' : 'ada';
  assert.throws(() => a.init({ force: true, human: other }), /--replace-human/);
  a.init({ force: true, human: eff }); a.store.invalidate(); assert.equal(a.humanName(), eff);
});

// ---- iac doctor ---------------------------------------------------------------
//
// Every doctor run here uses a scratch HOME and an explicit store, and asserts that the
// store and the scratch HOME (transcripts, rollouts, plugin caches) are byte-for-byte and
// mtime-for-mtime unchanged afterwards: doctor is read-only by design.

function treeSnapshot(...roots) {
  const out = {};
  const walk = (p) => {
    let st; try { st = fs.lstatSync(p); } catch { return; }
    out[p] = st.isDirectory() ? `d ${st.mtimeMs}` : `f ${st.size} ${st.mtimeMs} ${fs.readFileSync(p).toString('base64')}`;
    if (st.isDirectory()) for (const n of fs.readdirSync(p)) walk(path.join(p, n));
  };
  for (const r of roots) walk(r);
  return out;
}

async function runDoctor({ home, env = {}, ...opts }) {
  const { doctor } = await import('../src/doctor.js');
  // no WSL Windows-side lookup, and HOME-derived dirs come only from `env`
  // no managed-settings file from this machine either; every hook check is held to "never delete"
  const r = doctor({ home, env: { ...HARNESS_CLEAN, ...env }, resolve: { homedir: env.HOME || os.tmpdir(), wslUsers: null }, cwd: env.HOME || os.tmpdir(), managedSettings: null, ...opts });
  assertHookChecksSafe(r);
  return r;
}
const check = (r, id) => r.checks.find((c) => c.id === id);
/**
 * Hook commands that resolve without the host: a shim dir holding an `iac` (and iac.cmd for
 * Windows) to put on PATH, and an absolute-path form that needs no PATH at all.
 */
function hookFixture(root) {
  const bin = path.join(root, 'shim-bin'); fs.mkdirSync(bin, { recursive: true });
  for (const f of ['iac', 'iac.cmd']) fs.writeFileSync(path.join(bin, f), '', { mode: 0o755 });
  return { bin, abs: `node "${binPath('iac.js')}" brief --hook` };
}
/** The one removal doctor may say about a hook is conditional on the user seeing two briefs. */
const HOOK_SYMPTOM = /if you see two iac briefs per prompt, remove the hand-written hook in [^;]+/g;
function assertNoHookDeletion(c) {
  if (!c) return;
  const text = `${c.message} ${c.fix || ''}`.replace(HOOK_SYMPTOM, '');
  assert.doesNotMatch(text, /\b(rm|delete|deleting|remove|removing|uninstall)\b/i, `${c.id}: ${c.message} → ${c.fix}`);
}
/** Every hook check in a report, held to the same rule. */
const assertHookChecksSafe = (r) => { for (const c of r.checks.filter((x) => /^hooks-/.test(x.id))) assertNoHookDeletion(c); };

test('doctor: an uninitialised store fails with exit 1; nothing is created', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-doc-'));
  const store = path.join(scratch, 'store');
  const r = await runDoctor({ home: store, env: { HOME: scratch } });
  assert.equal(r.exitCode, 1);
  assert.equal(check(r, 'store').status, 'fail');
  assert.match(check(r, 'store').fix, /iac init/);
  assert.equal(fs.existsSync(store), false, 'doctor never creates the store');
  // a corrupt config.json is also unreadable
  fs.mkdirSync(store); fs.writeFileSync(path.join(store, 'config.json'), '{nope');
  const bad = await runDoctor({ home: store, env: { HOME: scratch } });
  assert.deepEqual([bad.exitCode, check(bad, 'store').status], [1, 'fail']);
  assert.match(check(bad, 'store').message, /not valid JSON/);
});

test('doctor: a healthy Claude Code session reports ok end to end, reading the model attachment, and writes nothing', async () => {
  const { a, home } = fresh();
  await a.open({ as: 'fable', title: 'T', body: 'hello' });
  const s = fakeSession({ models: ['claude-fable-5-1'] });
  fs.appendFileSync(s.file, JSON.stringify({ type: 'attachment', attachment: { type: 'model', identity: { modelId: 'claude-opus-5-5' } } }) + '\n');
  // the Claude plugin, installed at the CLI's version, with its hook
  const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'));
  const install = path.join(s.home, '.claude', 'plugins', 'cache', 'inter-agent-comms', 'inter-agent-comms', pkg.version);
  fs.mkdirSync(path.join(install, 'bin'), { recursive: true }); fs.mkdirSync(path.join(install, 'hooks'));
  fs.writeFileSync(path.join(install, 'bin', 'iac.js'), '');
  fs.copyFileSync(path.join(import.meta.dirname, '..', 'hooks', 'hooks.json'), path.join(install, 'hooks', 'hooks.json'));
  fs.writeFileSync(path.join(s.home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'inter-agent-comms@inter-agent-comms': [{ scope: 'user', installPath: install, version: pkg.version }] } }));
  const before = treeSnapshot(home, s.home);
  const r = await runDoctor({ home, env: s.env });
  assert.deepEqual(treeSnapshot(home, s.home), before, 'doctor wrote nothing');
  assert.equal(r.exitCode, 0);
  const st = Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
  for (const id of ['store', 'registry', 'verify', 'plugin-claude', 'harness', 'model', 'family', 'env', 'identity', 'hooks-claude']) assert.equal(st[id], 'ok', `${id}: ${JSON.stringify(check(r, id))}`);
  assert.match(check(r, 'model').message, /claude-opus-5-5 \(from the model attachment\)/);
  assert.match(check(r, 'family').message, /'opus' \(registered, pinned to claude-code\)/);
  assert.match(check(r, 'identity').message, /^opus from harness \(claude-code\)/);
  assert.equal(st['plugin-codex'], 'skip');
  // the assistant entry is named when it is the newest evidence
  s.append('claude-fable-5-1');
  assert.match(check(await runDoctor({ home, env: s.env }), 'model').message, /claude-fable-5-1 \(from the latest assistant entry\)/);
});

test('doctor: Claude record problems warn with the reason — missing transcript, /model switching, format drift, unmapped model', async () => {
  const { a, home } = fresh();
  const s = fakeSession({ models: ['claude-fable-5-1'] });
  const missing = await runDoctor({ home, env: { ...s.env, CLAUDE_CODE_SESSION_ID: 'no-such-session' } });
  assert.equal(check(missing, 'harness').status, 'warn'); assert.match(check(missing, 'harness').message, /no transcript/);
  assert.equal(check(missing, 'identity').status, 'warn');

  fs.appendFileSync(s.file, JSON.stringify({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Set model to `Opus 5`</local-command-stdout>' } }) + '\n');
  const sw = await runDoctor({ home, env: s.env });
  assert.equal(check(sw, 'model').status, 'warn'); assert.match(check(sw, 'model').message, /\/model switch/);

  // assistant entries whose shape no longer carries message.model: say the format may have changed
  const drift = fakeSession();
  for (let i = 0; i < 3; i++) fs.appendFileSync(drift.file, JSON.stringify({ type: 'assistant', message: { role: 'assistant', modelName: 'claude-opus-5' } }) + '\n');
  const d = await runDoctor({ home, env: drift.env });
  assert.equal(check(d, 'model').status, 'warn'); assert.match(check(d, 'model').message, /3 assistant entries .* format may have changed/);
  const blank = await runDoctor({ home, env: fakeSession().env });
  assert.match(check(blank, 'model').message, /names no model yet/);

  const unk = fakeSession({ models: ['claude-mystery-1'] });
  const u = await runDoctor({ home, env: unk.env });
  assert.equal(check(u, 'model').status, 'ok');
  assert.equal(check(u, 'family').status, 'warn'); assert.match(check(u, 'family').message, /matches no family/); assert.match(check(u, 'family').fix, /iac set-models/);
  // an unpinned family warns; an invalid pin fails
  a.addAgent('mystery', 'agent', { models: ['claude-mystery-*'] });
  const unpinned = await runDoctor({ home, env: unk.env });
  assert.equal(check(unpinned, 'family').status, 'warn'); assert.match(check(unpinned, 'family').fix, /--harness claude-code/);
  assert.equal(check(unpinned, 'families').status, 'warn');
  const cfgPath = path.join(home, 'config.json'); const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.familyHarness.mystery = 'claude'; fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const invalid = await runDoctor({ home, env: unk.env });
  assert.equal(check(invalid, 'families').status, 'fail'); assert.equal(invalid.exitCode, 0, 'only an unreadable store exits 1');
});

test('doctor: Codex task shells — rollout found and parsed, root-only, relative CODEX_HOME, no turn_context, missing rollout', async () => {
  const { a, home } = fresh(); a.setFamilyModels('sol', ['gpt-6-sol']); a.setFamilyHarness('sol', 'codex');
  const c = fakeCodexSession();
  const before = treeSnapshot(home, c.home);
  const ok = await runDoctor({ home, env: c.env });
  assert.deepEqual(treeSnapshot(home, c.home), before, 'doctor wrote nothing');
  assert.deepEqual(['harness', 'model', 'family', 'identity'].map((k) => check(ok, k).status), ['ok', 'ok', 'ok', 'ok']);
  assert.match(check(ok, 'model').message, /gpt-6-sol \(from the latest turn_context\)/);
  assert.match(check(ok, 'identity').message, /^sol from harness \(codex\)/);

  const root = await runDoctor({ home, env: { ...c.env, CODEX_THREAD_ID: '' } });
  assert.equal(check(root, 'harness').status, 'fail'); assert.match(check(root, 'harness').message, /root session id/);
  const rel = await runDoctor({ home, env: { ...c.env, CODEX_HOME: 'relative/codex' } });
  assert.equal(check(rel, 'harness').status, 'fail'); assert.match(check(rel, 'harness').message, /relative/);
  assert.equal(check(rel, 'plugin-codex').status, 'fail');
  const gone = await runDoctor({ home, env: { ...c.env, CODEX_THREAD_ID: 'nope', CODEX_SESSION_ID: 'nope' } });
  assert.equal(check(gone, 'harness').status, 'warn'); assert.match(check(gone, 'harness').message, /no single rollout/);

  const bare = fakeCodexSession();
  fs.writeFileSync(bare.file, JSON.stringify({ type: 'session_meta', payload: { id: bare.id } }) + '\n');
  const nt = await runDoctor({ home, env: bare.env });
  assert.equal(check(nt, 'model').status, 'warn'); assert.match(check(nt, 'model').message, /no turn_context/);
  fs.appendFileSync(bare.file, '{"type":"turn_context","payload":{"model":""}}\n');
  assert.match(check(await runDoctor({ home, env: bare.env }), 'model').message, /unparseable or names an invalid model/);
});

test('doctor: identity conflicts — ambiguous harness, IAC/AGORA disagreement, stale launcher binding', async () => {
  const { home } = fresh();
  const s = fakeSession({ models: ['claude-fable-5-1'] });
  const amb = await runDoctor({ home, env: { ...s.env, CODEX_THREAD_ID: 'x' } });
  assert.equal(check(amb, 'harness').status, 'fail'); assert.match(check(amb, 'harness').message, /both Claude and Codex/);
  const stale = await runDoctor({ home, env: { ...s.env, IAC_AGENT: 'opus', AGORA_AGENT: 'sol' } });
  assert.equal(check(stale, 'env').status, 'warn'); assert.match(check(stale, 'env').message, /IAC_AGENT=opus and AGORA_AGENT=sol differ/);
  assert.equal(check(stale, 'identity').status, 'fail'); assert.match(check(stale, 'identity').message, /^stale-binding/);
  assert.equal(stale.exitCode, 0);
  const unreg = await runDoctor({ home, env: { IAC_AGENT: 'ghost', HOME: s.home } });
  assert.match(check(unreg, 'env').message, /IAC_AGENT=ghost is not a registered agent/);
});

test('doctor: plugin versions against the CLI, stale gated hooks, duplicate hooks, a tampered or sampled chain', async () => {
  const { a, home } = fresh();
  const { thread } = await a.open({ as: 'fable', title: 'T', body: 'hello' });
  await a.open({ as: 'opus', title: 'U', body: 'there' });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-doc-'));
  const claude = path.join(scratch, '.claude'); fs.mkdirSync(path.join(claude, 'plugins'), { recursive: true });
  const install = path.join(claude, 'plugins', 'cache', 'inter-agent-comms', 'inter-agent-comms', '0.2.9');
  fs.mkdirSync(path.join(install, 'bin'), { recursive: true }); fs.writeFileSync(path.join(install, 'bin', 'iac.js'), '');
  fs.mkdirSync(path.join(install, 'hooks')); fs.copyFileSync(path.join(import.meta.dirname, '..', 'hooks', 'hooks.json'), path.join(install, 'hooks', 'hooks.json'));
  fs.writeFileSync(path.join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
    'inter-agent-comms@inter-agent-comms': [{ installPath: install, version: '0.2.9' }], 'agora@agora': [{ installPath: '/x', version: '0.2.3' }] } }));
  fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: '[ -n "$AGORA_AGENT" ] && agora brief --as "$AGORA_AGENT"' }] }] } }));
  // a Codex plugin a version behind
  const codex = path.join(scratch, '.codex'); const cdir = path.join(codex, 'plugins', 'cache', 'inter-agent-comms', 'inter-agent-comms', '0.2.9');
  fs.mkdirSync(path.join(cdir, '.codex-plugin'), { recursive: true }); fs.mkdirSync(path.join(cdir, 'bin'));
  fs.writeFileSync(path.join(cdir, 'bin', 'iac.js'), ''); fs.writeFileSync(path.join(cdir, '.codex-plugin', 'plugin.json'), JSON.stringify({ version: '0.2.9' }));
  fs.writeFileSync(path.join(codex, 'config.toml'), '[plugins."inter-agent-comms@inter-agent-comms"]\nenabled = true\n\n[hooks.state."inter-agent-comms@inter-agent-comms:plugin.json#hooks[0]:user_prompt_submit:0:0"]\ntrusted_hash = "abc"\n');
  fs.writeFileSync(path.join(codex, 'hooks.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node /x/bin/iac.js codex-hook' }] }] } }));
  // tamper with one thread
  const p = path.join(home, 'threads', `${thread}.ndjson`);
  const ev = JSON.parse(fs.readFileSync(p, 'utf8')); ev.body = 'forged'; fs.writeFileSync(p, JSON.stringify(ev) + '\n');

  const env = { HOME: scratch, USERPROFILE: scratch };
  const before = treeSnapshot(home, scratch);
  const r = await runDoctor({ home, env });
  assert.deepEqual(treeSnapshot(home, scratch), before, 'doctor wrote nothing');
  const pc = check(r, 'plugin-claude');
  assert.equal(pc.status, 'warn'); assert.match(pc.message, /plugin 0\.2\.9 \(user scope\) but CLI 0\.3\.2/); assert.match(pc.message, /agora@agora/);
  assert.match(pc.fix, /\/plugin marketplace update inter-agent-comms, then \/plugin update inter-agent-comms@inter-agent-comms/); assert.match(pc.fix, /\/plugin uninstall agora@agora/);
  assert.equal(check(r, 'plugin-codex').status, 'warn'); assert.match(check(r, 'plugin-codex').message, /plugin 0\.2\.9 but CLI/);
  const hc = check(r, 'hooks-claude');
  assert.equal(hc.status, 'warn'); assert.match(hc.message, /^likely active: plugin hook/); assert.match(hc.message, /gated on IAC_AGENT\/AGORA_AGENT .*inert/);
  assertNoHookDeletion(hc);
  const hx = check(r, 'hooks-codex');
  assert.equal(hx.status, 'warn'); assert.match(hx.message, /^plugin and hand-written hook configuration present; verification incomplete/);
  assert.match(hx.fix, /^if you see two iac briefs per prompt, remove the hand-written hook in .*hooks\.json; if you see none, trust the hooks in \/hooks$/);
  assertNoHookDeletion(hx);
  assert.equal(check(r, 'verify').status, 'warn'); assert.match(check(r, 'verify').message, new RegExp(`${thread} PROBLEMS`));
  // a zero budget still verifies one thread, and says it sampled
  const sampled = await runDoctor({ home, env, verifyBudgetMs: 0, now: (() => { let t = 0; return () => (t += 10); })() });
  assert.match(check(sampled, 'verify').message, /^1 of 2 threads \(time budget/);
  // a plugin whose bin is gone cannot run its hook
  fs.rmSync(path.join(install, 'bin'), { recursive: true });
  assert.equal(check(await runDoctor({ home, env }), 'plugin-claude').status, 'fail');
});

test('doctor: another initialised store is a warning only when the default rules chose this one', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-doc-'));
  for (const d of ['.inter-agent-comms', '.agora']) new Agora(path.join(scratch, d), { env: {} }).init({ human: 'ada' });
  const { doctor } = await import('../src/doctor.js');
  const env = { ...HARNESS_CLEAN, HOME: scratch };
  const r = doctor({ env, resolve: { homedir: scratch, wslUsers: null } });
  assert.equal(r.store, path.join(scratch, '.inter-agent-comms'));
  assert.equal(check(r, 'store-other').status, 'warn'); assert.match(check(r, 'store-other').message, /\.agora/);
  const pinned = doctor({ home: path.join(scratch, '.agora'), env, resolve: { homedir: scratch, wslUsers: null } });
  assert.equal(check(pinned, 'store-other').status, 'ok');
});

test('CLI doctor: one line per check, --json, exit 0 with warnings, under env -i with a scratch HOME; writes nothing', async () => {
  const { home } = fresh();
  const s = fakeSession({ models: ['claude-opus-5-5'] });
  // IAC_DOCTOR_WSL_USERS='' keeps the subprocess away from the real /mnt/c/Users/*/.codex
  const env = { HOME: s.home, PATH: process.env.PATH, IAC_HOME: home, CLAUDE_CODE_SESSION_ID: s.id, IAC_DOCTOR_WSL_USERS: '', IAC_DOCTOR_MANAGED_SETTINGS: '' };
  const before = treeSnapshot(home, s.home);
  const txt = spawnSync(process.execPath, [binPath('iac.js'), 'doctor'], { env, cwd: s.home, encoding: 'utf8', timeout: 20_000 });
  assert.equal(txt.status, 0, txt.stderr);
  const lines = txt.stdout.trim().split('\n');
  assert.ok(lines.slice(0, -1).every((l) => /^(ok  |warn|FAIL|--  ) {2}\S/.test(l)), txt.stdout);
  assert.match(txt.stdout, /^ok {4}identity +opus from harness \(claude-code\), model claude-opus-5-5$/m);
  assert.match(lines.at(-1), /^\d+ ok, \d+ warn, 0 fail/);
  const js = spawnSync(process.execPath, [binPath('iac.js'), 'doctor', '--json'], { env, cwd: s.home, encoding: 'utf8', timeout: 20_000 });
  const r = JSON.parse(js.stdout);
  assert.equal(r.exitCode, 0); assert.equal(r.storeSource, 'IAC_HOME');
  assertHookChecksSafe(r);
  assert.ok(r.checks.every((c) => ['ok', 'warn', 'fail', 'skip'].includes(c.status) && c.id && c.message));
  assert.deepEqual(treeSnapshot(home, s.home), before, 'doctor wrote nothing');
  const none = spawnSync(process.execPath, [binPath('iac.js'), 'doctor'], { env: { ...env, IAC_HOME: path.join(s.home, 'nostore') }, cwd: s.home, encoding: 'utf8', timeout: 20_000 });
  assert.equal(none.status, 1); assert.match(none.stdout, /FAIL {2}store/);
  assert.equal(fs.existsSync(path.join(s.home, 'nostore')), false);
});

test('MCP iac_doctor is read-only and identity-free', async () => {
  const { home } = fresh();
  const { buildTools } = await import('../src/mcp.js');
  const s = fakeSession({ models: ['claude-opus-5-5'] });
  const t = buildTools(new Agora(home, { env: { ...HARNESS_CLEAN, ...s.env } }), '');
  const before = treeSnapshot(home, s.home);
  const out = await t.iac_doctor.run({});
  assert.deepEqual(treeSnapshot(home, s.home), before);
  assert.match(out, /identity +opus from harness/);
  assert.match(out, /\d+ ok, \d+ warn, \d+ fail/);
});

test('doctor: malformed installed_plugins, config.json and agents.json are reported, never thrown', async () => {
  const { home } = fresh();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-doc-'));
  const claude = path.join(scratch, '.claude'); fs.mkdirSync(path.join(claude, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'inter-agent-comms@inter-agent-comms': [{ installPath: 123, version: 7 }, null, 'x'] } }));
  const env = { HOME: scratch };
  const r = await runDoctor({ home, env });
  assert.equal(r.exitCode, 0);
  assert.equal(check(r, 'plugin-claude').status, 'fail'); assert.match(check(r, 'plugin-claude').message, /no usable installPath/);
  assert.equal(check(r, 'hooks-claude').status, 'warn');
  // through the CLI too: a report, not a crash
  const cli = spawnSync(process.execPath, [binPath('iac.js'), 'doctor', '--json'], { env: { HOME: scratch, PATH: process.env.PATH, IAC_HOME: home, IAC_DOCTOR_WSL_USERS: '', IAC_DOCTOR_MANAGED_SETTINGS: '' }, cwd: scratch, encoding: 'utf8', timeout: 20_000 });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).checks.find((c) => c.id === 'plugin-claude').status, 'fail');

  const cfg = path.join(home, 'config.json'); const reg = path.join(home, 'agents.json');
  const goodCfg = fs.readFileSync(cfg, 'utf8'); const goodReg = fs.readFileSync(reg, 'utf8');
  for (const bad of ['null', '[]', '7']) {
    fs.writeFileSync(cfg, bad);
    const d = await runDoctor({ home, env });
    assert.deepEqual([d.exitCode, check(d, 'store').status], [1, 'fail'], bad);
    assert.match(check(d, 'store').message, /does not hold a JSON object/);
    // Store.config treats it like unparseable JSON: the defaults
    assert.equal(new Store(home).config().limits.titleMax, 80, bad);
  }
  fs.writeFileSync(cfg, goodCfg);
  fs.writeFileSync(reg, '["fable"]');
  const a = await runDoctor({ home, env });
  assert.deepEqual([a.exitCode, check(a, 'registry').status], [1, 'fail']);
  assert.match(check(a, 'registry').message, /does not hold a JSON object/);
  assert.ok(!r.checks.concat(a.checks).some((c) => /\b0 match/.test(c.message)), 'no "0 matches" from array indices');
  assert.deepEqual(new Store(home).registry(), {});
  fs.writeFileSync(reg, goodReg);
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    fs.chmodSync(path.join(home, 'threads'), 0o000);
    try {
      const t = await runDoctor({ home, env });
      assert.deepEqual([t.exitCode, check(t, 'verify').status], [1, 'fail']);
    } finally { fs.chmodSync(path.join(home, 'threads'), 0o755); }
  }
});

test('doctor: orphan keys, leftover init dirs and a clobbered config.human are warned with the exact fix', async () => {
  const { home } = fresh();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-doc-'));
  const clean = await runDoctor({ home, env: { HOME: scratch } });
  assert.ok(!['keys', 'init-leftover', 'human'].some((id) => check(clean, id)), JSON.stringify(clean.checks));
  fs.writeFileSync(path.join(home, 'keys', 'ghost.pem'), 'k', { mode: 0o600 });
  // a pid above the largest pid_max, so it is never alive; an mtime well past the live window
  const left = `${home}.init-4194311-abcdef`; fs.mkdirSync(path.join(left, 'keys'), { recursive: true });
  const old = new Date(Date.now() - 3_600_000); fs.utimesSync(left, old, old);
  const cfgPath = path.join(home, 'config.json'); const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.human = 'human'; fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const before = treeSnapshot(home, left);
  const r = await runDoctor({ home, env: { HOME: scratch } });
  assert.deepEqual(treeSnapshot(home, left), before, 'doctor wrote nothing');
  const k = check(r, 'keys');
  assert.equal(k.status, 'warn'); assert.match(k.message, /ghost/);
  assert.equal(k.fix, `mv '${path.join(home, 'keys', 'ghost.pem')}' '${path.join(home, 'keys', 'ghost.pem')}.orphan'`);
  const l = check(r, 'init-leftover');
  assert.equal(l.status, 'warn'); assert.match(l.message, /private keys/); assert.match(l.fix, new RegExp(`rm -r '${left.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  const h = check(r, 'human');
  assert.equal(h.status, 'warn'); assert.match(h.message, /"human", which is not a registered human \(registered: ada\)/);
  assert.equal(h.fix, 'iac init --force --human <you> --replace-human');
  assert.equal(r.exitCode, 0);
  // a crashed fresh init leaves the store absent: the leftover is still reported
  fs.rmSync(home, { recursive: true });
  const gone = await runDoctor({ home, env: { HOME: scratch } });
  assert.deepEqual([gone.exitCode, check(gone, 'init-leftover').status], [1, 'warn']);
});

test('doctor: Codex plugin needs its config.toml table; non-semver cache dirs are ignored; project/local settings can disable the Claude plugin', async () => {
  const { home } = fresh();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-doc-'));
  const base = path.join(scratch, '.codex', 'plugins', 'cache', 'inter-agent-comms', 'inter-agent-comms');
  fs.mkdirSync(path.join(base, 'tmp-staging', 'bin'), { recursive: true });
  const env = { HOME: scratch };
  assert.equal(check(await runDoctor({ home, env }), 'plugin-codex').status, 'skip', 'a non-semver dir is not an installed version');
  fs.mkdirSync(path.join(base, '0.3.2', 'bin'), { recursive: true }); fs.writeFileSync(path.join(base, '0.3.2', 'bin', 'iac.js'), '');
  fs.mkdirSync(path.join(base, '0.3.2', '.codex-plugin'));
  fs.copyFileSync(path.join(ROOT, '.codex-plugin', 'plugin.json'), path.join(base, '0.3.2', '.codex-plugin', 'plugin.json'));
  const off = check(await runDoctor({ home, env }), 'plugin-codex');
  assert.equal(off.status, 'warn'); assert.match(off.message, /not enabled in config\.toml/);
  fs.writeFileSync(path.join(scratch, '.codex', 'config.toml'), '# c\n[plugins."inter-agent-comms@inter-agent-comms"]\nenabled = true\n\n[other]\nx = 1\n');
  const untrusted = await runDoctor({ home, env });
  assert.equal(check(untrusted, 'plugin-codex').status, 'ok');
  assert.equal(check(untrusted, 'hooks-codex').status, 'warn'); assert.match(check(untrusted, 'hooks-codex').message, /saved UserPromptSubmit approval record: absent/);
  assert.equal(check(untrusted, 'hooks-codex').fix, 'trust the plugin hook in /hooks');
  fs.appendFileSync(path.join(scratch, '.codex', 'config.toml'), '\n[hooks.state."inter-agent-comms@inter-agent-comms:plugin.json#hooks[0]:user_prompt_submit:0:0"]\ntrusted_hash = "abc"\n');
  const on = await runDoctor({ home, env });
  assert.equal(check(on, 'plugin-codex').status, 'ok'); assert.equal(check(on, 'hooks-codex').status, 'warn');
  assert.match(check(on, 'hooks-codex').message, /^plugin enabled; hook verification incomplete/);
  assert.match(check(on, 'hooks-codex').message, /UserPromptSubmit codex-hook declared in the manifest/);
  assert.match(check(on, 'hooks-codex').message, /saved UserPromptSubmit approval record: present/);
  assert.match(check(on, 'hooks-codex').message, /current runtime definition match: unverified; automatic execution: unobserved/);

  const claude = path.join(scratch, '.claude'); fs.mkdirSync(path.join(claude, 'plugins'), { recursive: true });
  const install = path.join(claude, 'plugins', 'cache', 'inter-agent-comms', 'inter-agent-comms', '0.3.2');
  fs.mkdirSync(path.join(install, 'bin'), { recursive: true }); fs.writeFileSync(path.join(install, 'bin', 'iac.js'), '');
  fs.writeFileSync(path.join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'inter-agent-comms@inter-agent-comms': [{ installPath: install, version: '0.3.2' }] } }));
  fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({ enabledPlugins: { 'inter-agent-comms@inter-agent-comms': true } }));
  assert.equal(check(await runDoctor({ home, env }), 'plugin-claude').status, 'ok');
  const proj = path.join(scratch, 'proj'); fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'inter-agent-comms@inter-agent-comms': false } }));
  const dis = check(await runDoctor({ home, env, cwd: proj }), 'plugin-claude');
  assert.equal(dis.status, 'warn'); assert.match(dis.message, /disabled in .*settings\.local\.json/);
});

test('doctor: saved Codex hook approval is exact-slot scoped and never proves current trust or execution', async () => {
  const { home } = fresh();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-doc-'));
  const codex = path.join(scratch, '.codex');
  const install = path.join(codex, 'plugins', 'cache', 'inter-agent-comms', 'inter-agent-comms', '0.3.2');
  fs.mkdirSync(path.join(install, '.codex-plugin'), { recursive: true });
  fs.mkdirSync(path.join(install, 'bin')); fs.writeFileSync(path.join(install, 'bin', 'iac.js'), '');
  const manifestFile = path.join(install, '.codex-plugin', 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, '.codex-plugin', 'plugin.json'), 'utf8'));
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const config = path.join(codex, 'config.toml');
  const enabled = '[plugins."inter-agent-comms@inter-agent-comms"]\nenabled = true\n';
  const approval = (slot) => `\n[hooks.state."inter-agent-comms@inter-agent-comms:${slot}"]\ntrusted_hash = "sha256:${'0'.repeat(64)}"\n`;
  const env = { HOME: scratch };
  const hookCheck = async () => check(await runDoctor({ home, env }), 'hooks-codex');
  for (const slot of ['plugin.json#hooks[0]:session_start:0:0', 'plugin.json#hooks[0]:user_prompt_submit:0:1', 'other.json#hooks[0]:user_prompt_submit:0:0']) {
    fs.writeFileSync(config, enabled + approval(slot));
    const h = await hookCheck();
    assert.equal(h.status, 'warn');
    assert.match(h.message, /saved UserPromptSubmit approval record: absent/, slot);
    assert.doesNotMatch(h.message, /likely active|enabled and trusted/);
  }
  fs.writeFileSync(config, enabled + approval('plugin.json#hooks[0]:user_prompt_submit:0:0'));
  // A stored hash may belong to a previous definition. Static doctor must not bless it.
  manifest.hooks.hooks.UserPromptSubmit[0].hooks[0].command += ' --changed-definition';
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const before = treeSnapshot(home, scratch);
  const changed = await hookCheck();
  assert.deepEqual(treeSnapshot(home, scratch), before, 'doctor wrote no evidence or trust state');
  assert.equal(changed.status, 'warn');
  assert.match(changed.message, /saved UserPromptSubmit approval record: present/);
  assert.match(changed.message, /current runtime definition match: unverified; automatic execution: unobserved/);
  assert.match(changed.fix, /\/hooks or hooks\/list/);
  assert.doesNotMatch(changed.message, /likely active|enabled and trusted/);
  // An explicit hooks field overrides the default file, even when the latter has a hook.
  fs.mkdirSync(path.join(install, 'hooks'));
  fs.writeFileSync(path.join(install, 'hooks', 'hooks.json'), JSON.stringify(manifest.hooks));
  manifest.hooks = { hooks: {} }; fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.match((await hookCheck()).message, /no UserPromptSubmit codex-hook in the explicit manifest hooks/);
  // A non-inline source is not inferred from either the saved record or a default file.
  manifest.hooks = './other-hooks.json'; fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.match((await hookCheck()).message, /configuration unverified \(inline manifest hooks not available\)/);
});

test('doctor: a Windows-side Codex home seen from WSL — stale agora plugin, a baked store that differs, gated hooks; fallback user scan', async () => {
  const { home } = fresh();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-doc-'));
  const users = path.join(scratch, 'Users');
  const win = path.join(users, 'alice', '.codex');
  fs.mkdirSync(path.join(users, 'Public', '.codex'), { recursive: true });
  const agoraCache = path.join(win, 'plugins', 'cache', 'agora', 'agora', '0.2.3'); fs.mkdirSync(agoraCache, { recursive: true });
  fs.writeFileSync(path.join(win, 'config.toml'), [
    '[plugins."agora@agora"]', 'enabled = true', '',
    '[mcp_servers.agora]', 'command = "node"', '',
    '[mcp_servers.agora.env]', "AGORA_HOME = 'C:\\Users\\alice\\.agora'", '',
  ].join('\n'));
  fs.writeFileSync(path.join(win, 'hooks.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'if ($env:AGORA_AGENT) { agora brief }' }] }] } }));
  const { doctor } = await import('../src/doctor.js');
  const env = { ...HARNESS_CLEAN, HOME: scratch };
  const before = treeSnapshot(home, scratch);
  // no Windows user by this name: fall back to scanning Users/*, skipping Public
  const r = doctor({ home, env, cwd: scratch, managedSettings: null, resolve: { homedir: scratch, wslUsers: users, username: 'nobody' } });
  assertHookChecksSafe(r);
  assert.deepEqual(treeSnapshot(home, scratch), before, 'doctor wrote nothing');
  const p = check(r, 'plugin-codex-win');
  assert.equal(p.status, 'warn'); assert.match(p.message, /agora@agora plugin is still enabled/); assert.match(p.fix, /codex plugin remove agora@agora/);
  const m = check(r, 'mcp-codex-win');
  assert.equal(m.status, 'warn'); assert.match(m.message, /AGORA_HOME=C:\\Users\\alice\\\.agora/); assert.match(m.message, /different board/);
  assert.equal(check(r, 'hooks-codex-win').status, 'warn');
  assert.equal(r.checks.filter((c) => c.id.startsWith('plugin-codex-win')).length, 1, 'Public is skipped');
  // the same store spelled for Windows is not a mismatch
  fs.writeFileSync(path.join(win, 'config.toml'), `[mcp_servers.iac]\ncommand = "node"\nenv = { IAC_HOME = ${JSON.stringify(home)} }\n`);
  const same = doctor({ home, env, cwd: scratch, resolve: { homedir: scratch, wslUsers: users, username: 'alice' } });
  assert.equal(check(same, 'mcp-codex-win'), undefined);
  assert.equal(check(same, 'plugin-codex-win').status, 'skip');
  fs.writeFileSync(path.join(win, 'config.toml'), `[mcp_servers.iac.env]\nIAC_HOME = "D:\\\\other"\n`);
  assert.match(check(doctor({ home, env, cwd: scratch, resolve: { homedir: scratch, wslUsers: users, username: 'alice' } }), 'mcp-codex-win').message, /IAC_HOME=D:\\other/);
});

test('MCP iac_doctor over a Codex transport says it is read-only and that its harness lines are the server\'s', async () => {
  const { a, home } = fresh(); a.setFamilyModels('sol', ['gpt-6-sol']); a.setFamilyHarness('sol', 'codex');
  const c = fakeCodexSession();
  const { buildTools } = await import('../src/mcp.js');
  const ctx = { agent: null, codex: true, reason: 'the MCP client identifies as Codex (codex-mcp-client)' };
  const out = await buildTools(new Agora(home, { env: { ...HARNESS_CLEAN, ...c.env } }), '', null, ctx).iac_doctor.run({});
  assert.match(out, /^warn +mcp +this MCP server is read-only for Codex/m);
  assert.match(out, /^warn +identity +this MCP server is read-only for Codex; the CLI in a task shell attests \(the server's own environment reads as: sol from harness \(codex\)/m);
  assert.doesNotMatch(out, /^ok +identity/m);
});

test('doctor: a config.human that is any registered human is fine (after --replace-human); a live init is left alone', async () => {
  const { a, home } = fresh();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-doc-'));
  // the legitimate path: --replace-human makes bob the human; ada stays registered (her posts keep verifying)
  a.init({ force: true, human: 'bob', replaceHuman: true });
  const reg = JSON.parse(fs.readFileSync(path.join(home, 'agents.json'), 'utf8'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).human, 'bob');
  assert.ok(reg.ada && reg.bob, 'both are still registered');
  assert.equal(check(await runDoctor({ home, env: { HOME: scratch } }), 'human'), undefined, 'config.human names a registered human');
  // a just-created init dir, and an old one whose pid is alive (this process): both in progress
  const fresh1 = `${home}.init-4194311-aaaaaa`; fs.mkdirSync(fresh1);
  const mine = `${home}.init-${process.pid}-bbbbbb`; fs.mkdirSync(mine);
  const old = new Date(Date.now() - 3_600_000); fs.utimesSync(mine, old, old);
  const r = await runDoctor({ home, env: { HOME: scratch } });
  assert.equal(check(r, 'init-leftover'), undefined, JSON.stringify(r.checks));
  assert.equal(check(r, 'init-progress').status, 'ok'); assert.match(check(r, 'init-progress').message, /in progress; leave it/);
  assert.doesNotMatch(JSON.stringify(r.checks), /rm -r/);
  fs.utimesSync(fresh1, old, old);
  const later = await runDoctor({ home, env: { HOME: scratch } });
  assert.match(check(later, 'init-leftover').fix, /rm -r/);
  assert.doesNotMatch(check(later, 'init-leftover').fix, new RegExp(`${process.pid}-bbbbbb`));
});

test('doctor: names with newlines cannot forge lines; a BOM is not invalid JSON; every rendered check is one line', async () => {
  const { home } = fresh();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-doc-'));
  const cfgPath = path.join(home, 'config.json');
  fs.writeFileSync(cfgPath, '﻿' + fs.readFileSync(cfgPath, 'utf8'));
  const { renderDoctor } = await import('../src/doctor.js');
  const r = await runDoctor({ home, env: { HOME: scratch } });
  assert.deepEqual([r.exitCode, check(r, 'store').status], [0, 'ok']);
  if (process.platform === 'win32') return;
  fs.writeFileSync(path.join(home, 'keys', 'evil\nok    identity  forged.pem'), 'k');
  const left = `${home}.init-x\nFAIL  forged`; fs.mkdirSync(left);
  const old = new Date(Date.now() - 3_600_000); fs.utimesSync(left, old, old);
  const f = await runDoctor({ home, env: { HOME: scratch } });
  const out = renderDoctor(f);
  assert.equal(out.split('\n').length, f.checks.length + 1, out);
  assert.doesNotMatch(out, /^ok {4}identity {2}forged/m); assert.doesNotMatch(out, /^FAIL {2}forged/m);
  assert.match(check(f, 'keys').message, /"evil\\nok/);
  assert.match(check(f, 'keys').fix, /by hand/); assert.match(check(f, 'init-leftover').fix, /by hand/);
  // the renderer enforces it for any report
  assert.equal(renderDoctor({ exitCode: 0, checks: [{ id: 'x', status: 'ok', message: 'a\nb\r\nc', fix: 'd\ne' }] }).split('\n').length, 2);
});

test('doctor: Codex MCP env keys are matched exactly, secrets never printed, and the Windows spelling of a WSL-native store matches', async () => {
  const { home } = fresh();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-doc-'));
  const users = path.join(scratch, 'Users'); const win = path.join(users, 'alice', '.codex'); fs.mkdirSync(win, { recursive: true });
  const { doctor } = await import('../src/doctor.js');
  const run = (toml, extra = {}) => { fs.writeFileSync(path.join(win, 'config.toml'), toml); return doctor({ home, env: { ...HARNESS_CLEAN, HOME: scratch, ...extra }, cwd: scratch, resolve: { homedir: scratch, wslUsers: users, username: 'alice' } }); };
  // NOT_IAC_HOME / XAGORA_HOME are other keys; IAC_HOME is the real one and equals this store
  const ok = run(`[mcp_servers.iac]\nenv = { NOT_IAC_HOME = "sk-SECRET", XAGORA_HOME = "sk-OTHER", IAC_HOME = ${JSON.stringify(home)} }\n`);
  assert.equal(check(ok, 'mcp-codex-win'), undefined, JSON.stringify(ok.checks));
  assert.doesNotMatch(JSON.stringify(ok.checks), /sk-/);
  // quoted keys count; a non-path value is described, not printed
  const secret = run(`[mcp_servers.iac.env]\n"IAC_HOME" = "sk-SECRET"\n`);
  assert.match(check(secret, 'mcp-codex-win').message, /sets IAC_HOME to a non-path value/);
  assert.doesNotMatch(JSON.stringify(secret.checks), /sk-SECRET/);
  // a WSL-native store spelled as the share Windows sees: \\wsl$ and \\wsl.localhost, any case and slashes.
  // Only a posix store has a WSL-share spelling; on native Windows the store is already C:\...
  if (process.platform === 'win32') return;
  const posixHome = path.resolve(home).replace(/\\/g, '/');
  const share = (pre) => `${pre}\\Ubuntu${posixHome.replace(/\//g, '\\')}`;
  for (const v of [share('\\\\wsl.localhost'), share('\\\\WSL$'), share('//wsl.localhost').replace(/\\/g, '/')]) {
    const r = run(`[mcp_servers.iac.env]\nIAC_HOME = ${JSON.stringify(v)}\n`, { WSL_DISTRO_NAME: 'Ubuntu' });
    assert.equal(check(r, 'mcp-codex-win'), undefined, `${v}: ${JSON.stringify(r.checks.find((c) => c.id === 'mcp-codex-win'))}`);
  }
  // another distro, or another store: warned, and the hint is the Windows spelling
  const other = run(`[mcp_servers.iac.env]\nIAC_HOME = ${JSON.stringify(share('\\\\wsl.localhost').replace('Ubuntu', 'Debian'))}\n`, { WSL_DISTRO_NAME: 'Ubuntu' });
  const m = check(other, 'mcp-codex-win');
  assert.equal(m.status, 'warn');
  assert.ok(m.fix.includes(`\\\\wsl.localhost\\Ubuntu${posixHome.replace(/\//g, '\\')}`), m.fix);
});

test('doctor: destructive hints quote the real path byte for byte, double spaces included', async () => {
  if (process.platform === 'win32') return;
  const { home } = fresh();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-doc-'));
  const left = `${home}.init-1-dd  two`; fs.mkdirSync(left);
  const decoy = `${home}.init-1-dd two`;   // the collapsed spelling must never be what the hint names
  const old = new Date(Date.now() - 3_600_000); fs.utimesSync(left, old, old);
  const key = path.join(home, 'keys', 'a  b.pem'); fs.writeFileSync(key, 'k');
  const { renderDoctor } = await import('../src/doctor.js');
  const r = await runDoctor({ home, env: { HOME: scratch } });
  const unquote = (q) => q.slice(1, -1).replace(/'\\''/g, "'");
  const l = check(r, 'init-leftover');
  assert.equal(l.fix, `check nothing is mid-init, then delete: rm -r '${left}'`);
  assert.equal(unquote(l.fix.match(/rm -r ('.*')$/)[1]), left);
  assert.notEqual(unquote(l.fix.match(/rm -r ('.*')$/)[1]), decoy);
  assert.match(l.message, /"store\.init-1-dd {2}two"|\.init-1-dd {2}two"/);
  const k = check(r, 'keys');
  assert.equal(k.fix, `mv '${key}' '${key}.orphan'`);
  assert.match(k.message, /"a {2}b"/);
  // and the rendered line carries the same bytes
  const out = renderDoctor(r);
  assert.ok(out.includes(`rm -r '${left}'`), out); assert.ok(out.includes(`mv '${key}' '${key}.orphan'`), out);
});

test('doctor: a file that exists but cannot be read is "unreadable (CODE)", never "missing"', async () => {
  const { home } = fresh();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-doc-'));
  const env = { HOME: scratch };
  const reg = path.join(home, 'agents.json'); const cfg = path.join(home, 'config.json');
  // EISDIR works for every user, root included
  const regText = fs.readFileSync(reg, 'utf8');
  fs.rmSync(reg); fs.mkdirSync(reg);
  const d = await runDoctor({ home, env });
  assert.equal(d.exitCode, 1);
  assert.equal(check(d, 'registry').status, 'fail');
  assert.match(check(d, 'registry').message, /exists but cannot be read \(EISDIR\)/);
  assert.doesNotMatch(check(d, 'registry').message, /missing/);
  assert.doesNotMatch(check(d, 'registry').fix, /init --force/, 'recreating would orphan every key');
  fs.rmdirSync(reg); fs.writeFileSync(reg, regText);
  const cfgText = fs.readFileSync(cfg, 'utf8');
  fs.rmSync(cfg); fs.mkdirSync(cfg);
  const c = await runDoctor({ home, env });
  assert.deepEqual([c.exitCode, check(c, 'store').status], [1, 'fail']);
  assert.match(check(c, 'store').message, /cannot be read \(EISDIR\)/); assert.doesNotMatch(check(c, 'store').message, /not initialised/);
  fs.rmdirSync(cfg); fs.writeFileSync(cfg, cfgText);
  // Reproduction: agents.json mode 000 (EACCES); not meaningful as root
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    fs.chmodSync(reg, 0o000);
    try {
      const e = await runDoctor({ home, env });
      assert.equal(e.exitCode, 1);
      assert.match(check(e, 'registry').message, /cannot be read \(EACCES\)/);
      assert.doesNotMatch(check(e, 'registry').fix, /init --force/);
    } finally { fs.chmodSync(reg, 0o600); }
  }
  assert.equal((await runDoctor({ home, env })).exitCode, 0);
});

test('doctor: with the cached plugin disabled, the hand-written hook is the likely active one and is never advised away', async () => {
  const { home } = fresh();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-doc-'));
  const claude = path.join(scratch, '.claude'); fs.mkdirSync(path.join(claude, 'plugins'), { recursive: true });
  const install = path.join(claude, 'plugins', 'cache', 'inter-agent-comms', 'inter-agent-comms', '0.3.2');
  fs.mkdirSync(path.join(install, 'bin'), { recursive: true }); fs.writeFileSync(path.join(install, 'bin', 'iac.js'), '');
  fs.mkdirSync(path.join(install, 'hooks')); fs.copyFileSync(path.join(import.meta.dirname, '..', 'hooks', 'hooks.json'), path.join(install, 'hooks', 'hooks.json'));
  fs.writeFileSync(path.join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'inter-agent-comms@inter-agent-comms': [{ installPath: install, version: '0.3.2' }] } }));
  const settings = (enabled, hooks) => fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({ enabledPlugins: { 'inter-agent-comms@inter-agent-comms': enabled }, hooks }));
  // hermetic: `iac` resolves through a fixture shim dir, never through the host's PATH
  const fx = hookFixture(scratch);
  const manual = { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'iac brief --hook' }] }] };
  const env = { HOME: scratch, PATH: fx.bin };
  const run = async () => { const r = await runDoctor({ home, env, managedSettings: null }); assertHookChecksSafe(r); return check(r, 'hooks-claude'); };
  settings(false, manual);
  const off = await run();
  assert.equal(off.status, 'ok', JSON.stringify(off));
  assert.match(off.message, /^likely active: hand-written hook/); assert.match(off.message, /plugin hook: cached at .*, disabled/);
  // the absolute form (node "<cli>" brief --hook) needs no PATH at all
  settings(false, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: fx.abs }] }] });
  const abs = check(await runDoctor({ home, env: { HOME: scratch, PATH: '' }, managedSettings: null }), 'hooks-claude');
  assert.equal(abs.status, 'ok', JSON.stringify(abs)); assert.match(abs.message, /^likely active: hand-written hook/);
  // without the shim, `iac` is not resolvable here: still the likely active hook, never advised away
  settings(false, manual);
  const bare = check(await runDoctor({ home, env: { HOME: scratch, PATH: '' }, managedSettings: null }), 'hooks-claude');
  assert.equal(bare.status, 'warn'); assert.match(bare.message, /^likely active: hand-written hook/); assert.match(bare.message, /not on PATH here/);
  assertNoHookDeletion(bare);
  settings(false, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: '[ -n "$AGORA_AGENT" ] && agora brief' }] }] });
  const gated = await run();
  assert.equal(gated.status, 'warn'); assert.match(gated.message, /^likely active: none/); assert.match(gated.message, /inert/);
  assert.match(gated.fix, /^if you see no iac brief, \/plugin enable inter-agent-comms@inter-agent-comms, or add /);
  settings(false, {});
  const none = await run();
  assert.equal(none.status, 'warn'); assert.match(none.message, /^likely active: none/);
  settings(true, manual);
  const dup = await run();
  assert.equal(dup.status, 'warn'); assert.match(dup.message, /^both may run \(duplicate briefs\)/);
  assert.match(dup.fix, new RegExp(`^if you see two iac briefs per prompt, remove the hand-written hook in ${path.join(claude, 'settings.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}; if you see none, `));
});

test('doctor hook checks: scoped installs, unreadable layers, untrusted Codex hooks, managed settings and disableAllHooks never yield delete advice', async () => {
  const { home } = fresh();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-doc-'));
  const claude = path.join(scratch, '.claude'); fs.mkdirSync(path.join(claude, 'plugins'), { recursive: true });
  const install = path.join(claude, 'plugins', 'cache', 'inter-agent-comms', 'inter-agent-comms', '0.3.2');
  fs.mkdirSync(path.join(install, 'bin'), { recursive: true }); fs.writeFileSync(path.join(install, 'bin', 'iac.js'), '');
  fs.mkdirSync(path.join(install, 'hooks')); fs.copyFileSync(path.join(import.meta.dirname, '..', 'hooks', 'hooks.json'), path.join(install, 'hooks', 'hooks.json'));
  const projA = path.join(scratch, 'projA'); const projB = path.join(scratch, 'projB');
  for (const p of [projA, projB]) fs.mkdirSync(path.join(p, '.git'), { recursive: true });
  const sub = path.join(projB, 'src', 'deep'); fs.mkdirSync(sub, { recursive: true });
  const installs = (entries) => fs.writeFileSync(path.join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'inter-agent-comms@inter-agent-comms': entries } }));
  const fx = hookFixture(scratch);
  fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'iac brief --hook' }] }] } }));
  const env = { HOME: scratch, PATH: fx.bin };
  const hc = async (opts) => { const r = await runDoctor({ home, env, ...opts }); return [check(r, 'hooks-claude'), check(r, 'plugin-claude'), r]; };

  // 1. a local-scoped install for projA does not run in projB (doctor run from a subdirectory of projB)
  installs([{ scope: 'local', projectPath: projA, installPath: install, version: '0.3.2' }]);
  const [b, bp] = await hc({ cwd: sub });
  assert.equal(b.status, 'ok'); assert.match(b.message, /^likely active: hand-written hook/); assert.match(b.message, /plugin hook: not installed here/);
  assert.match(bp.message, new RegExp(`installed for ${projA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(local scope\\), not this project`));
  // ...but in projA it does: both may run, and the only removal is conditional on the symptom
  const [a] = await hc({ cwd: projA });
  assert.match(a.message, /^both may run/); assert.match(a.fix, /^if you see two iac briefs per prompt, remove the hand-written hook/);

  // 2. an unreadable project or local settings layer makes the plugin state unknown, not "enabled"
  installs([{ scope: 'user', installPath: install, version: '0.3.2' }]);
  fs.mkdirSync(path.join(projB, '.claude', 'settings.local.json'), { recursive: true });   // EISDIR: unreadable for any user
  const [u, up] = await hc({ cwd: projB });
  assert.equal(u.status, 'warn'); assert.match(u.message, /^unknown/); assert.match(u.message, /settings\.local\.json is unreadable \(EISDIR\)/);
  assert.match(up.message, /enabled is unknown/); assert.match(up.message, /local=unreadable \(EISDIR\)/);
  fs.rmdirSync(path.join(projB, '.claude', 'settings.local.json'));

  // managed settings: highest precedence, and disableAllHooks there means no hook runs at all
  const managed = path.join(scratch, 'managed-settings.json');
  fs.writeFileSync(managed, JSON.stringify({ enabledPlugins: { 'inter-agent-comms@inter-agent-comms': false } }));
  fs.writeFileSync(path.join(projB, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'inter-agent-comms@inter-agent-comms': true } }));
  const [m, mp] = await hc({ cwd: projB, managedSettings: managed });
  assert.match(mp.message, /disabled in .*managed-settings\.json/); assert.match(m.message, /^likely active: hand-written hook/);
  fs.writeFileSync(managed, JSON.stringify({ disableAllHooks: true }));
  const [off] = await hc({ cwd: projB, managedSettings: managed });
  assert.equal(off.status, 'warn'); assert.match(off.message, /^likely active: none \(all hooks disabled\)/);
  assert.match(off.fix, /unset disableAllHooks in .*managed-settings\.json/);

  // 3. Codex: an untrusted plugin hook beside a hand-written one is not a duplicate to clean up
  const codex = path.join(scratch, '.codex'); const cdir = path.join(codex, 'plugins', 'cache', 'inter-agent-comms', 'inter-agent-comms', '0.3.2');
  fs.mkdirSync(path.join(cdir, 'bin'), { recursive: true }); fs.writeFileSync(path.join(cdir, 'bin', 'iac.js'), '');
  fs.writeFileSync(path.join(codex, 'config.toml'), '[plugins."inter-agent-comms@inter-agent-comms"]\nenabled = true\n');
  fs.writeFileSync(path.join(codex, 'hooks.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node /x/bin/iac.js codex-hook' }] }] } }));
  const [, , r3] = await hc({ cwd: projB });
  const x = check(r3, 'hooks-codex');
  assert.equal(x.status, 'warn'); assert.match(x.message, /^plugin and hand-written hook configuration present; verification incomplete/);
  assert.match(x.message, /saved UserPromptSubmit approval record: absent/);
  assert.match(x.fix, /if you see none, trust the hooks in \/hooks$/);
  // an unreadable config.toml: unknown
  fs.rmSync(path.join(codex, 'config.toml')); fs.mkdirSync(path.join(codex, 'config.toml'));
  const [, , r4] = await hc({ cwd: projB });
  assert.match(check(r4, 'hooks-codex').message, /^unknown/);
  // the rendered text of every hook check: no rm/delete/remove except the symptom sentence
  const { renderDoctor } = await import('../src/doctor.js');
  for (const rep of [r3, r4]) for (const line of renderDoctor(rep).split('\n').filter((l) => /\bhooks-/.test(l))) {
    assert.doesNotMatch(line.replace(HOOK_SYMPTOM, ''), /\b(rm|delete|remove|uninstall)\b/i, line);
  }
});
test('a torn final line: verify names thread and line (exit 2), reads survive, the next post lands on its own line', async () => {
  const { brief } = await import('../src/format.js');
  const { a, home, clock } = fresh();
  const { thread } = await a.open({ as: 'fable', title: 'Torn', kind: 'status', waitingOn: ['astra'], body: 'first @astra' });
  const other = (await a.open({ as: 'sol', title: 'Other', kind: 'status', body: 'untouched' })).thread;
  const file = path.join(home, 'threads', `${thread}.ndjson`);
  fs.appendFileSync(file, '{"type":"post","id":"e-torn","thr'); // crash mid-write, no newline
  a.store.invalidate();
  const cli = (...args) => spawnSync(process.execPath, [binPath('iac.js'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...HARNESS_CLEAN, IAC_HOME: home } });
  const v = cli('verify');
  assert.equal(v.status, 2, v.stdout + v.stderr);
  assert.ok(v.stdout.includes(thread) && /unparseable@line 2/.test(v.stdout), v.stdout);
  assert.ok(new RegExp(`${other}  ✓`).test(v.stdout), 'the other thread is unaffected');
  assert.deepEqual(a.verify(thread).problems.map((p) => [p.kind, p.line, p.thread]), [['unparseable', 2, thread]]);
  // reads keep working
  assert.ok(brief(a, 'astra').includes('waiting on astra'));
  assert.equal(a.inbox({ as: 'astra' }).length >= 0, true);
  assert.equal(a.threads().length, 2);
  const shown = a.threadWithVerification(thread);
  assert.deepEqual(shown.damagedLines.map((d) => d.line), [2]);
  assert.match(cli('show', thread).stdout, /DAMAGED: line 2/);
  assert.equal(a.waitingBoard().length, 1);
  // the next append starts on its own line, chains to the last valid event, and verifies
  clock.tick(MIN);
  await a.post({ as: 'astra', thread, body: 'after the tear' });
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  assert.equal(lines[1], '{"type":"post","id":"e-torn","thr');
  assert.equal(JSON.parse(lines[2]).author, 'astra');
  const v2 = a.verify(thread);
  assert.deepEqual(v2.problems.map((p) => p.problem), ['unparseable'], 'only the torn line is flagged; the new event verifies and chains');
  assert.equal(v2.events, 2);
});

test('a corrupt middle line is reported; other threads are unaffected', async () => {
  const { a, home } = fresh();
  const t1 = (await a.open({ as: 'fable', title: 'One', kind: 'status', body: 'a' })).thread;
  await a.post({ as: 'opus', thread: t1, body: 'b' });
  const t2 = (await a.open({ as: 'sol', title: 'Two', kind: 'status', body: 'c' })).thread;
  const file = path.join(home, 'threads', `${t1}.ndjson`);
  const ls = fs.readFileSync(file, 'utf8').split('\n');
  fs.writeFileSync(file, [ls[0], 'not json at all', ls[1], ''].join('\n'));
  a.store.invalidate();
  const v = a.verify(t1);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => p.kind === 'unparseable' && p.line === 2));
  assert.equal(a.verify(t2).ok, true);
  assert.equal(a.thread(t1).posts.length, 2, 'valid events around the damage still read');
  assert.equal(a.verifyAll().length, 2);
});

test('verify requires the signature to be the canonical base64 the signer wrote', async () => {
  const { a, home } = fresh();
  const { thread } = await a.open({ as: 'fable', title: 'Sig', kind: 'status', body: 'x' });
  const file = path.join(home, 'threads', `${thread}.ndjson`);
  const ev = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  assert.equal(a.verify(thread).ok, true);
  for (const sig of [ev.sig + '!!', ev.sig.slice(0, 20) + '\n' + ev.sig.slice(20), ev.sig.replace(/=+$/, '') + (ev.sig.endsWith('=') ? '' : '')]) {
    if (sig === ev.sig) continue;
    fs.writeFileSync(file, JSON.stringify({ ...ev, sig }) + '\n');
    a.store.invalidate();
    assert.ok(a.verify(thread).problems.some((p) => p.problem === 'bad-signature'), JSON.stringify(sig));
  }
});

test('MCP iac_verify on a missing thread is a clean error', async () => {
  const { buildTools } = await import('../src/mcp.js');
  const { a } = fresh();
  assert.throws(() => buildTools(a, '').iac_verify.run({ thread: 't-abcdef' }), /no such thread: t-abcdef/);
  const { thread } = await a.open({ as: 'fable', title: 'M', kind: 'status', body: 'x' });
  assert.match(buildTools(a, '').iac_verify.run({ thread }), /ok/);
  fs.appendFileSync(path.join(a.store.home, 'threads', `${thread}.ndjson`), '{"x');
  a.store.invalidate();
  assert.match(buildTools(a, '').iac_verify.run({ thread }), new RegExp(`unparseable@${thread}:line 2`));
});

test('a UTF-8 BOM at the start of a thread file is not a damaged line', async () => {
  const { a, home } = fresh();
  const { thread } = await a.open({ as: 'fable', title: 'Bommed', kind: 'status', body: 'x' });
  const file = path.join(home, 'threads', `${thread}.ndjson`);
  fs.writeFileSync(file, '﻿' + fs.readFileSync(file, 'utf8'));
  a.store.invalidate();
  assert.equal(a.verify(thread).ok, true);
  const s = a.thread(thread);
  assert.equal(s.title, 'Bommed'); assert.equal(s.project, 'test/suite'); assert.ok(!s.damagedLines);
});

test('damage is visible: brief note, DAMAGED in list, marks on waits and inbox; posts still allowed', async () => {
  const { brief } = await import('../src/format.js');
  const { buildTools } = await import('../src/mcp.js');
  const { a, home, clock } = fresh(); noIdle(a);
  const { thread } = await a.open({ as: 'fable', title: 'Damaged', kind: 'status', waitingOn: ['astra'], body: 'need you @astra' });
  const clean = (await a.open({ as: 'sol', title: 'Clean', kind: 'status', body: 'ok' })).thread;
  assert.ok(!/damaged/.test(brief(a, 'astra')), 'no note on a healthy board');
  clock.tick(MIN);
  await a.post({ as: 'astra', thread, body: 'on it', kind: 'ack' });
  clock.tick(MIN);
  await a.clearWait({ as: 'fable', thread, post: a.thread(thread).posts[0].id, on: 'astra', reason: 'no longer needed' });
  const file = path.join(home, 'threads', `${thread}.ndjson`);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  lines[lines.length - 1] = lines[lines.length - 1].slice(0, 30); // corrupt the last (clear) line
  fs.writeFileSync(file, lines.join('\n') + '\n');
  a.store.invalidate();
  const line = brief(a, 'astra');
  assert.match(line, /1 thread damaged: iac verify/);
  assert.match(line, /\(damaged thread\)/);
  assert.match(buildTools(a, 'astra').iac_brief.run({}), /damaged: iac verify/);
  const rows = a.threads();
  assert.equal(rows.find((s) => s.id === thread).damagedLines.length, 1);
  assert.ok(!rows.find((s) => s.id === thread).damaged, 'no boolean field: only structural damage refuses posts');
  assert.ok(!rows.find((s) => s.id === clean).damagedLines);
  assert.equal(a.waitingBoard({ on: 'astra' })[0].damagedLines.length, 1);
  const env = { PATH: process.env.PATH, ...HARNESS_CLEAN, IAC_HOME: home };
  const ls = spawnSync(process.execPath, [binPath('iac.js'), 'list'], { encoding: 'utf8', env });
  assert.match(ls.stdout, new RegExp(`${thread}  \\[[^\\]]*\\] DAMAGED|${thread}.*DAMAGED`));
  assert.doesNotMatch(ls.stdout.split('\n').find((l) => l.startsWith(clean)), /DAMAGED/);
  await a.post({ as: 'sol', thread, body: 'still allowed' });
  assert.equal(a.thread(thread).posts.at(-1).body, 'still allowed');
});

test('parseable but malformed events are damaged lines, not a crash for the whole board', async () => {
  const { brief } = await import('../src/format.js');
  const shapes = {
    'ts not a date': (e) => ({ ...e, ts: 'not-a-date' }),
    'numeric ts': (e) => ({ ...e, ts: 12345 }),
    'missing author': (e) => { const { author, ...r } = e; return r; },
    'null body': (e) => ({ ...e, body: null }),
    'unknown kind': (e) => ({ ...e, kind: 'shout' }),
    'unknown type': (e) => ({ ...e, type: 'explode' }),
    'bad waitingOn': (e) => ({ ...e, waitingOn: 'astra' }),
  };
  for (const [name, mutate] of Object.entries(shapes)) {
    const { a, home, clock } = fresh();
    const bad = (await a.open({ as: 'fable', title: 'Bad', kind: 'status', body: 'x', waitingOn: ['astra'] })).thread;
    const good = (await a.open({ as: 'sol', title: 'Good', kind: 'status', body: 'y' })).thread;
    clock.tick(MIN);
    await a.post({ as: 'opus', thread: bad, body: 'second' });
    const file = path.join(home, 'threads', `${bad}.ndjson`);
    const ls = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    ls[1] = JSON.stringify(mutate(JSON.parse(ls[1])));
    fs.writeFileSync(file, ls.join('\n') + '\n');
    a.store.invalidate();
    const v = a.verify(bad);
    assert.ok(v.problems.some((p) => p.kind === 'malformed' && p.line === 2 && p.reason), name);
    assert.equal(a.threads().length, 2, name);
    assert.ok(a.threads().find((s) => s.id === bad).damagedLines.length, name);
    assert.equal(a.waitingBoard().length, 1, name);
    assert.equal(a.threadWithVerification(good).verified, true, name);
    assert.ok(a.threadWithVerification(bad).damagedLines.some((d) => d.line === 2), name);
    assert.match(brief(a, 'astra'), /1 thread damaged: iac verify/, name);
    const cli = spawnSync(process.execPath, [binPath('iac.js'), 'verify'], { encoding: 'utf8', env: { PATH: process.env.PATH, ...HARNESS_CLEAN, IAC_HOME: home } });
    assert.equal(cli.status, 2, name);
    assert.match(cli.stdout, /malformed@line 2/, name);
  }
});

test('replay is defensive: an event that throws in derivation does not break the board', async () => {
  const { deriveState } = await import('../src/rules.js');
  const { a } = fresh();
  const evs = [{ type: 'open', id: 'e-1', thread: 't-aaaaaa', author: 'fable', ts: '2026-09-05T12:00:00Z', title: 'T', body: 'b', kind: 'status' },
    { type: 'post', id: 'e-2', get ts() { throw new Error('boom'); } }];
  const s = deriveState('t-aaaaaa', evs, a.config(), a.registry(), Date.now());
  assert.equal(s.title, 'T'); assert.deepEqual(s.damagedLines, [{ kind: 'replay-error' }]); assert.equal(s.damaged, undefined);
});

test('a thread never vanishes: max-date ts and a non-numeric TTL are damaged or defaulted, nothing throws', async () => {
  const { brief } = await import('../src/format.js');
  // 1. a well-shaped event with an out-of-range timestamp is a damaged line
  {
    const { a, home } = fresh();
    const t = (await a.open({ as: 'fable', title: 'Far', kind: 'status', body: 'x', waitingOn: ['astra'] })).thread;
    const other = (await a.open({ as: 'sol', title: 'Near', kind: 'status', body: 'y' })).thread;
    const file = path.join(home, 'threads', `${t}.ndjson`);
    const ev = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.appendFileSync(file, JSON.stringify({ ...ev, id: 'e-far', ts: '+275760-09-13T00:00:00.000Z', type: 'post', body: 'b', kind: 'status', sig: 'AAAA' }) + '\n');
    a.store.invalidate();
    assert.equal(a.threads().length, 2);
    assert.ok(a.verify(t).problems.some((p) => p.kind === 'malformed' && /range/.test(p.reason)));
    assert.match(brief(a, 'astra'), /1 thread damaged/);
    assert.ok(a.threads().find((s) => s.id === other));
  }
  // 2. a non-numeric TTL in config falls back to the default; all threads stay listed
  {
    const { a, home } = fresh();
    const t = (await a.open({ as: 'fable', title: 'Ttl', kind: 'status', body: 'x', waitingOn: ['astra'] })).thread;
    const cfgFile = path.join(home, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, limits: { ...cfg.limits, threadTtlHours: '72h', closedTtlHours: null } }));
    a.store.invalidate();
    const s = a.threads();
    assert.equal(s.length, 1);
    assert.ok(Number.isFinite(Date.parse(s[0].expiresAt)), 'expiry derived from the default TTL');
    assert.equal(a.waitingBoard().length, 1);
    assert.ok(brief(a, 'astra').includes(t));
  }
  // 3. whatever else makes derivation throw, the thread is listed as damaged, not dropped
  {
    const { deriveState } = await import('../src/rules.js');
    const { a } = fresh();
    const t = (await a.open({ as: 'fable', title: 'Boom', kind: 'status', body: 'x' })).thread;
    const cfg = a.config(); cfg.limits.threadTtlHours = 1e300;
    const s = deriveState(t, a.store.readEvents(t), cfg, a.registry());
    assert.equal(s.expiresAt, null); assert.equal(s.damagedLines[0].kind, 'replay-error');
    const orig = a.registry.bind(a); a.registry = () => { throw new Error('registry boom'); };
    const rows = a.threads(); a.registry = orig;
    assert.equal(rows.length, 1); assert.equal(rows[0].damagedLines[0].kind, 'replay-error');
  }
});

test('event validity never depends on the reader clock; unreadable threads refuse posts', async () => {
  const { checkPost } = await import('../src/rules.js');
  const { a, home } = fresh();
  const t = (await a.open({ as: 'fable', title: 'Fast clock', kind: 'status', body: 'x' })).thread;
  // a writer whose clock runs two days ahead posts a correctly signed event
  const ahead = new Agora(home, { now: () => Date.now() + 2 * 86_400_000, env: { IAC_PROJECT: 'test/suite' } });
  await ahead.post({ as: 'opus', thread: t, body: 'from the future' });
  a.store.invalidate();
  assert.equal(a.verify(t).ok, true, 'a post dated now+2d is valid, chained and verified');
  assert.equal(a.thread(t).posts.length, 2);
  // year 10000 is outside the fixed range
  const file = path.join(home, 'threads', `${t}.ndjson`);
  const ev = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]);
  fs.appendFileSync(file, JSON.stringify({ ...ev, id: 'e-y10k', ts: '+010000-01-01T00:00:00.000Z' }) + '\n');
  a.store.invalidate();
  assert.ok(a.verify(t).problems.some((p) => p.kind === 'malformed' && /range/.test(p.reason)));
  // a post into an unreadable stub is refused
  const stub = { id: t, status: 'unreadable', posts: [], damagedLines: [{ kind: 'replay-error', reason: 'boom' }] };
  assert.throws(() => checkPost({ state: stub, allStates: [], author: 'opus', instance: 'opus@x', role: 'agent', kind: 'status', body: 'hi', mentions: [], now: Date.now(), config: a.config(), registry: a.registry() }), (e) => e instanceof Rejected && e.code === 'unreadable');
});

// ---- thread ids are created exclusively; a collision is never appended to ----------

/** Make `a` draw `ids` first, then fresh random ids; returns the list of ids it drew. */
function pinThreadIds60(a, ids) {
  const drawn = []; const queue = [...ids]; const orig = a._newThreadId.bind(a);
  a._newThreadId = () => { const id = queue.length ? queue.shift() : orig(); drawn.push(id); return id; };
  return drawn;
}

test('an open whose id collides leaves the existing thread untouched and gets a different id', async () => {
  const { a, home, clock } = fresh();
  const orig = await a.open({ as: 'fable', title: 'Deploy plan', kind: 'proposal', body: 'Ship on Friday.' });
  assert.match(orig.thread, /^t-[0-9a-f]{8}$/, 'new ids carry 4 random bytes');
  const file = path.join(home, 'threads', `${orig.thread}.ndjson`);
  const bytes = fs.readFileSync(file);
  clock.tick(MIN);
  const drawn = pinThreadIds60(a, [orig.thread]);
  const r = await a.open({ as: 'opus', title: 'Unrelated', kind: 'question', body: 'Something else.' });
  assert.notEqual(r.thread, orig.thread);
  assert.equal(drawn.length, 2, 'one collision, one retry'); assert.equal(drawn[0], orig.thread);
  assert.deepEqual(fs.readFileSync(file), bytes, 'the original file is byte-for-byte untouched');
  const s = a.thread(orig.thread);
  assert.deepEqual([s.title, s.opener, s.posts.length], ['Deploy plan', 'fable', 1]);
  const n = a.thread(r.thread);
  assert.deepEqual([n.title, n.opener, n.posts.length], ['Unrelated', 'opus', 1]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'threads', `${r.thread}.ndjson`), 'utf8')).thread, r.thread, 'the open signs the id it is stored under');
  assert.ok(a.verifyAll().every((v) => v.ok), JSON.stringify(a.verifyAll()));
  // another Store in this process, sharing the read cache, sees both threads
  assert.deepEqual(new Agora(home, { env: {} }).store.threadIds().sort(), [orig.thread, r.thread].sort());
});

test('an expired thread file not yet swept is still a collision; an id that never frees up fails cleanly', async () => {
  const { a, home, clock } = fresh();
  const old = await a.open({ as: 'fable', title: 'Old', body: 'x' });
  const file = path.join(home, 'threads', `${old.thread}.ndjson`); const bytes = fs.readFileSync(file);
  clock.tick(73 * 60 * MIN);
  assert.ok(Date.parse(a.thread(old.thread).expiresAt) < a.now(), 'expired, but its file is still there');
  pinThreadIds60(a, [old.thread]);
  const r = await a.open({ as: 'opus', title: 'New', body: 'y' });
  assert.notEqual(r.thread, old.thread);
  assert.deepEqual(fs.readFileSync(file), bytes, 'an expired thread is never reused');
  // every draw collides: bounded, then an error, and nothing new is written
  const before = a.store.threadIds().sort();
  a._newThreadId = () => old.thread;
  await assert.rejects(a.open({ as: 'astra', title: 'Stuck', body: 'z' }), /could not allocate a free thread id in 8 attempts/);
  assert.deepEqual(a.store.threadIds().sort(), before);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.existsSync(path.join(home, '.lock')), false, 'the lock is released');
});

test('Store.createThread is exclusive across Store instances; appendEvent never creates a thread file', async () => {
  const { home } = fresh();
  const s1 = new Store(home); const s2 = new Store(home);
  assert.deepEqual(s2.threadIds(), []);   // warm s2's cache with the empty listing
  // well-formed events: the reader skips anything that fails its shape check
  const ev = (n) => E({ type: 'open', id: `p-0000000${n}`, thread: 't-00c0ffee', title: `t${n}` });
  s1.createThread('t-00c0ffee', ev(1));
  assert.throws(() => s2.createThread('t-00c0ffee', ev(2)), (e) => e.code === 'EEXIST');
  assert.deepEqual(s2.readEvents('t-00c0ffee'), [ev(1)]);
  assert.deepEqual(s2.threadIds(), ['t-00c0ffee'], 'the failed create still dropped the stale listing');
  assert.throws(() => s1.appendEvent('t-0000beef', E({ thread: 't-0000beef' })), (e) => e.code === 'ENOENT');
  assert.equal(fs.existsSync(path.join(home, 'threads', 't-0000beef.ndjson')), false);
  assert.equal(s1.readEvents('t-0000beef'), null);
});

test('concurrent opens drawing the same id give distinct threads, each verifying', async () => {
  const { home } = fresh();
  const gate = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'iac-gate-')), 'go');
  const pinned = 't-c011151e';
  const kids = [0, 1, 2].map((i) => child45(`const a = new Agora(${JSON.stringify(home)}, { env: { IAC_PROJECT: 'test/suite' } });
let first = true; const orig = a._newThreadId.bind(a);
a._newThreadId = () => { if (first) { first = false; return ${JSON.stringify(pinned)}; } return orig(); };
const r = await a.open({ as: 'ada', title: 'race ${i}', body: 'b${i}' }); console.log('THREAD ' + r.thread)`, gate));
  const res = await race45(gate, kids);
  const ids = res.map((r, i) => { assert.match(r.out, /^THREAD t-[0-9a-f]{8}\nOK$/, `child ${i}: ${r.out}`); return r.out.split('\n')[0].slice(7); });
  assert.equal(new Set(ids).size, 3, `distinct threads: ${ids}`);
  assert.ok(ids.includes(pinned), 'one child won the pinned id');
  const b = new Agora(home, { env: {} });
  assert.deepEqual(b.store.threadIds().sort(), [...ids].sort());
  for (const id of ids) {
    const s = b.thread(id); assert.equal(s.posts.length, 1, id); assert.match(s.title, /^race \d$/);
    assert.equal(b.verify(id).ok, true, id);
  }
  assert.deepEqual(new Set(ids.map((id) => b.thread(id).title)).size, 3);
  noDebris45(home);
});

test('old 3-byte (6 hex) thread ids still work end to end; malformed ids are refused', async () => {
  const { a, home, clock } = fresh();
  pinThreadIds60(a, ['t-0a0b0c']);
  const { thread } = await a.open({ as: 'fable', title: 'Legacy id', kind: 'question', body: 'Old shape? @astra', waitingOn: ['astra'] });
  assert.equal(thread, 't-0a0b0c');
  clock.tick(MIN); await a.post({ as: 'astra', thread, kind: 'ack', body: 'ack' });
  clock.tick(MIN); await a.post({ as: 'astra', thread, body: 'Still fine.' });
  clock.tick(MIN); await a.close({ as: 'fable', thread, body: 'Done.' });
  assert.equal(a.verify(thread).ok, true);
  const env = { PATH: process.env.PATH, ...HARNESS_CLEAN, IAC_HOME: home };
  for (const args of [['show', thread, '--compact'], ['show', thread], ['verify', thread]]) {
    const r = spawnSync(process.execPath, [binPath('iac.js'), ...args], { encoding: 'utf8', env });
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stdout}${r.stderr}`); assert.ok(r.stdout.includes(thread) || args[0] === 'show', r.stdout);
  }
  const { buildTools } = await import('../src/mcp.js');
  assert.match(await buildTools(a, 'astra').iac_show.run({ thread }), /Legacy id/);
  for (const bad of ['t-0a0b0', 't-0A0B0C', 'p-0a0b0c0d', 't-0a0b0c/../x', 't-']) assert.throws(() => a.store.threadPath(bad), /bad thread id/, bad);
});

test('verify flags an open anywhere but first (misplaced-open) and a first event that is not an open (missing-open)', async () => {
  const { signEvent, eventHash, newId } = await import('../src/crypto.js');
  const { a, home, clock } = fresh();
  const key = (n) => fs.readFileSync(path.join(home, 'keys', `${n}.pem`), 'utf8');
  const { thread } = await a.open({ as: 'fable', title: 'Deploy plan', body: 'Ship Friday.' });
  clock.tick(MIN); await a.post({ as: 'astra', thread, body: 'ok' });
  assert.equal(a.verify(thread).ok, true);
  // a validly signed, correctly chained second open, as a pre-exclusive-create collision would have written
  const file = path.join(home, 'threads', `${thread}.ndjson`);
  const evs = a.store.readEvents(thread);
  const spliced = { type: 'open', id: newId('p'), thread, author: 'opus', instance: 'opus@test/suite', idSource: 'self', ts: a.ts(), title: 'Unrelated', kind: 'proposal', body: 'mine now', mentions: [], project: 'test/suite', prev: eventHash(evs.at(-1)) };
  spliced.sig = signEvent(spliced, key('opus'));
  fs.appendFileSync(file, JSON.stringify(spliced) + '\n');
  a.store.invalidate();
  const v = a.verify(thread);
  assert.equal(v.ok, false);
  assert.deepEqual(v.problems.map((p) => [p.problem, p.i]), [['misplaced-open', 2]], 'chain, signature and thread id are all fine: only the position is wrong');
  assert.match(v.problems[0].message, /second open \(by opus\) at position 2/);
  const s = a.thread(thread);
  assert.deepEqual([s.title, s.opener], ['Deploy plan', 'fable'], 'a later open cannot take the thread over');
  assert.equal(a.threadWithVerification(thread).posts.find((p) => p.id === spliced.id).verified, false);
  // a thread whose first event is a post
  const t2 = 't-1234abcd';
  const post = { type: 'post', id: newId('p'), thread: t2, author: 'astra', ts: a.ts(), kind: 'answer', body: 'orphan', mentions: [], prev: null };
  post.sig = signEvent(post, key('astra'));
  fs.writeFileSync(path.join(home, 'threads', `${t2}.ndjson`), JSON.stringify(post) + '\n');
  a.store.invalidate();
  assert.deepEqual(a.verify(t2).problems.map((p) => [p.problem, p.i]), [['missing-open', 0]]);
  const cli = spawnSync(process.execPath, [binPath('iac.js'), 'verify'], { encoding: 'utf8', env: { PATH: process.env.PATH, ...HARNESS_CLEAN, IAC_HOME: home } });
  assert.equal(cli.status, 2, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /misplaced-open/); assert.match(cli.stdout, /missing-open/);
});

test('the 0.2.3 fixture and every thread this suite writes start with exactly one open', async () => {
  const src = path.join(ROOT, 'test', 'fixtures', 'legacy-0.2.3-store', 'threads');
  for (const f of fs.readdirSync(src)) {
    const types = fs.readFileSync(path.join(src, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).type);
    assert.equal(types[0], 'open', f); assert.equal(types.filter((t) => t === 'open').length, 1, f);
  }
  const { a, clock } = fresh();
  const { thread } = await a.open({ as: 'fable', title: 'All kinds', body: 'x', waitingOn: ['astra'] });
  clock.tick(MIN); await a.clearWait({ as: 'fable', thread, reason: 'done' });
  clock.tick(MIN); await a.post({ as: 'astra', thread, kind: 'answer', body: 'y' });
  await a.setProject({ as: 'ada', thread, project: 'o/r' });
  await a.lock({ as: 'ada', thread, reason: 'l' }); await a.unlock({ as: 'ada', thread, reason: 'u' });
  await a.close({ as: 'ada', thread, body: 'z' });
  const v = a.verify(thread); assert.equal(v.ok, true, JSON.stringify(v.problems));
});

test('an empty thread file is missing-open, listed as damaged, refuses posts, and is swept by gc only once stale', async () => {
  const { EMPTY_THREAD_GRACE_MS } = await import('../src/api.js');
  const { a, home } = fresh();
  const live = await a.open({ as: 'fable', title: 'Live', body: 'x' });
  // a crash between the exclusive create and its write leaves a 0-byte file; blank lines are no better
  const empty = 't-deadbeef'; const blank = 't-0b1a0c0d';
  const fileOf = (id) => path.join(home, 'threads', `${id}.ndjson`);
  fs.writeFileSync(fileOf(empty), ''); fs.writeFileSync(fileOf(blank), '\n\n');
  a.store.invalidate();
  for (const id of [empty, blank]) {
    const v = a.verify(id);
    assert.deepEqual([v.ok, v.events, v.problems.map((p) => p.problem)], [false, 0, ['missing-open']], id);
    assert.equal(a.threadWithVerification(id).verified, false);
    const s = a.thread(id);
    assert.deepEqual([s.status, s.damage, s.title], ['damaged', 'empty', '(damaged: empty thread file)'], id);
    assert.equal('damaged' in s, false, 'structural damage is `damage`; `damaged` belongs to nobody');
    await rejects(a.post({ as: 'ada', thread: id, body: 'into the void' }), 'damaged');
    assert.equal(fs.statSync(fileOf(id)).size, id === empty ? 0 : 2, 'the refused post wrote nothing');
  }
  assert.equal(a.threads()[0].id, live.thread, 'a live thread sorts first; damaged ones have no activity');
  const env = { PATH: process.env.PATH, ...HARNESS_CLEAN, IAC_HOME: home };
  const list = spawnSync(process.execPath, [binPath('iac.js'), 'list', '--all'], { encoding: 'utf8', env });
  assert.match(list.stdout, new RegExp(`${empty} {2}\\[damaged\\] DAMAGED {2}\\(damaged: empty thread file\\)`), list.stdout);
  assert.doesNotMatch(list.stdout, /\[open\] {2}null/);
  const verify = spawnSync(process.execPath, [binPath('iac.js'), 'verify'], { encoding: 'utf8', env });
  assert.equal(verify.status, 2); assert.match(verify.stdout, /missing-open/);
  // fresh empty files are left alone (an open may be mid-create); stale ones go, and only those
  assert.deepEqual(a.gc(), []);
  assert.ok(fs.existsSync(fileOf(empty)) && fs.existsSync(fileOf(blank)));
  const old = new Date(Date.now() - EMPTY_THREAD_GRACE_MS - 60_000);
  fs.utimesSync(fileOf(empty), old, old);
  assert.deepEqual(a.gc(), [empty]);
  assert.equal(fs.existsSync(fileOf(empty)), false);
  assert.ok(fs.existsSync(fileOf(blank)), 'the fresh blank-only file waits its turn');
  fs.utimesSync(fileOf(blank), old, old);
  assert.deepEqual(a.gc(), [blank], 'a stale whitespace-only file is empty too, as the post hint says');
  // a stale missing-open file with content is never swept by mtime: it expires from its activity
  const { signEvent, newId } = await import('../src/crypto.js');
  const orphan = 't-0aaa0000';
  const post = { type: 'post', id: newId('p'), thread: orphan, author: 'astra', ts: a.ts(), kind: 'answer', body: 'orphan', mentions: [], prev: null };
  post.sig = signEvent(post, fs.readFileSync(path.join(home, 'keys', 'astra.pem'), 'utf8'));
  fs.writeFileSync(fileOf(orphan), JSON.stringify(post) + '\n'); fs.utimesSync(fileOf(orphan), old, old);
  a.store.invalidate();
  assert.equal(a.thread(orphan).damage, 'missing-open');
  await rejects(a.post({ as: 'ada', thread: orphan, body: 'x' }), 'damaged');
  assert.deepEqual(a.gc(), []);
  assert.ok(fs.existsSync(fileOf(orphan)));
  assert.ok(fs.existsSync(fileOf(live.thread)), 'the live thread is untouched');
  // line-level damage (`damagedLines`, or any `damaged` flag) never refuses a post: only status 'damaged' does
  const thread = a.thread.bind(a);
  a.thread = (id) => { const st = thread(id); return st && { ...st, damaged: true, damagedLines: [{ line: 3, problem: 'torn' }] }; };
  try { assert.equal((await a.post({ as: 'ada', thread: live.thread, body: 'still takes posts' })).ok, true); } finally { a.thread = thread; }
  assert.equal(a.verify(live.thread).ok, true);
});

test('a first-event-less thread derives as damaged; the first open wins even if its author is missing', async () => {
  const { deriveState } = await import('../src/rules.js');
  const { a } = fresh();
  const cfg = a.config(); const reg = a.registry(); const ts = '2026-09-05T12:00:00.000Z';
  const post = { type: 'post', id: 'p-1', thread: 't-aaaaaaaa', author: 'astra', ts, kind: 'answer', body: 'x' };
  const s = deriveState('t-aaaaaaaa', [post], cfg, reg);
  assert.deepEqual([s.status, s.damage, s.title, s.opener], ['damaged', 'missing-open', '(damaged: no open event)', null]);
  assert.ok(s.expiresAt, 'a non-empty damaged thread still expires from its activity');
  // an open with no author (null opener) must still be the one and only opener: a later open cannot slip in
  const first = { type: 'open', id: 'p-0', thread: 't-aaaaaaaa', author: null, ts, title: 'First', body: 'x' };
  const second = { type: 'open', id: 'p-2', thread: 't-aaaaaaaa', author: 'opus', ts, title: 'Takeover', body: 'y' };
  const t = deriveState('t-aaaaaaaa', [first, second], cfg, reg);
  assert.deepEqual([t.title, t.opener, t.status, t.damage], ['First', null, 'open', undefined]);
});

test('wait-board entries carry the thread status, so a structurally damaged thread is visible on its waits', async () => {
  const { signEvent, newId } = await import('../src/crypto.js');
  const { a, home } = fresh();
  const ok = await a.open({ as: 'fable', title: 'Healthy', body: 'Need you.', waitingOn: ['astra'] });
  // a validly signed post with a wait, but no open before it: missing-open
  const id = 't-0d0d0d0d';
  const post = { type: 'post', id: newId('p'), thread: id, author: 'sol', instance: 'sol@test/suite', ts: a.ts(), kind: 'question', body: 'orphan wait', mentions: ['astra'], waitingOn: ['astra'], prev: null };
  post.sig = signEvent(post, fs.readFileSync(path.join(home, 'keys', 'sol.pem'), 'utf8'));
  fs.writeFileSync(path.join(home, 'threads', `${id}.ndjson`), JSON.stringify(post) + '\n');
  a.store.invalidate();
  const byThread = Object.fromEntries(a.waitingBoard({ includeExpired: true }).map((w) => [w.thread, w]));
  assert.equal(byThread[ok.thread].status, 'open');
  assert.equal(byThread[id]?.status, 'damaged', JSON.stringify(Object.keys(byThread)));
});

test('event 0 not an open is structural damage; a later chained open never repairs it', async () => {
  const { signEvent, eventHash, newId } = await import('../src/crypto.js');
  const { a, home } = fresh();
  const key = (n) => fs.readFileSync(path.join(home, 'keys', `${n}.pem`), 'utf8');
  const id = 't-1a7e0be0';
  const post = { type: 'post', id: newId('p'), thread: id, author: 'astra', ts: a.ts(), kind: 'answer', body: 'first, but no open', mentions: [], prev: null };
  post.sig = signEvent(post, key('astra'));
  const late = { type: 'open', id: newId('p'), thread: id, author: 'opus', instance: 'opus@test/suite', idSource: 'self', ts: a.ts(), title: 'Late opener', kind: 'proposal', body: 'mine', mentions: [], project: 'test/suite', prev: eventHash(post) };
  late.sig = signEvent(late, key('opus'));
  const file = path.join(home, 'threads', `${id}.ndjson`);
  fs.writeFileSync(file, [post, late].map((e) => JSON.stringify(e) + '\n').join(''));
  a.store.invalidate();
  const v = a.verify(id);
  assert.deepEqual(v.problems.map((p) => [p.problem, p.i]), [['missing-open', 0], ['misplaced-open', 1]]);
  const s = a.thread(id);
  assert.deepEqual([s.status, s.damage, s.opener, s.title], ['damaged', 'missing-open', null, '(damaged: no open event)'], 'the late open names nobody');
  const bytes = fs.readFileSync(file);
  await rejects(a.post({ as: 'ada', thread: id, body: 'human post' }), 'damaged');
  await rejects(a.post({ as: 'opus', thread: id, body: 'late opener post' }), 'damaged');
  assert.deepEqual(fs.readFileSync(file), bytes, 'nothing was appended');
  // regression: a normal thread is unaffected
  const { thread } = await a.open({ as: 'fable', title: 'Normal', body: 'x' });
  const n = a.thread(thread);
  assert.deepEqual([n.status, n.damage, n.opener, n.title], ['open', undefined, 'fable', 'Normal']);
  assert.equal((await a.post({ as: 'ada', thread, body: 'fine' })).ok, true);
  assert.equal(a.verify(thread).ok, true);
});

test('gc does not throw on CRLF- or space-only thread files; it sweeps them once stale', async () => {
  const { EMPTY_THREAD_GRACE_MS } = await import('../src/api.js');
  const { a, home } = fresh();
  const live = await a.open({ as: 'fable', title: 'Live', body: 'x' });
  const fileOf = (id) => path.join(home, 'threads', `${id}.ndjson`);
  const odd = { 't-0c0c0c0c': '\r\n\r\n', 't-05050505': '   ', 't-0e0e0e0e': ' \r\n \t\n' };
  for (const [id, text] of Object.entries(odd)) fs.writeFileSync(fileOf(id), text);
  a.store.invalidate();
  assert.deepEqual(a.gc(), [], 'fresh ones are left alone, and gc does not throw');
  const old = new Date(Date.now() - EMPTY_THREAD_GRACE_MS - 60_000);
  for (const id of Object.keys(odd)) fs.utimesSync(fileOf(id), old, old);
  assert.deepEqual(a.gc().sort(), Object.keys(odd).sort());
  for (const id of Object.keys(odd)) assert.equal(fs.existsSync(fileOf(id)), false, id);
  // an unparseable file with real content is never swept by mtime
  fs.writeFileSync(fileOf('t-0f0f0f0f'), '{"type":"open"'); fs.utimesSync(fileOf('t-0f0f0f0f'), old, old);
  a.store.invalidate();
  assert.deepEqual(a.gc(), []);
  assert.ok(fs.existsSync(fileOf('t-0f0f0f0f')) && fs.existsSync(fileOf(live.thread)));
});

test('torn lines take posts; missing-open, torn-open-only and empty threads refuse them; all show DAMAGED, on the wait board and in the brief count', async () => {
  const { signEvent, newId } = await import('../src/crypto.js');
  const { brief, isDamaged } = await import('../src/format.js');
  const { EMPTY_THREAD_GRACE_MS } = await import('../src/api.js');
  const { a, home, clock } = fresh();
  const fileOf = (id) => path.join(home, 'threads', `${id}.ndjson`);
  // line-level damage only: a torn tail after a good open
  const torn = (await a.open({ as: 'fable', title: 'Torn tail', kind: 'status', body: 'need @astra', waitingOn: ['astra'] })).thread;
  fs.appendFileSync(fileOf(torn), '{"type":"post","id":"p-torn","thr');
  // structural: a signed post with a wait at event 0, no open
  const missing = 't-0e15510e';
  const post = { type: 'post', id: newId('p'), thread: missing, author: 'sol', instance: 'sol@test/suite', ts: a.ts(), kind: 'question', body: 'orphan', mentions: ['astra'], waitingOn: ['astra'], prev: null };
  post.sig = signEvent(post, fs.readFileSync(path.join(home, 'keys', 'sol.pem'), 'utf8'));
  fs.writeFileSync(fileOf(missing), JSON.stringify(post) + '\n');
  // structural: the only line is a torn open; and a truly empty file
  const tornOpen = 't-70a70a70'; fs.writeFileSync(fileOf(tornOpen), '{"type":"open","id":"p-x","thr');
  const empty = 't-e0e0e0e0'; fs.writeFileSync(fileOf(empty), '');
  a.store.invalidate();

  const t = a.thread(tornOpen);
  assert.deepEqual([t.status, t.damage, t.title, t.damagedLines.length], ['damaged', 'missing-open', '(damaged: no readable events)', 1]);
  assert.deepEqual([a.thread(empty).damage, a.thread(empty).title], ['empty', '(damaged: empty thread file)']);
  assert.equal(a.thread(missing).damage, 'missing-open');
  assert.notEqual(a.thread(torn).status, 'damaged', 'line damage never sets status');
  assert.ok([torn, missing, tornOpen, empty].every((id) => isDamaged(a.thread(id))));

  clock.tick(MIN);
  assert.equal((await a.post({ as: 'ada', thread: torn, body: 'torn tail still takes posts' })).ok, true);
  for (const id of [missing, tornOpen, empty]) await rejects(a.post({ as: 'ada', thread: id, body: 'no' }), 'damaged');

  const env = { PATH: process.env.PATH, ...HARNESS_CLEAN, IAC_HOME: home };
  const list = spawnSync(process.execPath, [binPath('iac.js'), 'list', '--all'], { encoding: 'utf8', env });
  for (const id of [torn, missing, tornOpen, empty]) assert.match(list.stdout, new RegExp(`^${id} .* DAMAGED `, 'm'), `${id}\n${list.stdout}`);

  // the wait board: both waits carry what isDamaged needs (damagedLines, status)
  const b = new Agora(home, { now: clock.now, env: { IAC_PROJECT: 'test/suite' } });
  const waits = Object.fromEntries(b.waitingBoard({ on: 'astra' }).map((w) => [w.thread, w]));
  assert.ok(waits[torn]?.damagedLines?.length && waits[torn].status !== 'damaged');
  assert.equal(waits[missing]?.status, 'damaged');
  assert.ok(isDamaged(waits[torn]) && isDamaged(waits[missing]));
  // the brief, from a fresh reader, counts structural damage with line damage: all four
  const line = brief(new Agora(home, { now: clock.now, env: { IAC_PROJECT: 'test/suite' } }), 'astra');
  assert.match(line, /4 threads damaged/, line);
  assert.match(line, new RegExp(`sol ${missing} \\(damaged thread\\)`), line);

  // gc sweeps only the truly empty file once stale; a torn open is not "empty"
  const old = new Date(Date.now() - EMPTY_THREAD_GRACE_MS - 60_000);
  for (const id of [tornOpen, empty]) fs.utimesSync(fileOf(id), old, old);
  assert.deepEqual(a.gc(), [empty]);
  assert.ok(fs.existsSync(fileOf(tornOpen)) && fs.existsSync(fileOf(missing)) && fs.existsSync(fileOf(torn)));
});

const repairPaths = (a, thread) => ({ file: a.store.threadPath(thread), damaged: path.join(a.store.threadsDir, `${thread}.damaged`) });
async function repairFixture() {
  const f = fresh();
  f.thread = (await f.a.open({ as: 'fable', title: 'Repair', body: 'Unicode: 雪 😀 café @astra', waitingOn: ['astra'] })).thread;
  Object.assign(f, repairPaths(f.a, f.thread));
  f.original = fs.readFileSync(f.file);
  f.bad = Buffer.from('{"torn":"雪\r\n');
  fs.appendFileSync(f.file, f.bad);
  return f;
}
async function patchRepair(method, replacement, run) {
  const orig = fs[method]; fs[method] = (...args) => replacement(orig, ...args);
  try { return await run(); } finally { fs[method] = orig; }
}

test('repair: exact retained bytes, parser classification, signatures, audit chain and healthy retry', async () => {
  const { a, thread, file, damaged, original } = await repairFixture();
  const opener = JSON.parse(original.toString());
  // Formatting is not signed; preserve the original formatting rather than reserializing.
  const retained = Buffer.from('\ufeff' + JSON.stringify(opener, null, ' ').replace(/\n */g, ' ') + '\r\n \r\n');
  const removed = Buffer.from('null\r\n[1,2]\nfalse\n{"torn":"雪');
  fs.writeFileSync(file, Buffer.concat([retained, removed]));
  a.store.invalidate();
  assert.deepEqual(a.verify(thread).problems.map((p) => p.kind), Array(4).fill('unparseable'));
  const r = await a.repair({ as: 'ada', thread });
  assert.deepEqual([r.repaired, r.lines, r.damagedPath], [true, 4, damaged]);
  assert.deepEqual(fs.readFileSync(damaged), removed, 'quarantine physical bytes include original line endings and unterminated tail');
  const after = fs.readFileSync(file);
  assert.deepEqual(after.subarray(0, retained.length), retained, 'BOM, CRLF, blank line, Unicode and event formatting survive byte for byte');
  const events = a.store.readEvents(thread);
  assert.deepEqual(events[0], opener, 'no retained field or signature changed');
  assert.equal(events[1].type, 'repair'); assert.equal(events[1].author, 'ada');
  assert.equal(events[1].prev, eventHash(opener)); assert.equal(events[1].lines, 4);
  assert.equal(a.verify(thread).ok, true);
  assert.equal((await a.repair({ as: 'ada', thread })).repaired, false);
  assert.deepEqual(fs.readFileSync(file), after, 'healthy retry appends no duplicate repair audit');
  assert.deepEqual(fs.readFileSync(damaged), removed);
});

test('repair: leading garbage and valid unterminated Unicode event preserve raw bytes', async () => {
  const { a, thread, file, damaged, original } = await repairFixture();
  const opener = original.subarray(0, original.length - 1);
  const garbage = Buffer.from('\ufeffnot json\r\n');
  fs.writeFileSync(file, Buffer.concat([garbage, opener]));
  await a.repair({ as: 'ada', thread });
  assert.deepEqual(fs.readFileSync(damaged), garbage);
  assert.deepEqual(fs.readFileSync(file).subarray(0, opener.length), opener);
  assert.equal(fs.readFileSync(file)[opener.length], 0x0a, 'audit starts on its own line');
  assert.equal(a.verify(thread).ok, true);
});

test('repair: retained malformed, signature, chain, opener and thread failures refuse before writes', async () => {
  for (const failure of ['malformed', 'signature', 'chain', 'missing-open', 'misplaced-open', 'thread-mismatch']) {
    const { a, thread, file, damaged, original, bad } = await repairFixture();
    const open = JSON.parse(original.toString());
    let events = [open];
    const post = { ...open, type: 'post', id: 'p-deadbeef', body: 'second', prev: eventHash(open) };
    if (failure === 'malformed') events.push({ ...post, body: null });
    if (failure === 'signature') events[0] = { ...open, body: 'forged body' };
    if (failure === 'chain') events.push({ ...post, prev: '0'.repeat(64) });
    if (failure === 'missing-open') events = [{ ...post, prev: null }];
    if (failure === 'misplaced-open') events.push({ ...post, type: 'open' });
    if (failure === 'thread-mismatch') events[0] = { ...open, thread: 't-abcdef' };
    if (failure !== 'signature' && failure !== 'malformed') {
      for (const ev of events) ev.sig = signEvent(ev, a.store.privateKey(ev.author));
    }
    const raw = Buffer.concat([Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n'), bad]);
    fs.writeFileSync(file, raw);
    const e = await rejects(a.repair({ as: 'ada', thread }), 'repair-refused');
    assert.match(e.message, new RegExp(failure === 'signature' ? 'bad-signature' : failure === 'chain' ? 'chain-break' : failure), failure);
    assert.deepEqual(fs.readFileSync(file), raw, failure);
    assert.equal(fs.existsSync(damaged), false, failure);
    assert.deepEqual(fs.readdirSync(a.store.threadsDir), [`${thread}.ndjson`], 'no preparation artifact before verification');
  }
  for (const raw of [Buffer.alloc(0), Buffer.from(' \r\n'), Buffer.from('{"torn"')]) {
    const { a, thread, file, damaged } = await repairFixture(); fs.writeFileSync(file, raw);
    await rejects(a.repair({ as: 'ada', thread }), 'repair-refused');
    assert.deepEqual(fs.readFileSync(file), raw); assert.equal(fs.existsSync(damaged), false);
  }
});

test('repair: invalid audit key or clock refuses before recovery writes', async () => {
  for (const invalid of ['key', 'clock']) {
    const f = await repairFixture(); const raw = fs.readFileSync(f.file);
    if (invalid === 'key') { const key = f.a.store.privateKey('fable'); f.a.store.privateKey = () => key; }
    else f.a._now = () => Date.parse('1999-01-01T00:00:00Z');
    await rejects(f.a.repair({ as: 'ada', thread: f.thread }), 'repair-refused');
    assert.deepEqual(fs.readFileSync(f.file), raw); assert.equal(fs.existsSync(f.damaged), false);
    assert.deepEqual(fs.readdirSync(f.a.store.threadsDir), [`${f.thread}.ndjson`]);
  }
});

test('repair: human-only API and CLI, bound override refused, missing and healthy outcomes, no MCP tool', async () => {
  const { a, home, thread, file } = await repairFixture(); const raw = fs.readFileSync(file);
  await rejects(a.repair({ as: 'fable', thread }), 'forbidden');
  await rejects(a.repair({ as: 'nobody', thread }), 'unknown-author');
  const bound = new Agora(home, { env: { IAC_AGENT: 'fable' } });
  await rejects(bound.repair({ as: 'ada', thread }), 'identity-override');
  assert.deepEqual(fs.readFileSync(file), raw);
  const cli = (args, env = {}) => spawnSync(process.execPath, [binPath('iac.js'), ...args], { encoding: 'utf8', env: { ...process.env, ...HARNESS_CLEAN, IAC_HOME: home, ...env } });
  let c = cli(['repair', thread, '--as', 'ada'], { IAC_AGENT: 'fable' });
  assert.equal(c.status, 2); assert.match(c.stderr, /identity-override/);
  c = cli(['repair', thread, '--as', 'fable']); assert.equal(c.status, 2); assert.match(c.stderr, /only the human/);
  c = cli(['repair', 't-abcdef', '--as', 'ada']); assert.equal(c.status, 1); assert.match(c.stderr, /no such thread/);
  c = cli(['repair', thread, '--as', 'ada']); assert.equal(c.status, 0, c.stderr); assert.match(c.stdout, /quarantined 1 line\(s\).*\.damaged/);
  c = cli(['repair', thread, '--as', 'ada', '--json']); assert.equal(c.status, 0); assert.equal(JSON.parse(c.stdout).repaired, false);
  c = cli(['repair', thread, '--as', 'ada']); assert.match(c.stdout, /healthy; nothing to repair/);
  c = cli(['--help']); assert.match(c.stdout, /human \/ ops[\s\S]*repair <thread>/);
  const { buildTools } = await import('../src/mcp.js');
  for (const who of ['', 'ada', 'fable']) assert.equal(buildTools(a, who).iac_repair, undefined);
});

test('repair: fresh locked reads keep concurrent retained posts and reject newly malformed history', async () => {
  const { a, home, clock, thread, file } = await repairFixture();
  a.verify(thread); // populate the damaged reader cache
  const other = new Agora(home, { now: clock.now, env: { IAC_PROJECT: 'test/suite' } });
  const post = await other.post({ as: 'opus', thread, body: 'other writer' });
  await a.repair({ as: 'ada', thread });
  assert.equal(a.verify(thread).ok, true); assert.ok(a.thread(thread).posts.some((p) => p.id === post.post));
  a.verify(thread);
  fs.appendFileSync(file, '{"type":"no-such-event"}\n{bad');
  const raw = fs.readFileSync(file);
  await rejects(a.repair({ as: 'ada', thread }), 'repair-refused');
  assert.deepEqual(fs.readFileSync(file), raw);
});

test('repair: waits, frozen/locked/closed state, guard counts, idle and retention remain inert', async () => {
  for (const state of ['open', 'frozen', 'locked', 'auto-locked', 'closed']) {
    const { a, clock, home } = fresh();
    const { thread } = await a.open({ as: 'fable', title: state, body: '@astra wait', waitingOn: ['astra'] });
    if (state === 'frozen') for (const author of ['opus', 'fable', 'opus', 'fable', 'opus']) { await a.post({ as: author, thread, body: 'turn' }); clock.tick(MIN); }
    if (state === 'locked') await a.lock({ as: 'fable', thread, reason: 'held' });
    if (state === 'auto-locked') a.store.saveConfig({ ...a.config(), limits: { ...a.config().limits, threadPostCap: 1 } });
    if (state === 'closed') await a.close({ as: 'fable', thread, body: 'done' });
    clock.tick(2 * 60 * MIN);
    const before = a.thread(thread); const waits = a.waitingBoard({ includeExpired: true }); const inbox = a.inbox({ as: 'astra' });
    fs.appendFileSync(a.store.threadPath(thread), '{bad');
    await a.repair({ as: 'ada', thread });
    const after = a.thread(thread);
    for (const key of ['posts', 'participants', 'waitClears', 'locked', 'lockReason', 'autoLocked', 'closed', 'closedAt', 'lastActivity', 'expiresAt', 'cooldown', 'status']) assert.deepEqual(after[key], before[key], `${state}: ${key}`);
    assert.equal(after.eventCount, before.eventCount + 1);
    assert.deepEqual(a.waitingBoard({ includeExpired: true }), waits, `${state}: audit never answers waits`);
    assert.deepEqual(a.inbox({ as: 'astra' }), inbox, `${state}: no audit post appears in inbox`);
    assert.equal(new Agora(home, { now: clock.now, env: {} }).verify(thread).ok, true);
    if (state === 'frozen') await rejects(a.post({ as: 'fable', thread, body: 'still frozen' }), 'cooldown');
  }
});

test('repair: exclusive existing and racing quarantine are never overwritten or removed', async () => {
  for (const racing of [false, true]) {
    const { a, thread, file, damaged } = await repairFixture(); const raw = fs.readFileSync(file); const peer = Buffer.from('peer recovery');
    if (!racing) fs.writeFileSync(damaged, peer);
    const run = () => assert.rejects(a.repair({ as: 'ada', thread }), /EEXIST/);
    if (racing) await patchRepair('openSync', (orig, p, ...args) => {
      if (p === damaged) { const fd = orig(p, 'wx'); fs.writeFileSync(fd, peer); fs.closeSync(fd); }
      return orig(p, ...args);
    }, run); else await run();
    assert.deepEqual(fs.readFileSync(file), raw); assert.deepEqual(fs.readFileSync(damaged), peer);
    assert.deepEqual(fs.readdirSync(a.store.threadsDir).sort(), [`${thread}.damaged`, `${thread}.ndjson`]);
  }
});

test('repair: short writes finish, zero/partial writes preserve original and recovery artifacts', async () => {
  const short = await repairFixture();
  await patchRepair('writeSync', (orig, fd, buf, offset, length) => orig(fd, buf, offset, Math.min(length, 7)), () => short.a.repair({ as: 'ada', thread: short.thread }));
  assert.deepEqual(fs.readFileSync(short.damaged), short.bad); assert.equal(short.a.verify(short.thread).ok, true);
  for (const where of ['sidecar', 'candidate']) {
    const f = await repairFixture(); const raw = fs.readFileSync(f.file); let opened; let writes = 0;
    await patchRepair('openSync', (orig, p, ...args) => { const fd = orig(p, ...args); if (p === f.damaged || String(p).includes('.repair-')) opened = { fd, target: p === f.damaged ? 'sidecar' : 'candidate' }; return fd; },
      () => patchRepair('writeSync', (orig, fd, buf, offset, length) => {
        if (fd === opened?.fd && opened.target === where) { if (writes++ === 0) return orig(fd, buf, offset, 2); return 0; }
        return orig(fd, buf, offset, length);
      }, () => assert.rejects(f.a.repair({ as: 'ada', thread: f.thread }), /no valid progress.*repair recovery paths/)));
    assert.deepEqual(fs.readFileSync(f.file), raw, where);
    assert.deepEqual(fs.readFileSync(f.damaged), where === 'sidecar' ? f.bad.subarray(0, 2) : f.bad);
    const temps = fs.readdirSync(f.a.store.threadsDir).filter((p) => p.includes('.repair-'));
    assert.equal(temps.length, where === 'candidate' ? 1 : 0);
    await assert.rejects(f.a.repair({ as: 'ada', thread: f.thread }), /EEXIST/);
    assert.deepEqual(fs.readFileSync(f.file), raw, 'failed preparation retry is blocked with original untouched');
  }
});

test('repair: failed rename leaves verified candidate; rename that landed then threw has no duplicate audit on retry', async () => {
  for (const landed of [false, true]) {
    const f = await repairFixture(); const raw = fs.readFileSync(f.file);
    await patchRepair('renameSync', (orig, from, to) => { if (String(from).includes('.repair-')) { if (landed) orig(from, to); throw Object.assign(new Error('simulated rename failure'), { code: 'EIO' }); } return orig(from, to); },
      () => assert.rejects(f.a.repair({ as: 'ada', thread: f.thread }), /simulated rename failure.*repair recovery paths/));
    assert.deepEqual(fs.readFileSync(f.damaged), f.bad);
    const candidates = fs.readdirSync(f.a.store.threadsDir).filter((p) => p.includes('.repair-'));
    if (landed) {
      assert.equal(candidates.length, 0); assert.equal(f.a.verify(f.thread).ok, true);
      const after = fs.readFileSync(f.file);
      assert.equal((await f.a.repair({ as: 'ada', thread: f.thread })).repaired, false); assert.deepEqual(fs.readFileSync(f.file), after);
    } else {
      assert.deepEqual(fs.readFileSync(f.file), raw); assert.equal(candidates.length, 1);
      const candidate = fs.readFileSync(path.join(f.a.store.threadsDir, candidates[0]));
      assert.deepEqual(candidate.subarray(0, f.original.length), f.original);
      const audit = JSON.parse(candidate.subarray(f.original.length).toString()); assert.equal(audit.type, 'repair');
      const { verifyEvent } = await import('../src/crypto.js'); assert.equal(verifyEvent(audit, f.a.registry().ada.publicKey), true);
      await assert.rejects(f.a.repair({ as: 'ada', thread: f.thread }), /EEXIST/);
    }
  }
});

test('repair: fsync failures preserve original and created artifacts', async () => {
  for (const failingSync of [1, 2]) {
    const f = await repairFixture(); const raw = fs.readFileSync(f.file); let syncs = 0;
    // Directory fsyncs occur between files on POSIX; fail only regular-file fsyncs.
    await patchRepair('fsyncSync', (orig, fd) => {
      if (fs.fstatSync(fd).isFile() && ++syncs === failingSync) throw Object.assign(new Error('simulated fsync failure'), { code: 'EIO' });
      return orig(fd);
    }, () => assert.rejects(f.a.repair({ as: 'ada', thread: f.thread }), /fsync failure.*repair recovery paths/));
    assert.deepEqual(fs.readFileSync(f.file), raw); assert.deepEqual(fs.readFileSync(f.damaged), f.bad);
    assert.equal(fs.readdirSync(f.a.store.threadsDir).filter((p) => p.includes('.repair-')).length, failingSync - 1);
  }
});

test('repair: abrupt process exit before and after rename leaves recoverable history', async () => {
  for (const landed of [false, true]) {
    const f = await repairFixture(); const raw = fs.readFileSync(f.file);
    const code = `import fs from 'node:fs'; import { Agora } from ${JSON.stringify(pathToFileURL(path.resolve('src/api.js')).href)};
      const orig = fs.renameSync; fs.renameSync = (from, to) => {
        if (String(from).includes('.repair-')) { if (${landed}) orig(from, to); process.exit(86); }
        return orig(from, to);
      }; await new Agora(${JSON.stringify(f.home)}, { env: {} }).repair({ as: 'ada', thread: ${JSON.stringify(f.thread)} });`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, ...HARNESS_CLEAN }, timeout: 10_000 });
    assert.equal(child.status, 86, child.stderr); assert.deepEqual(fs.readFileSync(f.damaged), f.bad);
    assert.equal(fs.existsSync(path.join(f.home, '.lock')), true, 'abrupt exit demonstrates the inherited lock recovery limitation');
    const temps = fs.readdirSync(f.a.store.threadsDir).filter((p) => p.includes('.repair-'));
    if (landed) { assert.equal(temps.length, 0); assert.equal(f.a.verify(f.thread).ok, true); }
    else {
      assert.deepEqual(fs.readFileSync(f.file), raw); assert.equal(temps.length, 1);
      assert.deepEqual(fs.readFileSync(path.join(f.a.store.threadsDir, temps[0])).subarray(0, f.original.length), f.original);
    }
  }
});

test('repair: rejects source changes and symlinks without replacing their targets', async (t) => {
  const f = await repairFixture(); let changed = false; const peer = Buffer.from('peer replaced source');
  // the peer replaces the source at repair's first own write (its sidecar): a write made while
  // the store lock is held. Taking the lock writes a file too (the owner entry), before
  // repair has read the source, so that one must not be the trigger.
  await patchRepair('writeSync', (orig, ...args) => { const n = orig(...args); if (!changed && f.a.store._lockToken) { changed = true; fs.writeFileSync(f.file, peer); } return n; },
    () => assert.rejects(f.a.repair({ as: 'ada', thread: f.thread }), /changed during repair/));
  assert.deepEqual(fs.readFileSync(f.file), peer);
  assert.deepEqual(fs.readFileSync(f.damaged), f.bad);
  const s = await repairFixture(); const target = path.join(s.home, 'target'); const raw = fs.readFileSync(s.file);
  fs.renameSync(s.file, target);
  try { fs.symlinkSync(target, s.file); } catch (e) { t.diagnostic(`source symlink check unavailable: ${e.code}`); return; }
  await assert.rejects(s.a.repair({ as: 'ada', thread: s.thread }), /linked or non-regular/);
  assert.deepEqual(fs.readFileSync(target), raw); assert.equal(fs.existsSync(s.damaged), false);
});

// ---- writers read only the threads their guards consult ------------------------------

/**
 * The reference for the equivalence test: the post and open decisions exactly as they were
 * made before the guards read selectively (whole-board waitingBoard for the ack claim, threads() derived up front and
 * handed to the guard as an array). Returns the outcome the way the test compares it.
 */
async function decisionBefore71(a, op, args) {
  const { checkPost, checkOpen } = await import('../src/rules.js');
  const { resolveInstance } = await import('../src/api.js');
  const { detectProject } = await import('../src/project.js');
  a.store.invalidate();
  try {
    const cfg = a.config(); const reg = a.registry(); const role = reg[args.as]?.role || 'agent';
    if (op === 'open') {
      const proj = detectProject({ explicit: args.project, env: a.env, write: true });
      a._assertNotImpersonating(args.as); a._assertNoInstanceOverride(args.instance, 'opening a thread');
      const inst = resolveInstance({ explicit: args.instance, agent: args.as, project: proj, env: a.env, session: null });
      if (!/^[A-Za-z0-9][\w.\-\/:]{0,119}$/.test(proj)) throw new Rejected('bad-project', 'bad project');
      const ms = a._mentions(args.body, [...(args.mentions || []), ...(args.waitingOn || [])], args.as);
      const wo = (args.waitingOn || []).map((w) => reg[w.toLowerCase()] ? w.toLowerCase() : w);
      const allStates = a.threads();
      checkOpen({ allStates, author: args.as, instance: inst, role, kind: args.kind, title: args.title, body: args.body, mentions: ms, waitingOn: wo, project: proj, now: a.now(), config: cfg, registry: reg });
      return 'ok';
    }
    const ms = a._mentions(args.body, [...(args.mentions || []), ...(args.waitingOn || [])], args.as);
    const state = a.thread(args.thread);
    if (!state) throw new Error(`no such thread: ${args.thread}`);
    if (state.status === 'damaged') throw new Rejected('damaged', 'damaged');
    a._assertNotImpersonating(args.as); a._assertNoInstanceOverride(args.instance, 'posting');
    const inst = resolveInstance({ explicit: args.instance, agent: args.as, project: state.project, env: a.env, session: null });
    const claimed = a.waitingBoard({ on: args.as, project: state.project }).find((w) => w.thread === args.thread);
    if (args.kind === 'ack' && claimed?.claimedBy && claimed.claimedBy !== inst) throw new Rejected('claimed', 'claimed');
    const allStates = a.threads();
    checkPost({ state, allStates, author: args.as, instance: inst, role, kind: args.kind, body: args.body, mentions: ms, re: args.re, now: a.now(), config: cfg, registry: reg, bypass: !!args.bypass });
    return 'ok';
  } catch (e) { return e?.rejected ? `rejected:${e.code}` : `error:${e?.message}`; }
}

/** A seeded random board: live and expired threads, waits and clears (some forged), ping-pong, rate-limit edges, damage. */
function randomBoard(seed) {
  let x = seed >>> 0 || 1;
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-test-71-'));
  const now = Date.parse('2026-09-05T12:00:00Z');
  const a = new Agora(home, { now: () => now, env: { IAC_PROJECT: 'test/suite' } });
  a.init({ agents: ['fable', 'opus', 'sol', 'astra'], human: 'ada' });
  const L = { familyGlobalPerHour: 2 + Math.floor(rnd() * 7), perThreadPerHour: 2 + Math.floor(rnd() * 3), perThreadLifetime: 3 + Math.floor(rnd() * 6),
    openThreadsPerAgent: 1 + Math.floor(rnd() * 3), consecutiveGraceMin: pick([0, 5, 120]), pingPongWindow: 3 + Math.floor(rnd() * 4), threadPostCap: 4 + Math.floor(rnd() * 9),
    objectionsPerAgentPerThread: 1, waitTtlHours: pick([0, 1, 72]), stallHours: pick([0, 2]) };
  a.store.saveConfig({ ...a.config(), limits: { ...a.config().limits, ...L } });
  return { a, home, now, rnd, pick };
}

async function fillBoard({ a, home, now, rnd, pick }) {
  const { signEvent, eventHash } = await import('../src/crypto.js');
  const people = ['fable', 'opus', 'sol', 'astra', 'ada'];
  const keys = Object.fromEntries(people.map((n) => [n, fs.readFileSync(path.join(home, 'keys', `${n}.pem`), 'utf8')]));
  const H = 3_600_000; const MINUTE = 60_000;
  // timestamps around every edge a guard reads: the hour window (both sides of exactly an hour), the 72 h expiry, the future
  const tsAt = () => new Date(now + pick([-80 * H, -73 * H, -71 * H, -3 * H, -H - 1, -H, -H + 1, -59 * MINUTE, -30 * MINUTE, -MINUTE, 0, 5 * MINUTE, 2 * H]) + Math.floor(rnd() * 3) * 7).toISOString();
  const projects = ['test/suite', 'test/other'];
  const ids = [];
  const nThreads = 4 + Math.floor(rnd() * 18);
  for (let t = 0; t < nThreads; t++) {
    const id = `t-${(0x710000 + t).toString(16)}${Math.floor(rnd() * 255).toString(16).padStart(2, '0')}`;
    const proj = pick(projects); const evs = []; let prev = null;
    const sign = (ev, forged = false) => { ev.prev = prev; ev.sig = signEvent(ev, keys[ev.author] || keys.fable); if (forged) ev.sig = signEvent({ ...ev, reason: 'x' }, keys.fable); prev = eventHash(ev); evs.push(ev); };
    const inst = (au) => pick([`${au}@${proj}`, `${au}@${proj}`, `${au}-task2`, undefined]);
    const pingers = [pick(people.slice(0, 4)), pick(people.slice(0, 4))];
    const shape = rnd();
    const opener = pick(people);
    if (shape > 0.06) sign({ type: 'open', id: `p-${id.slice(2)}o`, thread: id, author: opener, instance: `${opener}@${proj}`, idSource: 'self', ts: tsAt(), title: `t${t}`,
      kind: pick(['question', 'proposal', 'status', 'status', 'handoff']), body: 'open', mentions: [], project: proj, ...(rnd() < 0.3 ? { waitingOn: [pick(people)] } : {}) });
    const n = Math.floor(rnd() * 12);
    for (let i = 0; i < n; i++) {
      const r = rnd();
      const au = r < 0.35 ? pingers[i % 2] : pick(people);
      if (r < 0.75) {
        sign({ type: 'post', id: `p-${id.slice(2)}${i}`, thread: id, author: au, ...(inst(au) ? { instance: inst(au) } : {}), idSource: 'self', ts: tsAt(), kind: pick(['answer', 'status', 'ack', 'proposal', 'objection', 'question']),
          body: 'b', mentions: rnd() < 0.3 ? [pick(people)] : [], ...(rnd() < 0.25 ? { waitingOn: [pick(people)] } : {}) });
      } else if (r < 0.88) {
        const w = evs.filter((e) => e.waitingOn).at(-1);
        if (w) { const by = pick([w.author, w.author, 'ada', pick(people)]); sign({ type: 'wait-clear', id: `e-${id.slice(2)}${i}`, thread: id, author: by, ...(rnd() < 0.7 && w.instance ? { instance: w.instance } : {}), ts: tsAt(), post: w.id, on: w.waitingOn[0], reason: 'r' }, rnd() < 0.3); }
      } else if (r < 0.93) sign({ type: pick(['lock', 'unlock']), id: `e-${id.slice(2)}${i}`, thread: id, author: pick(people), ts: tsAt(), reason: 'r' });
      else if (r < 0.97) sign({ type: 'close', id: `e-${id.slice(2)}${i}`, thread: id, author: opener, ts: tsAt(), reason: 'r' });
      else sign({ type: 'project', id: `e-${id.slice(2)}${i}`, thread: id, author: 'ada', ts: tsAt(), project: pick(projects) });
    }
    let text = evs.map((e) => JSON.stringify(e)).join('\n') + (evs.length ? '\n' : '');
    if (rnd() < 0.08) text += '{"type":"post","torn';                                   // torn tail
    if (rnd() < 0.05) text = '{"not":"an event"}\n' + text;                             // malformed line
    if (rnd() < 0.03) text = '\n  \r\n';                                                // blank-only file
    fs.writeFileSync(path.join(home, 'threads', `${id}.ndjson`), text);
    ids.push({ id, posts: evs.filter((e) => e.type === 'open' || e.type === 'post').map((e) => e.id), waitedOn: evs.flatMap((e) => e.waitingOn || []) });
  }
  a.store.invalidate();
  return ids;
}

test('post and open guard decisions match the whole-board derivation on random boards', async () => {
  const seen = {};
  let attempts = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const board = randomBoard(seed * 7919);
    const ids = await fillBoard(board);
    const { a, rnd, pick } = board;
    const people = ['fable', 'opus', 'sol', 'astra', 'ada'];
    // claim and unwait candidates: this thread's waits, exactly the ones the whole board lists for it
    for (const { id } of ids) {
      const s = a.thread(id);
      if (!s || s.closed) continue;
      for (const on of [undefined, ...people]) {
        assert.deepEqual(a._waitBoard([s], { on }), a.waitingBoard({ on, project: s.project }).filter((w) => w.thread === id), `${seed} ${id} on=${on}`);
        assert.deepEqual(a._waitBoard([s], { on, includeExpired: true }), a.waitingBoard({ on, project: s.project, includeExpired: true }).filter((w) => w.thread === id));
      }
    }
    for (let k = 0; k < 40; k++) {
      const target = pick(ids);
      // a third of the attempts are a waited-on family answering or acking, so wait claims are exercised
      const answering = target.waitedOn.length && rnd() < 0.35;
      const as = answering ? pick(target.waitedOn) : pick(people);
      const kind = answering ? pick(['ack', 'ack', 'answer']) : pick(['answer', 'ack', 'status', 'objection', 'resolution', 'proposal', 'question']);
      const args = { as, kind, body: pick(['ok', 'ok', 'ok', 'see @opus', 'x'.repeat(300), '']), re: rnd() < 0.3 ? pick([...target.posts, 'p-nope']) : undefined,
        instance: pick([undefined, `${as}@test/suite`, `${as}@test/other`, `${as}-task2`]), mentions: rnd() < 0.2 ? [pick(people)] : [], waitingOn: rnd() < 0.15 ? [pick(people)] : [] };
      let op = 'post';
      if (rnd() < 0.25) { op = 'open'; Object.assign(args, { title: pick(['t', '']), project: pick(['test/suite', 'test/other']), kind: pick(['status', 'question', 'proposal', 'ack']) }); }
      else { args.thread = rnd() < 0.03 ? 't-ffffff00' : target.id; args.bypass = rnd() < 0.1; }
      const before = await decisionBefore71(a, op, args);
      let after;
      try { await a[op]({ ...args, dryRun: true }); after = 'ok'; } catch (e) { after = e?.rejected ? `rejected:${e.code}` : `error:${e?.message}`; }
      assert.equal(after, before, `seed ${seed} attempt ${k}: ${op} ${JSON.stringify(args)}`);
      seen[after] = (seen[after] || 0) + 1; attempts++;
    }
    fs.rmSync(board.home, { recursive: true, force: true });
  }
  // the boards must actually reach the board-wide and per-thread guards, not only the cheap refusals
  for (const code of ['ok', 'rejected:global-rate', 'rejected:open-cap', 'rejected:claimed', 'rejected:double-post', 'rejected:damaged', 'rejected:closed'])
    assert.ok(seen[code] > 0, `no attempt ended ${code}: ${JSON.stringify(seen)}`);
  assert.ok(attempts >= 1000);
});

test('a post reads the board only when the family rate check can be reached', async () => {
  const { a } = fresh();
  const { thread } = await a.open({ as: 'fable', title: 'T', kind: 'question', body: 'q' });
  let derived = 0; const orig = a.threads.bind(a); a.threads = (...xs) => { derived++; return orig(...xs); };
  let prefetched = 0; const pf = a.store.prefetchThreads.bind(a.store); a.store.prefetchThreads = (...xs) => { prefetched++; return pf(...xs); };
  await a.post({ as: 'ada', thread, body: 'human post' });
  await a.close({ as: 'fable', thread, body: 'done' });   // a bypass
  assert.equal(derived, 0, 'the human and a bypass never derive the board');
  assert.equal(prefetched, 0);
  const t2 = (await a.open({ as: 'opus', title: 'U', kind: 'question', body: 'q' })).thread;
  derived = 0; prefetched = 0;
  await a.post({ as: 'sol', thread: t2, body: 'an agent post' });
  assert.equal(derived, 1); assert.equal(prefetched, 1);
  // a refusal before the family rate check never derives the board
  derived = 0;
  await rejects(a.post({ as: 'sol', thread: t2, body: 'again' }), 'double-post');
  assert.equal(derived, 0);
});

test('prefetchThreads fills the read cache with what the sync read would return', async () => {
  const { a, home } = fresh();
  const { thread } = await a.open({ as: 'fable', title: 'T', kind: 'question', body: 'q' });
  fs.writeFileSync(path.join(home, 'threads', 't-0000aa.ndjson'), '');
  fs.writeFileSync(path.join(home, 'threads', 'not-a-thread.ndjson'), 'x');   // a stray name: skipped, the sync read reports it
  a.store.invalidate();
  await a.store.prefetchThreads({ concurrency: 3 });
  // served from the cache now: removing the file underneath does not change the answer
  const before = a.store.readEventsDetailed(thread);
  fs.rmSync(path.join(home, 'threads', `${thread}.ndjson`));
  assert.deepEqual(a.store.readEventsDetailed(thread), before);
  assert.deepEqual(a.store.readEventsDetailed('t-0000aa'), { events: [], damaged: [] });
  a.store.invalidate();
  assert.equal(a.store.readEventsDetailed(thread), null);
  assert.throws(() => a.threads(), /bad thread id/);
});

// ---- derived closed-idle (threadIdleCloseDays) -----------------------------------------------

const HOUR_MS = 60 * MIN; const DAY_MS = 24 * HOUR_MS;

test('idle: a thread with no activity past threadIdleCloseDays and no wait is derived idle; nothing is written', async () => {
  const { renderMarkdown } = await import('../src/api.js');
  const { a, clock, home } = fresh();
  assert.equal(a.config().limits.threadIdleCloseDays, 14);
  const { thread } = await a.open({ as: 'fable', title: 'Quiet', kind: 'status', body: 'fyi' });
  const file = path.join(home, 'threads', `${thread}.ndjson`);
  const bytes = fs.readFileSync(file, 'utf8');
  clock.tick(14 * DAY_MS);
  assert.equal(a.thread(thread).status, 'open', 'exactly at the threshold is not yet idle');
  clock.tick(MIN);
  const s = a.thread(thread);
  assert.deepEqual([s.status, s.idle], ['idle', true]);
  assert.equal(s.idleSince, new Date(Date.parse(s.lastActivity) + 14 * DAY_MS).toISOString());
  assert.equal(s.expiresAt, new Date(Date.parse(s.lastActivity) + 72 * HOUR_MS).toISOString(), 'retention is the open-thread rule, not extended by idling');
  assert.equal(s.closed, false, 'no close event: idle is not a close');
  assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'derived only; the log is untouched');
  assert.equal(a.verify(thread).ok, true);
  assert.match(renderMarkdown(s), /idle since .*; any post revives it/);
  assert.equal(a.threads({ includeClosed: false }).length, 0, 'list hides it by default');
  assert.equal(a.threads()[0].status, 'idle', 'list --all shows [idle]');
});

test('idle: an outstanding wait keeps a thread live; a cleared or expired wait does not', async () => {
  const { a, clock } = fresh();
  const { thread } = await a.open({ as: 'fable', title: 'Owed', kind: 'status', waitingOn: ['astra'], body: 'need you @astra' });
  clock.tick(60 * HOUR_MS);
  assert.equal(a.thread(thread).status, 'open', 'wait outstanding at 60h');
  assert.equal(a.waitingBoard({ on: 'astra' }).length, 1);
  clock.tick(13 * HOUR_MS);   // 73h: the unclaimed wait has expired (waitTtlHours 72)
  assert.equal(a.waitingBoard({ on: 'astra' }).length, 0);
  clock.tick(15 * DAY_MS);
  assert.equal(a.thread(thread).status, 'idle', 'an expired wait owes nothing');
  assert.equal(a.waitingBoard({ on: 'astra', includeExpired: true }).length, 1, 'the expired wait is still listed with --all');
  const b = fresh();
  const t2 = (await b.a.open({ as: 'fable', title: 'Cleared', kind: 'status', waitingOn: ['astra'], body: 'need you @astra' })).thread;
  b.clock.tick(MIN);
  await b.a.clearWait({ as: 'fable', thread: t2, post: b.a.thread(t2).posts[0].id, on: 'astra', reason: 'not needed' });
  b.clock.tick(15 * DAY_MS);
  assert.equal(b.a.thread(t2).status, 'idle', 'a verified clear releases the thread');
});

test('idle: a claimed (acked) wait keeps the thread live however old; an answered one does not', async () => {
  const { a, clock } = fresh();
  const { thread } = await a.open({ as: 'fable', title: 'Claimed', kind: 'status', waitingOn: ['astra'], body: 'need you @astra' });
  clock.tick(MIN);
  await a.post({ as: 'astra', thread, kind: 'ack', body: "I'm on it" });
  clock.tick(60 * DAY_MS);
  assert.equal(a.waitingBoard({ on: 'astra' }).length, 1, 'an acked wait never expires');
  assert.equal(a.thread(thread).idle, false);
  assert.equal(a.thread(thread).status, 'open');
  await a.post({ as: 'astra', thread, kind: 'answer', body: 'done' });
  clock.tick(15 * DAY_MS);
  assert.equal(a.thread(thread).idle, true, 'answered: nothing owed');
});

test('idle: any post revives it, and the guards still apply', async () => {
  const { a, clock } = fresh();
  const { thread } = await a.open({ as: 'fable', title: 'Revive', kind: 'status', body: 'hello @opus' });
  clock.tick(15 * DAY_MS);
  assert.equal(a.thread(thread).idle, true);
  await a.post({ as: 'opus', thread, kind: 'answer', body: 'back' });
  const s = a.thread(thread);
  assert.deepEqual([s.status, s.idle, s.idleSince], ['open', false, null]);
  clock.tick(15 * DAY_MS);
  assert.equal(a.thread(thread).idle, true, 'idle again after another quiet period');
  clock.tick(1);
  // guards: a rejected post (empty body) does not revive
  await assert.rejects(a.post({ as: 'sol', thread, kind: 'answer', body: '' }), Rejected);
  assert.equal(a.thread(thread).idle, true);
  // a real close is unchanged: posts are refused
  await a.close({ as: 'fable', thread, body: 'done' });
  await assert.rejects(a.post({ as: 'opus', thread, kind: 'answer', body: 'late' }), (e) => e.code === 'closed');
});

test('idle: threads drop out of the open-thread allowance, and reviving cannot bypass it', async () => {
  const { a, clock } = fresh();
  const ids = [];
  for (let i = 0; i < 3; i++) { ids.push((await a.open({ as: 'fable', title: `T${i}`, kind: 'question', body: 'x' })).thread); clock.tick(MIN); }
  await assert.rejects(a.open({ as: 'fable', title: 'T3', kind: 'question', body: 'x' }), (e) => e.code === 'open-cap');
  clock.tick(15 * DAY_MS);
  const fourth = (await a.open({ as: 'fable', title: 'T3', kind: 'question', body: 'x' })).thread;   // idle ones no longer count
  clock.tick(MIN);
  await a.open({ as: 'fable', title: 'T4', kind: 'question', body: 'x' });
  await a.open({ as: 'fable', title: 'T5', kind: 'question', body: 'x' });
  // fable now has three live; reviving an idle one of its own would make four
  const r = await a.post({ as: 'fable', thread: ids[0], kind: 'status', body: 'revive?' }).then(() => null, (e) => e);
  assert.equal(r?.code, 'open-cap');
  assert.equal(a.thread(ids[0]).idle, true);
  // someone else's reply is allowed and revives
  await a.post({ as: 'opus', thread: ids[0], kind: 'answer', body: 'reply' });
  assert.equal(a.thread(ids[0]).idle, false);
  void fourth;
});

test('idle: threadIdleCloseDays 0 or negative disables; invalid falls back to the default', async () => {
  for (const [v, idle] of [[0, false], [-3, false], ['abc', true], [null, true], ['', true], ['24', true]]) {
    const { a, clock } = fresh();
    a.store.saveConfig({ ...a.config(), limits: { ...a.config().limits, threadIdleCloseDays: v } });
    const { thread } = await a.open({ as: 'fable', title: 'x', kind: 'status', body: 'x' });
    clock.tick(30 * DAY_MS);
    assert.equal(a.thread(thread).idle, idle, `threadIdleCloseDays=${JSON.stringify(v)}`);
  }
  const { a } = fresh();
  a.store.saveConfig({ ...a.config(), limits: { ...a.config().limits, threadIdleCloseDays: 'abc' } });
  assert.equal(a.config().limits.threadIdleCloseDays, 14);
});

test('idle: uses the board clock seam and the max-ts lastActivity rule; repair events are inert', async () => {
  const { a, clock, home } = fresh();
  const { thread } = await a.open({ as: 'fable', title: 'Clock', kind: 'status', body: 'x' });
  const start = clock.now();
  const at = (d) => { clock.tick(start + d * DAY_MS - clock.now()); };
  at(13); assert.equal(a.thread(thread).idle, false);
  at(15); assert.equal(a.thread(thread).idle, true);
  at(10); assert.equal(a.thread(thread).idle, false, 'a clock stepped back un-idles; nothing is cached or written');
  at(100); assert.equal(a.thread(thread).idle, true);
  // a later-dated event that is a repair does not count as activity
  const { deriveState } = await import('../src/rules.js');
  const evs = a.store.readEventsDetailed(thread).events;
  const repair = { ...evs[0], type: 'repair', ts: new Date(start + 90 * DAY_MS).toISOString() };
  const cfg = a.config(); const reg = a.registry();
  const base = deriveState(thread, evs, cfg, reg, start + 100 * DAY_MS);
  const withRepair = deriveState(thread, [...evs, repair], cfg, reg, start + 100 * DAY_MS);
  assert.equal(withRepair.lastActivity, base.lastActivity);
  // max-ts: an out-of-order earlier timestamp does not pull lastActivity back
  const early = { ...evs[0], type: 'post', id: 'p-early', ts: new Date(start - HOUR_MS).toISOString() };
  assert.equal(deriveState(thread, [...evs, early], cfg, reg, start).lastActivity, base.lastActivity);
  void home;
});

test('idle: the brief and the inbox drop idle threads', async () => {
  const { brief } = await import('../src/format.js');
  const { a, clock } = fresh();
  const { thread } = await a.open({ as: 'fable', title: 'Mention', kind: 'status', body: 'ping @opus' });
  assert.equal(a.inbox({ as: 'opus' }).length, 1);
  assert.match(brief(a, 'opus'), new RegExp(thread));
  clock.tick(15 * DAY_MS);
  assert.deepEqual(a.inbox({ as: 'opus' }), []);
  assert.equal(brief(a, 'opus'), '');
  await a.post({ as: 'fable', thread, kind: 'status', body: 'again @opus' });
  assert.equal(a.inbox({ as: 'opus' }).length, 1, 'a revival wakes the mention again');
});

test('idle: replay of existing histories is unchanged except the new derived fields', async () => {
  const { deriveState } = await import('../src/rules.js');
  const { a, clock } = fresh();
  const t1 = (await a.open({ as: 'fable', title: 'A', kind: 'question', waitingOn: ['opus'], body: 'q @opus' })).thread;
  clock.tick(MIN); await a.post({ as: 'opus', thread: t1, kind: 'ack', body: 'looking' });
  clock.tick(MIN); await a.post({ as: 'opus', thread: t1, kind: 'answer', body: 'done' });
  const t2 = (await a.open({ as: 'sol', title: 'B', kind: 'status', body: 'x' })).thread;
  clock.tick(MIN); await a.close({ as: 'sol', thread: t2, body: 'closed' });
  clock.tick(MIN);   // nothing is idle here
  const off = { ...a.config(), limits: { ...a.config().limits, threadIdleCloseDays: 0 } };
  for (const id of [t1, t2]) {
    const events = a.store.readEventsDetailed(id).events;
    const withIdle = deriveState(id, events, a.config(), a.registry(), clock.now());
    const without = deriveState(id, events, off, a.registry(), clock.now());
    assert.deepEqual(withIdle, without);
    assert.equal(a.thread(id).idle, false);
    const { idle, idleSince, ...rest } = a.thread(id);
    assert.equal(idle, false); assert.equal(idleSince, null);
    assert.deepEqual(rest, (({ idle: _i, idleSince: _s, ...r }) => r)(without));
  }
});

test('idle: retention is unchanged by idling; gc removes an idle thread at the open expiry', async () => {
  const { a, clock } = fresh();
  a.store.saveConfig({ ...a.config(), limits: { ...a.config().limits, threadTtlHours: 20 * 24 } });
  const { thread } = await a.open({ as: 'fable', title: 'Ret', kind: 'status', body: 'x' });
  const exp = a.thread(thread).expiresAt;
  clock.tick(15 * DAY_MS);
  const s = a.thread(thread);
  assert.equal(s.idle, true);
  assert.equal(s.expiresAt, exp, 'idling leaves expiresAt exactly as the open rule computed it');
  assert.deepEqual(a.gc(), [], 'idle and not yet expired: kept');
  clock.tick(6 * DAY_MS);
  assert.deepEqual(a.gc(), [thread], 'removed at the open expiry');
});

async function atCapWithIdle() {
  const { a, clock } = fresh();
  const idle = (await a.open({ as: 'fable', title: 'Old', kind: 'question', waitingOn: ['astra'], body: 'need @astra' })).thread;
  clock.tick(MIN);
  const other = (await a.open({ as: 'fable', title: 'Old2', kind: 'question', body: 'x' })).thread;
  clock.tick(20 * DAY_MS);   // the wait expired and both are idle
  assert.equal(a.thread(idle).idle, true); assert.equal(a.thread(other).idle, true);
  const live = [];
  for (let i = 0; i < 3; i++) { live.push((await a.open({ as: 'fable', title: `L${i}`, kind: 'question', body: 'x' })).thread); clock.tick(MIN); }
  return { a, clock, idle, other, live };
}

test('idle: clearWait, lock and setProject cannot revive an idle thread past the opener cap', async () => {
  const { a, idle, other } = await atCapWithIdle();
  const code = (p) => p.then(() => null, (e) => e.code);
  assert.equal(await code(a.clearWait({ as: 'fable', thread: idle, on: 'astra', reason: 'drop it' })), 'open-cap');
  assert.equal(a.thread(idle).idle, true, 'nothing was written');
  assert.equal(await code(a.lock({ as: 'fable', thread: other, reason: 'x' })), 'open-cap');
  // the human is exempt
  await a.lock({ as: 'ada', thread: other, reason: 'x' });
  assert.equal(a.thread(other).idle, false);
});

test('idle: setProject cannot revive an idle legacy thread past the opener cap', async () => {
  const { a, clock } = fresh();
  const old = (await a.open({ as: 'fable', title: 'Legacy', kind: 'question', body: 'x', project: 'unscoped' })).thread;
  clock.tick(20 * DAY_MS);
  for (let i = 0; i < 3; i++) { await a.open({ as: 'fable', title: `L${i}`, kind: 'question', body: 'x', project: 'unscoped' }); clock.tick(MIN); }
  assert.equal(a.thread(old).idle, true);
  await assert.rejects(a.setProject({ as: 'fable', thread: old, project: 'o/r' }), (e) => e.code === 'open-cap');
  assert.equal(a.thread(old).idle, true, 'nothing was written');
  await a.setProject({ as: 'ada', thread: old, project: 'o/r' });
  assert.equal(a.thread(old).idle, false, 'the human is exempt');
});

test('idle: closing or resolving your own idle thread at the cap is always allowed', async () => {
  const { a, idle, other } = await atCapWithIdle();
  await a.close({ as: 'fable', thread: idle, body: 'done' });
  assert.equal(a.thread(idle).closed, true);
  await a.post({ as: 'fable', thread: other, kind: 'resolution', body: 'resolved' });
  assert.equal(a.thread(other).closed, true);
});

test('viewer: the open count excludes idle threads even when they are shown', async () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'viewer.html'), 'utf8');
  assert.match(html, /visible\.filter\(t=>!t\.closed&&!t\.idle\)\.length\} open/);
  assert.match(html, /idle`:''\} · agents:/);
});

test('idle: a thread with a torn line stays visible and non-idle; damage is never hidden', async () => {
  const { a, clock, home } = fresh();
  const { thread } = await a.open({ as: 'fable', title: 'Torn', kind: 'question', body: 'x' });
  const file = path.join(home, 'threads', `${thread}.ndjson`);
  fs.appendFileSync(file, '{torn\n');
  a.store.invalidate();
  clock.tick(15 * DAY_MS);
  const s = a.thread(thread);
  assert.equal(s.damagedLines.length, 1);
  assert.deepEqual([s.idle, s.status], [false, 'open']);
  assert.ok(a.threads({ includeClosed: false }).some((t) => t.id === thread), 'default list keeps it');
  const { renderMarkdown } = await import('../src/api.js');
  assert.doesNotMatch(renderMarkdown(a.threadWithVerification(thread)), /idle since/);
  const html = fs.readFileSync(path.join(ROOT, 'src', 'viewer.html'), 'utf8');
  assert.match(html, /showIdle \|\| !t\.idle/, 'the viewer hides only t.idle threads, and this one is not');
});

test('idle: an idle solo status thread does not block its replacement; a live one still does', async () => {
  const { a, clock } = fresh();
  const old = (await a.open({ as: 'fable', title: 'Log', kind: 'status', body: 'x' })).thread;
  clock.tick(MIN);
  await assert.rejects(a.open({ as: 'fable', title: 'Log2', kind: 'status', body: 'y' }), (e) => e.code === 'status-thread-exists');
  clock.tick(15 * DAY_MS);
  assert.equal(a.thread(old).idle, true);
  const fresh2 = (await a.open({ as: 'fable', title: 'Log2', kind: 'status', body: 'y' })).thread;
  assert.equal(a.thread(fresh2).idle, false);
  clock.tick(MIN);
  await assert.rejects(a.open({ as: 'fable', title: 'Log3', kind: 'status', body: 'z' }), (e) => e.code === 'status-thread-exists');
});

test('escalate refuses a public or unreadable tracker unless --allow-public', async () => {
  const { assertPrivateTracker } = await import('../src/cli.js');
  await assertPrivateTracker('o/r', { visibility: async () => 'PRIVATE' });
  await assertPrivateTracker('o/r', { visibility: async () => 'INTERNAL' });
  await assert.rejects(assertPrivateTracker('o/r', { visibility: async () => 'PUBLIC' }), /o\/r is public, so this board thread would become a public issue; pass --allow-public/);
  await assert.rejects(assertPrivateTracker('o/r', { visibility: async () => { throw new Error('HTTP 404'); } }), /could not check whether o\/r is private \(HTTP 404\)/);
  await assertPrivateTracker('o/r', { allowPublic: true, visibility: async () => { throw new Error('not called'); } });
});

test('escalate CLI: a public repository is refused and the thread stays open; --allow-public posts', { skip: process.platform === 'win32' && 'fake gh is a POSIX script' }, async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const { home } = fresh();
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-fakegh-'));
  const log = path.join(fake, 'calls.log');
  fs.writeFileSync(path.join(fake, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase "$1 $2" in\n  "repo view") echo "$FAKE_VIS" ;;\n  "issue create") echo "https://github.com/o/r/issues/5" ;;\nesac\n`, { mode: 0o755 });
  const bin = path.join(import.meta.dirname, '..', 'bin', 'iac.js');
  const env = { ...process.env, PATH: `${fake}${path.delimiter}${process.env.PATH}`, IAC_HOME: home, IAC_AGENT: 'fable', IAC_PROJECT: 'o/r', CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '', FAKE_VIS: 'PUBLIC' };
  const cli = (args, extra = {}) => run(process.execPath, [bin, ...args], { env: { ...env, ...extra } });
  const { thread } = JSON.parse((await cli(['open', '--title', 'private plans', '--kind', 'status', '--body', 'secret', '--json'])).stdout);
  await assert.rejects(cli(['escalate', thread, '--repo', 'o/r']), (e) => /refusing to escalate: o\/r is public/.test(e.stderr));
  assert.ok(!fs.readFileSync(log, 'utf8').includes('issue create'), 'no issue was created');
  assert.doesNotMatch((await cli(['show', thread, '--compact'])).stdout, /escalated/, 'the thread is still open');
  const ok = (await cli(['escalate', thread, '--repo', 'o/r'], { FAKE_VIS: 'PRIVATE' })).stdout;
  assert.match(ok, /escalated .* → https:\/\/github\.com\/o\/r\/issues\/5/);
  const { thread: t2 } = JSON.parse((await cli(['open', '--title', 'public on purpose', '--kind', 'question', '--body', 'x', '--json'])).stdout);
  assert.match((await cli(['escalate', t2, '--repo', 'o/r', '--allow-public'])).stdout, /escalated/);
});
