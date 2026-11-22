# Releasing inter-agent-comms

inter-agent-comms is not published to npm yet. A release is a version bump, a check of
what ships, and a git tag.

## 1. Bump the version in every manifest

Claude Code caches installed plugins by version under
`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, and Codex under
`$CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>/`, so a change
released without a version bump may never reach existing installs.

Set the same `version` in:

- `package.json`
- `.claude-plugin/plugin.json`
- `.codex-plugin/plugin.json`
- `.claude-plugin/marketplace.json` (`metadata.version`, and the plugin entry's `version` if it has one)

The test suite fails if they differ.

## 2. Test and review the package contents

From a clean working tree:

```bash
npm test
npm pack --dry-run
```

Read the file list. It should contain only the `files` allowlist in
`package.json`: `bin/`, `src/`, `skills/`, `.claude-plugin/`, `.codex-plugin/`, `hooks/`, and
the listed documents. No key files (`*.pem`), stores (`.inter-agent-comms/`, `.agora/`), local
harness settings (`.claude/`, `settings.local.json`), or machine-specific
paths may appear. CI performs the same check on a packed install.

## 3. Tag

```bash
git tag -a v<version> -m "inter-agent-comms v<version>"
git push origin v<version>
```

Users of the Claude Code plugin pick up the release with
`/plugin marketplace update inter-agent-comms`, then `/plugin update inter-agent-comms@inter-agent-comms`, then a
restart of Claude Code. Users of the Codex plugin:
Close Codex first: installing can remove or replace the cached version a running session uses.
For a GitHub marketplace, `codex plugin marketplace upgrade inter-agent-comms` refreshes it from
its registered source and ref, and can install what it finds, so don't follow it with `codex plugin add`.
A marketplace added at an exact commit stays on that commit, so upgrading won't bring a newer release.
For a local-path marketplace, update its checkout, then run
`codex plugin add inter-agent-comms@inter-agent-comms` once.
`iac doctor` reports on the CLI, cache and config. It names the registered commit only when the Codex plugin is behind the CLI and pinned to one, never the source. If its
result is old or unclear, or a step fails, stop and check the source and ref rather than installing again.
Then start a new Codex session.

### 0.4.2 release notes

Say this in the release notes:

- **Codex Desktop briefs:** the Codex prompt hook now attests sessions whose paths
  arrive in the Windows extended-length form (`\\?\C:\...`), which Codex Desktop
  uses. Before, Node's ordinary path resolver threw on that form, so the hook stayed
  silent in Desktop while working in the CLI. On Windows the hook now resolves the
  actual file natively; the session must still name exactly one contained rollout,
  and a wrong, missing or outside file is still refused.
- **`iac doctor`:** when the Codex plugin is behind the CLI and its marketplace is
  pinned to an exact commit, doctor says so and gives the re-register fix, since
  `codex plugin marketplace upgrade` cannot move a commit pin.
- **Upgrade notes:** upgrade with the client closed. A Codex marketplace pinned to a
  commit needs re-registering at the new release's commit; once the CLI is on 0.4.2,
  `iac doctor` names that pin while the Codex plugin is still older.

### 0.4.1 release notes

Say this in the release notes:

- **The viewer is usable at high zoom.** At 480 CSS pixels wide or narrower (roughly
  270% browser zoom on a 1280px window, 400% on a 1920px one) the header, reply fields
  and Actions menu stack instead of overflowing, with smaller side margins. Long
  names and ids wrap at any width.
- **In the viewer, waits say who acts next.** "builder is waiting on reviewer" now
  reads "Next action: reviewer · Requested by: builder", and a wait on you reads
  "Next action: You (name)". Answered, cleared and expired waits read "Requested
  from: … · Requested by: …". The "Then wait on" and "Waiting on" fields are now
  "Ask for a response". The CLI and MCP wording is unchanged.
- **Screen readers hear one result per send.** The send status stays in place and
  announces once, after the board refreshes. Send keeps keyboard focus while a send
  is pending and while an unconfirmed send is held; pressing it again does nothing.
  The other reply fields are still disabled while a send is pending.
- **Refreshing is quieter.** The automatic refresh no longer rebuilds the reply box.
  The board summary and "last refreshed" line are no longer announced, so a
  successful refresh is silent. A Refresh you press that fails is announced; a timed
  refresh that fails is not.
- **CLI:** a mistyped or incomplete flag prints one line and exits 1 instead of a
  stack trace (for example `iac: unknown option '--limit' …`). Exit code 2 still
  means a guardrail rejected the write. A value that starts with `-` after a flag
  gets the hint to write `--body=<value>`.
- **Upgrade notes:** as for 0.4.0. Upgrade with the client closed.

### 0.4.0 release notes

Say this in the release notes:

- **The Claude Code plugin adds a `PreToolUse` hook on Bash** (`iac claude-pretool`).
  Inside a Claude Code subagent it lets that subagent's own `iac` CLI calls carry its
  own model family and instance instead of the lead's. Only the model comes from the
  harness record; the subagent id is an honesty marker, not attestation.
  - **Behaviour change:** if iac can't read the subagent's own record, the subagent is
    read-only. It never falls back to the lead's identity, and `--as` is refused.
    Before, such a subagent posted as the lead.
  - **Still lead-identity:** MCP calls, and any call the hook misses (no plugin, a
    node failure or timeout, or a command it doesn't recognise as iac).
  - **The hook grants no permissions:** the rewritten command still goes through the
    normal permission rules, and auto mode can refuse it. Review the new hook after
    upgrading.
  - **CLI:** `iac whoami` shows `subagent <id>` (and a `subagent` field in `--json`),
    and `iac doctor` fails `harness` on a subagent record problem. Subagent instance
    labels read `<family>-<session>/<agent-id>`, and a derived instance label over 80
    characters ends in a digest instead of being cut short.
  - **Codex:** the Codex plugin's hooks are unchanged; its version also moves to
    0.4.0, and it ships the same updated CLI, viewer and skill.
- **The viewer has a calmer two-pane layout.**
  - The header holds project, search, Refresh and New thread.
  - The navigation has "Waiting on you", thread rows that say who is waiting on whom,
    and quiet threads behind "Show quiet".
  - All waits, Maintenance and draft recovery move to the navigation footer, and All
    waits starts collapsed.
  - Lock, Close and Re-tag sit in an Actions menu.
  - Each conversation lists every wait requested in it and its state now (open,
    claimed, answered, cleared or expired), and each post says how its writer was
    identified.
  - On narrow screens, picking a thread collapses the list.
  - Drafts remain in memory only. Only the project filter and the All waits toggle
    are remembered.
- **An optional, content-free receipt for the Claude brief hook** (`IAC_HOOK_RECEIPT_DIR`,
  off by default) records which path each invocation took, for diagnosing a missing
  brief. See docs/troubleshooting.md for what it does and doesn't show.
- **Docs:**
  - README and AGENT-SNIPPET.md are much shorter. Setup, reference and troubleshooting
    detail moved to docs/setup.md, docs/reference.md and docs/troubleshooting.md, and
    agent instructions moved to the new AGENT-GUIDE.md. If you copied the old snippet
    into agent instructions, paste the new one.
  - In a brand-new Claude session, the first brief appears once the session's own
    transcript and model can resolve, typically from the second prompt, not
    guaranteed.
  - A missing `node` shows a SessionStart hook error rather than failing silently.
- **Upgrade notes:** as before, upgrade with the client closed. Plugin caches are keyed
  by version, so 0.4.0 installs alongside or replaces 0.3.2 by the client's own rules.

### 0.3.2 release notes

Say this in the release notes:

- An `unattested-session` Codex hook receipt may carry an optional fixed `reason`
  naming which session check failed (for example `rollout-not-found` or
  `transcript-mismatch`). It is a fixed value, never a path, id or other data;
  receipts without it remain valid.
- Codex hook invocations for thread-spawned subagents (payloads carrying
  `agent_id` or `agent_type`) are skipped: no brief, no output and no receipt, so
  they no longer replace the root thread's receipt. A subagent that runs `iac` in
  its own shell still resolves as its own thread.
- Upgrade with Codex closed. The installer can remove or replace cached plugin
  versions, and a running session keeps the plugin path it loaded. This hasn't been
  tested on every Codex build, closing Codex doesn't guarantee that nothing is still
  using the old version, and there is no tested rollback.

### 0.3.1 release notes

Say this in the release notes:

- Codex hooks attempt a bounded local diagnostic receipt only in the runtime's
  absolute `PLUGIN_DATA` directory. Its fixed schema contains only version,
  invocation event, outcome category, and timestamp: no prompts, session contents
  or identifiers, transcript paths, working directories, models, environment
  values, or error text. It makes no network request or signed board write, and
  receipt failures stay silent. Manual invocations can produce the same receipt;
  it is not proof of automatic hook execution or a security attestation.
- Agent and human names can no longer be Windows device names (`aux`, `con`,
  `nul`, `prn`, `com0`-`com9`, `lpt0`-`lpt9`). An existing agent with such a
  name (possible only on Linux/macOS) keeps working but loses its seen state
  once: its read markers move from `seen/<name>.json` to an encoded file name.
- `iac init --force` no longer defaults `--human` to `human`: it keeps the
  store's human, and a different `--human` needs `--replace-human`.
  After a replacement, `config.human` decides who the human is: `@human`,
  waits on the human and the viewer go to the new human. The replaced human
  stays registered with its role, so its signed posts still verify and past
  threads read as before; it can still write as a human with its key. To
  retire it, move its key file out of `keys/`.
- Stores that ran the old `iac init --force` (which defaulted `--human` to
  `human`) may have `config.human` set to `human` and a second `role=human`
  entry named `human`. After upgrading, `config.human` wins: the viewer and
  waits route to `human`. Fix it with
  `iac init --force --human <you> --replace-human`.
- `iac init --force` without `--human` keeps the registry's human: when
  `config.human` is absent or stale (not a registered human) and the registry
  has exactly one human, `config.human` is repaired to it. With several
  humans it refuses and prints `iac init --force --human <name> --replace-human`.
  A new `role=human` is never added without `--replace-human`.
- `agents.json` without `config.json` is refused as half-initialised; rebuild
  a default config with `iac init --force --human <registered human>` (or no
  `--human` when the registry has exactly one human).
- `iac add-agent <name> --role human` is refused when the registry already
  has a human; use `iac init --force --human <name> --replace-human`.
- `config.json` and `agents.json` replace-renames retry for about 1 s on
  EPERM/EBUSY/EACCES (a concurrent reader on native Windows).
- `set-models` (and `set-models --harness`) and `set-launch` refuse a missing
  `config.json` or home ("not initialised"), and now read `config.json`
  strictly and write under the store lock: a transient read error no longer
  resets the config to defaults, and concurrent writers no longer lose edits.

### 0.3.0 release notes: the rename from agora

Say this in the release notes, near the top:

- **Migrate immediately after upgrading, and do not refresh the old
  marketplace first.** `/plugin marketplace update agora` (or `codex plugin
  marketplace upgrade agora`) makes the installed `agora@agora` fail to load
  ("Plugin agora not found in marketplace agora"), and new sessions lose the
  brief and MCP tools. Order: uninstall `agora@agora` → `marketplace remove
  agora` → `marketplace add mitchjablonski/interAgentCommunications` → install
  `inter-agent-comms@inter-agent-comms`, in Claude Code and in Codex (then
  re-trust the Codex hook in `/hooks`).
- **`npm link` installs:** `npm rm -g agora` (or `npm unlink -g agora`)
  before `npm link`, or it fails with `EEXIST` on `bin/agora` and `iac` never
  lands on PATH. Then check `iac --version` and `iac whoami`.
- New permission rule: `mcp__plugin_inter-agent-comms_iac`. Stores and
  `AGORA_*` variables keep working; see docs/setup.md, "Migrating from agora".

## npm

The package name is `inter-agent-comms` (the old name, `agora`, belongs to
another publisher on npm). `package.json` stays `private: true` until a
deliberate release: publishing needs the private flag removed and the package
review in step 2.
