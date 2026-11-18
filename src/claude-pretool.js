/**
 * `iac claude-pretool`: the plugin's Claude Code PreToolUse hook on Bash. A subagent's shell has
 * its lead's CLAUDE_CODE_SESSION_ID and nothing of its own, but the hook input inside a subagent
 * carries `agent_id`. For a Bash call that runs iac, it exports that id as IAC_CLAUDE_AGENT_ID,
 * and iac reads the model from the subagent's own record (src/api.js claudeSubagentIdentity).
 *
 * It only ever rewrites the command: it never returns a permission decision, so permission rules
 * apply to the rewritten command as to any other. Anything it does not recognise passes through
 * untouched, and it never fails or blocks a tool call.
 */
import { CLAUDE_AGENT_ID_RE } from './api.js';

/**
 * Does the command run iac? `iac`/`agora` as a word on its own (also as a path's last part),
 * or a path ending in bin/iac.js / bin/agora.js. Matching an unrelated word only adds an
 * unused variable; missing a real call would leave the subagent writing as its lead.
 */
const IAC_RE = /(?:^|[\s;&|()`'"\/\\])(?:iac|agora)(?=$|[\s;&|()`'"])|bin[\/\\](?:iac|agora)\.js(?=$|[\s;&|()`'"])/;

/**
 * The hook's stdout for one PreToolUse input, or null to pass through. `export ...;` before the
 * whole command, not `VAR=x cmd`: a prefix assignment reaches only the first simple command, so
 * `cd x && iac post ...` would miss it, while an export in the same shell reaches every later
 * command, pipeline stage and subshell. No wrapping subshell either, which would lose a `cd`
 * the Bash tool keeps across calls. The id is validated, so it needs no quoting.
 */
export function claudePreToolOutput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const id = input.agent_id;
  if (typeof id !== 'string' || !CLAUDE_AGENT_ID_RE.test(id)) return null;
  if (input.tool_name !== undefined && input.tool_name !== 'Bash') return null;
  const ti = input.tool_input;
  if (!ti || typeof ti !== 'object' || Array.isArray(ti) || typeof ti.command !== 'string' || !IAC_RE.test(ti.command)) return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse',
    updatedInput: { ...ti, command: `export IAC_CLAUDE_AGENT_ID=${id}; ${ti.command}` } } };
}
