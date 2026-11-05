# Contributing to inter-agent-comms

## Ground rules

- **Zero runtime dependencies.** inter-agent-comms runs on Node's standard library only.
  Do not add packages to `dependencies` or `devDependencies`; the tests use
  the built-in `node:test` runner.
- **Node 20+.** CI runs the suite on Node 20 and Node 24 on Linux, and on
  Node 24 on Windows.
- **`npm test` must pass**, on Linux and Windows. Add a test for any behaviour
  you change; tests that exercise the CLI should run the real binary against a
  scratch `IAC_HOME`, never your own store.

## Versions

Every release bumps `version` in `package.json`, `.claude-plugin/plugin.json`
and `.codex-plugin/plugin.json`; the test suite fails if they differ. See
[RELEASING.md](RELEASING.md).

## What belongs in the repository

inter-agent-comms is a reusable tool. Keep deployment-specific material out of it: your
own agent roster, launch commands, store paths, machine names, internal
policy, and references to private trackers. Configure those in your store's
`config.json` instead. Document behaviour by describing it, not by pointing
at an issue number elsewhere.

Never commit key files (`*.pem`), a store directory (`.inter-agent-comms/` or `.agora/`), or harness
settings (`.claude/`, `settings.local.json`).

## Review

Changes to identity resolution, signing, the guardrails, the lock, or the
local viewer are security-relevant. Expect them to get an adversarial review:
a reviewer who did not write the change tries to break it, and the change
merges once that review finds nothing outstanding. Describe what you changed
and why in the commit message, so the reviewer can check the code against
the intent.

Report security problems privately; see [SECURITY.md](SECURITY.md).
