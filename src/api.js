import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { Store, KINDS, DEFAULT_CONFIG, NAME_RE, nameProblem, eventShapeProblem, LOCK_TIMEOUT_MS } from './store.js';
import { generateKeypair, signEvent, verifyEvent, eventHash, newId } from './crypto.js';
import { deriveState, applyIdle, checkPost, checkRevive, checkOpen, parseMentions, resolveMention, currentHuman, Rejected } from './rules.js';
import { detectProject } from './project.js';
import { envVar, envSource } from './env.js';
import { codexRolloutIdentity, codexTaskId, codexPresent, CODEX_ROOT_ONLY_REASON, MAX_SCAN as CODEX_SCAN_CAP } from './codex-hook.js';

const PROJECT_RE = /^[A-Za-z0-9][\w.\-\/:]{0,119}$/;
const INSTANCE_RE = /^[A-Za-z0-9][\w.\-\/:@#]{0,79}$/;
export { NAME_RE, nameProblem };

/**
 * Instance label: which running task of a model family authored an event.
 * Explicit > harness task/session id > IAC_INSTANCE (set by iac-launch; legacy AGORA_INSTANCE) >
 * `<agent>@<project>`. Harness ids are resume-stable where available.
 * Signed by the family key, so it is authenticated as the family and self-declared as the instance.
 */
/** The harness's own id for the running task. Resume-stable where the harness has one. */
export function harnessTaskId(env = process.env) {
  const claude = env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID;
  const codex = codexTaskId(env); // CODEX_THREAD_ID only: a root-only CODEX_SESSION_ID names no task
  if (claude && codexPresent(env)) return null;
  return claude || codex || null;
}

/** Tests redirect HOME; follow the env like store.js follows IAC_HOME, not os.homedir() blindly. */
function homeDir(env = process.env) { return env.HOME || env.USERPROFILE || os.homedir(); }

/** Claude Code's config dir: CLAUDE_CONFIG_DIR when set, else ~/.claude. */
export function claudeDir(env) { return env.CLAUDE_CONFIG_DIR || path.join(homeDir(env), '.claude'); }

/**
 * Claude Code keeps one JSONL transcript per session, in a directory named after the
 * cwd it was started in: ~/.claude/projects/<slug>/<session-id>.jsonl. The slug encoding
 * is not ours to reconstruct, so find the file by its session id.
 */
export function claudeTranscriptPath(sessionId, env = process.env) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(sessionId || '')) return null;
  const root = path.join(claudeDir(env), 'projects');
  let dirs; try { dirs = fs.readdirSync(root); } catch { return null; }
  for (const d of dirs) {
    const p = path.join(root, d, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * The model that last drove the session, read from the end of its transcript: the latest,
 * by position, of an assistant entry's `message.model` and a model attachment's
 * `attachment.identity.modelId`. Claude Code writes the attachment with the user prompt
 * whenever the model is (re)announced: at the first prompt of a session, and at the first
 * prompt after `/model`. That lands before the turn's first assistant entry, so the
 * attachment is the earliest evidence of the new model a tool call can see; an
 * assistant entry may also be on disk by then (tool_use entries are written while the tool
 * runs), and either counts. A `/model` switch newer than any model evidence yields null
 * (see isModelSwitch); sessionModelState tells that case apart from a record with no model
 * evidence at all. Sub-agent entries (isSidechain) are not the session's own model.
 */
export function lastSessionModel(file, opts) { return sessionModelState(file, opts).model; }

/** The most a transcript read will cover before giving up on finding model evidence. */
export const TRANSCRIPT_SCAN_CAP = 64 * 1024 * 1024;

/**
 * `{ model, switching, unknown }` from a Claude transcript. `switching` is true when a
 * `/model` switch is newer than any model evidence: the model is unknown *because* the
 * harness is changing it, which is not the same as a fresh record that names no model yet.
 * Transcripts reach several megabytes and `brief` runs on every prompt, so the read starts
 * with the tail and doubles it only while the window holds no evidence either way; only a
 * whole-file read with no evidence is a fresh record. Past `cap` with still no evidence,
 * `unknown` is true: as with a switch, the model cannot be established.
 */
export function sessionModelState(file, { tail = 256 * 1024, cap = TRANSCRIPT_SCAN_CAP } = {}) {
  const none = { model: null, switching: false, unknown: false };
  let size;
  try { size = fs.statSync(file).size; } catch { return none; }
  for (let want = Math.min(tail, cap); ; want = Math.min(want * 2, cap)) {
    const start = Math.max(0, size - want);
    let text;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        text = buf.toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch { return { ...none, unknown: true }; }
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);  // drop the truncated first line
    const found = scanModelEvidence(text);
    if (found) return { ...none, ...found };
    if (start === 0) return none;               // the whole record, and it names no model
    if (want >= cap) return { ...none, unknown: true };
  }
}

function scanModelEvidence(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l) continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (!e || typeof e !== 'object' || e.isSidechain) continue;
    const m = e.type === 'assistant' ? e.message?.model
      : e.type === 'attachment' && e.attachment?.type === 'model' ? e.attachment.identity?.modelId
        : null;
    // `via` says which record named it, so `iac doctor` can report what the harness wrote
    if (typeof m === 'string' && m) return { model: m, via: e.type === 'assistant' ? 'assistant' : 'attachment' };
    if (isModelSwitch(e)) return { model: null, switching: true };
  }
  return null;
}

/**
 * `/model` that changed the model: Claude Code writes `<local-command-stdout>Set model to ...`
 * as a user entry at once, but announces the new model (attachment) only with the next
 * prompt, after UserPromptSubmit hooks have run. Until newer model evidence lands, the
 * session's model is unknown rather than the previous one. A picker closed without a change
 * writes `Kept model as ...` (a `system`/`local_command` entry) and does not count. Typed
 * prompts carry `origin`/`promptSource`; harness local-command entries do not, and the
 * stdout tag must open the entry, so a prompt that quotes it is not a switch.
 */
function isModelSwitch(e) {
  if (e.origin !== undefined || e.promptSource !== undefined) return false;
  const c = e.type === 'user' ? e.message?.content
    : e.type === 'system' && e.subtype === 'local_command' ? e.content : null;
  return typeof c === 'string' && c.startsWith('<local-command-stdout>Set model to');
}

/**
 * A hook's stdin payload names its session's transcript. `brief --hook` carries it on the
 * env object under a Symbol, which no exported variable can set. It is only a fallback for
 * when the session's file is not found under HOME, and it is used only when it is that
 * session's own file (`<session-id>.jsonl`) and really lives under <CLAUDE_CONFIG_DIR or ~/.claude>/projects/
 * (compared after resolving symlinks), so a payload cannot point identity at a file
 * written anywhere else.
 */
export const HOOK_TRANSCRIPT = Symbol('iac.hookTranscript');
function hookTranscript(env, session) { return claudeHookTranscript(env[HOOK_TRANSCRIPT], session, env); }

/** `p` if it is session `session`'s own transcript under the Claude config dir's projects/, else null. */
export function claudeHookTranscript(p, session, env = process.env) {
  if (typeof p !== 'string' || path.basename(p) !== `${session}.jsonl`) return null;
  try {
    const root = fs.realpathSync(path.join(claudeDir(env), 'projects'));
    const real = fs.realpathSync(p);
    const rel = path.relative(root, real);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return fs.statSync(real).isFile() ? real : null;
  } catch { return null; }
}

/**
 * What the harness itself says is running this process: `{ harness, session, model }`, or
 * null when no harness is detectable. This is the one place a harness is taught about.
 *
 * Claude Code exposes a session transcript naming the live model. Codex exposes a
 * current task id whose contained rollout names the active model. Hook JSON is not
 * an identity authority: a Claude hook payload (`brief --hook`) may only say which session
 * record to read, and the record itself, contained under the Claude config dir, names the
 * model. If both harnesses are present, ambiguity fails read-only.
 */
export function harnessIdentity(env = process.env, store) {
  const session = env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID;
  if (session && codexPresent(env)) {
    return { harness: 'ambiguous', session: null, transcript: null, rollout: null, model: null,
      conflict: 'both Claude and Codex session ids are present; the immediate harness cannot be established safely' };
  }
  if (session) {
    const transcript = claudeTranscriptPath(session, env) || hookTranscript(env, session);
    const st = transcript ? sessionModelState(transcript) : { model: null, switching: false, unknown: false };
    return { harness: 'claude-code', session, transcript, model: st.model, switching: st.switching, modelUnknown: st.unknown, ...(st.via ? { modelVia: st.via } : {}) };
  }
  return codexRolloutIdentity(env);
}

function globToRe(g) {
  return new RegExp('^' + String(g).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
}

/** The harnesses iac can read a session record from, as named in config.familyHarness. */
export const HARNESSES = ['claude-code', 'codex'];

/**
 * What is at a store path, read-only: 'absent' (lstat ENOENT) or 'dir' (a directory, or a link
 * to one). A dangling link is not absent: refuse it rather than create or delete through it.
 */
function homeState(home) {
  // resolve first: lstat('link/') follows the link, so a dangling `link/` would read as absent
  const p = path.resolve(home);
  let l;
  try { l = fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return 'absent'; throw e; }
  let s = l;
  if (l.isSymbolicLink()) {
    try { s = fs.statSync(p); } catch (e) {
      if (e.code === 'ENOENT') throw new Error(`${home} is a link to a missing target; refusing to initialise or write through it. Remove the link or create its target first`);
      throw e;
    }
  }
  if (!s.isDirectory()) throw new Error(`${home} exists and is not a directory`);
  return 'dir';
}

/** Refuse an init that would make a registered agent the human, or the human an agent. */
function roleConflicts(reg, human, agents) {
  if (Object.hasOwn(reg, human) && reg[human].role !== 'human') throw new Error(`'${human}' is registered as an agent; it cannot become the human (pick another --human)`);
  for (const a of agents) if (Object.hasOwn(reg, a) && reg[a].role === 'human') throw new Error(`'${a}' is registered as the human; it cannot also be an agent`);
}

/** True when agents.json on disk now maps each [name, publicKey] pair (a write that landed). */
function registryHolds(st, pairs) {
  try {
    const reg = st.readJsonStrict('agents.json') || {};
    return pairs.every(([n, pk]) => Object.hasOwn(reg, n) && reg[n]?.publicKey === pk);
  } catch { return true; }   // cannot tell: keep the keys rather than risk orphaning entries
}

/** True only when nothing is at `p` now (a check that never throws). */
function absentNow(p) { try { return homeState(p) === 'absent'; } catch { return false; } }

/**
 * renameSync, retried for up to ~1.5 s on EPERM/EACCES/EBUSY while the target is still absent:
 * on Windows a virus scanner or indexer briefly holding a file in the fresh temp dir makes the
 * rename fail transiently (the graceful-fs workaround). Anything else is thrown at once.
 */
function renameRetrying(from, to, { budgetMs = 1500 } = {}) {
  const start = Date.now(); let wait = 10;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try { return fs.renameSync(from, to); } catch (e) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || Date.now() - start >= budgetMs || !absentNow(to)) throw e;
      Atomics.wait(pause, 0, 0, wait); wait = Math.min(wait * 2, 200);
    }
  }
}

/**
 * Create `dir` and any missing ancestors one level at a time, returning exactly the dirs this
 * call created (outermost first). A dir that already exists, or that another process creates
 * first (EEXIST), is not ours. (mkdirSync's recursive return value is a different spelling on
 * Windows, \\?\C:\..., so it cannot be compared against to know where to stop.)
 */
function mkdirParents(dir) {
  const missing = [];
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    try { fs.statSync(d); break; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    missing.unshift(d);
    if (path.dirname(d) === d) break;
  }
  const made = [];
  for (const d of missing) {
    try { fs.mkdirSync(d); made.push(d); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  return made;
}

/** The legacy rule for a family that declares no harness: a model from the other provider. */
function crossProviderModel(harness, model) {
  return (harness === 'codex' && /(^|[/.:])claude-/i.test(model || ''))
    || (harness === 'claude-code' && /(^|[/.:])gpt-/i.test(model || ''));
}

/**
 * The harness a family declares in config.familyHarness; null only when the key is absent.
 * A present but unrecognised value (typo, wrong case after trimming, array, null) is
 * 'invalid', which matches no harness: a hand-edit mistake must fail closed, not unpin.
 */
export function declaredHarness(family, config = {}) {
  // keys are matched case-insensitively, so a hand-edited "Sol" still pins sol
  const raw = config.familyHarness && typeof config.familyHarness === 'object' ? config.familyHarness : {};
  const map = {};
  const norm = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : null);
  for (const k of Object.keys(raw)) {
    const lk = k.toLowerCase(); const v = norm(raw[k]);
    // two spellings of one family that disagree (after trimming and lower-casing) are not a pin
    // either harness may rely on; "claude-code" and " Claude-Code" agree
    map[lk] = Object.prototype.hasOwnProperty.call(map, lk) && map[lk] !== v ? 'invalid' : v;
  }
  const key = String(family || '').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(map, key)) return null;
  const h = map[key];
  return HARNESSES.includes(h) ? h : 'invalid';
}

/**
 * config.families maps an agent name to the model ids it answers to, as globs.
 * With `harness`, only families that harness may attest are considered: one whose
 * config.familyHarness names that harness, or (no declaration) one the legacy prefix
 * rule allows. A family declared for another harness is never a match, however broad
 * its globs, so a Codex rollout naming a Claude model cannot become a Claude family.
 */
export function familyForModel(model, config = {}, { harness } = {}) {
  if (!model) return null;
  for (const [family, globs] of Object.entries(config.families || {})) {
    if (harness) {
      const declared = declaredHarness(family, config);
      if (declared ? declared !== harness : crossProviderModel(harness, model)) continue;
    }
    for (const g of [].concat(globs || [])) if (globToRe(g).test(model)) return family.toLowerCase();
  }
  return null;
}

/**
 * Where `family`'s globs overlap another family's. familyForModel takes the first family in
 * config order whose glob matches, so on an overlap the earlier family wins and the later one
 * never sees those models. Two globs overlap here when either matches the other read as a
 * literal string ('claude-*' vs 'claude-opus-*', or the same glob twice). That is a heuristic:
 * it misses overlaps that need wildcards on both sides ('*-opus' vs 'claude-*'). Families
 * pinned to different harnesses never compete, so they are not reported.
 */
export function familyOverlaps(family, config = {}) {
  const name = String(family || '').toLowerCase();
  const order = Object.keys(config.families || {}).map((f) => f.toLowerCase());
  const mine = [].concat(config.families?.[name] || []);
  const hn = declaredHarness(name, config);
  const found = [];
  for (const other of order) {
    if (other === name) continue;
    const ho = declaredHarness(other, config);
    if (hn && ho && hn !== ho) continue;
    for (const g of mine) for (const og of [].concat(config.families[other] || [])) {
      if (globToRe(g).test(og) || globToRe(og).test(g)) {
        found.push({ glob: g, family: other, otherGlob: og, winner: order.indexOf(other) < order.indexOf(name) ? other : name });
      }
    }
  }
  return found;
}

/**
 * Who is writing, and how that was established.
 * 'launcher' — IAC_AGENT (or legacy AGORA_AGENT) named this agent, so a trusted launcher chose it.
 * 'harness'  — the harness's own session record says this model is running.
 * 'self'     — chosen at the command line with --as.
 * null       — nothing to go on: read-only.
 *
 * Conflicts are refused rather than resolved: a launcher binding that disagrees with the
 * live model is stale, and --as may not override what the harness attests. Both remain
 * honesty markers, not security controls: a process that can pass --as can equally export
 * IAC_AGENT or write the transcript. They make the *accidental* case visible, which is
 * the failure this project has actually suffered twice.
 */
const CODEX_ROOT_ONLY_TODO = 'run iac from a Codex task shell, which exports CODEX_THREAD_ID; do not copy or forward CODEX_SESSION_ID on its own.';

export function resolveIdentity({ explicit, env = process.env, config = {}, registry = {}, store, harness } = {}) {
  const want = (explicit || '').toLowerCase() || null;
  const bound = (envVar(env, 'AGENT') || '').toLowerCase() || null;
  // `harness`: a harnessIdentity(env) result the caller already has (iac doctor), so the
  // session record is located and read once
  const h = harness !== undefined ? harness : harnessIdentity(env, store);
  const model = h?.model || null;
  // Defence in depth: the prefix rule holds for every family, declared or not. On top of it,
  // a family that declares a harness (config.familyHarness) is attestable by that harness only.
  const incompatibleModel = !!h && crossProviderModel(h.harness, model);
  const family = incompatibleModel || !h || h.conflict ? null : familyForModel(model, config, { harness: h.harness });
  // a family the model's globs match, but that this harness may not attest
  const foreign = !incompatibleModel && !family && model && h && !h.conflict ? familyForModel(model, config) : null;
  const attested = family && registry[family] ? family : null;
  // the model is unknown because a /model switch has not been announced yet
  const switching = !!(h && !h.conflict && !model && h.switching);
  // the record is too long to find any model evidence within the scan cap
  const modelUnknown = !!(h && !h.conflict && !model && !switching && h.modelUnknown);
  const base = { harness: h?.harness || null, session: h?.session || null, model, family,
    familyHarness: family ? declaredHarness(family, config) : null,
    ...(switching ? { switching: true } : {}), ...(modelUnknown ? { modelUnknown: true } : {}),
    // root-only Codex refuses every write, even under a launcher binding: say so on every resolution
    ...(h?.rootOnly ? { rootOnly: true, readOnly: CODEX_ROOT_ONLY_REASON, readOnlyTodo: CODEX_ROOT_ONLY_TODO } : {}) };
  const reason = !h ? 'no IAC_AGENT, and no harness session id in this environment'
    : h.conflict || h.unattestable || (!(h.transcript || h.rollout) ? `no session record found for ${h.harness} session ${h.session}`
      : switching ? `session ${h.session} is switching models (/model); the new model is not announced yet`
      : modelUnknown ? `session record for ${h.session} names no model in its last ${TRANSCRIPT_SCAN_CAP / 1024 / 1024}MB, or could not be read`
      : !model && h.modelProblem === 'invalid-record' ? `the newest complete record in the session record for ${h.session} is unparseable or names an invalid model, so the current model cannot be established (fail closed)`
      : !model && h.modelProblem === 'scan-cap' ? `session record for ${h.session} names no model in its last ${CODEX_SCAN_CAP / 1024 / 1024}MB`
      : !model && h.modelProblem === 'unreadable' ? `session record for ${h.session} could not be read`
      : !model ? `session record for ${h.session} names no model yet`
        : incompatibleModel ? `model '${model}' cannot be attested by ${h.harness}`
        : foreign ? `model '${model}' matches family '${foreign}', which ${h.harness} cannot attest (familyHarness: ${declaredHarness(foreign, config) || 'none'})`
        : !family ? `model '${model}' matches no family in config.json (families)`
          : `model '${model}' maps to family '${family}', which is not a registered agent`);
  const todo = h?.conflict ? 'start the inner harness outside the parent harness, or bind it explicitly with iac-launch.'
    : h?.rootOnly ? CODEX_ROOT_ONLY_TODO
    : h?.unattestable ? 'set CODEX_HOME to an absolute path (or unset it for ~/.codex) and restart Codex.'
    : !h ? 'pass --as <name>, or start through iac-launch <name>.'
    : switching ? 'the harness is switching models; retry after the next prompt.'
    : modelUnknown ? 'retry after the next prompt (it re-announces the model), or bind this session explicitly with iac-launch <name>.'
    : !model && h.modelProblem === 'invalid-record' ? 'retry after the next prompt (Codex writes a new turn context); until a newer complete record names the model, this session stays read-only.'
    : foreign && declaredHarness(foreign, config) === 'invalid'
      ? `fix config.json familyHarness.${foreign} (iac set-models ${foreign} --harness claude-code|codex)`
    : incompatibleModel || foreign ? 'check the harness session record and model; cross-harness models cannot attest identity.'
    : !family && model ? `iac set-models <agent> --models '${String(model).replace(/[^-]*$/, '')}*'`
      : family ? `iac add-agent ${family}`
        : 'bind this session explicitly with iac-launch <name>.';

  if (bound) {
    if (want && want !== bound) {
      throw new Rejected('identity-override',
        `this session is bound to '${bound}' but --as says '${want}'`,
        `act as ${bound}, or relaunch through iac-launch ${want}. Never override a binding with --as.`);
    }
    if (attested && attested !== bound) {
      throw new Rejected('stale-binding',
        `${envSource(env, 'AGENT') || 'IAC_AGENT'} binds this session to '${bound}', but it is running ${model}, which iac reads as '${attested}'`,
        `relaunch as ${attested} (iac-launch ${attested}), or empty both IAC_AGENT and AGORA_AGENT and let the harness name you.`);
    }
    return { ...base, agent: bound, source: 'launcher' };
  }
  if (attested) {
    if (want && want !== attested) {
      const human = registry[want]?.role === 'human';
      throw new Rejected('identity-override',
        `this session is running ${model}, which iac reads as '${attested}', but --as says '${want}'`,
        human ? `write as ${attested}; an agent may not write as the human (${want}).`
          : `write as ${attested}. Relaunch through iac-launch ${want} if you really are ${want}.`);
    }
    return { ...base, agent: attested, source: 'harness' };
  }
  if (h?.conflict && want) {
    throw new Rejected('identity-override', h.conflict,
      'do not choose an identity with --as; start the inner harness outside the parent, or bind it through iac-launch.');
  }
  if ((switching || modelUnknown) && want) {
    throw new Rejected(switching ? 'model-switching' : 'model-unknown', reason,
      `${todo} Do not choose an identity with --as while the model is unknown.`);
  }
  if (h?.harness === 'codex' && want) {
    throw new Rejected('identity-override', reason,
      `${todo} An unattested Codex session may not choose an identity with --as.`);
  }
  if (want) return { ...base, agent: want, source: 'self' };

  return { ...base, agent: null, source: null, reason, todo };
}

export function resolveInstance({ explicit, agent, project, env = process.env, session }) {
  const harnessId = session || harnessTaskId(env);
  const v = explicit || (harnessId ? `${agent}-${harnessId}` : null) || envVar(env, 'INSTANCE') || `${agent}@${project}`;
  if (!INSTANCE_RE.test(v)) throw new Rejected('bad-instance', `instance label '${v}' is invalid`);
  return v;
}

export { KINDS, Rejected, DEFAULT_CONFIG };

/** /mnt/c/x -> C:\x, so WSL can print a command a native Windows shell can run. */
export function toWin(p) {
  const m = /^\/mnt\/([a-z])\/(.*)$/.exec(p || '');
  return m ? `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}` : p;
}

/**
 * A directory a native Windows program can open: the C:\ form of a /mnt/<drive> path, else
 * (under WSL) the \\wsl.localhost\<distro> share, else the path unchanged. Codex 0.160.1's
 * Windows build accepts the share for `codex plugin marketplace add`.
 */
export function toWinDir(p, env = process.env) {
  const win = toWin(p);
  if (win !== p || !p?.startsWith('/') || !/^[^\\/\0]+$/.test(env.WSL_DISTRO_NAME || '')) return win;
  return `\\\\wsl.localhost\\${env.WSL_DISTRO_NAME}${p.replace(/\//g, '\\')}`;
}

/** How many fresh ids open() tries before giving up; each collision is an existing thread file. */
const OPEN_ID_ATTEMPTS = 8;
/** gc holds the store lock for at most this long, or this many deletes, before letting writers in. */
export const GC_BATCH_MS = 1_000;
export const GC_BATCH_MAX = 20;
/**
 * Between batches gc stays off the lock this long: longer than a waiting writer's longest
 * poll (120 ms), so every writer already queued gets a try before the next batch.
 */
export const GC_BATCH_GAP_MS = 150;
/**
 * Lock waits (LOCK_TIMEOUT_MS each) a sweep without waitMs retries in a row before it stops
 * and reports what is left: unlimited, since a holder that keeps the lock that long is live
 * (it heartbeats; a dead one is broken at LOCK_STALE_MS). maxMs bounds the whole sweep.
 */
export const GC_BUSY_RETRIES = Infinity;
/** gc leaves an empty thread file alone until it is this old: it may be an open mid-create. */
export const EMPTY_THREAD_GRACE_MS = 5 * 60_000;

export class Agora {
  constructor(home, { now, env = process.env } = {}) {
    this.store = new Store(home);
    this._now = now || (() => Date.now());
    this.env = env;
  }
  now() { return this._now(); }
  ts() { return new Date(this.now()).toISOString(); }

  // ---- setup -------------------------------------------------------------

  /**
   * Create the store, or (--force, or a directory that is not a store yet) add what is missing.
   *
   * Everything that can be checked is checked before anything is written: every name
   * (pattern, Windows device names, duplicates) and, against the registry as it is on disk,
   * that no agent would become the human or the human an agent. Nothing is ever snapshotted
   * and restored, so another process's writes are never mistaken for this call's debris:
   * - home absent: the whole store is built in a sibling temp dir and renamed into place in
   *   one step. A concurrent init that got there first wins; this call removes only its own
   *   temp dir and reports "already initialised".
   * - home is a directory: under the store lock, each file is created exclusively or
   *   replaced atomically (mode kept). On failure only the paths this call created are
   *   removed, and only while nothing on disk refers to them yet.
   */
  init({ agents = [], human, repo = null, force = false, replaceHuman = false } = {}) {
    const st = this.store;
    // The human is only ever named by --human: without it, a fresh store gets 'human' and an
    // existing one keeps its own. Replacing an existing human takes --replace-human.
    const names = [...(human != null ? [human] : []), ...agents];
    for (const n of names) { const why = nameProblem(n); if (why) throw new Error(why); }
    const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
    if (dupes.length) throw new Error(`duplicate name: ${dupes.join(', ')}`);
    const forHuman = (h) => {
      const why = nameProblem(h); if (why) throw new Error(`the human: ${why}`);
      if (agents.includes(h)) throw new Error(`'${h}' is the human; it cannot also be an agent`);
      return h;
    };
    st.invalidate();
    if (homeState(st.home) === 'absent') return this._initFresh({ agents, human: forHuman(human ?? 'human'), repo });

    // Read-only checks, once before the lock (taking it is a write) and again inside it.
    const check = () => {
      const cfg = st.readJsonStrict('config.json');
      if (cfg !== undefined && !force) throw new Error(`already initialised at ${st.home} (use --force to add missing agents/keys)`);
      const reg = st.readJsonStrict('agents.json');
      const humans = Object.keys(reg || {}).filter((k) => reg[k]?.role === 'human');
      const fix = (n) => `iac init --force --human ${n} --replace-human`;
      if (cfg === undefined && reg !== undefined) {
        // agents.json without config.json: rebuild a default config around a registered human
        const hint = humans.length ? `iac init --force --human ${humans.length === 1 ? humans[0] : '<one of: ' + humans.join(', ') + '>'}` : null;
        if (!force) throw new Error(`${st.home} has agents.json but no config.json, so it is half-initialised or damaged. Restore config.json from a backup${hint ? `, or rebuild a default one with: ${hint}` : ''}`);
        const h = human ?? (humans.length === 1 ? humans[0] : undefined);
        if (h === undefined || !humans.includes(h)) {
          throw new Error(`${st.home} has agents.json but no config.json. To rebuild a default config, name a registered human: ${humans.length ? `iac init --force --human <one of: ${humans.join(', ')}>` : 'the registry has no human; restore config.json from a backup'}`);
        }
        roleConflicts(reg, forHuman(h), agents);
        return { cfg, reg, human: h };
      }
      const current = cfg?.human ?? undefined;
      if (current !== undefined && (typeof current !== 'string' || nameProblem(current)) && !(human != null && replaceHuman)) {
        throw new Error(`config.json at ${st.home} names the human ${JSON.stringify(current)}, which is not a valid name (${NAME_RE}). Fix it with: ${fix('<name>')}`);
      }
      const currentIsHuman = current !== undefined && humans.includes(current);
      let h;
      if (human != null) h = forHuman(human);
      else if (current !== undefined && (currentIsHuman || !humans.length)) h = forHuman(current);
      else if (humans.length === 1) h = forHuman(humans[0]);   // no --human, stale or absent config.human: the registry's human
      else if (humans.length > 1) throw new Error(`${st.home} registers several humans (${humans.join(', ')}) and config.json ${current === undefined ? 'names none' : `names '${current}', which is not one of them`}. Pick one: ${fix('<name>')}`);
      else h = forHuman(current ?? 'human');
      roleConflicts(reg || {}, h, agents);
      // what every reader sees: the merged config (human defaults to 'human'), not the raw file
      const before = currentHuman(reg || {}, { ...DEFAULT_CONFIG, ...(cfg || {}) });
      const plainKeeps = humans.length <= 1 || currentIsHuman;   // `init --force` with no --human keeps `before`
      const keep = plainKeeps ? `drop --human to keep '${before}'` : `pass --human ${before} to keep '${before}'`;
      const repair = humans.includes(h) && h === before && current !== undefined && !currentIsHuman;   // stale config.human: pointing it at where readers already route
      if (current !== undefined && h !== current && !replaceHuman && !repair) {
        throw new Error(currentIsHuman
          ? `the human at ${st.home} is '${current}'; --human ${h} would replace it. Pass --replace-human to do that, or drop --human to keep '${current}'`
          : `config.json at ${st.home} names '${current}' as the human, which is not a registered human${humans.length ? ` (registered: ${humans.join(', ')})` : ''}; --human ${h} would change it. Pass --replace-human to do that${humans.length ? `, or ${keep}` : ''}`);
      }
      if (humans.length && !humans.includes(h) && !replaceHuman) {
        throw new Error(`the human at ${st.home} is '${before}'; --human ${h} would register a second human. Pass --replace-human to do that, or ${keep}`);
      }
      // general rule: the effective human (what the viewer and waits route to) only changes with --replace-human
      if (humans.length && h !== before && !replaceHuman) {
        throw new Error(`the human at ${st.home} is '${before}'; --human ${h} would change it. Pass --replace-human to do that, or ${keep}`);
      }
      return { cfg, reg, human: h };
    };
    check();
    return st.withLockSync(() => { const c = check(); return this._initExisting(c, { agents, human: c.human, repo }); });
  }

  /** Fresh init: build the complete store beside `home`, then rename it into place. */
  _initFresh({ agents, human, repo }) {
    const st = this.store;
    const home = path.resolve(st.home);
    const parent = path.dirname(home);
    const madeParents = mkdirParents(parent);   // exactly the dirs this call created, outermost first
    const tmp = `${home}.init-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    let ownTmp = false;
    const reg = {};
    try {
      fs.mkdirSync(tmp); ownTmp = true;   // exclusive: a random name only this call knows
      for (const d of ['threads', 'keys', 'seen']) fs.mkdirSync(path.join(tmp, d));
      for (const name of [...agents, human]) {
        const { publicPem, privatePem } = generateKeypair();
        st.writePrivateKey(name, privatePem, path.join(tmp, 'keys'));
        reg[name] = { role: name === human ? 'human' : 'agent', publicKey: publicPem, added: this.ts() };
      }
      const json = (o) => JSON.stringify(o, null, 2) + '\n';
      fs.writeFileSync(path.join(tmp, 'agents.json'), json(reg), { flag: 'wx' });
      fs.writeFileSync(path.join(tmp, 'config.json'), json({ ...DEFAULT_CONFIG, human, ...(repo ? { repo } : {}) }), { flag: 'wx' });
      try { renameRetrying(tmp, home); ownTmp = false; } catch (e) {
        // rename never replaces a non-empty directory, a file or a link: if home now
        // exists, someone else created it after our check. Their store is theirs.
        let now; try { now = homeState(home); } catch (h) { now = h; }
        if (now === 'absent') throw e;
        if (now instanceof Error) throw now;   // e.g. a dangling link appeared: say so, not "another process"
        throw Object.assign(new Error(fs.existsSync(path.join(home, 'config.json'))
          ? `already initialised at ${st.home} (another init finished first; use --force to add missing agents/keys)`
          : `${st.home} was created by another process while this init ran; nothing was written to it. Re-run iac init`), { code: 'EEXIST' });
      }
    } catch (e) {
      if (ownTmp) {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (c) {
          // keep the original error, but say where the orphaned private keys are
          e.message = `${e.message} (could not remove the temp dir ${tmp}: ${c.code || c.message}; it holds private keys (0600) from this failed init: delete it by hand)`;
        }
      }
      for (const d of madeParents.reverse()) { try { fs.rmdirSync(d); } catch { break; } }   // never recursive
      throw e;
    } finally { st.invalidate(); }
    return { home: st.home, created: [...agents, human], registry: reg };
  }

  /** init into an existing directory, under the store lock, with `check()`'s fresh reads. */
  _initExisting({ cfg, reg }, { agents, human, repo }) {
    const st = this.store;
    const made = [];       // paths this call created, in order; removed (newest first) on failure
    const madeDirs = [];
    const toAdd = [...agents, human].filter((n) => !Object.hasOwn(reg || {}, n));
    const next = { ...(reg || {}) };
    let committed = false;   // a pre-existing registry now names this call's keys: they stay
    try {
      for (const d of [st.threadsDir, st.keysDir, st.seenDir]) {
        try { fs.mkdirSync(d); madeDirs.push(d); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      }
      for (const name of toAdd) {
        const { publicPem, privatePem } = generateKeypair();
        made.push(st.writePrivateKey(name, privatePem));
        next[name] = { role: name === human ? 'human' : 'agent', publicKey: publicPem, added: this.ts() };
      }
      if (toAdd.length) {
        const regPath = path.join(st.home, 'agents.json');
        if (reg === undefined) made.push(regPath);   // ours, even if the rename landed and then threw
        try { st.saveRegistry(next); } finally {
          if (reg !== undefined) committed = registryHolds(st, toAdd.map((n) => [n, next[n].publicKey]));
        }
      }
      let cfgNext = null;
      if (cfg === undefined) { cfgNext = { ...DEFAULT_CONFIG, human, ...(repo ? { repo } : {}) }; made.push(path.join(st.home, 'config.json')); }
      else if (cfg.human !== human || (repo && cfg.repo !== repo)) cfgNext = { ...cfg, human, ...(repo ? { repo } : {}) };
      if (cfgNext) st.saveConfig(cfgNext);
      return { home: st.home, created: toAdd, registry: next, ...(cfg === undefined && reg !== undefined ? { rebuiltConfig: true } : {}) };
    } catch (e) {
      if (committed) {
        e.message = `${e.message} (registered ${toAdd.join(', ')} with keys, but config.json was not updated; re-run iac init --force)`;
      } else {
        for (const p of made.reverse()) { try { fs.unlinkSync(p); } catch { /* never written */ } }
        for (const d of madeDirs.reverse()) { try { fs.rmdirSync(d); } catch { /* not empty: someone else's now */ } }
      }
      throw e;
    } finally { st.invalidate(); }
  }

  addAgent(name, role = 'agent', { quiet = false, models = null, harness = null } = {}) {
    const why = nameProblem(name); if (why) throw new Error(`agent ${why}`);
    if (role !== 'agent' && role !== 'human') throw new Error(`--role must be agent or human: ${role}`);
    const h = harness ? String(harness).trim().toLowerCase() : null;
    if (harness && !HARNESSES.includes(h)) throw new Error(`--harness must be one of ${HARNESSES.join(', ')}: ${harness}`);
    let globs = null;
    if (models != null) {
      if (!Array.isArray(models)) throw new Error('models must be a list of globs');
      globs = [...new Set(models.map((s) => String(s).trim()).filter(Boolean))];
      if (models.length && !globs.length) throw new Error(`give at least one model glob, e.g. --models 'claude-${name}-*'`);
      if (!globs.length) globs = null;
    }
    const st = this.store;
    // Read-only checks, once before the lock and again inside it.
    const check = () => {
      if (homeState(st.home) === 'absent' || st.readJsonStrict('config.json') === undefined) throw new Error(`not initialised at ${st.home} (run: iac init)`);
      const reg = st.readJsonStrict('agents.json') || {};
      if (role === 'human' && !Object.hasOwn(reg, name)) {
        const humans = Object.keys(reg).filter((k) => reg[k]?.role === 'human');
        if (humans.length) throw new Error(`the human at ${st.home} is '${humans[0]}'; add-agent will not register a second human. To replace it: iac init --force --human ${name} --replace-human`);
      }
      return Object.hasOwn(reg, name) ? null : reg;
    };
    if (!check()) { if (quiet) return false; throw new Error(`'${name}' already registered`); }
    return st.withLockSync(() => {
      const reg = check();
      if (!reg) { if (quiet) return false; throw new Error(`'${name}' already registered`); }
      let madeKeys = false; let key = null; let referenced = false;
      try {
        try { fs.mkdirSync(st.keysDir); madeKeys = true; } catch (e) { if (e.code !== 'EEXIST') throw e; }
        const { publicPem, privatePem } = generateKeypair();
        key = st.writePrivateKey(name, privatePem);
        try { st.saveRegistry({ ...reg, [name]: { role, publicKey: publicPem, added: this.ts() } }); } catch (e) {
          referenced = registryHolds(st, [[name, publicPem]]);   // the rename landed, then the call threw
          throw e;
        }
      } catch (e) {
        if (!referenced) {
          if (key) { try { fs.unlinkSync(key); } catch { /* already gone */ } }
          if (madeKeys) { try { fs.rmdirSync(st.keysDir); } catch { /* not empty: someone else's now */ } }
        }
        st.invalidate();
        throw e;
      }
      if (globs || h) {
        try {
          const cfg = st.readJsonStrict('config.json') || {};
          const out = { ...cfg };
          if (globs) out.families = { ...(cfg.families || {}), [name]: globs };
          if (h) out.familyHarness = { ...Object.fromEntries(Object.entries(cfg.familyHarness || {}).filter(([k]) => k.toLowerCase() !== name)), [name]: h };
          st.saveConfig(out);
        } catch (e) {
          e.message = `'${name}' is registered with a key, but recording its models/harness failed: ${e.message}. Finish with: iac set-models ${name}${globs ? ` --models '${globs.join(',')}'` : ''}${h ? ` --harness ${h}` : ''}`;
          throw e;
        } finally { st.invalidate(); }
      }
      st.invalidate();
      return true;
    });
  }

  /**
   * Read-modify-write of config.json for a registered agent: under the store lock, from a
   * strict read of disk (only ENOENT means absent; any other error throws before writing).
   */
  _configEdit(name, mutate) {
    const st = this.store;
    const read = () => {
      st.invalidate();
      if (homeState(st.home) === 'absent') throw new Error(`not initialised at ${st.home} (run: iac init)`);
      const cfg = st.readJsonStrict('config.json');
      if (cfg === undefined) throw new Error(`not initialised at ${st.home} (run: iac init)`);
      const reg = st.readJsonStrict('agents.json') || {};
      if (!Object.hasOwn(reg, name)) throw new Error(`'${name}' is not a registered agent (iac add-agent ${name})`);
      return cfg;
    };
    read();   // friendly errors before taking the lock (taking it creates .lock)
    st.withLockSync(() => {
      const cfg = read();
      mutate(cfg);
      st.saveConfig(cfg);
    });
    st.invalidate();
  }

  /**
   * Which model ids write as this agent. A session whose harness reports a matching model
   * is that agent, without a launcher. Only a registered agent may claim models.
   */
  setFamilyModels(agent, globs) {
    const name = String(agent || '').toLowerCase();
    const list = [...new Set((globs || []).map((s) => String(s).trim()).filter(Boolean))];
    if (!list.length) throw new Error(`give at least one model glob, e.g. iac set-models ${name} --models 'claude-${name}-*'`);
    this._configEdit(name, (cfg) => { cfg.families = { ...cfg.families, [name]: list }; });
    return { ok: true, agent: name, models: list };
  }

  /**
   * Which harness may attest this agent's family. Once declared, a session in any other
   * harness never writes as this agent through attestation, whatever model it reports.
   */
  setFamilyHarness(agent, harness) {
    const name = String(agent || '').toLowerCase();
    const h = String(harness || '').trim().toLowerCase();
    if (!HARNESSES.includes(h)) throw new Error(`--harness must be one of ${HARNESSES.join(', ')}: ${harness}`);
    this._configEdit(name, (cfg) => {
      // drop hand-edited case variants ("Sol") so the new pin is the only spelling
      const kept = Object.entries(cfg.familyHarness || {}).filter(([k]) => k.toLowerCase() !== name);
      cfg.familyHarness = { ...Object.fromEntries(kept), [name]: h };
    });
    return { ok: true, agent: name, harness: h };
  }

  config() { return this.store.config(); }

  /** Record how `iac-launch <agent>` should start this agent's harness. */
  setLaunch(agent, argv) {
    const name = String(agent || '').toLowerCase();
    if (!Array.isArray(argv) || !argv.length) throw new Error('give a command after --, e.g. iac set-launch reviewer -- claude');
    this._configEdit(name, (cfg) => { cfg.launch = { ...cfg.launch, [name]: argv }; });
    return { ok: true, agent: name, launch: argv };
  }

  /** Absolute paths a copy-pasteable command needs. No assumptions about who is running it. */
  paths() {
    const cli = fileURLToPath(new URL('../bin/iac.js', import.meta.url));
    const mcp = fileURLToPath(new URL('../bin/iac-mcp.js', import.meta.url));
    const skill = fileURLToPath(new URL('../skills/inter-agent-comms/SKILL.md', import.meta.url));
    const root = path.dirname(path.dirname(cli)); // the install (plugin) root: holds .codex-plugin/ and .claude-plugin/
    return { cli, mcp, skill, root, store: this.store.home, storeSource: this.store.homeSource, winCli: toWin(cli), winMcp: toWin(mcp), winSkill: toWin(skill), winStore: toWin(this.store.home), winRoot: toWinDir(root, this.env) };
  }
  registry() { return this.store.registry(); }
  roleOf(name) { return this.registry()[name]?.role || (this.registry()[name] ? 'agent' : null); }
  /**
   * Who the human is now: config.human when it names a registered human. A human replaced with
   * `init --replace-human` stays registered (its signed posts keep verifying, and past events
   * keep deriving as they did) but no longer receives @human, the viewer or waits.
   */
  humanName() { return currentHuman(this.registry(), this.config()); }

  // ---- reading -----------------------------------------------------------

  thread(id) {
    const read = this.store.readEventsDetailed(id); // unparseable lines are skipped, not fatal
    if (!read) return null;
    let s;
    try { s = deriveState(id, read.events, this.config(), this.registry(), this.now()); } catch (e) {
      // never drop a thread silently: list it, marked damaged, with nothing derived
      s = { id, title: '(unreadable thread)', opener: null, created: null, project: 'unscoped', posts: [], participants: [], waitClears: [], locked: false, closed: false,
        idle: false, idleSince: null, status: 'unreadable', lastActivity: '1970-01-01T00:00:00.000Z', expiresAt: null, cooldown: null, eventCount: read.events.length,
        damagedLines: [{ kind: 'replay-error', reason: String(e?.message || e) }] };
    }
    const lineDamage = read.damaged.map(({ line, kind, reason }) => ({ line, kind, ...(reason ? { reason } : {}) }));
    if (lineDamage.length || s.damagedLines) { s.damagedLines = [...lineDamage, ...(s.damagedLines || [])]; this.store.markDamaged(id); }
    // 'empty' is only a whitespace-only file; no valid events but lines that did not parse
    // (a torn open, say) is a thread with no readable open, which gc never sweeps by mtime
    if (s.damage === 'empty' && lineDamage.length) { s.damage = 'missing-open'; s.title = '(damaged: no readable events)'; }
    // structural damage counts in the brief's damaged-thread tally too
    if (s.status === 'damaged') this.store.markDamaged(id);
    // Idle is derived last, and never for a thread with any damage (torn lines included): a
    // damaged thread must stay visible. It needs the wait board, which is only consulted once
    // the cheap timestamp test passes.
    if (s.status === 'open' && !s.damagedLines?.length) applyIdle(s, this.config(), this.now(), () => this._waitBoard([s]).length > 0);
    return s;
  }
  threads({ includeClosed = true, includeIdle, project } = {}) {
    const out = [];
    for (const id of this.store.threadIds()) {
      const s = this.thread(id);
      if (s && (includeClosed || (!s.closed && (includeIdle || !s.idle))) && (!project || s.project === project)) out.push(s);
    }
    // a structurally damaged empty thread has no lastActivity: it sorts last rather than poisoning the sort with NaN
    return out.sort((a, b) => (Date.parse(b.lastActivity) || 0) - (Date.parse(a.lastActivity) || 0));
  }

  /** Verify signatures + hash chain for one thread. */
  verify(id) {
    const read = this.store.readEventsDetailed(id);
    if (!read) return null;
    return this._verifyRead(id, read);
  }

  _verifyRead(id, read) {
    const { events, damaged } = read;
    const reg = this.registry();
    // a torn or corrupt line is a problem to report, never a reason to stop; the chain is
    // checked over the lines that did parse (an event after a lost one shows as a chain-break)
    const problems = damaged.map((d) => ({ ...d, problem: d.kind, message: d.kind === 'malformed' ? `line ${d.line} is not a well-formed event: ${d.reason}` : `line ${d.line} is not a valid event (torn or corrupt)` }));
    let prevHash = null;
    // an empty (or blank-only) file has no open at all: the loop below would never see it
    if (!events.length) problems.push({ i: 0, id: null, problem: 'missing-open', type: null, message: 'thread file holds no events, so no open' });
    events.forEach((ev, i) => {
      if ((ev.prev ?? null) !== prevHash) problems.push({ i, id: ev.id, problem: 'chain-break' });
      if (!verifyEvent(ev, reg[ev.author]?.publicKey)) problems.push({ i, id: ev.id, problem: 'bad-signature', author: ev.author });
      // a thread is exactly one `open`, first: a second one is a splice or a pre-exclusive-create id collision
      if (i === 0 && ev.type !== 'open') problems.push({ i, id: ev.id, problem: 'missing-open', type: ev.type, message: `first event is a ${ev.type ?? '(no type)'}, not the thread's open` });
      if (i > 0 && ev.type === 'open') problems.push({ i, id: ev.id, problem: 'misplaced-open', author: ev.author, message: `a second open (by ${ev.author ?? '(none)'}) at position ${i}; only event 0 may open a thread` });
      // `thread` is signed, so a file copied under another id still carries its original one
      if (ev.thread !== id) problems.push({ i, id: ev.id, problem: 'thread-mismatch', thread: ev.thread, storedUnder: id, message: `event signed for thread ${ev.thread ?? '(none)'} but stored under ${id}` });
      prevHash = eventHash(ev);
    });
    return { id, events: events.length, ok: problems.length === 0, problems };
  }
  verifyAll() { return this.store.threadIds().map((id) => this.verify(id)); }

  /** Per-post verification flags for rendering. */
  threadWithVerification(id) {
    const s = this.thread(id);
    if (!s) return null;
    const v = this.verify(id);
    const bad = new Set(v.problems.map((p) => p.id));
    s.posts = s.posts.map((p) => ({ ...p, verified: !bad.has(p.id) }));
    s.waitClears = (s.waitClears || []).map((c) => ({ ...c, verified: !bad.has(c.id) }));
    s.verified = v.ok;
    return s;
  }

  // ---- writing -----------------------------------------------------------

  /** Who this session is, by launcher binding or by the harness's own session record. */
  identity({ explicit, harness } = {}) {
    return resolveIdentity({ explicit, env: this.env, config: this.config(), registry: this.registry(), store: this.store, harness });
  }

  /**
   * A session with an identity must not write as a different one, including the human.
   * Returns the resolution so the caller can record how the name was obtained.
   */
  _assertNotImpersonating(author) {
    const id = this.identity();
    if (id.harness === 'ambiguous' && id.source !== 'launcher') {
      throw new Rejected('identity-conflict', id.reason,
        'start the inner harness outside the parent harness, or bind it explicitly with iac-launch.');
    }
    // Even a launcher binding cannot say which task a root-only Codex id belongs to.
    if (id.rootOnly) {
      throw new Rejected('unattested-identity', CODEX_ROOT_ONLY_REASON, `${CODEX_ROOT_ONLY_TODO} Until then this session is read-only.`);
    }
    if (id.agent && id.agent !== author) {
      throw new Rejected('identity-override',
        id.source === 'launcher'
          ? `this session is bound to '${id.agent}' but you are writing as '${author}'`
          : `this session is running ${id.model}, which iac reads as '${id.agent}', but you are writing as '${author}'`,
        `act as ${id.agent}, or relaunch through iac-launch ${author}. Never override a binding with --as.`);
    }
    if ((id.switching || id.modelUnknown) && !id.agent) {
      throw new Rejected(id.switching ? 'model-switching' : 'model-unknown', id.reason, `${id.todo} Until then this session is read-only.`);
    }
    if (id.harness === 'codex' && !id.agent) {
      throw new Rejected('unattested-identity', id.reason,
        `${id.todo} An unattested Codex session is read-only.`);
    }
    return id;
  }

  /** A harness-bound task may not hand-pick a sibling's visible instance label. */
  _assertNoInstanceOverride(instance, action, hint = "the running task's own identity is authoritative; omit --instance.") {
    const harnessId = harnessTaskId(this.env || {}) || envVar(this.env, 'INSTANCE');
    if (instance && harnessId) {
      throw new Rejected('instance-override',
        `this task already has an instance identity; --instance ${instance} is not accepted when ${action}`,
        hint);
    }
    return harnessId;
  }

  _mentions(body, explicit, author) {
    const reg = this.registry(); const cfg = this.config();
    const raw = [...new Set([...(explicit || []), ...parseMentions(body)].map((m) => m.toLowerCase()))];
    const out = [];
    for (const m of raw) {
      const r = resolveMention(m, reg, cfg);
      if (!r) throw new Rejected('unknown-mention', `@${m} is not a registered agent`, `known: ${Object.keys(reg).join(', ')}`);
      if (!out.includes(r)) out.push(r);
    }
    return out;
  }

  /**
   * Chain, sign and append one event to an existing thread. `partial` says earlier events of
   * the same action were already written; if the file is gone now they went with it, and the
   * Rejected says so (and carries partial: true).
   * A thread file that is gone (swept by gc, or removed by hand) is a clear Rejected, never a
   * raw ENOENT and never a recreated file.
   */
  _finalize(id, event, author, { partial = false } = {}) {
    const swept = () => Object.assign(new Rejected('swept', partial
      ? `thread ${id} expired and was swept part-way through this action; the thread and the events this action had already written are gone`
      : `thread ${id} expired and was swept; nothing was written`, 'open a new thread and reference this one if it still matters.'), { partial });
    // unparseable lines are skipped, so `prev` is the hash of the last VALID event: a new event
    // links past a torn line and verifies, while verify keeps flagging the torn line itself
    const events = this.store.readEvents(id);
    if (!events) throw swept();
    event.prev = events.length ? eventHash(events.at(-1)) : null;
    event.sig = signEvent(event, this.store.privateKey(author));
    try { this.store.appendEvent(id, event); } catch (e) { if (e.code === 'ENOENT') throw swept(); throw e; }
    return event;
  }

  async open({ as: author, title, kind = 'proposal', body, mentions, waitingOn = [], project, instance, dryRun = false }) {
    // The project comes from git/env, not the store, so it is found before the lock is held.
    const proj = detectProject({ explicit: project, env: this.env, write: true });
    // Everything a guard or authorisation reads from the store (config, registry, identity,
    // board state) is read inside the lock, after it has dropped this process's read cache:
    // a value captured before it could predate another process's write.
    return this.store.withLock(async () => {
      const cfg = this.config(); const reg = this.registry(); const role = reg[author]?.role || 'agent';
      const identity = this._assertNotImpersonating(author);
      this._assertNoInstanceOverride(instance, 'opening a thread');
      const idSource = identity.source || 'self';
      const inst = resolveInstance({ explicit: instance, agent: author, project: proj, env: this.env, session: identity.source === 'harness' ? identity.session : null });
      if (!PROJECT_RE.test(proj)) throw new Rejected('bad-project', `project id '${proj}' is invalid`, 'use owner/repo, local:<name>, or global');
      const ms = this._mentions(body, [...(mentions || []), ...waitingOn], author);
      const wo = waitingOn.map((w) => resolveMention(w.toLowerCase(), reg, cfg));
      // Only an agent's open reads the whole board (status thread, open cap, family rate). The
      // files are read concurrently first, then derived from memory: the same states, much
      // sooner on a slow drive.
      if (role !== 'human') await this.store.prefetchThreads();
      checkOpen({ allStates: () => this.threads(), author, instance: inst, role, kind, title, body, mentions: ms, waitingOn: wo, project: proj, now: this.now(), config: cfg, registry: reg });
      if (dryRun) return { ok: true, dryRun: true, project: proj };
      // The thread file is created exclusively. On a collision with any file already there
      // (live, closed, or expired but not yet swept) a fresh id is drawn and the open event,
      // which signs its thread id, is rebuilt and re-signed. A collision is never appended to.
      const key = this.store.privateKey(author);
      for (let attempt = 0; attempt < OPEN_ID_ATTEMPTS; attempt++) {
        const id = this._newThreadId();
        const ev = { type: 'open', id: newId('p'), thread: id, author, instance: inst, idSource, ts: this.ts(), title, kind, body, mentions: ms, project: proj };
        if (wo.length) ev.waitingOn = wo;
        ev.prev = null;
        ev.sig = signEvent(ev, key);
        try { this.store.createThread(id, ev); } catch (e) { if (e.code === 'EEXIST') continue; throw e; }
        return { ok: true, thread: id, post: ev.id, project: proj };
      }
      throw new Error(`could not allocate a free thread id in ${OPEN_ID_ATTEMPTS} attempts; nothing was written`);
    });
  }

  /** A new thread id: 4 random bytes. Tests replace this to force a collision. */
  _newThreadId() { return newId('t', 4); }

  /**
   * `closeWith` (internal, not reachable from the CLI, MCP or viewer) appends a close event
   * with these fields right after the post, inside the same lock, so no concurrent post can
   * land between them and become the thread's closing post. `escalate` uses it.
   */
  async post({ as: author, thread, kind = 'answer', body, re, mentions, waitingOn = [], instance, dryRun = false, issueUrl, bypass = false }, { closeWith } = {}) {
    // config, registry, mentions and identity are read inside the lock (see open)
    return this.store.withLock(async () => {
      const cfg = this.config(); const reg = this.registry(); const role = reg[author]?.role || 'agent';
      const ms = this._mentions(body, [...(mentions || []), ...waitingOn], author);
      const wo = waitingOn.map((w) => resolveMention(w.toLowerCase(), reg, cfg));
      const state = this.thread(thread);
      if (!state) throw new Error(`no such thread: ${thread}`);
      // only structural damage (no open event) refuses posts; damaged lines never do
      if (state.status === 'damaged') throw new Rejected('damaged', `thread ${thread} has no open event (${state.damage}); it takes no posts`,
        state.damage === 'empty' ? 'open a new thread; iac gc sweeps this empty file once it is a few minutes old.' : 'open a new thread; iac verify shows the problem.');
      const identity = this._assertNotImpersonating(author);
      this._assertNoInstanceOverride(instance, 'posting');
      const idSource = identity.source || 'self';
      const inst = resolveInstance({ explicit: instance, agent: author, project: state.project, env: this.env, session: identity.source === 'harness' ? identity.session : null });
      // Only this thread's waits can match, so only this thread is consulted: the same entry
      // waitingBoard({ on: author, project: state.project }) would list for it.
      const claimed = state.closed ? undefined : this._waitBoard([state], { on: author }).find((w) => w.thread === thread);
      if (kind === 'ack' && claimed?.claimedBy && claimed.claimedBy !== inst) {
        throw new Rejected('claimed', `this wait is already claimed by ${claimed.claimedBy}`, 'it belongs to another instance; do nothing.');
      }
      // The family rate is the one check that reads every thread, and the human and a bypass
      // never reach it: the board is read (concurrently, see open) only when it can be.
      if (role !== 'human' && !bypass) await this.store.prefetchThreads();
      checkPost({ state, allStates: () => this.threads(), author, instance: inst, role, kind, body, mentions: ms, re, now: this.now(), config: cfg, registry: reg, bypass });
      if (dryRun) return { ok: true, dryRun: true };
      // Ending a thread ends the waits it carried: whoever closes it withdraws their own
      // outstanding waits here, so the record says the request was dropped rather than
      // leaving it to vanish silently with the thread.
      const withdraw = kind === 'resolution'
        ? this._outstandingWaits(state).filter((w) => role === 'human' || w.from === author)
        : [];
      const ev = { type: 'post', id: newId('p'), thread, author, instance: inst, idSource, ts: this.ts(), kind, body, mentions: ms };
      if (re) ev.re = re;
      if (wo.length) ev.waitingOn = wo;
      if (issueUrl) ev.issueUrl = issueUrl;
      this._finalize(thread, ev, author);
      if (kind === 'resolution') this._finalize(thread, { type: 'close', id: newId('e'), thread, author, ts: this.ts(), reason: 'resolution' }, author, { partial: true });
      else if (closeWith) this._finalize(thread, { type: 'close', id: newId('e'), thread, author, ts: this.ts(), ...closeWith }, author, { partial: true });
      for (const w of withdraw) {
        // Replay only accepts a clear whose instance matches the wait it silences (the human
        // may clear any), so carry the source instance, exactly as `clearWait` does.
        const eventInst = role === 'human' ? inst : (w.fromInstance || inst);
        this._finalize(thread, { type: 'wait-clear', id: newId('e'), thread, author, instance: eventInst,
          idSource, ts: this.ts(), post: w.post, on: w.on, reason: `thread closed by ${author}` }, author, { partial: true });
      }
      return { ok: true, thread, post: ev.id, closed: kind === 'resolution' || !!closeWith,
        ...(withdraw.length ? { cleared: withdraw.map((w) => ({ post: w.post, on: w.on })) } : {}) };
    });
  }

  /** Close = resolution post + close event. Opener or human only. Bypasses rate limits (ending is always allowed). */
  async close({ as: author, thread, body }) {
    const state = this.thread(thread);
    if (!state) throw new Error(`no such thread: ${thread}`);
    return this.post({ as: author, thread, kind: 'resolution', body: body || `Closed by ${author}.`, bypass: true });
  }

  /** Withdraw one outstanding wait without deleting its signed origin post. */
  async clearWait({ as: author, thread, post, on, reason = 'No longer waiting.', instance }) {
    // identity and registry are read inside the lock (see open)
    return this.store.withLock(async () => {
      const identity = this._assertNotImpersonating(author);
      const idSource = identity.source || 'self';
      const reg = this.registry();
      if (!reg[author]) throw new Rejected('unknown-author', `'${author}' is not a registered agent`);
      const why = String(reason || '').trim();
      if (!why) throw new Rejected('empty-reason', 'wait cleanup reason is empty');
      if (why.length > 240) throw new Rejected('too-long', `wait cleanup reason is ${why.length} chars; max 240`);
      // Clearing a wait silences a claim on someone's attention, and the instance label
      // is printed in plain text by `iac show`. A sibling task could read one and replay
      // it, so a task that already has an identity may not hand-pick a different one here.
      // A process with no harness id at all may still pass one: that is how the human, or a
      // task resumed outside a harness, addresses a specific wait.
      const harnessId = this._assertNoInstanceOverride(instance, 'clearing a wait',
        "the running task's own identity is authoritative: a wait may only be cleared by the task that raised it, or by the human.");
      const state = this.thread(thread);
      if (!state) throw new Error(`no such thread: ${thread}`);
      if (state.closed) throw new Rejected('closed', 'thread is closed');
      const currentInst = resolveInstance({ explicit: instance, agent: author, project: state.project, env: this.env, session: identity.source === 'harness' ? identity.session : null });
      const fallbackIdentity = !instance && !harnessId;
      const target = on ? resolveMention(String(on).toLowerCase(), reg, this.config()) : null;
      if (on && !target) throw new Rejected('unknown-mention', `@${on} is not a registered agent`);
      // expired waits are off the board but still in the thread, so they remain withdrawable
      // only this thread's waits are candidates, so only this (open) thread is consulted
      let candidates = this._waitBoard([state], { includeExpired: true });
      if (post) candidates = candidates.filter((w) => w.post === post);
      if (target) candidates = candidates.filter((w) => w.on === target);
      const role = reg[author].role;
      const owned = candidates.filter((w) => role === 'human' || (w.from === author && (
        !w.fromInstance || w.fromInstance === currentInst ||
        (fallbackIdentity && w.fromInstance === `${author}@${w.fromProject}` && currentInst === `${author}@${state.project}`)
      )));
      if (!owned.length) {
        // Only a caller that named the wait gets the idempotent answer. Without a selector,
        // any earlier clear by this author in this thread would match, so an agent owning
        // nothing outstanding would be told it withdrew something it never raised.
        const prior = post ? (state.waitClears || []).find((c) => c.post === post && (!target || c.on === target)) : null;
        if (prior && (role === 'human' || (prior.author === author && (!prior.instance || prior.instance === currentInst || fallbackIdentity)))) {
          return { ok: true, thread, post: prior.post, on: prior.on, already: true };
        }
        throw new Rejected('not-wait-owner', 'no matching outstanding wait belongs to this task', 'clear only waits you raised; no other family can clear one, and within-family scoping depends on harness identity. The human may clear any wait. Use iac waiting to see post and target ids.');
      }
      if (owned.length > 1) {
        const choices = owned.map((w) => `${w.post}/${w.on}`).join(', ');
        throw new Rejected('ambiguous-wait', `more than one wait matches: ${choices}`, 'pass --post <id> and --on <agent>.');
      }
      const w = owned[0];
      const eventInst = role === 'human' ? currentInst : (w.fromInstance || currentInst);
      const ev = { type: 'wait-clear', id: newId('e'), thread, author, instance: eventInst,
        idSource, ts: this.ts(), post: w.post, on: w.on, reason: why };
      this._reviveGuard(state, author, role, currentInst);
      this._finalize(thread, ev, author);
      return { ok: true, thread, post: w.post, on: w.on, event: ev.id };
    });
  }

  /** Assign a project to a legacy (unscoped) thread. Opener, human, or an agent mentioned in it. Human may re-tag. */
  async setProject({ as: author, thread, project }) {
    // identity and registry are read inside the lock (see open)
    return this.store.withLock(async () => {
      const identity = this._assertNotImpersonating(author);
      const reg = this.registry();
      if (!reg[author]) throw new Rejected('unknown-author', `'${author}' is not a registered agent`);
      if (!PROJECT_RE.test(project || '')) throw new Rejected('bad-project', `project id '${project}' is invalid`, 'use owner/repo, local:<name>, or global');
      const state = this.thread(thread);
      if (!state) throw new Error(`no such thread: ${thread}`);
      if (state.closed) throw new Rejected('closed', 'thread is closed');
      const role = reg[author].role;
      const mentioned = state.posts.some((p) => p.mentions?.includes(author) || p.waitingOn?.includes(author));
      if (role !== 'human' && !(state.opener === author || mentioned)) throw new Rejected('forbidden', 'only the opener, the human, or an agent mentioned in the thread may set its project');
      if (role !== 'human' && state.project !== 'unscoped') throw new Rejected('already', `project is already ${state.project}`, 'only the human can re-tag a scoped thread');
      if (state.project === project) throw new Rejected('already', `project is already ${project}`);
      this._reviveGuard(state, author, role, this._instanceFor(author, state, identity));
      this._finalize(thread, { type: 'project', id: newId('e'), thread, author, ts: this.ts(), project }, author);
      return { ok: true, thread, project };
    });
  }

  async lock({ as: author, thread, reason }) { return this._control('lock', author, thread, reason, ['opener', 'human']); }
  async unlock({ as: author, thread, reason }) { return this._control('unlock', author, thread, reason, ['human']); }

  /** Human-only physical-line recovery; never a post, unlock, or activity reset. */
  async repair({ as: author, thread }) {
    return this.store.withLock(() => {
      const identity = this._assertNotImpersonating(author);
      const reg = this.registry();
      if (!reg[author]) throw new Rejected('unknown-author', `'${author}' is not a registered agent`);
      if (reg[author].role !== 'human') throw new Rejected('forbidden', 'only the human may repair a thread');
      const result = this.store.repairThread(thread, (read) => {
        const retained = { events: read.events, damaged: read.damaged.filter((d) => d.kind !== 'unparseable') };
        const verified = this._verifyRead(thread, retained);
        if (!verified.ok) throw new Rejected('repair-refused', `retained history fails verification: ${verified.problems.map((p) => p.problem).join(', ')}`, 'restore from a trusted backup; repair only removes parser-classified unparseable lines. Nothing was written.');
        if (!read.damaged.length) return null;
        const event = { type: 'repair', id: newId('e'), thread, author, ts: this.ts(),
          idSource: identity.source || 'self', lines: read.damaged.length, quarantine: `${thread}.damaged`,
          prev: eventHash(read.events.at(-1)) };
        event.sig = signEvent(event, this.store.privateKey(author));
        const problem = eventShapeProblem(event);
        if (problem || !verifyEvent(event, reg[author].publicKey)) throw new Rejected('repair-refused', `repair audit fails verification: ${problem || 'bad-signature'}`, 'check the human key and clock. Nothing was written.');
        return event;
      });
      if (!result) throw new Error(`no such thread: ${thread}`);
      return result;
    });
  }

  /** The caller's instance in a thread, resolved as post() resolves it. */
  _instanceFor(author, state, identity) {
    return resolveInstance({ explicit: undefined, agent: author, project: state.project, env: this.env, session: identity.source === 'harness' ? identity.session : null });
  }

  /** The one revival check: every path that appends an activity event to a thread calls it first (post goes through checkPost). */
  _reviveGuard(state, author, role, instance) {
    checkRevive({ state, allStates: () => this.threads(), author, instance, role, config: this.config() });
  }

  async _control(type, author, thread, reason, allowed) {
    // identity and registry are read inside the lock (see open)
    return this.store.withLock(async () => {
      const identity = this._assertNotImpersonating(author);
      const reg = this.registry();
      if (!reg[author]) throw new Rejected('unknown-author', `'${author}' is not a registered agent`);
      const state = this.thread(thread);
      if (!state) throw new Error(`no such thread: ${thread}`);
      if (state.closed) throw new Rejected('closed', 'thread is closed');
      const role = reg[author].role;
      const may = (allowed.includes('human') && role === 'human') || (allowed.includes('opener') && state.opener === author);
      if (!may) throw new Rejected('forbidden', `only ${allowed.join(' or ')} may ${type} a thread`, type === 'unlock' ? 'mention @human, or escalate.' : undefined);
      if (type === 'lock' && state.locked && !state.autoLocked) throw new Rejected('already', 'already locked');
      if (type === 'unlock' && !state.locked) throw new Rejected('already', 'not locked');
      this._reviveGuard(state, author, role, this._instanceFor(author, state, identity));
      this._finalize(thread, { type, id: newId('e'), thread, author, ts: this.ts(), reason: reason || `${type} by ${author}` }, author);
      return { ok: true, thread, [type]: true };
    });
  }

  /** Hand the thread to a GitHub issue; always allowed; closes the thread. `createIssue` is injected (gh wrapper). */
  async escalate({ as: author, thread, repo, title, labels = [], createIssue }) {
    this.store.invalidate();   // it files an issue before post() takes the lock: decide on the board as it is now
    this._assertNotImpersonating(author);
    const state = this.thread(thread);
    if (!state) throw new Error(`no such thread: ${thread}`);
    if (state.closed) throw new Rejected('closed', 'thread is closed');
    const r = repo || this.config().repo;
    if (!r) throw new Error('no repo: pass --repo owner/name or set "repo" in config.json');
    const md = renderMarkdown(state, { forIssue: true });
    const url = await createIssue({ repo: r, title: title || `[iac] ${state.title}`, body: md, labels: ['iac', ...labels] });
    // The handoff and the close go in under one lock: the closing post decides who is woken,
    // so a concurrent post must not slip in between them.
    await this.post({ as: author, thread, kind: 'handoff', body: `Escalated to ${url}. Continue there; this thread is closed.`, issueUrl: url, bypass: true },
      { closeWith: { reason: 'escalated', issueUrl: url } });
    return { ok: true, thread, issueUrl: url };
  }

  // ---- inbox -------------------------------------------------------------

  inbox({ as: agent, markRead = false, project, instance, includeGlobal = false } = {}) {
    if (markRead) this.store.invalidate();   // read-modify-write of seen-marks: start from disk
    const seen = this.store.seen(instance || agent);
    const scopedThreads = this.threads().filter((s) => !project || s.project === project || (includeGlobal && s.project === 'global') || (instance && s.openerInstance === instance));
    const scopedIds = new Set(scopedThreads.map((s) => s.id));
    const claimedByAnother = new Set(this.waitingBoard({ on: agent })
      .filter((w) => scopedIds.has(w.thread))
      .filter((w) => w.claimedBy && instance && w.claimedBy !== instance).map((w) => w.thread));
    // Seen-marks are per instance and only mark-read writes them (brief never does), so a new
    // session has none and would see every retained mention as new: days old, long closed.
    // For a thread this instance has not marked read, posts older than waitTtlHours are not
    // new — the same horizon at which an unclaimed wait leaves the wait board. Anything that
    // needs action past that horizon should be an acknowledged wait, which never expires.
    // A thread it has marked read keeps its seen-mark, however old.
    const ttlMs = this._waitTtlMs();
    const cutoff = ttlMs > 0 ? this.now() - ttlMs : 0;
    const items = [];
    for (const s of scopedThreads) {
      if (claimedByAnother.has(s.id) || s.idle) continue;
      const since = seen[s.id] ? Date.parse(seen[s.id]) : cutoff;
      const myPostIds = new Set(s.posts.filter((p) => p.author === agent && (!instance || eventInstance(p, s.project) === instance)).map((p) => p.id));
      // A closed thread wakes only whoever its closing post (the last one) mentions; mentions
      // from before the close were for work the close has ended.
      const closing = s.closed ? s.posts[s.posts.length - 1] : null;
      const fresh = s.posts.filter((p) => p.author !== agent && Date.parse(p.ts) > since && (s.closed
        ? p === closing && p.mentions?.includes(agent)
        : p.mentions?.includes(agent) || (p.re && myPostIds.has(p.re)) || (s.opener === agent && (!instance || s.openerInstance === instance))));
      if (fresh.length) items.push({ thread: s.id, title: s.title, status: s.status, project: s.project, posts: fresh, ...(s.damagedLines?.length ? { damagedLines: s.damagedLines } : {}) });
    }
    if (markRead) {
      const now = this.ts();
      for (const it of items) seen[it.thread] = now;
      this.store.saveSeen(instance || agent, seen);
    }
    return items;
  }

  /** waitTtlHours in ms; 0 (never expire, no floor) unless it is a finite positive number. */
  _waitTtlMs() {
    const h = Number(this.config().limits.waitTtlHours);
    return Number.isFinite(h) && h > 0 ? h * 3_600_000 : 0;
  }

  /** stallHours in ms; 0 (stalling disabled) unless it is a finite positive number. */
  _stallMs() {
    const h = Number(this.config().limits.stallHours);
    return Number.isFinite(h) && h > 0 ? h * 3_600_000 : 0;
  }

  /**
   * Who is waiting on whom, across open threads. A wait names a model family *within the thread's project*.
   * The first instance of that family to post afterwards (ack or otherwise) claims it: `claimedBy`.
   * A substantive (non-ack) post by the family clears it.
   */
  waitingBoard({ on, project, includeExpired = false } = {}) {
    return this._waitBoard(this.threads({ includeClosed: false, includeIdle: true, project }), { on, includeExpired });
  }

  /** waitingBoard over the given derived states (the caller picks them; closed ones included if passed). */
  _waitBoard(states, { on, includeExpired = false } = {}) {
    const ttlMs = this._waitTtlMs();
    const stallMs = this._stallMs();
    // A wait on the human is not a missing session: the human is the one who starts them.
    const reg = this.registry();
    const now = this.now();
    const out = [];
    for (const s of states) {
      for (const w of this._outstandingWaits(s, { on })) {
        // Nobody ever claimed it and nobody ever will: after waitTtlHours an unclaimed,
        // unanswered wait stops being a claim on attention. It is dropped from the wait
        // surfaces by derivation only — the log still carries it, and `show` still prints it.
        const age = now - Date.parse(w.since);
        const expired = ttlMs > 0 && !w.acked && age > ttlMs;
        if (expired && !includeExpired) continue;
        // Unclaimed for stallHours: no session of that family has posted in the thread since,
        // so probably none is running in that project. Derived, like expiry; never written.
        const stalled = stallMs > 0 && !w.acked && !w.claimedBy && !expired && age > stallMs && reg[w.on]?.role !== 'human';
        out.push({ ...w, expired, stalled, ageHours: Math.round(age / 360_000) / 10 });
      }
    }
    return out.sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
  }

  /**
   * The waits raised in one derived thread that are still outstanding: not withdrawn by a
   * verifiable clear, and not answered by a non-ack post from the target that claimed them.
   * No expiry and no closed-thread filtering — that is the board's business, not the thread's.
   */
  _outstandingWaits(s, { on } = {}) {
    // A forged *clear* silences someone's claim on attention, and no wait surface shows
    // signature state, so a clear that does not verify must not remove a wait from here.
    // Signature checks are the expensive part and this runs on every brief, so pay only
    // when a clear actually suppresses a wait being listed: `verified` stays null otherwise.
    let verified = null;
    const silences = (c, post, target) => c.post === post && c.on === target;
    const out = [];
    for (const p of s.posts) {
      for (const target of p.waitingOn || []) {
        if (on && target !== on) continue;
        if ((s.waitClears || []).some((c) => silences(c, p.id, target))) {
          // verify() reads the file directly (not thread()), which idle derivation calls through here
          verified ??= new Set(this.verify(s.id).problems.map((q) => q.id));
          if (s.waitClears.some((c) => silences(c, p.id, target) && !verified.has(c.id))) continue;
        }
        const later = s.posts.filter((q) => q.author === target && Date.parse(q.ts) > Date.parse(p.ts));
        const claimedBy = later.length ? eventInstance(later[0], s.project) : null;
        const answered = claimedBy && later.some((q) => q.kind !== 'ack' && eventInstance(q, s.project) === claimedBy);
        if (!answered) out.push({ from: p.author, fromInstance: p.instance || null, fromProject: p.projectAtPost || s.project, on: target, thread: s.id, title: s.title, status: s.status, project: s.project, openerInstance: s.openerInstance || null, post: p.id, since: p.ts, body: p.body, acked: later.length > 0, claimedBy, ...(s.damagedLines?.length ? { damagedLines: s.damagedLines } : {}) });
      }
    }
    return out;
  }

  // ---- housekeeping ------------------------------------------------------

  /**
   * Delete expired threads, and empty thread files left by a crashed open once they are
   * stale. Every decision is made under the store lock from a read taken inside it, so a
   * post that revives a thread, or an open still writing its file, cannot interleave between
   * the decision and the delete: writers hold the same lock.
   *
   * The sweep runs in batches: the lock is held for at most GC_BATCH_MS or GC_BATCH_MAX
   * deletes, then released and taken again, so a writer waits at most one batch even when a
   * delete is slow (about 66 ms a file on a WSL /mnt/c store), with a pause between batches
   * so writers already waiting get in rather than lose the race to the next batch. Candidates are listed without
   * the lock; each is re-read under it just before its delete.
   *
   * Options: `waitMs` bounds each wait for the lock; when it is busy the sweep stops there
   * (skipped if nothing was done yet), so a caller on a latency-sensitive path never stalls
   * behind a writer. Without it each wait is a writer's (10 s), retried while the holder is
   * busy (GC_BUSY_RETRIES, unlimited) within maxMs; it never throws for a busy lock. `maxMs` is a
   * total budget: once it has elapsed no batch and no further delete starts. It is checked
   * again after the pause between batches and once the lock is held, since either wait can
   * use it up. `onProgress` gets { removed, remaining } after
   * each batch. Returns { removed, remaining, busy, skipped }, `remaining` counting
   * candidates not yet looked at.
   */
  sweep(opts = {}) {
    const run = this._sweeper(opts); const pause = new Int32Array(new SharedArrayBuffer(4));
    for (let step = run.next(); ; step = run.next()) {
      if (step.done) return step.value;
      if (step.value.pause) { Atomics.wait(pause, 0, 0, step.value.pause); continue; }
      step.value.result = this._lockedBatch(step.value, opts);
    }
  }

  /** sweep for async callers (the viewer server): the event loop runs between batches (the pause is a timer) and while it waits. */
  async sweepAsync(opts = {}) {
    const run = this._sweeper(opts);
    for (let step = run.next(); ; step = run.next()) {
      if (step.done) return step.value;
      if (step.value.pause) { await new Promise((r) => setTimeout(r, step.value.pause)); continue; }
      try { step.value.result = { removed: await this.store.withLock(() => this._batch(step.value), { timeoutMs: opts.waitMs ?? LOCK_TIMEOUT_MS }) }; } catch (e) {
        if (e.code === 'ELOCKBUSY') step.value.result = { busy: true }; else throw e;
      }
    }
  }

  /** The removed ids, or null when the lock was busy before anything was swept (see sweep). */
  gc(opts = {}) { const r = this.sweep(opts); return r.skipped ? null : r.removed; }
  async gcAsync(opts = {}) { const r = await this.sweepAsync(opts); return r.skipped ? null : r.removed; }

  _lockedBatch(job, { waitMs }) {
    try { return { removed: this.store.withLockSync(() => this._batch(job), { timeoutMs: waitMs ?? LOCK_TIMEOUT_MS }) }; } catch (e) {
      if (e.code === 'ELOCKBUSY') return { busy: true };
      throw e;
    }
  }

  /** The sweep's plan, shared by sweep and sweepAsync: yields one batch job at a time; the driver runs it under the lock. */
  * _sweeper({ waitMs, maxMs, onProgress, batchMax = GC_BATCH_MAX, batchMs = GC_BATCH_MS, busyRetries = GC_BUSY_RETRIES } = {}) {
    const start = performance.now();   // monotonic: a wall clock that steps back (WSL2 under load) must not stretch the budget
    this.store.invalidate();
    const now = this.now();
    // Candidates are derived one thread at a time. The tolerant reader parses whitespace-only
    // files (CRLF, spaces) to zero events, so they derive as damage 'empty'; any read that
    // still throws must not abort the sweep: that id stays a candidate, and the locked batch
    // decides from a fresh raw read whether it is a stale empty file.
    const queue = [];
    for (const id of this.store.threadIds()) {
      let s; try { s = this.thread(id); } catch { queue.push(id); continue; }
      if (s && ((s.expiresAt && Date.parse(s.expiresAt) < now) || s.damage === 'empty')) queue.push(id);
    }
    const removed = []; let busy = false; let tries = 0; let first = true;
    const deadline = maxMs != null ? start + maxMs : Infinity;
    while (queue.length) {
      if (performance.now() >= deadline) { busy = tries > 0; break; }
      // the pause between batches is part of the budget: a writer that got in during it may
      // have held the lock well past the deadline, so look at the clock again after it
      if (!first) { yield { pause: GC_BATCH_GAP_MS }; if (performance.now() >= deadline) { busy = tries > 0; break; } }
      first = false;
      const job = { queue, batchMax, batchMs, deadline, result: null };
      yield job;
      if (job.result.busy) {
        // Another writer held the lock for a whole wait. A bounded caller stops at once; an
        // unbounded one waits again (a live holder heartbeats, so it is busy, not dead; on a
        // drvfs store with thousands of threads one post can hold it for over a minute),
        // within maxMs and busyRetries, then stops cleanly with what is left.
        if (waitMs != null || ++tries > busyRetries) { busy = true; break; }
        continue;
      }
      tries = 0;
      removed.push(...job.result.removed);
      onProgress?.({ removed: removed.length, remaining: queue.length });
    }
    return { removed, remaining: queue.length, busy, skipped: busy && !removed.length };
  }

  /**
   * One batch. Call only with the store lock held (taking it dropped the read cache). The
   * wait for the lock may have outlived the sweep's deadline: then nothing starts here.
   */
  _batch(job) {
    const t0 = performance.now(); const out = []; const until = Math.min(t0 + job.batchMs, job.deadline ?? Infinity);
    while (job.queue.length && out.length < job.batchMax && performance.now() < until) {
      const id = job.queue.shift();
      // An empty thread file has no activity to expire from. Sweep it only once a fresh raw
      // read (uncached) still finds nothing but whitespace, CRLF and spaces included, and its
      // mtime (wall clock, like the file system's) is EMPTY_THREAD_GRACE_MS old. An open
      // creates and writes its file under this lock, so the grace only covers a writer from
      // before gc took the lock.
      // The read itself can be slow (a big thread on drvfs), so the deadline is looked at
      // again right before the delete: past it, the candidate goes back on the queue unswept.
      const remove = () => { if (performance.now() >= until) { job.queue.unshift(id); return false; } this.store.deleteThread(id); out.push(id); return true; };
      const sweepIfEmpty = () => {
        const st = this.store.threadStat(id); const raw = st && this.store.threadText(id);
        if (st && raw != null && !raw.trim() && Date.now() - st.mtimeMs > EMPTY_THREAD_GRACE_MS) return remove();
        return true;
      };
      // re-read under the lock, just before deciding. A read that throws is swept only if the
      // file is a stale whitespace-only one; one with content is left for verify and never
      // throws out of the sweep.
      let s; try { s = this.thread(id); } catch { s = undefined; }
      let go = true;
      if (s === undefined) go = sweepIfEmpty();
      else if (!s) { /* gone already */ }
      else if (s.expiresAt && Date.parse(s.expiresAt) < this.now()) go = remove();
      else if (s.damage === 'empty') go = sweepIfEmpty();
      if (!go) break;
      this.store._beatIfDue();
    }
    return out;
  }
}

function eventInstance(event, project) {
  return event.instance || `${event.author}@${project}`;
}

// ---- rendering --------------------------------------------------------------

export function renderMarkdown(s, { forIssue = false, verified } = {}) {
  const lines = [];
  lines.push(`# ${s.id} · ${s.title}   [${s.status}]`);
  lines.push(`project: ${s.project} · opener: ${s.opener} · created: ${s.created} · posts: ${s.posts.length} · participants: ${s.participants.join(', ')}`);
  if (s.lockReason) lines.push(`locked: ${s.lockReason}`);
  if (s.cooldown?.active) lines.push(`frozen: ${s.cooldown.authors.join(' & ')} until a third party posts`);
  if (s.issueUrl) lines.push(`issue: ${s.issueUrl}`);
  if (s.damagedLines?.length) { const ns = s.damagedLines.filter((d) => d.line).map((d) => d.line); lines.push(`DAMAGED: ${ns.length ? `line${ns.length > 1 ? 's' : ''} ${ns.join(', ')} of the thread file` : 'part of this thread'} could not be read and ${ns.length > 1 ? 'are' : 'is'} skipped (run verify)`); }
  if (s.idle) lines.push(`idle since ${s.idleSince}; any post revives it`);
  if (!forIssue) lines.push(`expires: ${s.expiresAt}`);
  lines.push('');
  for (const p of s.posts) {
    const badge = verified ? (p.verified ? ' ✓' : ' ✗ UNVERIFIED') : '';
    const re = p.re ? ` · re ${p.re}` : '';
    const ms = p.mentions?.length ? ' · ' + p.mentions.map((m) => '@' + m).join(' ') : '';
    const wo = p.waitingOn?.length ? ` · ⏳ waiting on ${p.waitingOn.map((w) => `${w} (any instance in ${s.project})`).join(', ')}` : '';
    const inst = p.instance && p.instance !== `${p.author}@${s.project}` ? ` [${p.instance}]` : '';
    const src = p.idSource === 'self' ? ' · identity self-declared' : '';
    lines.push(`### ${p.id} · **${p.author}**${inst} · ${p.kind} · ${p.ts}${re}${ms}${wo}${src}${badge}`);
    lines.push(p.body.trim());
    lines.push('');
  }
  for (const c of s.waitClears || []) {
    const badge = verified ? (c.verified ? ' ✓' : ' ✗ UNVERIFIED') : '';
    lines.push(`- wait ${c.post}/${c.on} cleared by **${c.author}** at ${c.ts}: ${c.reason}${badge}`);
  }
  if (forIssue) lines.push(`_Escalated from the inter-agent-comms thread ${s.id}. The thread is closed; continue here._`);
  return lines.join('\n');
}
