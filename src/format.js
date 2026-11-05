/** Token-lean renderings. */
/** Line-level damage (`damagedLines`) or structural damage (`status: 'damaged'`). Posting stays allowed for the former. */
export const isDamaged = (s) => !!s && (s.damagedLines?.length > 0 || s.status === 'damaged');
const one = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

const projectsOf = (ws) => [...new Set(ws.map((w) => w.project))].join(', ');
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

/** "stalled 19h — no opus session has picked this up in o/r; start one there". */
export function stalledNote(w) {
  if (w.project === 'global') return `stalled ${Math.floor(w.ageHours)}h — no ${w.on} session has picked this up; start one in any project`;
  return `stalled ${Math.floor(w.ageHours)}h — no ${w.on} session has picked this up in ${w.project}; start one there`;
}

/** Stalled waits grouped as "opus in o/r ×2, sol in x/y, +2 more" for the human's count. */
export function stalledSummary(ws, max = 3) {
  const groups = new Map();
  for (const w of ws) { const k = w.project === 'global' ? `${w.on} in any project` : `${w.on} in ${w.project}`; groups.set(k, (groups.get(k) || 0) + 1); }
  const all = [...groups].map(([k, n]) => n > 1 ? `${k} ×${n}` : k);
  return all.slice(0, max).join(', ') + (all.length > max ? `, +${all.length - max} more` : '');
}

/**
 * Waits on `me` outside the current project scope, as count phrases. A wait this instance
 * already claimed (acked) is its own work, so it is never described as another instance's.
 */
export function elsewhereParts(me, elsewhere, instance) {
  const own = instance ? elsewhere.filter((w) => w.claimedBy === instance) : [];
  const others = elsewhere.filter((w) => !own.includes(w));
  const parts = [];
  if (own.length) parts.push(`${plural(own.length, 'wait')} you acked in other projects (${projectsOf(own)})`);
  if (others.length) parts.push(`${plural(others.length, 'wait')} for other ${me} instances (${projectsOf(others)}), not yours`);
  return parts;
}

/**
 * One line, or empty string when there is nothing. Meant for hooks.
 * Scoped to `project` when given: waits in this project in full, waits elsewhere as a count,
 * new posts from this project only. Without `project`, everything.
 */
export function brief(agora, me, { project, instance } = {}) {
  const allWaiting = agora.waitingBoard({ on: me });
  // a wait already claimed by a different instance of my family is not mine
  const mine = allWaiting.filter((w) => !w.claimedBy || !instance || w.claimedBy === instance);
  const inScope = (w) => !project || w.project === project || w.project === 'global' || (!!instance && w.openerInstance === instance);
  const claimedElsewhere = allWaiting.filter((w) => !mine.includes(w) && inScope(w)).length;
  const here = mine.filter(inScope);
  const elsewhere = project ? mine.filter((w) => !inScope(w)) : [];
  const items = agora.inbox({ as: me, project, instance, includeGlobal: true });
  // Stalled waits are the human's to act on: only the human can start a session. Agents'
  // briefs never pay for the unscoped board scan.
  const stalled = agora.roleOf(me) === 'human' ? agora.waitingBoard().filter((w) => w.stalled) : [];
  // read passes above already parsed every thread; this reuses what they found (no extra reads)
  const damaged = agora.store.damagedThreads().length;
  if (!here.length && !elsewhere.length && !items.length && !claimedElsewhere && !stalled.length && !damaged) return '';
  const parts = [];
  if (here.length) parts.push(`waiting on ${me} for this task: ` + here.map((w) => `${w.from} ${w.thread}${project && w.project !== project ? ` [${w.project}]` : ''}${w.claimedBy ? ' (you acked)' : ''}${isDamaged(w) ? ' (damaged thread)' : ''}`).join(', '));
  const fresh = items.filter((it) => !here.some((w) => w.thread === it.thread));
  if (fresh.length) parts.push('new: ' + fresh.map((it) => `${it.thread} (${[...new Set(it.posts.map((p) => p.author + ' ' + p.kind))].join(', ')}${isDamaged(it) ? '; damaged thread' : ''})`).join(', '));
  parts.push(...elsewhereParts(me, elsewhere, instance));
  if (claimedElsewhere) parts.push(`${claimedElsewhere} claimed by another ${me} instance`);
  if (stalled.length) parts.push(`${plural(stalled.length, 'stalled wait')} nobody has picked up (${stalledSummary(stalled)}): start a session there`);
  if (damaged) parts.push(`${plural(damaged, 'thread')} damaged: iac verify`);
  return `iac[${me}${instance && instance !== `${me}@${project}` ? '#' + instance : ''}${project ? ' @ ' + project : ''}]: ${parts.join(' · ')} · iac show <id> --compact`;
}

/** Compact thread: header + one line per post. */
export function compact(s, chars = 160) {
  const head = `${s.id} [${s.status}] ${s.title} · ${s.project} · by ${s.opener} · ${s.posts.length} posts · ${s.participants.join(',')}` +
    (s.lockReason ? ` · LOCKED: ${s.lockReason}` : '') + (s.idle ? ` · idle since ${s.idleSince}; any post revives it` : '') + (s.cooldown?.active ? ` · FROZEN: ${s.cooldown.authors.join('&')}` : '') + (s.issueUrl ? ` · ${s.issueUrl}` : '') +
    (isDamaged(s) ? ` · DAMAGED${s.damagedLines?.some((d) => d.line) ? `: unreadable line ${s.damagedLines.filter((d) => d.line).map((d) => d.line).join(',')}` : ''}` : '');
  const posts = s.posts.map((p) => `${p.id} ${p.author}${p.instance && p.instance !== `${p.author}@${s.project}` ? `[${p.instance}]` : ''} ${p.kind}${p.re ? ` re ${p.re}` : ''}${p.waitingOn?.length ? ` ⏳${p.waitingOn.join(',')}` : ''}${p.idSource === 'self' ? ' self-id' : ''}${p.verified === false ? ' UNVERIFIED' : ''} (${p.body.length}c): ${one(p.body, chars)}`);
  const clears = (s.waitClears || []).map((c) => `${c.id} ${c.author} cleared wait ${c.post}/${c.on}: ${one(c.reason, chars)}`);
  return [head, ...posts, ...clears].join('\n');
}
