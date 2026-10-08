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
function viaRelay(req, body) {
  return new Promise((resolve, reject) => {
    const id = String(++seq) + "-" + crypto.randomBytes(4).toString("hex");
    const t = setTimeout(() => { inflight.delete(id); reject(new Error("relay timeout")); }, 30000);
    inflight.set(id, { resolve: (r) => { clearTimeout(t); inflight.delete(id); resolve(r); } });
    const headers = {}; for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
    dispatch({ id, method: req.method, url: req.url, headers, body: body ? body.toString("base64") : "" });
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
http.createServer(async (req, res) => {
  if (req.url === "/healthz") { res.writeHead(200); return res.end("ok"); }
  if (req.url.startsWith("/__relay/")) {
    if (!okKey(req.headers["x-relay-key"])) { res.writeHead(403); return res.end(); }
    agentSeen = Date.now();
    if (req.url.startsWith("/__relay/poll")) {
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
    res.writeHead(404); return res.end();
  }
  const relayLive = Date.now() - agentSeen < 45000;
  if (!relayLive && !target) await loadTarget();
  if (!relayLive && !target) { res.writeHead(503, { "content-type": "text/plain" }); return res.end("Scoreboard is starting up. Please refresh in a minute."); }
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  if (relayLive) {
    try {
      const m = await viaRelay(req, body);
      const out = {}; for (const [k, v] of Object.entries(m.headers || {})) if (!HOP.has(k) && k !== "content-encoding") out[k] = v;
      res.writeHead(m.status || 502, out); return res.end(Buffer.from(m.body || "", "base64"));
    } catch (e) { if (!target) { res.writeHead(502, { "content-type": "text/plain" }); return res.end("Scoreboard is restarting. Please refresh in a minute."); } }
  }
  const headers = {}; for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
  async function go() { return fetch(target + req.url, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body, redirect: "manual" }); }
  try {
    let r; try { r = await go(); } catch (e) { await loadTarget(); r = await go(); }
    const out = {}; r.headers.forEach((v, k) => { if (!HOP.has(k) && k !== "content-encoding") out[k] = v; });
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(r.status, out); res.end(buf);
  } catch (e) { res.writeHead(502, { "content-type": "text/plain" }); res.end("Scoreboard is restarting. Please refresh in a minute."); }
}).listen(process.env.PORT || 10000);
