// Permanent front door for the Talk Realty Monthly Scoreboard.
// Forwards every request to the live site. The live address is read from target.txt in this repo and refreshed every 30 seconds.
const http = require("http");
const crypto = require("crypto");
// Relay mode: the box connects OUT to this server (long-poll over HTTPS) and answers requests itself,
// so no inbound tunnel is needed. Used whenever a relay agent has checked in during the last 45 s;
// otherwise falls back to the tunnel in target.txt. Only the SHA-256 of the agent key lives here.
const RELAY_HASH = "0d255e9c9ba45c37967f83bbf7bb23d0a1e29283ce0109284a35b78c06093646";
const queue = [], waiters = [], inflight = new Map();
let agentSeen = 0, seq = 0;
const okKey = (k) => typeof k === "string" && crypto.createHash("sha256").update(k).digest("hex") === RELAY_HASH;
function dispatch(item) {
  while (waiters.length) { const w = waiters.shift(); clearTimeout(w.t); if (!w.res.destroyed) { w.res.writeHead(200, { "content-type": "application/json" }); w.res.end(JSON.stringify(item)); return; } }
  queue.push(item);
}
// Oct 17 2026: a relay agent counts as live for 35 s after its last poll (polls last 25 s). Requests that sat in the queue
// past their deadline are dropped instead of being replayed when the box wakes up. A GET that has a saved copy waits at most
// 8 s for the box before the saved copy is served, so a sleeping box never shows a blank page.
const RELAY_WINDOW = 35000;
function viaRelay(req, body, ms) {
  return new Promise((resolve, reject) => {
    const id = String(++seq) + "-" + crypto.randomBytes(4).toString("hex");
    ms = ms || 30000;
    const t = setTimeout(() => { inflight.delete(id); reject(new Error("relay timeout")); }, ms);
    inflight.set(id, { resolve: (r) => { clearTimeout(t); inflight.delete(id); resolve(r); } });
    const headers = {}; for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
    dispatch({ id, exp: Date.now() + ms, method: req.method, url: req.url, headers, body: body ? body.toString("base64") : "" });
  });
}
const TARGET_FILE = process.env.TARGET_FILE_URL || "https://raw.githubusercontent.com/cstrickland-hash/talk-scoreboard-front/main/target.txt";
let target = "";
async function loadTarget() {
  try {
    const r = await fetch(TARGET_FILE + "?t=" + Date.now(), { cache: "no-store" });
    if (r.ok) { const t = (await r.text()).trim(); if (/^https:\/\/[a-z0-9.-]+$/.test(t)) target = t; }
  } catch (e) { }
}
loadTarget(); setInterval(loadTarget, 30000);
const HOP = new Set(["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "content-length", "accept-encoding"]);

// ---- Offline mode (Oct 12 2026): keeps the site + swipe page up when the box is unreachable. ----
// Every 200 GET answered through the relay is cached in memory (key = path + query minus t/v cache-busters);
// the box also pushes a full snapshot every 5 min (/__relay/cache). When no relay agent has checked in,
// GETs are served from this cache and swipe approvals/edits are queued here until the box drains them
// (/__relay/queue). Only an exact cached URL is served, so token-gated pages stay gated by the same token.
const CACHE = new Map(); let cacheBytes = 0; const CACHE_MAX = 150 * 1024 * 1024;
const PENDING = []; let adminHash = "";
const sha = (x) => crypto.createHash("sha256").update(String(x)).digest("hex");
function ckey(u) { try { const x = new URL(u, "http://h"); x.searchParams.delete("t"); x.searchParams.delete("v"); x.searchParams.sort(); return x.pathname + (x.search || ""); } catch (e) { return u; } }
function cput(u, m) {
  const k = ckey(u), b = Buffer.from(m.body || "", "base64"); if (b.length > 8 * 1024 * 1024) return;
  const old = CACHE.get(k); if (old) cacheBytes -= old.b.length;
  const h = {}; for (const [a, v] of Object.entries(m.headers || {})) if (!HOP.has(a) && a !== "content-encoding") h[a] = v;
  CACHE.set(k, { h, b, at: Date.now() }); cacheBytes += b.length;
  while (cacheBytes > CACHE_MAX && CACHE.size) { const [fk, fv] = CACHE.entries().next().value; CACHE.delete(fk); cacheBytes -= fv.b.length; }
}
function tokenOf(u) { try { return new URL(u, "http://h").searchParams.get("k") || ""; } catch (e) { return ""; } }
function patchSwipe(u, fn) { // update every cached /api/swipe list for this token
  for (const [k, v] of CACHE) if (k.startsWith("/api/swipe?") || k === "/api/swipe") {
    try { const j = JSON.parse(v.b.toString()); fn(j); j.count = (j.cards || []).length; const nb = Buffer.from(JSON.stringify(j)); cacheBytes += nb.length - v.b.length; v.b = nb; } catch (e) { }
  }
}
function offline(req, res, body) {
  const u = new URL(req.url, "http://h");
  if (req.method === "POST" && (u.pathname === "/api/swipe/answer" || u.pathname === "/api/swipe/edit")) {
    if (!adminHash || sha(tokenOf(req.url)) !== adminHash) { res.writeHead(403, { "content-type": "application/json" }); return res.end('{"error":"Admin link required"}'); }
    let j; try { j = JSON.parse((body || "").toString()); } catch (e) { j = null; }
    if (!j || typeof j.id !== "string" || PENDING.length >= 1000) { res.writeHead(400, { "content-type": "application/json" }); return res.end('{"error":"Bad request"}'); }
    PENDING.push({ path: u.pathname, url: req.url, body: (body || "").toString(), at: new Date().toISOString() });
    let card = null;
    if (u.pathname === "/api/swipe/answer") patchSwipe(req.url, (s) => { s.cards = (s.cards || []).filter((c) => c.id !== j.id); });
    else patchSwipe(req.url, (s) => { for (const c of s.cards || []) if (c.id === j.id) { if (typeof j.text === "string") { c.draft_text = j.text; c.edited = true; } card = c; } });
    res.writeHead(200, { "content-type": "application/json", "x-served-from": "offline-queue" });
    return res.end(JSON.stringify({ ok: true, queued: true, duplicate: false, answer: j.answer, card }));
  }
  if (req.method === "GET" || req.method === "HEAD") {
    let k = ckey(req.url); if (k === "/") k = "/index.html";
    const c = CACHE.get(k) || CACHE.get(ckey(req.url.replace(/^\/(\?|$)/, "/index.html$1")));
    if (c) { res.writeHead(200, Object.assign({}, c.h, { "x-served-from": "offline-cache", "x-cached-at": new Date(c.at).toISOString(), "cache-control": "no-store" })); return res.end(req.method === "HEAD" ? undefined : c.b); }
  }
  res.writeHead(503, { "content-type": "text/plain" }); return res.end("The office computer is offline right now. This page has no saved copy yet. Please try again shortly.");
}
http.createServer(async (req, res) => {
  if (req.url === "/healthz") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ ok: true, relay: Date.now() - agentSeen < RELAY_WINDOW, cached: CACHE.size, queued: PENDING.length })); }
  if (req.url.startsWith("/__relay/")) {
    if (!okKey(req.headers["x-relay-key"])) { res.writeHead(403); return res.end(); }
    agentSeen = Date.now();
    if (req.url.startsWith("/__relay/poll")) {
      while (queue.length && queue[0].exp && queue[0].exp < Date.now()) queue.shift();
      if (queue.length) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(queue.shift())); }
      const w = { res, t: setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); if (!res.destroyed) { res.writeHead(204); res.end(); } }, 25000) };
      waiters.push(w); req.on("close", () => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); clearTimeout(w.t); } });
      return;
    }
    if (req.url.startsWith("/__relay/resp")) {
      const cs = []; for await (const c of req) cs.push(c);
      try { const m = JSON.parse(Buffer.concat(cs).toString()); const f = inflight.get(m.id); if (f) f.resolve(m); } catch (e) { }
      res.writeHead(204); return res.end();
    }
    if (req.url.startsWith("/__relay/cache")) { // box snapshot push: {items:[{url,status,headers,body}], admin_hash}
      const cs = []; for await (const c of req) cs.push(c);
      try { const m = JSON.parse(Buffer.concat(cs).toString()); if (m.admin_hash) adminHash = m.admin_hash; for (const it of m.items || []) if (it.status === 200) cput(it.url, it); } catch (e) { }
      res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ cached: CACHE.size, bytes: cacheBytes }));
    }
    if (req.url.startsWith("/__relay/queue")) { // box drains offline approvals
      const out = PENDING.splice(0, PENDING.length);
      res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ items: out }));
    }
    if (req.url.startsWith("/__relay/requeue")) { const cs = []; for await (const c of req) cs.push(c); try { PENDING.unshift(...JSON.parse(Buffer.concat(cs).toString()).items); } catch (e) { } res.writeHead(204); return res.end(); }
    res.writeHead(404); return res.end();
  }
  const relayLive = Date.now() - agentSeen < RELAY_WINDOW;
  if (!relayLive && !target) await loadTarget();
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  if (!relayLive && !target) return offline(req, res, body);
  if (relayLive) {
    try {
      const hasCopy = (req.method === "GET" || req.method === "HEAD") && CACHE.has(ckey(req.url));
      const m = await viaRelay(req, body, hasCopy ? 8000 : 30000);
      const out = {}; for (const [k, v] of Object.entries(m.headers || {})) if (!HOP.has(k) && k !== "content-encoding") out[k] = v;
      if (req.method === "GET" && m.status === 200) cput(req.url, m);
      if (m.status >= 500 && m.status !== 501) return offline(req, res, body); // box server restarting: use the saved copy
      res.writeHead(m.status || 502, out); return res.end(Buffer.from(m.body || "", "base64"));
    } catch (e) { if (!target) return offline(req, res, body);
      if (false) { res.writeHead(502, { "content-type": "text/plain" }); return res.end("Scoreboard is restarting. Please refresh in a minute."); } }
  }
  const headers = {}; for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
  async function go() { return fetch(target + req.url, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body, redirect: "manual" }); }
  try {
    let r; try { r = await go(); } catch (e) { await loadTarget(); r = await go(); }
    const out = {}; r.headers.forEach((v, k) => { if (!HOP.has(k) && k !== "content-encoding") out[k] = v; });
    const buf = Buffer.from(await r.arrayBuffer());
    if (r.status >= 500) return offline(req, res, body);
    res.writeHead(r.status, out); res.end(buf);
  } catch (e) { return offline(req, res, body); }
}).listen(process.env.PORT || 10000);
