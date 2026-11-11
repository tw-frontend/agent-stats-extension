// service/main.ts
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
var PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT || 0);
var TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN || "";
var OC_URL = (process.env.OPENCHAMBER_OPENCODE_URL || "").replace(/\/+$/, "");
var DATA_DIR = process.env.OPENCHAMBER_SERVICE_DATA_DIR || path.join(os.homedir(), ".agent-stats-extension");
var STATE_FILE = path.join(DATA_DIR, "state.json");
if (!TOKEN || !OC_URL || !PORT) {
  console.error("agent-stats: OpenChamber service environment is missing (OPENCHAMBER_SERVICE_TOKEN, OPENCHAMBER_OPENCODE_URL, OPENCHAMBER_SERVICE_PORT)");
  process.exit(1);
}
var DAY = 86400000;
var SLICE_MS = 2500;
var FETCH_TIMEOUT_MS = 1e4;
var SESSION_PAGE = 500;
var MESSAGE_PAGE = 200;
var MESSAGE_PAGE_FLOOR = 25;
var MAX_MESSAGE_PAGES = 1000;
var MAX_SESSIONS = 20000;
var ROUTING_SUFFIX = /[-:](nitro|floor|free|batch)$/;
function canonicalModel(id) {
  return id.replace(ROUTING_SUFFIX, ":$1");
}
var DISPLAY_NAMES = [
  ["claude-opus-4-6", "Claude Opus 4.6"],
  ["claude-sonnet-4", "Claude Sonnet 4.5"],
  ["claude-opus-4-5", "Claude Opus 4.5"],
  ["gpt-5.2", "GPT 5.2"],
  ["gpt-5.1-codex", "GPT 5.1 Codex"],
  ["gpt-5.1", "GPT 5.1"],
  ["gpt-5", "GPT 5"],
  ["gemini-3-pro", "Gemini 3 Pro"],
  ["gemini-3-flash", "Gemini 3 Flash"],
  ["gemini-2.5-pro", "Gemini 2.5 Pro"],
  ["glm-5.3", "GLM 5.3"],
  ["kimi-k2-thinking", "Kimi K2 Thinking"],
  ["muse-spark-1.1", "Muse Spark 1.1"],
  ["muse-spark-1.2", "Muse Spark 1.2"],
  ["muse-spark-1.2-contributor", "Muse Spark 1.2 (contributor)"],
  ["muse-ember", "Muse Ember"],
  ["nex-n2.5-pro", "Nex-N2.5 Pro"],
  ["nex-n2.5-mini", "Nex-N2.5 Mini"],
  ["nex-n2.6", "Nex-N2.6"]
];
var DEFAULT_EFFORT = [
  [/^claude[-_]/, "high"],
  [/^(gpt-5|o[134])/, "medium"],
  [/^gemini-3/, "high"],
  [/^glm/, "max"],
  [/^deepseek/, "max"],
  [/^nex-n2\.5/, "medium"]
];
function defaultEffort(base) {
  const id = (base.split("/").pop() || base).toLowerCase();
  for (const [re, eff] of DEFAULT_EFFORT) {
    if (re.test(id))
      return eff;
  }
  return "";
}
function displayName(provider, base) {
  const bare = base.split("/").pop() || base;
  const routing = ROUTING_SUFFIX.exec(bare);
  const suffix = routing ? `:${routing[1]}` : "";
  const stem = routing ? bare.slice(0, routing.index) : bare;
  const full = provider ? `${provider}/${base}` : base;
  for (const [id, name] of DISPLAY_NAMES) {
    if (stem === id || full === id || bare === id)
      return name + suffix;
  }
  return bare;
}
function isValidRec(r) {
  return Array.isArray(r) && r.length === 8;
}
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (raw && raw.v === 3 && raw.sessions && typeof raw.sessions === "object") {
      const sessions = {};
      let dropped = 0;
      for (const [id, val] of Object.entries(raw.sessions)) {
        const v = val;
        if (v && typeof v.u === "number" && Array.isArray(v.r) && v.r.every(isValidRec)) {
          sessions[id] = { u: v.u, r: v.r };
        } else {
          dropped++;
        }
      }
      return {
        v: 3,
        complete: !!raw.complete && dropped === 0,
        incomplete: !!raw.incomplete || dropped > 0,
        savedAt: Number(raw.savedAt) || 0,
        sessions
      };
    }
  } catch {}
  return { v: 3, complete: false, incomplete: false, savedAt: 0, sessions: {} };
}
var state = loadState();
function saveState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    console.error("agent-stats: could not persist state", err);
  }
}
function num(v) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
function str(v) {
  return typeof v === "string" ? v : "";
}
function msgTime(m) {
  const t = m?.time?.created ?? m?.time;
  if (typeof t === "number" && Number.isFinite(t))
    return t;
  const parsed = Date.parse(str(t));
  return Number.isFinite(parsed) ? parsed : 0;
}
async function fetchJson(p) {
  const res = await fetch(OC_URL + p, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!res.ok) {
    const err = new Error(`OpenCode ${res.status} on ${p.split("?")[0]}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}
function pageOf(body) {
  if (Array.isArray(body))
    return { items: body, next: null };
  const items = body?.data ?? body?.items;
  const next = body?.cursor?.next ?? body?.nextCursor ?? null;
  return {
    items: Array.isArray(items) ? items : [],
    next: typeof next === "string" && next ? next : null
  };
}
function newScan() {
  return {
    id: Math.random().toString(36).slice(2) + Date.now().toString(36),
    listCursor: null,
    listDone: false,
    listCapped: false,
    queue: [],
    seen: new Set,
    scanned: 0,
    msgOverflow: false
  };
}
var scan = null;
var lastFinishedScanId = null;
var chain = Promise.resolve();
var pending = new Map;
async function collectSession(sid, updated, deadline) {
  const prev = pending.get(sid);
  const st = prev && prev.u === updated ? prev : { u: updated, raw: [], cursor: null, limit: MESSAGE_PAGE, pages: 0 };
  pending.set(sid, st);
  let overflow = false;
  let gaveUp = false;
  while (true) {
    if (st.raw.length || st.cursor) {
      if (Date.now() >= deadline)
        return { status: "partial", overflow };
    }
    let body;
    try {
      const q = new URLSearchParams({ limit: String(st.limit) });
      if (st.cursor)
        q.set("cursor", st.cursor);
      body = await fetchJson(`/api/session/${encodeURIComponent(sid)}/message?${q}`);
    } catch (err) {
      if (err.status === 404) {
        pending.delete(sid);
        delete state.sessions[sid];
        return { status: "done", overflow: false };
      }
      if (Date.now() >= deadline) {
        return { status: "partial", overflow };
      }
      if (st.limit > MESSAGE_PAGE_FLOOR) {
        st.limit = Math.max(MESSAGE_PAGE_FLOOR, Math.floor(st.limit / 2));
        continue;
      }
      if (!st.cursor && st.pages === 0) {
        try {
          body = await fetchJson(`/api/session/${encodeURIComponent(sid)}/message`);
        } catch {
          gaveUp = true;
        }
      } else {
        gaveUp = true;
      }
      if (gaveUp) {
        overflow = true;
        break;
      }
    }
    const { items, next } = pageOf(body);
    st.raw.push(...items);
    st.pages++;
    if (next) {
      st.cursor = next;
      if (st.pages >= MAX_MESSAGE_PAGES) {
        overflow = true;
        break;
      }
    } else {
      st.cursor = null;
      break;
    }
  }
  pending.delete(sid);
  st.raw.sort((a, b) => msgTime(a) - msgTime(b));
  const recs = [];
  for (const m of st.raw) {
    const type = m?.type ?? m?.role;
    if (type === "assistant") {
      const model = canonicalModel(str(m?.model?.id) || str(m?.modelID) || "unknown");
      const variant = str(m?.model?.variant);
      const provider = str(m?.model?.providerID) || str(m?.providerID);
      const tk = m?.tokens;
      const tokens = tk ? num(tk.input) + num(tk.output) + num(tk.reasoning) + num(tk.cache?.read) + num(tk.cache?.write) : 0;
      recs.push([msgTime(m), 1, str(m?.agent) || "unknown", provider, model, num(m?.cost), tokens, variant]);
    } else if (type === "user") {
      recs.push([msgTime(m), 0, "", "", "", 0, 0, ""]);
    }
  }
  const nextStep = new Array(recs.length).fill(null);
  let nxt = null;
  for (let i = recs.length - 1;i >= 0; i--) {
    if (recs[i][1] === 1)
      nxt = recs[i];
    nextStep[i] = nxt;
  }
  let last = null;
  for (let i = 0;i < recs.length; i++) {
    const r = recs[i];
    if (r[1] === 1) {
      last = r;
      continue;
    }
    const src = nextStep[i] ?? last;
    if (src) {
      r[2] = src[2];
      r[3] = src[3];
      r[4] = src[4];
      r[7] = src[7];
    } else {
      r[2] = "unanswered";
      r[3] = "";
      r[4] = "";
      r[7] = "";
    }
  }
  state.sessions[sid] = { u: updated, r: recs };
  return { status: "done", overflow };
}
async function scanSlice(s) {
  const deadline = Date.now() + SLICE_MS;
  while (!s.listDone && Date.now() < deadline) {
    const q = new URLSearchParams({ limit: String(SESSION_PAGE) });
    if (s.listCursor)
      q.set("cursor", s.listCursor);
    const { items, next } = pageOf(await fetchJson(`/api/session?${q}`));
    for (const sess of items) {
      const id = str(sess?.id);
      if (!id)
        continue;
      s.seen.add(id);
      const u = num(sess?.time?.updated) || num(sess?.time?.created) || 0;
      const prev = state.sessions[id];
      if (!prev || prev.u !== u)
        s.queue.push({ id, u });
    }
    if (s.seen.size >= MAX_SESSIONS) {
      s.listCapped = true;
      s.listDone = true;
      break;
    }
    if (next)
      s.listCursor = next;
    else
      s.listDone = true;
  }
  while (s.queue.length && Date.now() < deadline) {
    const b = s.queue.shift();
    try {
      const r = await collectSession(b.id, b.u, deadline);
      if (r.status === "partial")
        s.queue.unshift(b);
      else
        s.scanned++;
      if (r.overflow)
        s.msgOverflow = true;
    } catch (err) {
      s.queue.unshift(b);
      throw err;
    }
  }
}
var HOUR = 3600000;
function localMidnight(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
var persianFmt = (() => {
  try {
    const f = new Intl.DateTimeFormat("en-u-ca-persian", { year: "numeric", month: "numeric", day: "numeric" });
    return f.resolvedOptions().calendar === "persian" ? f : null;
  } catch {
    return null;
  }
})();
function periodCutoff(period, now) {
  const midnight = localMidnight(now);
  if (period === "today")
    return midnight;
  if (period === "shamsi") {
    const day = persianFmt ? Number(persianFmt.formatToParts(new Date(now)).find((p) => p.type === "day")?.value) : NaN;
    const d = new Date(midnight);
    d.setDate(d.getDate() - ((day >= 1 && day <= 31 ? day : 30) - 1));
    return d.getTime();
  }
  if (period === "7d")
    return midnight - 6 * DAY;
  if (period === "30d")
    return midnight - 29 * DAY;
  return 0;
}
function bucketKey(t, granularity) {
  if (granularity === "day")
    return localMidnight(t);
  const d = new Date(t);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}
function buildSeries(cutoff, now, granularity) {
  const buckets = [];
  const index = new Map;
  const push = (t) => {
    if (t < cutoff || t > now || buckets.length >= 500)
      return;
    index.set(t, buckets.length);
    buckets.push({ startMs: t, prompts: 0, steps: 0, cost: 0, tokens: 0 });
  };
  if (granularity === "hour") {
    for (let day = new Date(cutoff);day.getTime() <= now; day.setDate(day.getDate() + 1)) {
      for (let h = 0;h < 24; h++) {
        const b = new Date(day);
        b.setHours(h, 0, 0, 0);
        push(b.getTime());
      }
    }
  } else {
    for (let d = new Date(cutoff);d.getTime() <= now; d.setDate(d.getDate() + 1))
      push(d.getTime());
  }
  for (const ss of Object.values(state.sessions)) {
    for (const r of ss.r) {
      if (!r[0] || r[0] < cutoff || r[0] > now)
        continue;
      const bi = index.get(bucketKey(r[0], granularity));
      if (bi === undefined)
        continue;
      const b = buckets[bi];
      if (r[1] === 0)
        b.prompts++;
      else {
        b.steps++;
        b.cost += r[5];
        b.tokens += r[6];
      }
    }
  }
  for (const b of buckets)
    b.cost = Math.round(b.cost * 1e6) / 1e6;
  return buckets;
}
function aggregate(period) {
  const now = Date.now();
  const cutoff = periodCutoff(period, now);
  const granularity = cutoff > 0 && now - cutoff <= 48 * HOUR ? "hour" : "day";
  const series = cutoff > 0 ? buildSeries(cutoff, now, granularity) : [];
  const agents = new Map;
  const pairs = new Map;
  const totals = { cost: 0, prompts: 0, steps: 0, tokens: 0, sessions: 0 };
  const bump = (map, key, r) => {
    let a = map.get(key);
    if (!a) {
      a = { p: 0, s: 0, c: 0, t: 0 };
      map.set(key, a);
    }
    if (r[1] === 0)
      a.p++;
    else
      a.s++;
    a.c += r[5];
    a.t += r[6];
    return a;
  };
  for (const ss of Object.values(state.sessions)) {
    let used = false;
    for (const r of ss.r) {
      if (r[0] && r[0] < cutoff)
        continue;
      used = true;
      if (r[1] === 0)
        totals.prompts++;
      else
        totals.steps++;
      totals.cost += r[5];
      totals.tokens += r[6];
      bump(agents, r[2], r);
      if (r[1] === 1 || r[4]) {
        const base = r[3] ? `${r[3]}/${r[4]}` : r[4];
        const eff = r[7] || defaultEffort(r[4]);
        const key = `${r[2]}\x00${base}\x00${eff}`;
        const entry = bump(pairs, key, r);
        entry.agent = r[2];
        entry.model = base;
        entry.effort = eff;
        entry.name = displayName(r[3], r[4]);
      }
    }
    if (used)
      totals.sessions++;
  }
  const agentRows = [...agents.entries()].map(([agent, a]) => ({ agent, prompts: a.p, steps: a.s, cost: a.c, tokens: a.t })).sort((x, y) => y.cost - x.cost || y.steps - x.steps || x.agent.localeCompare(y.agent));
  const pairRows = [...pairs.values()].map(({ p, s, c, t, agent, model, effort, name }) => ({ agent, model, effort, name, prompts: p, steps: s, cost: c, tokens: t })).sort((x, y) => y.cost - x.cost || y.steps - x.steps || (x.agent + x.model).localeCompare(y.agent + y.model));
  return {
    period,
    generatedAt: now,
    granularity,
    cutoffMs: cutoff,
    series,
    totals: { ...totals, cost: Math.round(totals.cost * 1e6) / 1e6 },
    agents: agentRows,
    pairs: pairRows,
    incomplete: state.incomplete
  };
}
function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
async function handleStats(sp, res) {
  const periodParam = sp.get("period") ?? "30d";
  const period = ["all", "today", "shamsi", "7d", "30d"].includes(periodParam) ? periodParam : "30d";
  const fresh = sp.get("fresh") === "1";
  const scanId = sp.get("scan");
  if (!fresh && state.complete && (!scanId || scanId === lastFinishedScanId)) {
    send(res, 200, { complete: true, ageMs: Math.max(0, Date.now() - state.savedAt), data: aggregate(period) });
    return;
  }
  if (fresh || !scan)
    scan = newScan();
  const s = scan;
  try {
    if (!s.listDone || s.queue.length) {
      await scanSlice(s);
      saveState();
    }
  } catch (err) {
    scan = null;
    send(res, 502, { error: String(err?.message || err) });
    return;
  }
  if (!s.listDone || s.queue.length) {
    send(res, 200, {
      complete: false,
      scan: s.id,
      progress: { scanned: s.scanned, pending: s.queue.length, listing: !s.listDone }
    });
    return;
  }
  if (!s.listCapped) {
    for (const id of Object.keys(state.sessions)) {
      if (!s.seen.has(id))
        delete state.sessions[id];
    }
  }
  state.complete = true;
  state.incomplete = s.listCapped || s.msgOverflow;
  state.savedAt = Date.now();
  saveState();
  lastFinishedScanId = s.id;
  scan = null;
  send(res, 200, { complete: true, ageMs: 0, data: aggregate(period) });
}
http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.writeHead(401).end();
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") {
    send(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && url.pathname === "/stats") {
    chain = chain.then(() => handleStats(url.searchParams, res)).catch((err) => {
      console.error("agent-stats: unhandled", err);
      if (!res.headersSent)
        send(res, 500, { error: "internal error" });
    });
    return;
  }
  res.writeHead(404).end("{}");
}).listen(PORT, "127.0.0.1");
