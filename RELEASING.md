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
`iac doctor` reports on the CLI, cache and config, not on which source or commit is registered. If its
result is old or unclear, or a step fails, stop and check the source and ref rather than installing again.
Then start a new Codex session.

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
  `AGORA_*` variables keep working; see README, "Migrating from agora".

## npm

The package name is `inter-agent-comms` (the old name, `agora`, belongs to
another publisher on npm). `package.json` stays `private: true` until a
deliberate release: publishing needs the private flag removed and the package
review in step 2.
