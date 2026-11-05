import fs from 'node:fs';
/**
 * Minimal MCP (stdio, newline-delimited JSON-RPC 2.0) exposing narrow inter-agent-comms tools.
 * Identity is read from the harness's own session record (or IAC_AGENT) on every call:
 * the model cannot choose it, and a `/model` switch mid-session is picked up immediately.
 * Zero dependencies.
 */
import { Agora, KINDS, Rejected, renderMarkdown, resolveInstance } from './api.js';
import { brief, compact, stalledNote } from './format.js';
import { detectProject } from './project.js';
import { codexPresent } from './codex-hook.js';
import { doctor, renderDoctor } from './doctor.js';

const VERSION = (() => { try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return '0.0.0'; } })();

const READ_ONLY = new Set(['iac_show', 'iac_list', 'iac_verify', 'iac_waiting', 'iac_doctor']);

/**
 * `ctx`: the server's own resolution (current() in startMcp), so iac_doctor can say when this
 * transport is read-only for Codex and its harness ids are not the caller's.
 */
export function buildTools(agora, me, session = null, ctx = null) {
  const str = (description) => ({ type: 'string', description });
  const T = {};
  const readOnly = !me;
  const here = () => detectProject();
  const inst = (project = here()) => resolveInstance({ agent: me, project, session });
  T.iac_brief = {
    description: 'One-line digest for this project: waits on your family here that no other instance has claimed, what is new here, waits for other instances as a count. Empty when nothing. Cheapest call; use first.',
    schema: { type: 'object', properties: { all_projects: { type: 'boolean' } } },
    run: ({ all_projects }) => { const p = here(); return brief(agora, me, { project: all_projects ? undefined : p, instance: inst(p) }) || '(nothing new)'; },
  };
  T.iac_inbox = {
    description: 'Unread items for you in this project: waits, mentions, replies. Compact; ≤200 chars per post. mark_read clears them. all_projects widens.',
    schema: { type: 'object', properties: { mark_read: { type: 'boolean' }, all_projects: { type: 'boolean' } } },
    run: ({ mark_read, all_projects }) => {
      const p = here(); const project = all_projects ? undefined : p; const my = inst(p);
      const waiting = agora.waitingBoard({ on: me }).filter((w) => (!project || w.project === project || w.project === 'global' || w.openerInstance === my) && (!w.claimedBy || w.claimedBy === my));
      const items = agora.inbox({ as: me, markRead: !!mark_read, project, instance: my, includeGlobal: true });
      const lines = waiting.map((w) => `⏳ ${w.from} waiting on ${me} in ${w.project} · ${w.thread}${w.claimedBy ? ' (you acked; finish it)' : ' (unclaimed: ack to claim)'}: ${w.body.split('\n')[0].slice(0, 160)}`);
      for (const it of items) for (const p of it.posts) lines.push(`${it.thread} ${p.id} ${p.author} ${p.kind}${p.re ? ` re ${p.re}` : ''}: ${p.body.replace(/\s+/g, ' ').slice(0, 200)}`);
      return lines.join('\n') || '(inbox empty)';
    },
  };
  T.iac_show = {
    description: 'Read a thread. Compact by default (160 chars/post). Pass post_id to read one post in full, or full=true for the whole thread.',
    schema: { type: 'object', properties: { thread: str('thread id, e.g. t-1a2b3c4d'), post_id: str('read this one post in full'), full: { type: 'boolean' } }, required: ['thread'] },
    run: ({ thread, post_id, full }) => {
      const s = agora.threadWithVerification(thread);
      if (!s) throw new Error(`no such thread: ${thread}`);
      if (post_id) { const p = s.posts.find((x) => x.id === post_id); if (!p) throw new Error(`no post ${post_id} in ${thread}`); return `${p.id} ${p.author} ${p.kind} ${p.ts}${p.verified ? '' : ' UNVERIFIED'}\n${p.body}`; }
      return full ? renderMarkdown(s, { verified: true }) : compact(s);
    },
  };
  T.iac_list = {
    description: 'Open threads, one line each.',
    schema: { type: 'object', properties: { all: { type: 'boolean', description: 'include closed' }, project: str('filter to one project id') } },
    run: ({ all, project }) => agora.threads({ includeClosed: !!all, project }).map((s) => `${s.id} [${s.status}] ${s.title} · ${s.project} · ${s.posts.length} posts · ${s.participants.join(',')}`).join('\n') || '(no threads)',
  };
  T.iac_waiting = {
    description: 'Who is waiting on whom (dependency board), one wait per line; stalled waits are marked. Needs no identity. all=true includes expired waits.',
    schema: { type: 'object', properties: { on: str('only waits on this agent family'), project: str('filter to one project id'), all: { type: 'boolean', description: 'include expired' } } },
    run: ({ on, project, all }) => {
      const b = agora.waitingBoard({ on, project, includeExpired: !!all });
      if (!b.length) return 'nobody is waiting on anybody';
      const stalled = b.filter((w) => w.stalled).length;
      const lines = stalled ? [`${stalled} stalled (unclaimed for over ${agora.config().limits.stallHours}h): start a session of that family in that project`] : [];
      for (const w of b) lines.push(`${w.from} → ${w.on} in ${w.project}${w.expired ? ' (expired)' : w.claimedBy ? ` (claimed by ${w.claimedBy})` : w.stalled ? ` (${stalledNote(w)})` : ' (unclaimed)'} · ${w.thread} wait ${w.post}/${w.on} (${w.title}) since ${w.since}: ${w.body.split('\n')[0].slice(0, 160)}`);
      return lines.join('\n');
    },
  };
  T.iac_post = {
    description: `Post to a thread as ${me}. kinds: ${KINDS.join('|')}. Guardrails may reject (rate, length, double-post, objection cap, freeze); the error says what to do instead. Never retry the same text. Local board only; nothing leaves the machine.`,
    schema: { type: 'object', properties: { thread: str('thread id'), kind: str('post kind'), body: str('≤1500 chars; link, do not paste'), re: str('post id this replies/objects to'), waiting_on: { type: 'array', items: { type: 'string' }, description: 'agents you are blocked on' } }, required: ['thread', 'body'] },
    run: async ({ thread, kind, body, re, waiting_on }) => { const r = await agora.post({ as: me, thread, kind: kind || 'answer', body, re, waitingOn: waiting_on || [] }); return `posted ${r.post} to ${r.thread}${r.closed ? ' (closed)' : ''}`; },
  };
  T.iac_open = {
    description: `Open a new thread as ${me}. One topic per thread. kinds: question|proposal|status|handoff. Local board only; nothing leaves the machine.`,
    schema: { type: 'object', properties: { title: str('≤80 chars'), kind: str('question|proposal|status|handoff'), body: str('≤3000 chars'), waiting_on: { type: 'array', items: { type: 'string' } }, project: str('project id; defaults to this server\'s IAC_PROJECT or its cwd git remote') }, required: ['title', 'body'] },
    run: async ({ title, kind, body, waiting_on, project }) => { const r = await agora.open({ as: me, title, kind: kind || 'proposal', body, waitingOn: waiting_on || [], project }); return `opened ${r.thread} (${r.post}) in project ${r.project}`; },
  };
  T.iac_ack = {
    description: 'Short receipt ("seen, on it"). Claims a wait on your family for this instance so other instances stop seeing it. Does not count as your turn and does not clear the wait. Local board only; nothing leaves the machine.',
    schema: { type: 'object', properties: { thread: str('thread id'), body: str('≤240 chars, default "ack"') }, required: ['thread'] },
    run: async ({ thread, body }) => { const r = await agora.post({ as: me, thread, kind: 'ack', body: body || 'ack' }); return `acked ${r.thread} (${r.post})`; },
  };
  T.iac_clear_wait = {
    description: 'Withdraw an outstanding wait you raised, without deleting its signed origin post. No other family can clear it; within-family task scoping depends on harness identity and is not a security boundary. Pass post_id/on when more than one owned wait is active in the thread. Local board only; nothing leaves the machine.',
    schema: { type: 'object', properties: { thread: str('thread id'), post_id: str('originating post id'), on: str('target agent family'), reason: str('short reason, ≤240 chars') }, required: ['thread'] },
    run: async ({ thread, post_id, on, reason }) => {
      const r = await agora.clearWait({ as: me, thread, post: post_id, on, reason: reason || 'No longer waiting.' });
      return r.already ? `wait ${r.post}/${r.on} was already clear` : `cleared wait ${r.post}/${r.on} in ${r.thread}`;
    },
  };
  T.iac_close = {
    description: 'Post a resolution and close the thread. Opener only. Always allowed. Local board only; nothing leaves the machine.',
    schema: { type: 'object', properties: { thread: str('thread id'), body: str('what was decided') }, required: ['thread', 'body'] },
    run: async ({ thread, body }) => { const r = await agora.close({ as: me, thread, body }); return `closed ${r.thread}`; },
  };
  T.iac_verify = {
    description: 'Verify signatures and hash chains (all threads, or one).',
    schema: { type: 'object', properties: { thread: str('thread id (optional)') } },
    run: ({ thread }) => {
      const fmt = (r) => `${r.id} ${r.ok ? 'ok' : 'PROBLEMS ' + r.problems.map((p) => p.kind === 'unparseable' || p.kind === 'malformed' ? `${p.kind}@${r.id}:line ${p.line}` : p.problem + '@' + p.id + (p.message ? ` (${p.message})` : '')).join(',')}`;
      if (thread) { const r = agora.verify(thread); if (!r) throw new Error(`no such thread: ${thread}`); return fmt(r); }
      return agora.verifyAll().map(fmt).join('\n');
    },
  };
  T.iac_doctor = {
    description: 'Read-only self-check of this installation: store, plugin versions, harness session record, model, family, env and hooks, one line each with a fix. Needs no identity; use it when identity looks wrong. Reports from this MCP server\'s own environment.',
    schema: { type: 'object', properties: {} },
    run: () => renderDoctor(doctor({ home: agora.store.home, why: agora.store.homeSource, env: agora.env, mcp: ctx?.codex ? { codex: true, reason: ctx.reason } : null })),
  };
  if (readOnly) for (const k of Object.keys(T)) if (!READ_ONLY.has(k)) delete T[k];
  return T;
}

/**
 * Identity is resolved on every request, not once at startup: the harness's session record
 * names the live model, and `/model` can change it mid-session. Codex resolution validates
 * the task's unique rollout and scans backwards with bounded memory and I/O. The tool table
 * is rebuilt per call rather than caching the model,
 * and it keeps the `${me}` in each description honest. No identity: read-only tools only.
 * Codex (a client that names itself codex*, or Codex ids without Claude ids): always read-only. The Codex ids in this server's env belong to
 * the Codex process that spawned it, not to the calling task; Codex writes go through the CLI.
 * A static IAC_AGENT in a shared host's MCP config is unsafe: two models on one host
 * would post under one name.
 */
export function startMcp({ home, agent } = {}) {
  const forced = (agent || '').toLowerCase();
  const agora = new Agora(home);
  if (forced && !agora.registry()[forced]) { process.stderr.write(`iac-mcp: '${forced}' is not registered in ${agora.store.home}\n`); process.exit(1); }
  const cliBase = `node "${agora.paths().cli}" --home "${agora.store.home}"`;
  const cliHint = `check the absolute-path CLI with ${cliBase} whoami --json; use CLI writes only if it attests your exact task and current model. Otherwise remain read-only.`;
  const codexHint = `Codex: write from your own shell with the CLI, whose environment is per-task: ${cliBase} whoami --json, and only if it attests your exact task and current model, ${cliBase} post <thread> --kind <kind> --body "..." (also open/ack/unwait/close; ${cliBase} brief and inbox for your own digest). Otherwise remain read-only.`;
  const claudeIds = () => !!(agora.env.CLAUDE_CODE_SESSION_ID || agora.env.CLAUDE_SESSION_ID);
  // The MCP client names itself at initialize (Codex: "codex-mcp-client"). A Codex client is
  // read-only whatever its env says, so neither inherited Claude ids nor a static IAC_AGENT
  // (with or without env_vars forwarding) can make a Codex transport writable.
  let clientName = '';
  const codexClient = () => /^codex/i.test(clientName);
  /** Resolve now. A refused conflict (stale binding) means read-only, with the reason said out loud. */
  const current = () => {
    // SESSION can be inherited from a parent: MCP has no caller task id in its requests.
    // Even a launcher override cannot give a known root-only Codex transport child ownership.
    if (agora.env.CODEX_SESSION_ID && !agora.env.CODEX_THREAD_ID) {
      return { agent: null, source: null, codex: true, reason: 'Codex MCP has root CODEX_SESSION_ID but no current CODEX_THREAD_ID; the caller task cannot be established', todo: codexHint };
    }
    // Codex MCP is read-only by design. Its CODEX_THREAD_ID/CODEX_SESSION_ID are
    // this server's own environment, forwarded by the Codex plugin's (or [mcp_servers.iac]) env_vars from the Codex
    // process that spawned it, not from the task making the call: a Codex started inside another
    // Codex shell would otherwise write as the outer task. No launcher binding or forced agent
    // lifts this (both are static config too). Lift it only once per-task MCP ids are proven.
    // A Codex client is read-only whatever its env. Otherwise both Claude and Codex ids present
    // is the existing ambiguous case, handled by identity().
    if (codexClient()) {
      return { agent: null, source: null, codex: true, reason: `Codex MCP is read-only by design: the MCP client identifies as Codex (${clientName}), and an MCP server cannot prove which Codex task is calling`, todo: codexHint };
    }
    if (codexPresent(agora.env) && !claudeIds()) {
      return { agent: null, source: null, codex: true, reason: "Codex MCP is read-only by design: its CODEX_THREAD_ID/CODEX_SESSION_ID come from the MCP server's own environment (forwarded from the Codex process), not from the calling task, so they cannot prove which task is writing", todo: codexHint };
    }
    if (forced) return { agent: forced, source: 'launcher', model: null };
    try { const id = agora.identity(); return id.agent ? id : { ...id, todo: id.switching || id.modelUnknown ? `${id.todo} ${cliHint}` : cliHint }; }
    catch (e) { return { agent: null, source: null, reason: `${e.code}: ${e.message}`, todo: cliHint }; }
  };
  const first = current();
  if (!first.agent) process.stderr.write(`iac-mcp: no identity (${first.reason}); starting read-only (list/show/verify/waiting).\n`);
  const instructionsFor = (id) => (id.codex
    ? `inter-agent-comms MCP is READ-ONLY for Codex by design: it cannot verify which Codex task is calling, so it never writes. Run ${cliBase} brief first from your shell; it is one line. ${id.todo} Do not choose an identity with --as, set a shared IAC_AGENT, or copy task ids. Available tools: list, show, verify, waiting, doctor. Reason: ${id.reason}. The board is a local file store under IAC_HOME; nothing leaves the machine.`
    : id.agent
    ? `The inter-agent-comms (iac) board is a local file store under IAC_HOME on this machine: posts are coordination between one user's own agents, the only network surface is an optional loopback viewer, and nothing leaves the machine. You are '${id.agent}' on this board — read from this session's own harness record, not chosen by you, and re-read on every call, so a model switch moves you to the matching identity. Call iac_brief first; it is one line. Read single posts, not whole threads. Say things once; if a post is rejected, follow the hint, do not retry.`
    : `inter-agent-comms MCP is READ-ONLY: no verified current-task identity. Check the absolute-path CLI with whoami --json; use CLI writes only if it attests your exact task and current model. Otherwise remain read-only. Do not choose an identity with --as, set a shared IAC_AGENT, or copy task ids. Available tools: list, show, verify, waiting, doctor. Reason: ${id.reason}. The board is a local file store under IAC_HOME; nothing leaves the machine. In a brand-new Claude Code session the record may not exist yet: call iac_list, then look up the tools again; the tool list refreshes if the session resolves. ${id.todo || cliHint}`);
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  // Clients cache tools/list. When the identity moves under them, say so: the descriptions
  // name the author. Enforcement does not depend on it — every call re-resolves.
  let announced = first.agent || '';
  const noteIdentity = (who) => {
    if ((who.agent || '') === announced) return;
    announced = who.agent || '';
    send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  };
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let req; try { req = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); continue; }
      const { id, method, params = {} } = req;
      agora.store.invalidate();   // long-lived reader: every request sees the board as it is now
      try {
        if (method === 'initialize') {
          const name = params.clientInfo?.name;
          // sticky once Codex: a later initialize cannot talk the transport back to writable
          if (typeof name === 'string' && !codexClient()) clientName = name.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 64);
          reply(id, { protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'inter-agent-comms', version: VERSION }, instructions: instructionsFor(current()) });
        }
        else if (method === 'ping') reply(id, {});
        else if (method === 'tools/list') {
          const who = current(); noteIdentity(who);
          reply(id, { tools: Object.entries(buildTools(agora, who.agent || '', who.source === 'harness' ? who.session : null, who)).map(([name, t]) => ({ name, description: t.description, inputSchema: t.schema })) });
        }
        else if (method === 'tools/call') {
          const who = current(); noteIdentity(who);
          const t = buildTools(agora, who.agent || '', who.source === 'harness' ? who.session : null, who)[params.name];
          if (!t) {
            const known = buildTools(agora, 'someone')[params.name];
            fail(id, -32602, !known ? `unknown tool ${params.name}`
              : who.codex ? `${params.name} is not available over Codex MCP, which is read-only by design (${who.reason}). ${who.todo}`
                : `${params.name} needs an identity, and this session has none (${who.reason}). ${who.todo || ''}`.trim());
            continue;
          }
          try { const text = await t.run(params.arguments || {}); reply(id, { content: [{ type: 'text', text }] }); }
          catch (e) { const text = (e instanceof Rejected || e?.rejected) ? `REJECTED (${e.code}): ${e.message}${e.hint ? `\nhint: ${e.hint}` : ''}` : `error: ${e.message}`; reply(id, { content: [{ type: 'text', text }], isError: true }); }
        }
        else if (method?.startsWith('notifications/')) { /* no response */ }
        else if (id !== undefined) fail(id, -32601, `method not found: ${method}`);
      } catch (e) { if (id !== undefined) fail(id, -32603, e.message); }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
