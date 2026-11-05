#!/usr/bin/env node
/**
 * Bind an inter-agent-comms identity to a harness process (cross-platform).
 * usage: iac-launch <agent> [-- command [args...]]
 *   iac-launch <registered-agent> -> configured harness command
 * Hooks and MCP servers spawned by the harness inherit IAC_AGENT, IAC_HOME and IAC_INSTANCE.
 * For one release it also sets the legacy AGORA_* names, so an older copy of the tool in the
 * child (a not-yet-upgraded plugin) still binds to the same identity and store.
 *
 * Optional. iac normally reads identity from the harness's own session record; this is
 * the override for harnesses that attest nothing (including an unsupported rollout). A binding that contradicts
 * the live model is refused as 'stale-binding' rather than believed.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Store, resolveHome } from '../src/store.js';
import { winCommandLine, winShell, WinArgError } from '../src/winargs.js';
import { envVar } from '../src/env.js';

const argv = process.argv.slice(2);
const agent = (argv.shift() || '').toLowerCase();
const usage = () => { console.error('usage: iac-launch <agent> [-- command...]'); process.exit(64); };
if (!agent) usage();
const home = resolveHome();
const store = new Store(home);
if (store.exists() && !store.registry()[agent]) { console.error(`iac-launch: '${agent}' is not registered in ${home} (iac add-agent ${agent})`); process.exit(65); }

let cmd;
if (argv[0] === '--') cmd = argv.slice(1);
else {
  // Launch commands live in config.json; the agent roster lives in agents.json.
  const configured = store.exists() ? (store.config().launch || {})[agent] : null;
  if (!configured) {
    console.error(`iac-launch: no launch command for '${agent}'.\n  set one:  iac set-launch ${agent} -- <command...>\n  or pass:  iac-launch ${agent} -- <command...>`);
    process.exit(64);
  }
  cmd = [...configured, ...argv];
}
if (!cmd.length) usage();
// Fallback label per launch. A resume-stable harness task/session id takes
// precedence inside iac when the child exposes one.
const instance = envVar(process.env, 'INSTANCE') || `${agent}-${randomBytes(2).toString('hex')}`;
const env = { ...process.env, IAC_AGENT: agent, IAC_HOME: home, IAC_INSTANCE: instance,
  AGORA_AGENT: agent, AGORA_HOME: home, AGORA_INSTANCE: instance };
console.error(`iac-launch: ${agent} (fallback instance ${instance})`);
// Windows shims (codex.cmd, claude.cmd) need cmd.exe; Node would join args unquoted,
// so hand it one pre-quoted line instead.
let line;
if (process.platform === 'win32') {
  try { line = winCommandLine(cmd, { env }); } catch (e) {
    if (!(e instanceof WinArgError)) throw e;
    console.error(`iac-launch: ${e.message}`); process.exit(64);
  }
}
// winShell = Node's shell: true wrapper (cmd.exe /d /s /c) plus /e:on /v:off, so the
// registry cannot change how the pre-quoted line parses.
const r = line !== undefined
  ? spawnSync(...winShell(line), { stdio: 'inherit', env, windowsVerbatimArguments: true })
  : spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', env });
if (r.error) { console.error(`iac-launch: ${r.error.message}`); process.exit(127); }
process.exit(r.status ?? 1);
