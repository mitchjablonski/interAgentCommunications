import { KINDS } from './store.js';

const MIN = 60_000;
const HOUR = 3_600_000;

export class Rejected extends Error {
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.rejected = true;
  }
}

/** Pull @names out of a body. Returns lowercased, deduped, in order. */
export function parseMentions(body) {
  const out = [];
  const re = /(?:^|[^\w@])@([a-zA-Z][\w-]*)/g;
  let m;
  while ((m = re.exec(body || ''))) {
    const n = m[1].toLowerCase();
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * The human now: config.human when it is registered as a human, else the first registered
 * human (stores from before config.human was kept in step), else config.human.
 */
export function currentHuman(registry, config) {
  const want = config?.human;
  if (typeof want === 'string' && Object.hasOwn(registry, want) && registry[want].role === 'human') return want;
  return Object.keys(registry).find((k) => registry[k]?.role === 'human') || want;
}

/** Resolve mention aliases: `@human` maps to the current human (config.human). */
export function resolveMention(name, registry, config) {
  if (name === 'human') {
    const h = currentHuman(registry, config);
    if (h && registry[h]) return h;
  }
  if (registry[name]) return name;
  return null;
}

/** Detect two non-human authors strictly alternating over the last N posts.
 *  The freeze has no clock: it lifts only when someone else posts (which breaks the alternation). */
export function detectPingPong(posts, limits) {
  const w = limits.pingPongWindow;
  if (posts.length < w) return null;
  const tail = posts.slice(-w);
  const authors = [...new Set(tail.map((p) => p.author))];
  if (authors.length !== 2) return null;
  for (let i = 1; i < tail.length; i++) if (tail[i].author === tail[i - 1].author) return null;
  if (tail.some((p) => p.authorRole === 'human')) return null;
  return { authors, since: tail.at(-1).ts, active: true };
}

/** Replay a thread's events into a state object. Pure. */
export function deriveState(id, events, config, registry, now = Date.now()) {
  const L = config.limits;
  const s = {
    id, title: null, opener: null, created: null, project: 'unscoped', posts: [], participants: [],
    waitClears: [],
    locked: false, lockReason: null, autoLocked: false, closed: false, closedAt: null,
    issueUrl: null, lastActivity: null, expiresAt: null, cooldown: null, eventCount: events.length,
    idle: false, idleSince: null,
  };
  let sinceUnlock = 0;
  let opened = false;
  for (const [i, ev] of events.entries()) {
    try {
    const role = registry[ev.author]?.role || 'agent';
    switch (ev.type) {
      case 'open':
        // Only an open at event 0 names the thread and its opener. A later one (a splice, or
        // two opens from an id collision before ids were created exclusively) cannot take the thread over, and cannot
        // repair a thread whose event 0 is not an open either. verify flags both.
        if (i === 0) {
          opened = true;
          s.title = ev.title; s.opener = ev.author; s.created = ev.ts; if (ev.project) s.project = ev.project;
          s.openerInstance = ev.instance || `${ev.author}@${s.project}`;
        }
        s.posts.push({ ...ev, projectAtPost: s.project, authorRole: role }); sinceUnlock++; break;
      case 'post':
        s.posts.push({ ...ev, projectAtPost: s.project, authorRole: role }); sinceUnlock++;
        if (ev.issueUrl) s.issueUrl = ev.issueUrl; break;
      case 'lock': s.locked = true; s.lockReason = ev.reason || `locked by ${ev.author}`; s.autoLocked = false; break;
      case 'unlock': s.locked = false; s.lockReason = null; s.autoLocked = false; sinceUnlock = 0; break;
      case 'close': s.closed = true; s.closedAt = ev.ts; break;
      case 'project': s.project = ev.project; s.projectSetBy = ev.author; break;
      case 'wait-clear': {
        const source = s.posts.find((p) => p.id === ev.post && p.waitingOn?.includes(ev.on));
        const owns = role === 'human' || (source && ev.author === source.author && (!source.instance || ev.instance === source.instance));
        if (source && owns) s.waitClears.push({ ...ev, authorRole: role });
        break;
      }
    }
    // Repair audits do not answer waits, change guards, or reset idle/retention. Otherwise
    // the latest timestamp, not the last line: a wall clock stepped backwards (WSL2's time
    // sync does, by up to ~0.7 s) must not move a thread's activity, and so its expiry,
    // earlier. Identical for any history whose timestamps never go backwards.
    if (ev.type !== 'repair' && (s.lastActivity == null || !(Date.parse(ev.ts) < Date.parse(s.lastActivity)))) s.lastActivity = ev.ts;
    } catch { (s.damagedLines ||= []).push({ kind: 'replay-error' }); /* one bad event never takes the board down */ }
  }
  if (!s.closed && !s.locked && sinceUnlock >= L.threadPostCap) {
    s.locked = true; s.autoLocked = true;
    s.lockReason = `post cap of ${L.threadPostCap} reached. A human can unlock; anyone can escalate.`;
  }
  s.participants = [...new Set(s.posts.map((p) => p.author))];
  s.cooldown = s.closed ? null : detectPingPong(s.posts, L);
  const ttl = s.closed ? L.closedTtlHours : L.threadTtlHours;
  const base = s.closed ? s.closedAt : s.lastActivity;
  const expiry = base ? Date.parse(base) + ttl * HOUR : null;
  if (expiry === null) s.expiresAt = null;
  else if (Number.isFinite(expiry) && Math.abs(expiry) <= 8.64e15) s.expiresAt = new Date(expiry).toISOString();
  else { s.expiresAt = null; (s.damagedLines ||= []).push({ kind: 'replay-error', reason: 'expiry is not a representable date (bad timestamp or ttl)' }); }
  s.status = s.closed ? 'closed' : s.locked ? 'locked' : s.cooldown?.active ? 'cooldown' : 'open';
  // Structural damage, derived from the valid events: event 0 is not an open (no valid
  // events at all, or any other first event, whatever opens follow it). It is status
  // 'damaged' plus `damage`, and it refuses posts. Line-level damage (torn or malformed
  // lines) lives in `damagedLines`, never sets status and never refuses posts; the
  // caller, which sees the raw lines, turns 'empty' into 'missing-open' when the file had
  // lines that did not parse. verify reports missing-open; gc sweeps a stale empty file.
  if (!opened) {
    s.damage = events.length ? 'missing-open' : 'empty';
    s.status = 'damaged';
    s.title = events.length ? '(damaged: no open event)' : '(damaged: empty thread file)';
  }
  return s;
}

/**
 * Closed-idle, derived only from timestamps and the clock: a thread whose latest activity is
 * older than limits.threadIdleCloseDays and that owes nobody a reply (`hasWait` is the caller's
 * answer, since waits need signature checks) is shown as status 'idle' and leaves the
 * brief, the inbox and the open-thread allowance. Nothing is written and no event changes
 * meaning; any new post moves lastActivity and revives it. Only a plain 'open' thread idles:
 * locked, cooldown, damaged and closed threads keep their own status. Mutates and returns s.
 */
export function applyIdle(s, config, now, hasWait) {
  const d = Number(config.limits.threadIdleCloseDays);
  if (!(d > 0) || s.status !== 'open' || s.closed || !s.lastActivity) return s;
  const idleAt = Date.parse(s.lastActivity) + d * 24 * HOUR;
  if (!Number.isFinite(idleAt) || !(now > idleAt) || hasWait()) return s;
  s.idle = true; s.idleSince = new Date(idleAt).toISOString(); s.status = 'idle';
  // Idle is display and allowance only: expiresAt stays what the open-thread rule gave it
  // (lastActivity + threadTtlHours), so gc retention is independent of idling.
  return s;
}

/**
 * The board-wide guards take `allStates` either as the derived states or as a function that
 * returns them. A function is called only when a check that reads the whole board is reached,
 * so a post that is refused earlier, or that skips those checks (the human, a bypass), never
 * derives the board.
 */
function boardStates(allStates) { return typeof allStates === 'function' ? allStates() : allStates; }

function countRecent(posts, author, now, windowMs) {
  return posts.filter((p) => p.author === author && now - Date.parse(p.ts) < windowMs).length;
}

function eventInstance(post, project) { return post.instance || `${post.author}@${project}`; }
function countRecentInstance(posts, author, instance, project, now, windowMs) {
  return posts.filter((p) => p.author === author && eventInstance(p, project) === instance && now - Date.parse(p.ts) < windowMs).length;
}

/** Checks shared by open and post. Throws Rejected. */
function checkCommon({ author, role, kind, body, mentions, config, registry }) {
  const L = config.limits;
  if (!registry[author]) throw new Rejected('unknown-author', `'${author}' is not a registered agent`, 'run: iac add-agent <name>');
  if (!KINDS.includes(kind)) throw new Rejected('bad-kind', `kind must be one of: ${KINDS.join(', ')}`);
  if (!body || !body.trim()) throw new Rejected('empty-body', 'body is empty');
  if (kind === 'ack' && body.length > L.ackBodyMax) {
    throw new Rejected('too-long', `ack is ${body.length} chars; max ${L.ackBodyMax}`, 'an ack is a receipt, not a reply. Use kind=answer or status if you have content.');
  }
  if (mentions.length > L.mentionsMax) throw new Rejected('too-many-mentions', `${mentions.length} mentions; max ${L.mentionsMax}`, 'mention only who must act.');
  if (mentions.includes(author)) throw new Rejected('self-mention', 'you cannot mention yourself');
  for (const m of mentions) {
    if (!registry[m]) throw new Rejected('unknown-mention', `@${m} is not a registered agent`, `known: ${Object.keys(registry).join(', ')}`);
  }
  if (/```[\s\S]{800,}```/.test(body)) {
    throw new Rejected('paste-dump', 'code block over 800 chars', 'commit it, or write it to a file, and reference the path/sha instead.');
  }
}

/**
 * An idle thread does not count against its opener's open-thread allowance, so any event that
 * revives it (a post, a wait cleanup, lock/unlock, a project change: anything that moves
 * lastActivity) must not be a way past that allowance: the opener instance cannot revive its
 * own idle thread into more than openThreadsPerAgent live ones. Others' events and the human's
 * are not held to it; closing is never a revival and does not call this.
 */
export function checkRevive({ state, allStates, author, instance, role, config }) {
  const L = config.limits;
  if (!state.idle || role === 'human' || state.opener !== author || state.openerInstance !== instance) return;
  const mineOpen = boardStates(allStates).filter((s) => s.opener === author && s.openerInstance === instance && !s.closed && !s.idle).length;
  if (mineOpen >= L.openThreadsPerAgent) {
    throw new Rejected('open-cap', `reviving idle thread ${state.id} would give instance ${instance} ${mineOpen + 1} open threads (max ${L.openThreadsPerAgent})`, 'close one first: iac close <id> --body "<resolution>"');
  }
}

/** Guardrails for posting into an existing thread. Throws Rejected. */
export function checkPost({ state, allStates, author, instance, role, kind, body, mentions, re, now, config, registry, bypass = false }) {
  const L = config.limits;
  if (state.status === 'unreadable') throw new Rejected('unreadable', `thread ${state.id} could not be read (${state.damagedLines?.[0]?.reason || 'replay error'})`, `run: iac verify ${state.id}; posts are refused until the thread can be read.`);
  checkCommon({ author, role, kind, body, mentions, config, registry });
  if (state.closed) throw new Rejected('closed', `thread ${state.id} is closed`, 'open a new thread and reference this one if you have new information.');
  if (body.length > L.postBodyMax) throw new Rejected('too-long', `body is ${body.length} chars; max ${L.postBodyMax}`, 'link to a file, commit, or issue instead of pasting.');
  // ending your own idle thread reduces load, so a resolution is never held to the revival cap
  if (!bypass && kind !== 'resolution') checkRevive({ state, allStates, author, instance, role, config });
  if (re && !state.posts.some((p) => p.id === re)) throw new Rejected('bad-ref', `--re ${re} is not a post in this thread`);
  if (kind === 'objection') {
    if (!re) throw new Rejected('objection-needs-ref', 'an objection must reference the post it objects to (--re <post-id>)');
    const target = state.posts.find((p) => p.id === re);
    if (target.kind === 'objection') throw new Rejected('objection-to-objection', 'you cannot object to an objection', 'post a proposal with a concrete alternative, or escalate to @human.');
    const mine = state.posts.filter((p) => p.author === author && p.kind === 'objection').length;
    if (mine >= L.objectionsPerAgentPerThread) {
      throw new Rejected('objection-cap', `you already objected in this thread (max ${L.objectionsPerAgentPerThread})`, 'accept, propose an alternative, or escalate. Do not relitigate.');
    }
  }
  if (kind === 'resolution' && role !== 'human' && (author !== state.opener || instance !== state.openerInstance)) {
    throw new Rejected('not-opener', 'only the opener or a human can post a resolution', 'use kind=proposal or ask the opener to close.');
  }
  if (role === 'human' || bypass) return;

  if (state.locked) throw new Rejected('locked', `thread is locked: ${state.lockReason}`, 'ask @human to unlock, or: iac escalate ' + state.id);
  if (state.cooldown?.active && state.cooldown.authors.includes(author)) {
    throw new Rejected('cooldown', `ping-pong detected between ${state.cooldown.authors.join(' and ')}; both are frozen until a third agent or the human posts here`,
      'two agents alternating without progress is a doom loop. Escalate (iac escalate) or @mention a third party. Waiting does not lift this.');
  }
  const last = state.posts.at(-1);
  // an ack is a placeholder ("seen, working"), not a turn: one substantive follow-up is allowed after it
  if (last && last.author === author && eventInstance(last, state.project) === instance && last.kind !== 'ack' && now - Date.parse(last.ts) < L.consecutiveGraceMin * MIN) {
    throw new Rejected('double-post', 'you posted last in this thread', `wait for someone else to reply (or ${L.consecutiveGraceMin} min). Posts cannot be edited; say it once.`);
  }
  if (countRecentInstance(state.posts, author, instance, state.project, now, HOUR) >= L.perThreadPerHour) {
    throw new Rejected('thread-rate', `you have posted ${L.perThreadPerHour} times in this thread in the last hour`, 'fold your points into fewer posts, or escalate.');
  }
  if (state.posts.filter((p) => p.author === author && eventInstance(p, state.project) === instance).length >= L.perThreadLifetime) {
    throw new Rejected('thread-lifetime', `you have reached ${L.perThreadLifetime} posts in this thread`, 'this thread has run its course. Close it or escalate.');
  }
  const globalRecent = boardStates(allStates).reduce((n, s) => n + countRecent(s.posts, author, now, HOUR), 0);
  if (globalRecent >= L.familyGlobalPerHour) {
    throw new Rejected('global-rate', `the ${author} family has posted ${L.familyGlobalPerHour} times across all threads in the last hour`, 'go do the work; come back with results.');
  }
}

/** Guardrails for opening a thread. Throws Rejected. */
export function checkOpen({ allStates, author, instance, role, kind, title, body, mentions, waitingOn = [], project, now, config, registry }) {
  const L = config.limits;
  checkCommon({ author, role, kind, body, mentions, config, registry });
  if (!title || !title.trim()) throw new Rejected('empty-title', 'title is required');
  if (title.length > L.titleMax) throw new Rejected('too-long', `title is ${title.length} chars; max ${L.titleMax}`);
  if (body.length > L.openerBodyMax) throw new Rejected('too-long', `body is ${body.length} chars; max ${L.openerBodyMax}`, 'link to a file, commit, or issue instead of pasting.');
  if (['ack', 'objection', 'resolution', 'answer'].includes(kind)) {
    throw new Rejected('bad-opener-kind', `a thread cannot open with kind=${kind}`, 'open with question, proposal, status, or handoff.');
  }
  if (role === 'human') return;
  const states = boardStates(allStates);
  // One running status thread per agent per project. A status thread that nobody is
  // addressed in and nobody has answered is a log, not a conversation: the next entry
  // belongs in it, not in a new thread announced to everyone as "new". An idle one is hidden
  // from every list, so it must not block its replacement (reviving it later is still allowed).
  if (kind === 'status' && !mentions.length && !waitingOn.length) {
    const running = states.find((s) => !s.closed && !s.idle && s.project === project && s.opener === author &&
      s.posts[0]?.kind === 'status' && s.participants.length === 1 && s.participants[0] === author &&
      !s.posts.some((p) => p.mentions?.length || p.waitingOn?.length));
    if (running) {
      throw new Rejected('status-thread-exists',
        `you already have a running status thread in ${project}: ${running.id} (${running.title})`,
        `post your status to ${running.id} instead of opening another. A status thread that waits on someone (--waiting-on) or @mentions them is a different thing and is always allowed.`);
    }
  }
  // A model family may have several independent tasks, including several in
  // one repository. Each task owns its own small open-thread allowance.
  const mineOpen = states.filter((s) => s.opener === author && s.openerInstance === instance && !s.closed && !s.idle).length;
  if (mineOpen >= L.openThreadsPerAgent) {
    throw new Rejected('open-cap', `instance ${instance} has ${mineOpen} open threads (max ${L.openThreadsPerAgent})`, 'close one first: iac close <id> --body "<resolution>"');
  }
  const globalRecent = states.reduce((n, s) => n + countRecent(s.posts, author, now, HOUR), 0);
  if (globalRecent >= L.familyGlobalPerHour) {
    throw new Rejected('global-rate', `the ${author} family has posted ${L.familyGlobalPerHour} times across all threads in the last hour`, 'go do the work; come back with results.');
  }
}
