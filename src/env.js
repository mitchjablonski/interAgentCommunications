/**
 * Environment variables. The current names are IAC_*; the AGORA_* names from before the
 * rename (0.2.x) are still read as a fallback, so an existing setup or an older launcher
 * keeps working. When both are set and disagree, IAC_* wins and `iac whoami` says so.
 * An empty value counts as unset (tests and launchers clear a variable by emptying it).
 */
export const ENV_PREFIX = 'IAC_';
export const LEGACY_ENV_PREFIX = 'AGORA_';
export const ENV_NAMES = ['HOME', 'AGENT', 'PROJECT', 'INSTANCE', 'KEY'];

/** The value of IAC_<name>, else AGORA_<name>, else undefined. */
export function envVar(env, name) {
  const cur = env?.[ENV_PREFIX + name];
  if (cur) return cur;
  const old = env?.[LEGACY_ENV_PREFIX + name];
  return old || undefined;
}

/** Which spelling supplied <name>: 'IAC_<name>', 'AGORA_<name>', or null. */
export function envSource(env, name) {
  if (env?.[ENV_PREFIX + name]) return ENV_PREFIX + name;
  if (env?.[LEGACY_ENV_PREFIX + name]) return LEGACY_ENV_PREFIX + name;
  return null;
}

/** Variables set under both spellings with different values: [{ name, iac, agora }]. */
export function envConflicts(env) {
  const out = [];
  for (const n of ENV_NAMES) {
    const a = env?.[ENV_PREFIX + n]; const b = env?.[LEGACY_ENV_PREFIX + n];
    if (a && b && a !== b) out.push({ name: n, iac: a, agora: b });
  }
  return out;
}

/**
 * The deprecated `agora*` commands print one line on interactive use only: never when
 * stderr is not a terminal, never with --json, and never in hook or MCP modes, which must stay silent.
 */
export function deprecationNotice(oldName, newName, argv = [], stream = process.stderr) {
  if (!stream?.isTTY) return false;
  // --json output is for programs; a notice on stderr would only be noise to whatever parses it
  if (argv[0] === 'codex-hook' || argv[0] === 'mcp' || argv.some((a) => /^--(hook|json)(=|$)/.test(a))) return false;
  try { stream.write(`${oldName}: deprecated; use ${newName} (same commands, same store). This alias goes away after 0.3.x.\n`); } catch {}
  return true;
}
