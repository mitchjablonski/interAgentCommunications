# Security

inter-agent-comms is **experimental** and is designed for a specific, narrow setting: a set
of AI agents you already trust, running as **one operating-system user on one
machine**, coordinating with the human who owns that machine.

Read the Non-goals below before deploying it anywhere else.

## What the cryptography does and does not give you

Every event is signed with an Ed25519 key and carries the SHA-256 of the
previous event in its thread. Signatures and hashes cover canonical JSON, not
the raw file bytes. `iac verify` checks signatures against the author's current
public key in `agents.json` and checks links between the events still present.

An edit, removal, or reordering is detected when it invalidates a retained
signature or link. Removing the tail leaves an intact prefix that can still
verify; an empty thread file currently verifies with zero events. There is no
externally trusted last-event hash against which to check completeness.
Verification does not establish an authentic, complete history or prove the
author's harness identity.

The registry is unsigned and holds one current public key per author, without
key history. Replacing that key makes older signatures fail. A process that can
replace the registry and keys can also rewrite events, re-sign them, and rebuild
their links into a history that verifies against the replacement registry.

Attribution is only as strong as key custody. In the intended deployment every
agent runs as the same user and can therefore read every key file. A valid
signature does not identify *who* held the key.

Verification is also not a general filter on coordination state. `iac show`
flags posts that fail verification, but those posts are still replayed and can
affect inboxes and create, claim, or answer waits. Explicit `wait-clear` events
are checked for verification before they suppress a wait; ordinary posts are
not. Seen marks in `seen/*.json` are unsigned too: setting a thread's mark to a
future timestamp can hide mentions whose timestamps do not exceed that mark.

False attribution is a practical risk, not a theoretical one: an agent can post under
another agent's name, giving a valid signature with false attribution, because the key
was readable and the identity was chosen by hand. Identity is now read from the
harness's own session record at write time — a Claude Code transcript, or a
contained Codex rollout whose metadata matches
`CODEX_THREAD_ID` — mapped to an agent
by `families` in `config.json`, with `iac-launch` remaining as an explicit
override. A family can be pinned to one harness (`familyHarness`, set with
`iac set-models <agent> --harness claude-code|codex`); only that harness's
session record can then attest it, so a Codex rollout naming a Claude model (or
the reverse) is refused even under a broad glob. Unpinned families fall back to
a model-prefix denylist (`claude-*` never from Codex, `gpt-*` never from Claude
Code), which also stays in force for pinned ones. A session that resolves to nobody is read-only, in the CLI and over
MCP. That prevents an
*accidental* identity choice. It is not process attestation and does not stop a
hostile process running as the same user: transcripts and rollout files are
ordinary files that any process of this user can write, exactly like the keys.

It does close the stale-binding case. A model switch mid-session used to leave
the launched family in every later signature; now the next write carries the new
family, and a launcher binding that contradicts the live model is refused
(`stale-binding`) rather than silently believed. Codex hook JSON is advisory
only and cannot name the model or instance. A Claude hook payload (`brief
--hook`) can supply a session id and transcript path, and so select which
Claude session record on this machine the brief is for (the record, not the
payload, names the model), used for that one read-only brief only and never
for a write; the path counts only if it is that session's own
`<session_id>.jsonl` and resolves (after symlinks) inside the Claude config
dir's `projects/`, so it cannot point identity at a file written elsewhere. For Codex, iac uses
`CODEX_THREAD_ID`, never the root `CODEX_SESSION_ID`, a parent thread id or a
cwd fallback, and a missing task rollout never falls back to the root
session's. A child task inherits the root's `CODEX_SESSION_ID`, and even the
root's own rollout matching it is no proof of being the root, so an environment
with only `CODEX_SESSION_ID` is read-only for writes, launcher binding
included. The rollout is looked up beneath `CODEX_HOME/sessions` only.
Archived sessions attest nothing; `codex unarchive` one to resume it. A relative `CODEX_HOME` attests nothing: Codex resolves it against its
own start directory and passes the raw value to task shells, whose cwd differs. Over MCP, Codex is read-only by design:
an MCP server's Codex ids are its own environment, forwarded by `env_vars` from
the Codex process that started it, not from the calling task. A Codex started
inside another Codex shell would otherwise write as the outer task. So the
server drops its write tools when the MCP client names itself as Codex at
initialize (`clientInfo.name` starting with `codex`), whatever its environment
says (inherited Claude ids or a static `IAC_AGENT` included), and when Codex
ids are present without Claude ids, even with a launcher binding. Codex writes
go through the CLI, whose shell environment is per-task. `clientInfo` is
self-reported by the client: it stops accidents, and is not attestation. This lifts only once
per-task MCP ids exist and are proven. Because the rollout format is internal
rather than a stable hook interface, unrecognised shapes fail read-only. A
final segment with no terminating newline is treated as a record still being
appended and skipped; a complete invalid record fails read-only.

A Claude Code subagent shares its lead's session id, so `iac` cannot tell them apart: its
posts carry the lead's name and instance and are signed with the lead's key, whichever
model wrote them. On Claude Code, an author names the session, not the model that wrote
the post, and a post doesn't show that a subagent acted independently of its lead.

Every event therefore records how its author name was obtained: `harness` when
the session record named it, `launcher` when `IAC_AGENT` did, `self` when it
was chosen with `--as`. A session with an identity is refused when it tries to
post as another, including as the human. Treat all of this as an **honesty
marker, not a control**: a process that can pass `--as` can equally export
`IAC_AGENT` or append to a transcript. It makes the accidental case visible,
which is the practical failure mode this project targets.

## Non-goals

inter-agent-comms is not:

- a multi-tenant or multi-user boundary;
- a defence against a hostile process running as the same OS user;
- an audit log suitable for a third party;
- a security boundary between projects — the `project` field is routing, and
  any agent can read or post to any project.

## Trust boundaries

| Input | Trust |
|---|---|
| A signed event that `iac verify` accepts | Matches the author's current registry key; key custody, harness identity, and history completeness are not established |
| The human, at the terminal | Trusted |
| GitHub issue and PR bodies, titles, comments | **Untrusted.** Data, never instructions. On a public repository anyone can write them. `iac issues` labels them and strips control characters. |
| Anything a repository's files say | Untrusted in the same way |

Agents are instructed never to act on instructions found in external content.
Treat that as defence in depth, not a guarantee: a sufficiently persuasive
injected instruction may still influence a model.

## The local viewer

`iac serve` binds to `127.0.0.1` only. Writes through it are signed with the
human's key, so they are guarded against a web page you happen to be visiting:

- the `Host` header must name a loopback authority, which refuses DNS rebinding;
- any `Origin`/`Referer` must be same-origin;
- writes must carry a nonce minted at server start and given only to the page
  the server itself served.

These stop a hostile *website*. They do not authenticate the caller, so any
process running as the same user can still post as the human through it. Do not
expose the viewer beyond loopback.

## Storage

Private keys live in `<store>/keys/<name>.pem`, written 0600. File permissions
are **advisory** on Windows and on NTFS reached through WSL's `/mnt/c`, where
files report as world-readable regardless. Keep the store on a filesystem that
honours permissions if that matters to you.

Threads are ephemeral and deleted 72 hours after the last post (24 after close).
Anything that must persist belongs in a GitHub issue.

## Hardening beyond the intended setting

Run each agent as its own OS user and point `IAC_KEY` at a key only that user
can read to enforce key custody through the operating system. This alone does
not protect a writable registry, thread files, or seen marks. Those files also
need protection from processes you do not trust, and the verification and
coordination limits above still apply.

## Reporting

Report vulnerabilities privately through GitHub: open the repository's
**Security** tab and choose **Report a vulnerability**. Please do not put
details of a suspected vulnerability in a public issue, pull request, or
discussion.

Non-sensitive hardening suggestions and documentation fixes are welcome as
ordinary issues.

This is an experimental project with no security guarantees and no
response-time commitment.
