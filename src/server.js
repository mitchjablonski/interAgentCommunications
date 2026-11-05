import http from 'node:http';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rejected } from './api.js';

const HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), 'viewer.html');

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

/** Read-mostly viewer. Writes are made as the registered human. Binds to localhost only. */
/**
 * A page on any website can send a request to 127.0.0.1, and DNS rebinding can
 * make a hostile origin look local. Writes here are signed with the human's
 * key, so an unguarded endpoint lets any site the human visits post as them.
 * Three checks, all cheap: the Host header must name a loopback authority (so
 * a rebound hostname is refused), any Origin/Referer must be the same origin
 * (browsers always send Origin on cross-origin writes), and writes must carry
 * a nonce minted at server start and handed only to the page we served.
 */
const LOOPBACK_HOST = /^(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/i;

function guard(req, nonce) {
  if (!LOOPBACK_HOST.test(req.headers.host || '')) return 'bad Host header (possible DNS rebinding)';
  const origin = req.headers.origin;
  if (origin) {
    let h; try { h = new URL(origin).host; } catch { return 'unparseable Origin'; }
    if (!LOOPBACK_HOST.test(h)) return `cross-origin request from ${origin}`;
  }
  if (req.method !== 'GET' && (req.headers['x-iac-nonce'] || '') !== nonce) return 'missing or stale x-iac-nonce';
  return null;
}

export function serve(agora, port) {
  const nonce = randomBytes(16).toString('hex');
  const startedAt = new Date().toISOString();
  let version = '0.1.0'; try { version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch {}
  const srv = http.createServer(async (req, res) => {
    agora.store.invalidate();   // long-lived reader: each request sees the board as it is now
    const human = agora.humanName();   // per request: an init --replace-human takes effect without a restart
    const url = new URL(req.url, 'http://x');
    try {
      const denied = guard(req, nonce);
      if (denied) {
        res.writeHead(403, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
        return res.end(`iac viewer refused this request: ${denied}\n`);
      }
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(fs.readFileSync(HTML, 'utf8').replace('__IAC_NONCE__', nonce));
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const threads = agora.store.threadIds().map((id) => agora.threadWithVerification(id)).filter(Boolean)
          .sort((a, b) => Date.parse(b.lastActivity) - Date.parse(a.lastActivity));
        return json(res, 200, { human, registry: Object.fromEntries(Object.entries(agora.registry()).map(([k, v]) => [k, { role: v.role }])),
          limits: agora.config().limits, threads, waiting: agora.waitingBoard(), now: agora.ts(), server: { version, startedAt, home: agora.store.home } });
      }
      if (req.method === 'POST' && url.pathname === '/api/open') {
        const b = await body(req);
        return json(res, 200, await agora.open({ as: human, title: b.title, kind: b.kind || 'question', body: b.body, waitingOn: b.waitingOn || [], project: b.project || 'global' }));
      }
      if (req.method === 'POST' && url.pathname === '/api/post') {
        const b = await body(req);
        return json(res, 200, await agora.post({ as: human, thread: b.thread, kind: b.kind || 'answer', body: b.body, re: b.re || undefined, waitingOn: b.waitingOn || [] }));
      }
      if (req.method === 'POST' && url.pathname === '/api/action') {
        const b = await body(req);
        if (b.action === 'lock') return json(res, 200, await agora.lock({ as: human, thread: b.thread, reason: b.reason }));
        if (b.action === 'unlock') return json(res, 200, await agora.unlock({ as: human, thread: b.thread, reason: b.reason }));
        if (b.action === 'close') return json(res, 200, await agora.close({ as: human, thread: b.thread, body: b.body }));
        if (b.action === 'unwait') return json(res, 200, await agora.clearWait({ as: human, thread: b.thread, post: b.post, on: b.on, reason: b.reason || 'Cleared by human.' }));
        if (b.action === 'gc') return json(res, 200, { removed: await agora.gcAsync() });
        if (b.action === 'set-project') return json(res, 200, await agora.setProject({ as: human, thread: b.thread, project: b.project }));
        return json(res, 400, { error: 'unknown action' });
      }
      res.writeHead(404); res.end('not found');
    } catch (e) {
      if (e instanceof Rejected || e?.rejected) return json(res, 422, { rejected: true, code: e.code, message: e.message, hint: e.hint });
      json(res, 500, { error: e.message });
    }
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => {
    console.log(`inter-agent-comms viewer: http://127.0.0.1:${port}  (posting as '${agora.humanName()}'; store ${agora.store.home})`);
    resolve(srv);
  }));
}
