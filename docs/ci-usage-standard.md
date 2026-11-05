# Shared CI usage standard

This standard governs CI cost reductions across repositories. Each repository
defines its own test commands, supported OS/runtime matrix, required check
names, and reviewed path policy. A shared policy does not itself prove that a
workflow implements it. Keep existing source coverage, release checks, and
branch-protection names unless a reviewed repository-specific change says
otherwise.

## Coverage policy

- For pull requests, a draft fast lane is allowed only after successful,
  fail-closed classification. It may defer only the explicitly approved heavy
  suites for that repository; lightweight lint, type, build, dependency, and
  required platform checks remain. The stable result says **not ready** while
  anything is deferred. Ready PRs and each ready-head revision run full
  applicable coverage before merge.
- Do not start expensive ready-only work just because a PR was converted to
  draft. A fresh merge guard must check current draft status; the next head
  revision follows draft policy. A ready transition must qualify the current
  merge candidate and schedule the full gate. Base retargeting must reclassify
  the complete candidate diff. Verify workflow event coverage for edited,
  ready, retarget, and synchronize events; document gaps and follow-up instead
  of claiming unverified behavior.
- For pushes to the default/release branches, source changes and unknown
  changes receive full applicable coverage. A repository may separately allow
  a verified docs-only exception. That exception requires complete diff data,
  a reviewed prose allowlist, correct old/new paths for renames, and checks
  proving the exception cannot include source, tooling, workflow, dependency,
  generated, or packaging inputs. Any uncertainty means full coverage.
- On push, verify the exact `before..after` range, nonzero SHAs, and that the
  old commit is an ancestor of the new commit without forcing the update. On a
  PR, inspect the complete base-to-head candidate diff; do not require PR base
  to be an ancestor of the source head because legitimate branches diverge.
  Missing SHAs/history, failed/empty diff, failed classification, mixed or
  unknown paths, and unsafe renames resolve to full coverage. Reclassify on
  base retarget so the candidate uses the new base.
- Labels, titles, user inputs, and repository-specific exceptions never
  downgrade coverage unless that repo has an explicit reviewed policy and a
  tested implementation. Markdown is not inherently safe: only allowlisted
  prose paths qualify; nested docs can be build/test inputs.

## Required check behavior

- Preserve stable required-check names. An always-running aggregate passes
  only when every mandatory check succeeds or a specifically permitted
  deferral is proven. Failed, cancelled, missing, and unexpectedly skipped
  checks fail the aggregate. Classifier failure means full coverage. Do not
  hide a required workflow behind a workflow-level path filter.
- Cancel obsolete PR runs only within the same PR. Main/release validation is
  independent per commit; newer commits must not cancel another commit's only
  validation. Repository-specific release and platform checks remain intact.
  Setting `cancel-in-progress: false` alone does not protect pending runs:
  GitHub's default shared-group queue replaces an older pending run. Use unique
  non-PR run groups and workflow-qualified PR groups to preserve independent
  main validation while cancelling obsolete work within the same PR. See
  [GitHub's concurrency documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
- Cache only through existing package-manager/build-tool caches with OS and
  lockfile keys. Never cache secrets or trust mutable output as an input. A
  cold run must work; do not blindly purge caches.
- Build and diagnose in the existing local box first, then batch pushes. Retry
  only an appropriate failed job. A budget block records run/job evidence and
  does not cause retry loops, billing changes, or branch-protection changes.

## Measurement and local-runner hygiene

- Record runner execution by OS and job separately from monthly billing,
  rounding, and storage. Compare cost per accepted change and time-to-feedback;
  run count alone is not a cost measure. Report sample count, cache state,
  window, and limitations.
- Review artifact retention separately. Preserve release outputs and evidence
  needed for failure investigation. No bulk artifact, log, probe, or failure
  history cleanup as a cost shortcut.
- Ordinary local boxes are shared resources: record ACTIVE state, start/max
  limits, and the exact process marker for each owned probe. Confirm ownership
  before starting; respect exclusive coordination and reboot state. Stop only
  your own process after capturing its logs and copying required evidence.
  Preserve all logs, probes, files, and failure history; never sweep another
  owner's processes or files.
- A self-hosted runner requires separate approval and an ephemeral, isolated,
  secretless design. Shared administrator runners are prohibited.

## Acceptance fixtures

| Candidate | Required result |
| --- | --- |
| Draft ordinary code PR | Only repo-approved heavy suite deferred; stable result is not ready |
| Ready PR or new ready revision | Full applicable matrix and required checks |
| Draft conversion | No new ready-only expensive run; current merge guard honors draft state |
| Ready transition or base retarget | Requalify current candidate and reclassify against correct base |
| Verified allowlisted docs-only PR/push | Exact complete diff proves prose-only; explicit permitted deferral |
| Markdown outside allowlist, docs plus source, nested build input, mixed rename | Full applicable coverage |
| Workflow/tooling/dependency/script/generated/unknown path | Full applicable coverage |
| Missing SHAs/history, unsafe push range, diff/classifier failure or empty diff | Full applicable coverage; aggregate rejects skipped jobs |
| Consecutive main commits | Each commit gets independent full source coverage |

## Adoption records

Deployment-specific rollout evidence belongs in each deployment's private
tracker. This reusable standard does not assert adoption or approval for any
repository.

Before enabling any reduction, record owner, independent reviewer, exact head
SHA, workflow revision, required check names, and branch-protection mapping.
Attach fixture results for missing history, rename, failure, draft/ready
transition, retarget, and consecutive commits. Measure representative draft,
ready, docs-only, and main runs before/after, split by job and OS, with sample
count, cache state, raw run references, cost categories, feedback time, and
limitations. Keep full coverage available for rollback. Review outcomes over a
stated window and revert if checks are skipped unexpectedly or evidence does
not support the change. This standard authorizes no new frameworks, security
tools, dependencies, runtime-floor changes, or release-process changes.
