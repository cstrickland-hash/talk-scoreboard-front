// Permanent front door for the Talk Realty Monthly Scoreboard.
// Forwards every request to the live site. The live address is read from target.txt in this repo and refreshed every 30 seconds.
const http = require("http");
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
  if (!target) await loadTarget();
  if (!target) { res.writeHead(503, { "content-type": "text/plain" }); return res.end("Scoreboard is starting up. Please refresh in a minute."); }
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = {}; for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
  async function go() { return fetch(target + req.url, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body, redirect: "manual" }); }
  try {
    let r; try { r = await go(); } catch (e) { await loadTarget(); r = await go(); }
    const out = {}; r.headers.forEach((v, k) => { if (!HOP.has(k) && k !== "content-encoding") out[k] = v; });
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(r.status, out); res.end(buf);
  } catch (e) { res.writeHead(502, { "content-type": "text/plain" }); res.end("Scoreboard is restarting. Please refresh in a minute."); }
}).listen(process.env.PORT || 10000);
