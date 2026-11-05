/**
 * `iac doctor`: a read-only self-check that says why identity or the brief might be failing,
 * before a session silently goes read-only. Harness record formats (the Claude Code
 * transcript, the Codex rollout) are not ours and can drift with a harness update; this
 * reports what iac can and cannot read from them, one line per check.
 *
 * Read-only by design: it opens files for reading only, takes no lock, spawns nothing, and
 * never calls a code path that writes (no seen-marks, no gc, no init). Every parse of a
 * harness record goes through the same functions identity uses (harnessIdentity,
 * resolveIdentity, sessionModelState, codexRolloutIdentity), so what it reports is what
 * identity sees.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agora, harnessIdentity, claudeDir, declaredHarness, familyOverlaps, Rejected, toWinDir } from './api.js';
import { resolveHomeWhy, STORE_DIR, LEGACY_STORE_DIR } from './store.js';
import { codexRoot, CODEX_ROOT_ONLY_REASON, CODEX_RELATIVE_HOME_REASON } from './codex-hook.js';
import { envConflicts, envSource, envVar } from './env.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ID = 'inter-agent-comms@inter-agent-comms';
const LEGACY_PLUGIN_ID = 'agora@agora';
/** How long the chain check may spend before it reports a sample (brief-like budget). */
export const VERIFY_BUDGET_MS = 400;

/**
 * A file's text: { text }, { missing } only when it does not exist (ENOENT, or a parent that is
 * not a directory), else { unreadable: <code> } (EACCES, EISDIR, EBUSY, ...): a file that is
 * there but cannot be read is never reported as absent.
 */
const readFile = (p) => { try { return { text: fs.readFileSync(p, 'utf8') }; } catch (e) { return e.code === 'ENOENT' || e.code === 'ENOTDIR' ? { missing: true } : { unreadable: e.code || e.message }; } };
const readText = (p) => readFile(p).text ?? null;
// a leading BOM (Notepad) is stripped, as Store.readJson does
const readJson = (p) => { const f = readFile(p); if (f.text == null) return f; const t = f.text; try { return { value: JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t) }; } catch (e) { return { invalid: e.message }; } };
/**
 * One check is one line: each control or line-separator character (C0, DEL, C1, U+2028/9)
 * becomes a space. Nothing else changes: no whitespace is collapsed or trimmed, so a path in
 * a hint (`rm -r '<path>'`) is byte for byte the real one.
 */
export const oneLine = (v) => String(v ?? '').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ');
/** A file name from disk, safe to print: quoted and escaped when it is not plain. */
const showName = (n) => (/^[\w.@+-]+$/.test(n) ? n : JSON.stringify(n));
/** A path that a shell command can carry as one quoted word on one line. */
const plainPath = (p) => !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(p);
/** process.kill(pid, 0): an existence check only, never a signal. EPERM means it exists. */
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
/** Init leftovers younger than this may be a live init. */
export const INIT_LIVE_MS = 60_000;
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const homeDir = (env) => env.HOME || env.USERPROFILE || os.homedir();
const cmpVer = (a, b) => {
  const pa = String(a).split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x)); const pb = String(b).split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { if (pa[i] === pb[i]) continue; if (pa[i] === undefined) return -1; if (pb[i] === undefined) return 1; return pa[i] < pb[i] ? -1 : 1; }
  return 0;
};
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const SEMVER = /^\d+(\.\d+)*([-+][0-9A-Za-z.-]+)?$/;
const shQuote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
const samePath = (a, b) => { if (typeof a !== 'string' || typeof b !== 'string') return false; try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return path.resolve(a) === path.resolve(b); } };

/** Every hook command in a Claude settings.json / Codex hooks.json `hooks` table. */
function hookCommands(hooks) {
  const out = [];
  if (!hooks || typeof hooks !== 'object') return out;
  for (const [event, groups] of Object.entries(hooks)) {
    for (const g of [].concat(groups || [])) for (const h of [].concat(g?.hooks || [])) {
      if (typeof h?.command === 'string') out.push({ event, command: h.command });
    }
  }
  return out;
}
const OURS = /(^|[\s"'\\/])(iac|agora|inter-agent-comms)(\.js)?(["'\s]|$)/;
const GATED = /\b(IAC|AGORA)_AGENT\b/;

/**
 * Run every check. Returns { exitCode, version, checks: [{ id, status, message, fix? }] }
 * where status is ok | warn | fail | skip. exitCode is 1 only when the store cannot be read.
 * `resolve` is passed to resolveHomeWhy (tests inject homedir / wslUsers); `cliRoot` is the
 * install whose version is compared with the plugins (default: this one).
 */
export function doctor({ home, why, env = process.env, resolve, cliRoot = PKG_ROOT, cwd = process.cwd(), managedSettings, mcp = null, verifyBudgetMs = VERIFY_BUDGET_MS, now = () => performance.now() } = {}) {
  const checks = [];
  const add = (id, status, message, fix) => { checks.push(fix ? { id, status, message: oneLine(message), fix: oneLine(fix) } : { id, status, message: oneLine(message) }); };
  const version = readJson(path.join(cliRoot, 'package.json')).value?.version || 'unknown';
  add('cli', 'ok', `iac ${version} at ${cliRoot}`);
  // `mcp`: the MCP server's own resolution (startMcp current()). Codex MCP is read-only by
  // design, and its Codex ids belong to the process that spawned the server, not the caller.
  if (mcp?.codex) add('mcp', 'warn', `this MCP server is read-only for Codex (${mcp.reason}); the harness, model and identity lines below describe the server's own environment, not the calling task`,
    'run iac doctor from the Codex task shell: the CLI there attests');

  // ---- store ---------------------------------------------------------------
  // `why`: the caller already resolved `home` (the MCP server's store) and knows by which rule
  const r = home && why ? { home, why } : resolveHomeWhy(home, env, resolve);
  let exitCode = 0;
  const cfgFile = path.join(r.home, 'config.json');
  const cfgRead = readJson(cfgFile);
  if (cfgRead.unreadable) {
    add('store', 'fail', `${cfgFile} exists but cannot be read (${cfgRead.unreadable})`, 'check its permissions and that it is a file (another process may hold it open on Windows)');
    exitCode = 1;
  } else if (cfgRead.missing) {
    add('store', 'fail', `${r.home} (${r.why}) is not initialised: no config.json`,
      isDir(r.home) ? 'run iac init, or point IAC_HOME at the initialised store' : 'run iac init (or set IAC_HOME to the store your other agents use)');
    exitCode = 1;
  } else if (cfgRead.invalid) {
    add('store', 'fail', `${cfgFile} is not valid JSON (${cfgRead.invalid}); every command falls back to defaults`, 'fix the file by hand (keep a copy first)');
    exitCode = 1;
  } else if (!isObj(cfgRead.value)) {
    add('store', 'fail', `${cfgFile} does not hold a JSON object; every command falls back to defaults`, 'fix the file by hand (keep a copy first)');
    exitCode = 1;
  } else add('store', 'ok', `${r.home} (${r.why})`);
  const storeOk = exitCode === 0;

  // a fresh init builds the store in <home>.init-* and renames it into place; a crash leaves it (with private keys)
  const abs = path.resolve(r.home); const prefix = `${path.basename(abs)}.init-`;
  let names = []; try { names = fs.readdirSync(path.dirname(abs)).filter((n) => n.startsWith(prefix) && isDir(path.join(path.dirname(abs), n))); } catch {}
  // A live init is not a leftover: modified in the last minute, or its pid (from
  // <home>.init-<pid>-<hex>) still exists. A store on a Windows drive seen from WSL may be
  // initialised by a Windows process, whose pids this side cannot see: mtime only there.
  const pidsVisible = !(process.platform === 'linux' && /^\/mnt\/[a-z]\//i.test(abs));
  const live = []; const dead = [];
  for (const n of names) {
    const p = path.join(path.dirname(abs), n);
    let age = Infinity; try { age = Date.now() - fs.statSync(p).mtimeMs; } catch {}
    const pid = Number(/^\.init-(\d+)-[0-9a-f]+$/.exec(n.slice(path.basename(abs).length))?.[1]);
    if (age < INIT_LIVE_MS || (pidsVisible && Number.isSafeInteger(pid) && pid > 0 && pidAlive(pid))) live.push(n); else dead.push(p);
  }
  if (live.length) add('init-progress', 'ok', `${live.map(showName).join(', ')} beside the store: an init in progress; leave it`);
  if (dead.length) add('init-leftover', 'warn', `${dead.map((p) => showName(path.basename(p))).join(', ')} in ${path.dirname(abs)}: left by an init that crashed; ${dead.length === 1 ? 'it holds' : 'they hold'} private keys`,
    dead.every(plainPath) ? `check nothing is mid-init, then delete: rm -r ${dead.map(shQuote).join(' ')}` : 'check nothing is mid-init, then delete them by hand (the names hold control characters)');

  // other initialised stores the resolution rules would have considered: agents on different stores never see each other
  const candidates = [path.join(homeDir(env), STORE_DIR), path.join(homeDir(env), LEGACY_STORE_DIR)];
  // IAC_DOCTOR_WSL_USERS (doctor only; empty disables) stands in for /mnt/c/Users, so tests never read the real one
  const wsl = resolve?.wslUsers !== undefined ? resolve.wslUsers
    : env.IAC_DOCTOR_WSL_USERS !== undefined ? (env.IAC_DOCTOR_WSL_USERS || null)
      : (process.platform === 'linux' ? '/mnt/c/Users' : null);
  if (wsl && isDir(wsl)) {
    let name = resolve?.username; if (!name) try { name = os.userInfo().username; } catch {}
    if (name) for (const d of [STORE_DIR, LEGACY_STORE_DIR]) candidates.push(path.posix.join(wsl, name, d));
  }
  const others = [...new Set(candidates)].filter((d) => isFile(path.join(d, 'config.json')) && !samePath(d, r.home));
  if (others.length) {
    const explicit = r.why === '--home' || /_HOME$/.test(r.why);
    add('store-other', explicit ? 'ok' : 'warn', `also initialised, not used here: ${others.join(', ')}`,
      explicit ? undefined : 'agents on different stores never see each other; set IAC_HOME to the one they share');
  }

  const agora = new Agora(r.home, { env });
  agora.store.invalidate();   // read the store as it is on disk now, not this process's read cache
  // a config.json that is not an object is not read through config() at all
  let reg = {}; const cfg = storeOk ? agora.config() : { families: {}, familyHarness: {} };
  if (storeOk) {
    const regRead = readJson(path.join(r.home, 'agents.json'));
    if (regRead.unreadable) {
      add('registry', 'fail', `agents.json exists but cannot be read (${regRead.unreadable}): no agent can sign or be verified`, 'check its permissions and that it is a file; do not re-run init, the registry is still there');
      exitCode = 1;
    } else if (regRead.missing || regRead.invalid || !isObj(regRead.value)) {
      add('registry', 'fail', `agents.json ${regRead.missing ? 'is missing' : regRead.invalid ? 'is not valid JSON' : 'does not hold a JSON object'}: no agent can sign or be verified`, 'run iac init --force to recreate missing agents and keys');
      exitCode = 1;
    } else {
      reg = regRead.value;
      const agents = Object.entries(reg).filter(([, v]) => v?.role !== 'human').map(([k]) => k);
      const humans = Object.entries(reg).filter(([, v]) => v?.role === 'human').map(([k]) => k);
      add('registry', agents.length ? 'ok' : 'warn', `${agents.length} agent(s): ${agents.join(', ') || 'none'}${humans.length ? `; human: ${humans.join(', ')}` : ''}`,
        agents.length ? undefined : 'iac add-agent <name> --models <glob> --harness claude-code|codex');
      // keys/<name>.pem with no registry entry: an add-agent killed between key and registry write
      let pems = []; try { pems = fs.readdirSync(agora.store.keysDir).filter((f) => f.endsWith('.pem')); } catch {}
      const orphans = pems.map((f) => f.slice(0, -4)).filter((n) => !Object.prototype.hasOwnProperty.call(reg, n));
      if (orphans.length) add('keys', 'warn', `orphan key${orphans.length === 1 ? '' : 's'} with no registry entry: ${orphans.map(showName).join(', ')} (add-agent ${orphans.length === 1 ? 'refuses' : 'refuse'} to overwrite ${orphans.length === 1 ? 'it' : 'them'})`,
        orphans.every(plainPath) ? orphans.map((n) => { const k = agora.store.keyPath(n); return `mv ${shQuote(k)} ${shQuote(`${k}.orphan`)}`; }).join(' && ')
          : `move them out of ${agora.store.keysDir} by hand (the names hold control characters)`);
      // stores clobbered by the old init --force: config.human no longer names the registered human
      const cfgHuman = cfgRead.value.human;
      // after a legitimate --replace-human both humans stay registered: only a config.human that
      // is not a registered human at all is a clobbered store
      if (humans.length && !humans.includes(cfgHuman)) add('human', 'warn', `config.json names the human ${JSON.stringify(cfgHuman ?? null)}, which is not a registered human (registered: ${humans.map(showName).join(', ')})`,
        'iac init --force --human <you> --replace-human');
    }
    // chain + signatures, within a time budget: a sample is reported as such
    let ids = []; let unreadable = null;
    try { ids = fs.readdirSync(path.join(r.home, 'threads')).filter((f) => f.endsWith('.ndjson')).map((f) => f.slice(0, -7)); }
    catch (e) { if (e.code !== 'ENOENT') unreadable = e.code || e.message; }
    if (unreadable) { add('verify', 'fail', `threads/ cannot be read (${unreadable})`, 'check the store directory permissions'); exitCode = 1; }
    else {
      const t0 = now(); let done = 0; const bad = []; const broken = [];
      for (const id of ids) {
        if (done && now() - t0 > verifyBudgetMs) break;
        try { const v = agora.verify(id); if (v && !v.ok) bad.push(id); } catch { broken.push(id); }
        done++;
      }
      const scope = done < ids.length ? `${done} of ${ids.length} threads (time budget; iac verify checks all)` : `${ids.length} thread(s)`;
      if (bad.length || broken.length) {
        add('verify', 'warn', `${scope}: ${[...bad.map((x) => `${x} PROBLEMS`), ...broken.map((x) => `${x} unparseable`)].join(', ')}`, `iac verify ${bad[0] || broken[0]} for details; a tampered thread shows UNVERIFIED posts`);
      } else add('verify', 'ok', `${scope}: signatures and hash chains ok`);
    }
  }

  // ---- plugins -------------------------------------------------------------
  // What is configured is reported as read. Which hook actually runs is a conclusion doctor
  // states as "likely", never a reason to delete anything: the hook advice is conditional on
  // what the user sees (two briefs, or none).
  const cdir = claudeDir(env);
  const projRoot = projectRootOf(cwd, homeDir(env));
  const layers = isDir(cdir) ? claudeSettingsLayers({ cdir, root: projRoot, managed: managedSettings !== undefined ? managedSettings
    // IAC_DOCTOR_MANAGED_SETTINGS (doctor only; empty disables) stands in for the machine's managed settings in tests
    : env.IAC_DOCTOR_MANAGED_SETTINGS !== undefined ? (env.IAC_DOCTOR_MANAGED_SETTINGS || null) : MANAGED_SETTINGS[process.platform] }) : [];
  const enabledState = pluginEnabledState(layers);
  const hooksOff = layers.find((L) => L.value?.disableAllHooks === true) || null;
  const claudePlugin = { entry: null, state: 'none' };   // state: none | broken | off | unknown | disabled | enabled
  if (!isDir(cdir)) add('plugin-claude', 'skip', `no Claude Code config dir at ${cdir}`);
  else {
    const instFile = path.join(cdir, 'plugins', 'installed_plugins.json');
    const instRead = readJson(instFile);
    const inst = instRead.value?.plugins || {};
    const raw = [].concat(inst[PLUGIN_ID] || []).filter(isObj);
    const usable = raw.filter((e) => typeof e.installPath === 'string' && e.installPath);
    // a project- or local-scoped install applies only in its own project
    const here = (e) => !['project', 'local'].includes(e.scope) || (typeof e.projectPath === 'string' && samePath(e.projectPath, projRoot));
    const entries = usable.filter(here);
    const elsewhere = usable.filter((e) => !here(e));
    const elsewhereNote = elsewhere.length ? `; also installed for ${elsewhere.map((e) => `${e.projectPath || '?'} (${e.scope} scope)`).join(', ')}, not this project (${projRoot})` : '';
    const legacy = [].concat(inst[LEGACY_PLUGIN_ID] || []).length;
    const legacyNote = legacy ? `; the old ${LEGACY_PLUGIN_ID} plugin is also installed (duplicate briefs and tools)` : '';
    const legacyFix = legacy ? `/plugin uninstall ${LEGACY_PLUGIN_ID}` : undefined;
    const layerNote = `; enabledPlugins: ${layers.map((L) => `${L.layer}=${L.read === 'ok' ? (typeof L.value?.enabledPlugins?.[PLUGIN_ID] === 'boolean' ? L.value.enabledPlugins[PLUGIN_ID] : 'unset') : L.read}`).join(', ')}`;
    if (instRead.unreadable) {
      claudePlugin.state = 'unknown';
      add('plugin-claude', 'warn', `${instFile} exists but cannot be read (${instRead.unreadable}): plugin state unknown`, 'check its permissions');
    } else if (raw.length && !usable.length) {
      claudePlugin.state = 'broken';
      add('plugin-claude', 'fail', `plugin is registered in installed_plugins.json with no usable installPath: its hooks and MCP server cannot start`, `/plugin uninstall ${PLUGIN_ID} then /plugin install ${PLUGIN_ID}`);
    } else if (!entries.length) {
      add('plugin-claude', 'warn', `the Claude Code plugin is not installed for this project${elsewhereNote}${legacyNote}`, [`/plugin install ${PLUGIN_ID} (see iac paths), unless you wired hooks and MCP by hand`, legacyFix].filter(Boolean).join('; '));
    } else {
      const versions = [...new Set(entries.map((e) => (typeof e.version === 'string' && e.version) || '?'))];
      const scopes = [...new Set(entries.map((e) => e.scope || 'user'))].join('/');
      const self = entries.find((e) => samePath(e.installPath, cliRoot));
      const missing = entries.filter((e) => !isFile(path.join(e.installPath, 'bin', 'iac.js')));
      claudePlugin.entry = entries.find((e) => isFile(path.join(e.installPath, 'bin', 'iac.js'))) || null;
      claudePlugin.state = missing.length ? 'broken' : hooksOff ? 'off' : enabledState.state;
      const tail = `${layerNote}${elsewhereNote}${legacyNote}`;
      if (missing.length) add('plugin-claude', 'fail', `plugin ${versions.join('/')} (${scopes} scope) is registered but ${missing[0].installPath}/bin/iac.js is missing: its hooks and MCP server cannot start${tail}`, `/plugin uninstall ${PLUGIN_ID} then /plugin install ${PLUGIN_ID}`);
      else if (enabledState.state === 'disabled') add('plugin-claude', 'warn', `plugin ${versions.join('/')} is installed but disabled in ${enabledState.by.file}${tail}`, `/plugin enable ${PLUGIN_ID} if you want it`);
      else if (enabledState.state === 'unknown') add('plugin-claude', 'warn', `plugin ${versions.join('/')} is installed; whether it is enabled is unknown: ${enabledState.by.file} is ${enabledState.by.read}${tail}`, 'check that file');
      else if (self || versions.every((v) => v === version)) add('plugin-claude', legacy ? 'warn' : 'ok', `plugin ${versions.join('/')} (${scopes} scope)${self ? ', this CLI is that copy' : ', same as the CLI'}${tail}`, legacyFix);
      else {
        const older = versions.some((v) => cmpVer(v, version) < 0);
        add('plugin-claude', 'warn', `plugin ${versions.join('/')} (${scopes} scope) but CLI ${version}${tail}`,
          [older ? `/plugin marketplace update inter-agent-comms, then /plugin update ${PLUGIN_ID} (then restart Claude Code)` : `upgrade the CLI from the plugin copy: npm install -g ${entries[0].installPath}`, legacyFix].filter(Boolean).join('; '));
      }
    }
  }

  const xroot = codexRoot(env);
  const inCodex = !!(env.CODEX_THREAD_ID || env.CODEX_SESSION_ID);
  if (!xroot) add('plugin-codex', inCodex ? 'fail' : 'skip', `CODEX_HOME is relative (${env.CODEX_HOME}); ${CODEX_RELATIVE_HOME_REASON}`, inCodex ? 'set CODEX_HOME to an absolute path (or unset it for ~/.codex) and restart Codex' : undefined);
  else if (!isDir(xroot)) add('plugin-codex', inCodex ? 'warn' : 'skip', `no Codex home at ${xroot}`, inCodex ? 'set CODEX_HOME to the directory Codex uses' : undefined);
  else codexInstallChecks(add, { root: xroot, suffix: '', version, cliRoot, inCodex, store: r.home, env });
  // Under WSL a native Windows Codex keeps its own home under C:\Users\<name>\.codex. Report
  // only (never an identity source): stats and small reads.
  for (const [i, win] of windowsCodexHomes(wsl, resolve?.username).filter((d) => !xroot || !samePath(d, xroot)).entries()) {
    codexInstallChecks(add, { root: win, suffix: i ? `-win${i + 1}` : '-win', version, cliRoot, inCodex: false, store: r.home, winStore: toWinDir(path.resolve(r.home), env), env, windows: true });
  }

  // ---- the harness this process runs under -----------------------------------
  const h = harnessIdentity(env);
  if (!h) add('harness', 'skip', 'not in a Claude Code session or a Codex task shell (no CLAUDE_CODE_SESSION_ID or CODEX_THREAD_ID): identity comes from IAC_AGENT (iac-launch) or --as');
  else if (h.harness === 'ambiguous') add('harness', 'fail', h.conflict, 'start the inner harness outside the parent harness, or bind it explicitly with iac-launch');
  else if (h.harness === 'claude-code') {
    if (!h.transcript) add('harness', 'warn', `Claude Code session ${h.session}: no transcript under ${path.join(cdir, 'projects')}`, 'a brand-new session writes it with the first prompt; if this persists, HOME or CLAUDE_CONFIG_DIR here differs from Claude Code\'s');
    else {
      add('harness', 'ok', `Claude Code session ${h.session}: transcript ${h.transcript}`);
      if (h.model) add('model', 'ok', `${h.model} (from the ${h.modelVia === 'attachment' ? 'model attachment' : 'latest assistant entry'})`);
      else if (h.switching) add('model', 'warn', 'a /model switch is newer than any model evidence: unknown until the next prompt announces it', 'send one more prompt; read-only until then');
      else if (h.modelUnknown) add('model', 'warn', 'no model evidence in the transcript tail within the scan cap, or it could not be read', 'send a prompt (it re-announces the model), or bind the session with iac-launch <name>');
      else {
        const n = assistantEntriesWithoutModel(h.transcript);
        add('model', 'warn', n ? `${n} assistant entr${n === 1 ? 'y' : 'ies'} in the transcript but none names message.model: the Claude Code transcript format may have changed` : 'the transcript names no model yet (a new session announces it with its first prompt)',
          n ? 'report it (iac reads message.model and attachment.identity.modelId); bind with iac-launch <name> meanwhile' : 'send a prompt, then run iac doctor again');
      }
    }
  } else {
    // Codex
    if (h.rootOnly) add('harness', 'fail', CODEX_ROOT_ONLY_REASON, 'run iac from a Codex task shell, which exports CODEX_THREAD_ID; do not copy or forward CODEX_SESSION_ID on its own');
    else if (h.unattestable) add('harness', 'fail', `Codex task ${h.session}: ${h.unattestable}`, 'set CODEX_HOME to an absolute path (or unset it for ~/.codex) and restart Codex');
    else if (!h.rollout) add('harness', 'warn', `Codex task ${h.session}: no single rollout under ${path.join(xroot, 'sessions')} whose session_meta names it (missing, archived, duplicated, or the rollout format changed)`, 'run from the task\'s own shell; codex unarchive an archived task; CODEX_HOME here must be Codex\'s');
    else {
      add('harness', 'ok', `Codex task ${h.session}: rollout ${h.rollout}`);
      if (h.model) add('model', 'ok', `${h.model} (from the latest turn_context)`);
      else if (h.modelProblem === 'invalid-record') add('model', 'warn', 'the newest complete record is unparseable or names an invalid model (fail closed)', 'send a prompt (Codex writes a new turn_context); if it persists, the rollout format may have changed');
      else if (h.modelProblem === 'scan-cap') add('model', 'warn', 'no turn_context within the last 64 MB of the rollout', 'send a prompt so Codex writes a new turn_context');
      else if (h.modelProblem === 'unreadable') add('model', 'warn', 'the rollout could not be read', 'check the file permissions under CODEX_HOME');
      else add('model', 'warn', 'the rollout has no turn_context record: a task that has not started a turn, or Codex changed its rollout format', 'send a prompt, then run iac doctor again');
    }
  }

  // ---- identity, families, env ---------------------------------------------------
  let id = null; let conflict = null;
  try { id = agora.identity({ harness: h }); } catch (e) { if (e instanceof Rejected || e?.rejected) conflict = e; else conflict = { code: 'error', message: e.message }; }

  const fams = cfg.families || {};
  const unmapped = Object.entries(reg).filter(([k, v]) => v?.role !== 'human' && !(fams[k] || []).length).map(([k]) => k);
  const invalidPins = Object.keys(fams).filter((f) => declaredHarness(f, cfg) === 'invalid');
  const unpinned = Object.keys(reg).filter((k) => reg[k]?.role !== 'human' && (fams[k] || []).length && !declaredHarness(k, cfg));
  if (invalidPins.length) add('families', 'fail', `config.json familyHarness is invalid for ${invalidPins.join(', ')}: no session can attest ${invalidPins.length === 1 ? 'it' : 'them'}`, `iac set-models ${invalidPins[0]} --harness claude-code|codex`);
  else if (unmapped.length || unpinned.length) add('families', 'warn', [unmapped.length && `${unmapped.join(', ')} match${unmapped.length === 1 ? 'es' : ''} no model glob (launcher/--as only)`, unpinned.length && `${unpinned.join(', ')} declare${unpinned.length === 1 ? 's' : ''} no harness`].filter(Boolean).join('; '),
    unmapped.length ? `iac set-models ${unmapped[0]} --models '<glob>' --harness claude-code|codex` : `iac set-models ${unpinned[0]} --harness claude-code|codex`);
  else if (Object.keys(reg).length) add('families', 'ok', 'every registered agent has model globs and a harness pin');

  if (h?.model && id && h.harness !== 'ambiguous') {
    const fam = id.family;
    const overl = fam ? familyOverlaps(fam, cfg).filter((x) => x.winner !== fam) : [];
    if (!fam) add('family', 'warn', id.reason || `model '${h.model}' matches no family`, id.todo);
    else if (!reg[fam]) add('family', 'warn', `model ${h.model} → family '${fam}', which is not a registered agent`, `iac add-agent ${fam}`);
    else if (overl.length) add('family', 'warn', `model ${h.model} → '${fam}', but its glob overlaps ${overl[0].family}'s '${overl[0].otherGlob}', which wins`, 'use a glob no other family covers');
    else add('family', id.familyHarness ? 'ok' : 'warn', `model ${h.model} → '${fam}' (registered${id.familyHarness ? `, pinned to ${id.familyHarness}` : ', no harness pin'})`,
      id.familyHarness ? undefined : `iac set-models ${fam} --harness ${h.harness}`);
  }

  const notes = []; let envStatus = 'ok';
  for (const c of envConflicts(env)) { notes.push(`IAC_${c.name}=${c.iac} and AGORA_${c.name}=${c.agora} differ (IAC_${c.name} wins)`); envStatus = 'warn'; }
  const bound = (envVar(env, 'AGENT') || '').toLowerCase();
  if (bound && Object.keys(reg).length && !reg[bound]) { notes.push(`${envSource(env, 'AGENT')}=${bound} is not a registered agent`); envStatus = 'warn'; }
  const key = envVar(env, 'KEY');
  if (key && !isFile(key)) { notes.push(`${envSource(env, 'KEY')} points at ${key}, which does not exist`); envStatus = 'warn'; }
  add('env', envStatus, notes.length ? notes.join('; ') : 'no IAC_*/AGORA_* disagreements', notes.length ? 'unset the stale AGORA_* (or IAC_*) variable; launchers set IAC_*' : undefined);

  if (conflict) add('identity', 'fail', `${conflict.code}: ${conflict.message}`, conflict.hint || 'run iac whoami');
  else if (id?.agent) {
    const from = id.source === 'launcher' ? `${envSource(env, 'AGENT') || 'IAC_AGENT'} (launcher)` : id.source === 'harness' ? `harness (${id.harness})` : '--as';
    if (id.readOnly) add('identity', 'warn', `${id.agent} from ${from}, but read-only: ${id.readOnly}`, id.readOnlyTodo);
    else {
      const keyOk = key ? isFile(key) : isFile(agora.store.keyPath(id.agent));
      add('identity', keyOk ? 'ok' : 'warn', `${id.agent} from ${from}${id.model ? `, model ${id.model}` : ''}${keyOk ? '' : `; no private key at ${agora.store.keyPath(id.agent)}, so writes fail`}`,
        keyOk ? undefined : `copy the key into the store, or iac init --force on the machine that owns it`);
    }
  } else if (id) add('identity', 'warn', `none: read-only (${id.reason})`, id.todo);
  if (mcp?.codex) {
    const c = checks.find((x) => x.id === 'identity');
    if (c) Object.assign(c, { status: 'warn', message: `this MCP server is read-only for Codex; the CLI in a task shell attests (the server's own environment reads as: ${c.message})`, fix: 'run iac doctor from the Codex task shell' });
  }

  // ---- hook wiring ----------------------------------------------------------------
  // Reported as configured; the conclusion is "likely". Doctor never tells anyone to delete a
  // hook outright: only "if you see two iac briefs per prompt, remove the hand-written hook".
  if (isDir(cdir)) {
    const entry = claudePlugin.entry;
    const pluginHook = entry ? readText(path.join(entry.installPath, 'hooks', 'hooks.json')) : null;
    const pluginHasHook = !!(pluginHook && /brief --hook/.test(pluginHook));
    const plugin = !entry ? (claudePlugin.state === 'unknown' ? 'unknown' : 'none')
      : !pluginHasHook ? 'none'
        : ({ enabled: 'active', default: 'active', disabled: 'inactive', off: 'inactive', broken: 'none', unknown: 'unknown' })[claudePlugin.state] || 'unknown';
    const seen = [];   // hand-written hooks, with the file they live in
    for (const L of layers) for (const c of hookCommands(L.value?.hooks)) if (OURS.test(c.command) || /\bbrief\b.*--hook|codex-hook/.test(c.command)) seen.push({ ...c, file: L.file });
    const gated = seen.filter((c) => GATED.test(c.command));
    const legacy = seen.filter((c) => !GATED.test(c.command) && /(^|[\s"'\\/])agora(\.js)?(["'\s]|$)/.test(c.command));
    const manual = seen.filter((c) => !GATED.test(c.command) && /brief --hook/.test(c.command));
    const blind = layers.filter((L) => L.read !== 'ok' && L.read !== 'absent');
    const notes = [];
    notes.push(`plugin hook: ${!entry ? 'not installed here' : !pluginHasHook ? 'none in the cached plugin' : `cached at ${entry.installPath} (${entry.scope || 'user'} scope), ${claudePlugin.state === 'default' ? 'not disabled by any settings layer' : claudePlugin.state}`}`);
    notes.push(manual.length ? `hand-written brief --hook in ${[...new Set(manual.map((c) => `${c.file} (${c.event})`))].join(', ')}` : 'no hand-written brief --hook');
    if (gated.length) notes.push(`${gated.length} hand-written hook(s) gated on IAC_AGENT/AGORA_AGENT in ${[...new Set(gated.map((c) => c.file))].join(', ')}: inert, they never fire in a normally started session`);
    if (legacy.length) notes.push(`${legacy.length} hook(s) call the deprecated agora alias, which goes away after 0.3.x`);
    if (hooksOff) notes.push(`disableAllHooks is set in ${hooksOff.file}: no hook runs`);
    for (const L of blind) notes.push(`${L.file} is ${L.read}: its hooks and settings were not seen`);
    for (const c of manual) {
      // the program the hook runs: `iac`, or the script after `node`; a quoted path may hold spaces
      const q = c.command.match(/^\s*(?:node(?:\.exe)?\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))/);
      const m = q && [null, q[1] ?? q[2] ?? q[3]];
      if (m && /^iac$/.test(m[1]) && !onPath('iac', env)) { notes.push('the hand-written hook runs `iac`, which is not on PATH here (it may be on the harness\'s PATH)'); break; }
      if (m && /\.js$/.test(m[1]) && path.isAbsolute(m[1]) && !isFile(m[1])) { notes.push(`the hand-written hook runs ${m[1]}, which does not exist`); break; }
    }
    const manualFile = manual[0]?.file || path.join(cdir, 'settings.json');
    const addHook = `add { "type": "command", "command": "iac brief --hook" } to SessionStart and UserPromptSubmit in ${path.join(cdir, 'settings.json')}`;
    const noneFix = entry && pluginHasHook ? `/plugin enable ${PLUGIN_ID}, or ${addHook}` : `/plugin install ${PLUGIN_ID}, or ${addHook}`;
    const twoOrNone = `if you see two iac briefs per prompt, remove the hand-written hook in ${manualFile}; if you see none, ${noneFix}`;
    let status; let conclusion; let fix;
    if (hooksOff) { status = 'warn'; conclusion = 'likely active: none (all hooks disabled)'; fix = `if you see no iac brief and want it, unset disableAllHooks in ${hooksOff.file}`; }
    else if (blind.length || plugin === 'unknown') { status = 'warn'; conclusion = 'unknown'; fix = manual.length ? twoOrNone : `if you see no iac brief, ${noneFix}`; }
    else if (plugin === 'active' && manual.length) { status = 'warn'; conclusion = 'both may run (duplicate briefs)'; fix = twoOrNone; }
    else if (plugin === 'active') { status = 'ok'; conclusion = 'likely active: plugin hook'; }
    else if (manual.length) { status = 'ok'; conclusion = `likely active: hand-written hook (${manualFile})`; }
    else { status = 'warn'; conclusion = 'likely active: none'; fix = `if you see no iac brief, ${noneFix}`; }
    if (status === 'ok' && (gated.length || legacy.length || notes.some((n) => /not on PATH|does not exist/.test(n)))) {
      status = 'warn';
      fix = [legacy.length && 'point the agora hooks at iac', notes.some((n) => /not on PATH|does not exist/.test(n)) && 'use node "<abs path>/bin/iac.js" brief --hook (see iac paths)'].filter(Boolean).join('; ') || `if you see no iac brief, ${noneFix}`;
    }
    add('hooks-claude', status, `${conclusion} — ${notes.join('; ')}`, fix);
  }
  return { exitCode, version, store: r.home, storeSource: r.why, checks };
}

/** Claude Code's managed (enterprise) settings file, per platform. */
const MANAGED_SETTINGS = { linux: '/etc/claude-code/managed-settings.json', darwin: '/Library/Application Support/ClaudeCode/managed-settings.json', win32: 'C:\\Program Files\\ClaudeCode\\managed-settings.json' };

/** The project a Claude session in `cwd` belongs to: the nearest dir with .git, or with a .claude that is not the user's. */
function projectRootOf(cwd, home) {
  const start = path.resolve(cwd);
  for (let d = start; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (!samePath(d, home) && isDir(path.join(d, '.claude'))) return d;
    if (path.dirname(d) === d) return start;
  }
}

/** The settings layers as read, highest precedence last: user, project, local, managed. */
function claudeSettingsLayers({ cdir, root, managed }) {
  const user = path.join(cdir, 'settings.json');
  return [['user', user], ['project', path.join(root, '.claude', 'settings.json')], ['local', path.join(root, '.claude', 'settings.local.json')], ['managed', managed]]
    .filter(([layer, f]) => f && (layer === 'user' || !samePath(f, user)))
    .map(([layer, file]) => {
      const r = readJson(file);
      const read = r.missing ? 'absent' : r.unreadable ? `unreadable (${r.unreadable})` : r.invalid || !isObj(r.value) ? 'invalid JSON' : 'ok';
      return { layer, file, read, value: read === 'ok' ? r.value : null };
    });
}

/**
 * enabledPlugins for this plugin across the layers: the highest-precedence layer that names it
 * decides; a higher layer that cannot be read makes it unknown. Nobody naming it is 'default'.
 */
function pluginEnabledState(layers) {
  for (const L of [...layers].reverse()) {
    if (L.read !== 'ok' && L.read !== 'absent') return { state: 'unknown', by: L };
    const v = L.value?.enabledPlugins?.[PLUGIN_ID];
    if (typeof v === 'boolean') return { state: v ? 'enabled' : 'disabled', by: L };
  }
  return { state: 'default', by: null };
}

const WIN_SKIP = new Set(['public', 'default', 'all users', 'default user']);
/** Windows-side Codex homes seen from WSL: <wslUsers>/<name>/.codex, else any user's. */
function windowsCodexHomes(wsl, username) {
  if (!wsl || !isDir(wsl)) return [];
  let name = username; if (!name) try { name = os.userInfo().username; } catch {}
  const mine = name ? path.posix.join(wsl, name, '.codex') : null;
  if (mine && isDir(mine)) return [mine];
  let users = []; try { users = fs.readdirSync(wsl); } catch {}
  return users.filter((u) => !WIN_SKIP.has(u.toLowerCase())).map((u) => path.posix.join(wsl, u, '.codex')).filter(isDir);
}

/** The body of a TOML table `[header]` (up to the next table), or null. Enough for config.toml lookups. */
function tomlTable(toml, header) {
  const esc = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = toml.match(new RegExp(`^\\s*\\[${esc}\\]\\s*(?:#.*)?$([\\s\\S]*?)(?=^\\s*\\[|(?![\\s\\S]))`, 'm'));
  return m ? m[1] : null;
}
/** A TOML string value: 'literal' or "basic" (JSON-compatible escapes). */
function tomlString(q) {
  if (q.startsWith("'")) return q.slice(1, -1);
  try { return JSON.parse(q); } catch { return q.slice(1, -1); }
}
/** IAC_HOME / AGORA_HOME baked into a [mcp_servers.<name>] table, as { name, key, value }. */
function mcpStoreEnv(toml, name) {
  const out = [];
  const str = `('(?:[^'\\n])*'|"(?:[^"\\\\\\n]|\\\\.)*")`;
  // the key exactly, bare or quoted: never NOT_IAC_HOME or XAGORA_HOME
  const key = `(?:(IAC_HOME|AGORA_HOME)|"(IAC_HOME|AGORA_HOME)"|'(IAC_HOME|AGORA_HOME)')`;
  const push = (m) => out.push({ name, key: m[1] || m[2] || m[3], value: tomlString(m[4]) });
  const env = tomlTable(toml, `mcp_servers.${name}.env`);
  if (env != null) for (const m of env.matchAll(new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*${str}`, 'gm'))) push(m);
  const main = tomlTable(toml, `mcp_servers.${name}`);
  const inline = main?.match(/^\s*env\s*=\s*\{([^}\n]*)\}/m);
  if (inline) for (const m of inline[1].matchAll(new RegExp(`(?:^|[\\s,{])${key}\\s*=\\s*${str}`, 'g'))) push(m);
  return out;
}
/** Paths compared as Windows sees them: slashes, case, trailing slash, and \\wsl$\ = \\wsl.localhost\. */
const normStore = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase().replace(/^\/\/wsl\$\//, '//wsl.localhost/');
/** Something a store path could be; anything else (a token, a stray value) is never printed. */
const looksLikePath = (v) => typeof v === 'string' && v.length <= 4096 && !/[\x00-\x1f\x7f]/.test(v)
  && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]|\/|~[\\/]?)/.test(v);

/**
 * Plugin, hook and MCP-table checks for one Codex home (the one this process would use, or
 * a native Windows one seen from WSL: `suffix` '-win', `store` the Windows spelling).
 */
function codexInstallChecks(add, { root, suffix, version, cliRoot, inCodex, store, winStore, env = {}, windows = false }) {
  const where = windows ? ` (Windows-side ${root})` : '';
  const base = path.join(root, 'plugins', 'cache', 'inter-agent-comms', 'inter-agent-comms');
  let dirs = []; try { dirs = fs.readdirSync(base).filter((d) => SEMVER.test(d) && isDir(path.join(base, d))); } catch {}
  const tomlRead = readFile(path.join(root, 'config.toml'));
  const toml = tomlRead.text || '';
  const table = (id) => tomlTable(toml, `plugins."${id}"`);
  const enabledIn = (t) => t != null && !/^\s*enabled\s*=\s*false/m.test(t);
  const legacyOn = enabledIn(table(LEGACY_PLUGIN_ID));
  const legacyNote = legacyOn ? `; the old ${LEGACY_PLUGIN_ID} plugin is still enabled in config.toml` : '';
  const legacyFix = legacyOn ? `codex plugin remove ${LEGACY_PLUGIN_ID}` : undefined;
  const id = `plugin-codex${suffix}`;
  let enabled = false; let pluginHookConfigured = null;
  if (!dirs.length) {
    add(id, inCodex || legacyOn ? 'warn' : 'skip', `the Codex plugin is not installed under ${root}${legacyNote}`,
      inCodex || legacyOn ? [`codex plugin add ${PLUGIN_ID} (see iac paths)`, legacyFix].filter(Boolean).join('; ') : undefined);
  } else {
    const latest = dirs.sort(cmpVer).at(-1);
    const dir = path.join(base, latest);
    const manifest = readJson(path.join(dir, '.codex-plugin', 'plugin.json')).value;
    const pv = manifest?.version;
    // Inspect the inline declaration we ship. Other hook sources remain unknown here:
    // an explicit manifest hooks field overrides defaults, so guessing a fallback can lie.
    if (isObj(manifest?.hooks)) pluginHookConfigured = hookCommands(manifest.hooks.hooks)
      .some((c) => c.event === 'UserPromptSubmit' && /\bcodex-hook\b/.test(c.command));
    const v = typeof pv === 'string' && pv ? pv : latest;
    // `codex plugin add` writes the table; a cached copy without one is not known to be enabled
    enabled = enabledIn(table(PLUGIN_ID));
    if (!isFile(path.join(dir, 'bin', 'iac.js'))) add(id, 'fail', `plugin ${v} at ${dir} has no bin/iac.js: its hook cannot run`, `codex plugin add ${PLUGIN_ID} again`);
    else if (!enabled) add(id, 'warn', `plugin ${v} is cached under ${root} but not enabled in config.toml${legacyNote}`, [table(PLUGIN_ID) == null ? `codex plugin add ${PLUGIN_ID}` : `set enabled = true under [plugins."${PLUGIN_ID}"]`, legacyFix].filter(Boolean).join('; '));
    else if (v === version || samePath(dir, cliRoot)) add(id, legacyOn ? 'warn' : 'ok', `plugin ${v}, same as the CLI${where}${legacyNote}`, legacyFix);
    else add(id, 'warn', `plugin ${v} but CLI ${version}${where}${legacyNote}`,
      [cmpVer(v, version) < 0 ? `close Codex; unless the marketplace is pinned to an older commit, run codex plugin marketplace upgrade inter-agent-comms once (a local-path marketplace: update its checkout, then codex plugin add ${PLUGIN_ID} once); then check /hooks in a new session` : `upgrade the CLI from the plugin copy: npm install -g ${dir}`, legacyFix].filter(Boolean).join('; '));
  }

  // an IAC_HOME baked into a Codex MCP table that names another store: agents on different boards
  // For a Windows Codex the store has a Windows spelling (C:\..., or \\wsl.localhost\<distro>\...
  // for a WSL-native store); a \\wsl$ / \\wsl.localhost share path names the posix path inside it.
  const shown = windows ? winStore : store;
  const same = (v) => {
    const n = normStore(v);
    if (n === normStore(store) || (windows && n === normStore(winStore))) return true;
    const share = /^\/\/wsl\.localhost\/([^/]+)(\/.*)$/.exec(n);
    return !!(windows && share && (!env.WSL_DISTRO_NAME || share[1] === env.WSL_DISTRO_NAME.toLowerCase()) && share[2] === normStore(store));
  };
  const baked = [...mcpStoreEnv(toml, 'iac'), ...mcpStoreEnv(toml, 'agora')].filter((e) => !looksLikePath(e.value) || !same(e.value));
  if (baked.length) {
    const b = baked[0];
    add(`mcp-codex${suffix}`, 'warn', `${path.join(root, 'config.toml')} [mcp_servers.${b.name}] sets ${b.key}${looksLikePath(b.value) ? `=${b.value}` : ' to a non-path value'}, but this store is ${shown}: Codex reads a different board`,
      `point it at ${shown}; if the Codex plugin is installed, this table is redundant`);
  }

  // Saved approval is not proof that the current runtime definition matches it, or that a
  // prompt dispatched the hook. Scope this record to the exact slot shipped by our manifest;
  // never derive Codex's trust hash or treat another plugin hook's approval as this one's.
  const hooksFile = path.join(root, 'hooks.json');
  const hj = readJson(hooksFile);
  const hand = hookCommands(hj.value?.hooks).filter((c) => /codex-hook/.test(c.command) || OURS.test(c.command));
  const gated = hand.filter((c) => GATED.test(c.command));
  const manual = hand.filter((c) => !GATED.test(c.command));
  const approvalId = `${PLUGIN_ID}:plugin.json#hooks[0]:user_prompt_submit:0:0`;
  const trustBody = tomlTable(toml, `hooks.state."${approvalId}"`);
  const approvalPresent = trustBody != null && /^\s*trusted_hash\s*=\s*["'][^"']+["']/m.test(trustBody);
  const blind = tomlRead.unreadable ? `${path.join(root, 'config.toml')} is unreadable (${tomlRead.unreadable})` : hj.unreadable ? `${hooksFile} is unreadable (${hj.unreadable})` : hj.invalid ? `${hooksFile} is not valid JSON` : null;
  const plugin = !dirs.length ? 'none' : tomlRead.unreadable ? 'unknown' : !enabled ? 'inactive' : 'enabled';
  const notes = [
    `plugin hook: ${!dirs.length ? 'not installed' : !enabled ? 'cached, not enabled' : pluginHookConfigured === true ? 'UserPromptSubmit codex-hook declared in the manifest' : pluginHookConfigured === false ? 'no UserPromptSubmit codex-hook in the explicit manifest hooks' : 'configuration unverified (inline manifest hooks not available)'}`,
    `saved UserPromptSubmit approval record: ${approvalPresent ? 'present' : 'absent'}`,
    'current runtime definition match: unverified; automatic execution: unobserved by this read-only check',
    manual.length ? `hand-written codex hook in ${hooksFile} (its trust is not checked)` : 'no hand-written codex hook',
    ...(gated.length ? [`${gated.length} hand-written hook(s) in ${hooksFile} gated on IAC_AGENT/AGORA_AGENT: inert, they never fire`] : []),
    ...(blind ? [`${blind}: not all hook state was seen`] : []),
  ];
  const twoOrNone = `if you see two iac briefs per prompt, remove the hand-written hook in ${hooksFile}; if you see none, trust the hooks in /hooks`;
  const hid = `hooks-codex${suffix}`;
  let status; let conclusion; let fix;
  if (blind || plugin === 'unknown') { status = 'warn'; conclusion = 'unknown'; fix = manual.length ? twoOrNone : 'if you see no iac brief, trust the plugin hook in /hooks'; }
  else if (plugin === 'enabled' && manual.length) { status = 'warn'; conclusion = 'plugin and hand-written hook configuration present; verification incomplete'; fix = twoOrNone; }
  else if (plugin === 'enabled') { status = 'warn'; conclusion = 'plugin enabled; hook verification incomplete'; fix = pluginHookConfigured === true && !approvalPresent ? 'trust the plugin hook in /hooks' : 'review the current plugin hook in /hooks or hooks/list; verify automatic dispatch separately with runtime evidence'; }
  else if (manual.length) { status = 'warn'; conclusion = `hand-written hook configured (${hooksFile}); verification incomplete`; fix = 'review its current definition and trust in /hooks or hooks/list; verify automatic dispatch separately with runtime evidence'; }
  else if (gated.length || inCodex) { status = 'warn'; conclusion = 'likely active: none'; fix = `if you see no iac brief, codex plugin add ${PLUGIN_ID} (see iac paths) and trust it in /hooks`; }
  else return;
  add(hid, status, `${conclusion}${where} — ${notes.join('; ')}`, fix);
}

/** Assistant entries (not sub-agent) in the transcript tail that carry no message.model. */
function assistantEntriesWithoutModel(file, tail = 256 * 1024) {
  let text = '';
  try {
    const size = fs.statSync(file).size; const start = Math.max(0, size - tail); const fd = fs.openSync(file, 'r');
    try { const buf = Buffer.alloc(size - start); fs.readSync(fd, buf, 0, buf.length, start); text = buf.toString('utf8'); } finally { fs.closeSync(fd); }
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  } catch { return 0; }
  let n = 0;
  for (const l of text.split('\n')) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e?.type === 'assistant' && !e.isSidechain && typeof e.message?.model !== 'string') n++;
  }
  return n;
}

function onPath(cmd, env) {
  const exts = process.platform === 'win32' ? (env.PATHEXT || '.CMD;.EXE').split(';') : [''];
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const x of exts) if (isFile(path.join(dir, cmd + x))) return true;
  }
  return false;
}

const MARK = { ok: 'ok  ', warn: 'warn', fail: 'FAIL', skip: '--  ' };

/** One line per check, then a tally. */
export function renderDoctor(report) {
  const w = Math.max(...report.checks.map((c) => c.id.length));
  // each piece is made one line here too, whoever built the report
  const lines = report.checks.map((c) => `${MARK[c.status] || oneLine(c.status)}  ${oneLine(c.id).padEnd(w)}  ${oneLine(c.message)}${c.fix ? `  → fix: ${oneLine(c.fix)}` : ''}`);
  const n = (s) => report.checks.filter((c) => c.status === s).length;
  lines.push(`${n('ok')} ok, ${n('warn')} warn, ${n('fail')} fail${n('skip') ? `, ${n('skip')} skipped` : ''}${report.exitCode ? ' — the store cannot be read' : ''}`);
  return lines.join('\n');
}
