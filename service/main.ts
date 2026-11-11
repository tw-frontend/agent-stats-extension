import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Agent Stats service: reads OpenCode sessions/messages through the loopback
// guest connection and aggregates cost / prompts / steps per agent and per
// agent+model pair. Read-only; state is a local snapshot in the extension's
// own data dir so a restarted service resumes instead of rescanning.

const PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT || 0);
const TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN || '';
const OC_URL = (process.env.OPENCHAMBER_OPENCODE_URL || '').replace(/\/+$/, '');
const DATA_DIR = process.env.OPENCHAMBER_SERVICE_DATA_DIR
  || path.join(os.homedir(), '.agent-stats-extension');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

if (!TOKEN || !OC_URL || !PORT) {
  console.error('agent-stats: OpenChamber service environment is missing (OPENCHAMBER_SERVICE_TOKEN, OPENCHAMBER_OPENCODE_URL, OPENCHAMBER_SERVICE_PORT)');
  process.exit(1);
}

// one message record: [timeMs, kind(0=prompt,1=step), agent, provider, model, cost, tokens, effortVariant]
type Rec = [number, 0 | 1, string, string, string, number, number, string];
type SessionState = { u: number; r: Rec[] };
type Persisted = { v: 3; complete: boolean; incomplete: boolean; savedAt: number; sessions: Record<string, SessionState> };

const DAY = 86_400_000;
const SLICE_MS = 2_500;          // work budget per /stats call (RPC limit is 20 s)
const FETCH_TIMEOUT_MS = 10_000; // per-request cap; the host also caps responses
const SESSION_PAGE = 500;
const MESSAGE_PAGE = 200;        // halved on oversized/failed pages
const MESSAGE_PAGE_FLOOR = 25;
const MAX_MESSAGE_PAGES = 1_000; // safety valve per session; sets "incomplete"
const MAX_SESSIONS = 20_000;     // safety valve on listing; sets "incomplete"

// OpenRouter routing suffixes are part of the model identity (:nitro !=
// :floor — fastest vs cheapest are different models). Only the separator
// spelling varies: `-nitro` and `:nitro` are the same model, canonicalized
// to the colon form.
const ROUTING_SUFFIX = /[-:](nitro|floor|free|batch)$/;

function canonicalModel(id: string): string {
  return id.replace(ROUTING_SUFFIX, ':$1');
}

// Display names (opencode-style) matched against the bare or provider-
// qualified model id; anything unlisted falls back to the stripped id.
const DISPLAY_NAMES: Array<[string, string]> = [
  ['claude-opus-4-6', 'Claude Opus 4.6'],
  ['claude-sonnet-4', 'Claude Sonnet 4.5'],
  ['claude-opus-4-5', 'Claude Opus 4.5'],
  ['gpt-5.2', 'GPT 5.2'],
  ['gpt-5.1-codex', 'GPT 5.1 Codex'],
  ['gpt-5.1', 'GPT 5.1'],
  ['gpt-5', 'GPT 5'],
  ['gemini-3-pro', 'Gemini 3 Pro'],
  ['gemini-3-flash', 'Gemini 3 Flash'],
  ['gemini-2.5-pro', 'Gemini 2.5 Pro'],
  ['glm-5.3', 'GLM 5.3'],
  ['glm-5.3-flash', 'GLM 5.3 Flash'],
  ['kimi-k2-thinking', 'Kimi K2 Thinking'],
  ['muse-spark-1.1', 'Muse Spark 1.1'],
  ['muse-spark-1.2', 'Muse Spark 1.2'],
  ['muse-spark-1.2-contributor', 'Muse Spark 1.2 (contributor)'],
  ['muse-ember', 'Muse Ember'],
  ['nex-n2.5-pro', 'Nex-N2.5 Pro'],
  ['nex-n2.5-mini', 'Nex-N2.5 Mini'],
  ['nex-n2.6', 'Nex-N2.6'],
];

// Default reasoning effort when a message carries no variant — each entry
// tracks its provider's API default. Meta has no documented default, so it
// is deliberately absent and resolves to blank.
const DEFAULT_EFFORT: Array<[RegExp, string]> = [
  [/^claude[-_]/, 'high'],     // Anthropic defaults effort to high
  [/^(gpt-5|o[134])/, 'medium'], // OpenAI defaults reasoning_effort to medium
  [/^gemini-3/, 'high'],       // Google defaults thinking_level to high
  [/^glm/, 'max'],             // Z.ai GLM API default (user-specified)
  [/^deepseek/, 'max'],        // DeepSeek API default (user-specified)
  [/^nex-n2\.5/, 'medium'],    // Nex-N2.5 README: reasoning_effort "medium" (default)
];

function defaultEffort(base: string): string {
  const id = (base.split('/').pop() || base).toLowerCase();
  for (const [re, eff] of DEFAULT_EFFORT) {
    if (re.test(id)) return eff;
  }
  return '';
}

// Display names from the OpenCode config (providers.<pid>.models.<mid>.name)
// which the user maintains per model. The file also holds API keys, so only
// non-empty string names are extracted; the file and raw content are never
// logged or returned. Missing/invalid file -> empty map -> built-in fallback.
function loadConfigNames(): Map<string, string> {
  const names = new Map<string, string>();
  const cfgPath = process.env.OPENCODE_CONFIG
    || path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const providers = cfg && typeof cfg === 'object' ? cfg.providers : null;
    if (providers && typeof providers === 'object') {
      for (const [pid, p] of Object.entries(providers as Record<string, unknown>)) {
        const models = (p as { models?: unknown })?.models;
        if (!models || typeof models !== 'object') continue;
        for (const [mid, m] of Object.entries(models as Record<string, unknown>)) {
          const name = (m as { name?: unknown })?.name;
          if (typeof name === 'string' && name.trim()) {
            names.set(`${pid}/${canonicalModel(mid)}`, name.trim());
          }
        }
      }
    }
  } catch {
    // no config, unreadable, or invalid JSON -> fallback names
  }
  return names;
}

// Config names win and are used verbatim (they already encode the routing
// word, e.g. "GLM 5.3 Floor"). The curated map is the fallback for models
// with no config entry; the bare id is the last resort.
function displayName(provider: string, base: string, cfg: Map<string, string>): string {
  const hit = cfg.get(provider ? `${provider}/${base}` : base);
  if (hit) return hit;
  const bare = (base.split('/').pop() || base);
  const routing = ROUTING_SUFFIX.exec(bare);
  const suffix = routing ? `:${routing[1]}` : '';
  const stem = routing ? bare.slice(0, routing.index) : bare;
  const full = provider ? `${provider}/${base}` : base;
  for (const [id, name] of DISPLAY_NAMES) {
    if (stem === id || full === id || bare === id) return name + suffix;
  }
  return bare;
}

function isValidRec(r: unknown): r is Rec {
  return Array.isArray(r) && r.length === 8;
}

function loadState(): Persisted {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (raw && raw.v === 3 && raw.sessions && typeof raw.sessions === 'object') {
      const sessions: Record<string, SessionState> = {};
      let dropped = 0;
      for (const [id, val] of Object.entries(raw.sessions as Record<string, unknown>)) {
        const v = val as SessionState;
        if (v && typeof v.u === 'number' && Array.isArray(v.r) && v.r.every(isValidRec)) {
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
        sessions,
      };
    }
  } catch {
    // missing or corrupt file -> start fresh
  }
  return { v: 3, complete: false, incomplete: false, savedAt: 0, sessions: {} };
}

const state: Persisted = loadState();

function saveState(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    console.error('agent-stats: could not persist state', err);
  }
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function msgTime(m: any): number {
  const t = m?.time?.created ?? m?.time;
  if (typeof t === 'number' && Number.isFinite(t)) return t;
  const parsed = Date.parse(str(t));
  return Number.isFinite(parsed) ? parsed : 0;
}

async function fetchJson(p: string): Promise<any> {
  const res = await fetch(OC_URL + p, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`OpenCode ${res.status} on ${p.split('?')[0]}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// OpenCode replies either as a bare array or as { data, cursor: { next } }.
function pageOf(body: any): { items: any[]; next: string | null } {
  if (Array.isArray(body)) return { items: body, next: null };
  const items = body?.data ?? body?.items;
  const next = body?.cursor?.next ?? body?.nextCursor ?? null;
  return {
    items: Array.isArray(items) ? items : [],
    next: typeof next === 'string' && next ? next : null,
  };
}

type Scan = {
  id: string;
  listCursor: string | null;
  listDone: boolean;
  listCapped: boolean;
  queue: Array<{ id: string; u: number }>;
  seen: Set<string>;
  scanned: number;
  msgOverflow: boolean;
};

function newScan(): Scan {
  return {
    id: Math.random().toString(36).slice(2) + Date.now().toString(36),
    listCursor: null,
    listDone: false,
    listCapped: false,
    queue: [],
    seen: new Set<string>(),
    scanned: 0,
    msgOverflow: false,
  };
}

let scan: Scan | null = null;
let lastFinishedScanId: string | null = null;
let chain: Promise<unknown> = Promise.resolve(); // serialize /stats handling

// Half-fetched sessions kept across slices (in memory only; a service restart
// simply re-queues them from scratch).
type Pending = { u: number; raw: any[]; cursor: string | null; limit: number; pages: number };
const pending = new Map<string, Pending>();

type CollectResult = { status: 'done' | 'partial'; overflow: boolean };

async function collectSession(sid: string, updated: number, deadline: number): Promise<CollectResult> {
  const prev = pending.get(sid);
  const st: Pending = prev && prev.u === updated ? prev : { u: updated, raw: [], cursor: null, limit: MESSAGE_PAGE, pages: 0 };
  pending.set(sid, st);
  let overflow = false;
  let gaveUp = false;

  while (true) {
    if (st.raw.length || st.cursor) {
      if (Date.now() >= deadline) return { status: 'partial', overflow }; // resume next slice
    }
    let body: any;
    try {
      const q = new URLSearchParams({ limit: String(st.limit) });
      if (st.cursor) q.set('cursor', st.cursor);
      body = await fetchJson(`/api/session/${encodeURIComponent(sid)}/message?${q}`);
    } catch (err) {
      if ((err as Error & { status?: number }).status === 404) {
        pending.delete(sid);
        delete state.sessions[sid]; // session vanished mid-scan
        return { status: 'done', overflow: false };
      }
      if (Date.now() >= deadline) {
        return { status: 'partial', overflow }; // retry next slice, keeping the shrunk limit
      }
      if (st.limit > MESSAGE_PAGE_FLOOR) {
        st.limit = Math.max(MESSAGE_PAGE_FLOOR, Math.floor(st.limit / 2)); // oversized page: shrink and retry
        continue;
      }
      if (!st.cursor && st.pages === 0) {
        try {
          body = await fetchJson(`/api/session/${encodeURIComponent(sid)}/message`); // older servers: no params
        } catch {
          gaveUp = true;
        }
      } else {
        gaveUp = true;
      }
      if (gaveUp) {
        overflow = true; // unread pages remain; totals flagged incomplete
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

  const recs: Rec[] = [];
  for (const m of st.raw) {
    const type = m?.type ?? m?.role;
    if (type === 'assistant') {
      const model = canonicalModel(str(m?.model?.id) || str(m?.modelID) || 'unknown');
      const variant = str(m?.model?.variant);
      const provider = str(m?.model?.providerID) || str(m?.providerID);
      const tk = m?.tokens;
      const tokens = tk
        ? num(tk.input) + num(tk.output) + num(tk.reasoning) + num(tk.cache?.read) + num(tk.cache?.write)
        : 0;
      recs.push([msgTime(m), 1, str(m?.agent) || 'unknown', provider, model, num(m?.cost), tokens, variant]);
    } else if (type === 'user') {
      recs.push([msgTime(m), 0, '', '', '', 0, 0, '']);
    }
  }

  // Attribute each prompt to the agent+model that answered it: the next
  // assistant message in the session, else the previous one, else "unanswered".
  const nextStep: Array<Rec | null> = new Array(recs.length).fill(null);
  let nxt: Rec | null = null;
  for (let i = recs.length - 1; i >= 0; i--) {
    if (recs[i][1] === 1) nxt = recs[i];
    nextStep[i] = nxt;
  }
  let last: Rec | null = null;
  for (let i = 0; i < recs.length; i++) {
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
      r[2] = 'unanswered';
      r[3] = '';
      r[4] = '';
      r[7] = '';
    }
  }

  state.sessions[sid] = { u: updated, r: recs };
  return { status: 'done', overflow };
}

async function scanSlice(s: Scan): Promise<void> {
  const deadline = Date.now() + SLICE_MS;

  while (!s.listDone && Date.now() < deadline) {
    const q = new URLSearchParams({ limit: String(SESSION_PAGE) });
    if (s.listCursor) q.set('cursor', s.listCursor);
    const { items, next } = pageOf(await fetchJson(`/api/session?${q}`));
    for (const sess of items) {
      const id = str(sess?.id);
      if (!id) continue;
      s.seen.add(id);
      const u = num(sess?.time?.updated) || num(sess?.time?.created) || 0;
      const prev = state.sessions[id];
      if (!prev || prev.u !== u) s.queue.push({ id, u });
    }
    if (s.seen.size >= MAX_SESSIONS) {
      s.listCapped = true;
      s.listDone = true;
      break;
    }
    if (next) s.listCursor = next;
    else s.listDone = true;
  }

  while (s.queue.length && Date.now() < deadline) {
    const b = s.queue.shift()!;
    try {
      const r = await collectSession(b.id, b.u, deadline);
      if (r.status === 'partial') s.queue.unshift(b); // finish it next slice
      else s.scanned++;
      if (r.overflow) s.msgOverflow = true;
    } catch (err) {
      s.queue.unshift(b); // put it back; a later scan retries it
      throw err;
    }
  }
}

const HOUR = 3_600_000;

function localMidnight(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Persian (Jalali) calendar day-of-month for "start of Shamsi month" cutoffs.
const persianFmt = (() => {
  try {
    const f = new Intl.DateTimeFormat('en-u-ca-persian', { year: 'numeric', month: 'numeric', day: 'numeric' });
    return f.resolvedOptions().calendar === 'persian' ? f : null;
  } catch {
    return null;
  }
})();

// Calendar-aligned window starts (local time). 7d/30d include today as a full day.
function periodCutoff(period: string, now: number): number {
  const midnight = localMidnight(now);
  if (period === 'today') return midnight;
  if (period === 'shamsi') {
    const day = persianFmt
      ? Number(persianFmt.formatToParts(new Date(now)).find((p) => p.type === 'day')?.value)
      : NaN;
    const d = new Date(midnight);
    d.setDate(d.getDate() - ((day >= 1 && day <= 31 ? day : 30) - 1));
    return d.getTime();
  }
  if (period === '7d') return midnight - 6 * DAY;
  if (period === '30d') return midnight - 29 * DAY;
  return 0; // 'all'
}

function bucketKey(t: number, granularity: 'day' | 'hour'): number {
  if (granularity === 'day') return localMidnight(t);
  const d = new Date(t);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

// Contiguous zero-filled buckets covering [cutoff, now] in local time.
function buildSeries(cutoff: number, now: number, granularity: 'day' | 'hour') {
  const buckets: Array<{ startMs: number; prompts: number; steps: number; cost: number; tokens: number }> = [];
  const index = new Map<number, number>();
  const push = (t: number) => {
    if (t < cutoff || t > now || buckets.length >= 500) return;
    index.set(t, buckets.length);
    buckets.push({ startMs: t, prompts: 0, steps: 0, cost: 0, tokens: 0 });
  };
  if (granularity === 'hour') {
    for (let day = new Date(cutoff); day.getTime() <= now; day.setDate(day.getDate() + 1)) {
      for (let h = 0; h < 24; h++) {
        const b = new Date(day);
        b.setHours(h, 0, 0, 0);
        push(b.getTime());
      }
    }
  } else {
    for (let d = new Date(cutoff); d.getTime() <= now; d.setDate(d.getDate() + 1)) push(d.getTime());
  }
  for (const ss of Object.values(state.sessions)) {
    for (const r of ss.r) {
      if (!r[0] || r[0] < cutoff || r[0] > now) continue;
      const bi = index.get(bucketKey(r[0], granularity));
      if (bi === undefined) continue;
      const b = buckets[bi];
      if (r[1] === 0) b.prompts++;
      else {
        b.steps++;
        b.cost += r[5];
        b.tokens += r[6];
      }
    }
  }
  for (const b of buckets) b.cost = Math.round(b.cost * 1e6) / 1e6;
  return buckets;
}

type Agg = { p: number; s: number; c: number; t: number };

function aggregate(period: string) {
  const now = Date.now();
  const cfgNames = loadConfigNames();
  const cutoff = periodCutoff(period, now);
  const granularity: 'day' | 'hour' = cutoff > 0 && now - cutoff <= 48 * HOUR ? 'hour' : 'day';
  const series = cutoff > 0 ? buildSeries(cutoff, now, granularity) : [];
  const agents = new Map<string, Agg>();
  const pairs = new Map<string, Agg & { agent: string; model: string; effort: string; name: string }>();
  const totals = { cost: 0, prompts: 0, steps: 0, tokens: 0, sessions: 0 };

  const bump = (map: Map<string, Agg>, key: string, r: Rec): Agg => {
    let a = map.get(key);
    if (!a) {
      a = { p: 0, s: 0, c: 0, t: 0 };
      map.set(key, a);
    }
    if (r[1] === 0) a.p++;
    else a.s++;
    a.c += r[5];
    a.t += r[6];
    return a;
  };

  for (const ss of Object.values(state.sessions)) {
    let used = false;
    for (const r of ss.r) {
      if (r[0] && r[0] < cutoff) continue;
      used = true;
      if (r[1] === 0) totals.prompts++;
      else totals.steps++;
      totals.cost += r[5];
      totals.tokens += r[6];
      bump(agents, r[2], r);
      if (r[1] === 1 || r[4]) {
        const base = r[3] ? `${r[3]}/${r[4]}` : r[4];
        const eff = r[7] || defaultEffort(r[4]);
        const key = `${r[2]}\u0000${base}\u0000${eff}`;
        const entry = bump(pairs, key, r) as Agg & { agent: string; model: string; effort: string; name: string };
        entry.agent = r[2];
        entry.model = base;
        entry.effort = eff;
        entry.name = displayName(r[3], r[4], cfgNames);
      }
    }
    if (used) totals.sessions++;
  }

  const agentRows = [...agents.entries()]
    .map(([agent, a]) => ({ agent, prompts: a.p, steps: a.s, cost: a.c, tokens: a.t }))
    .sort((x, y) => (y.cost - x.cost) || (y.steps - x.steps) || x.agent.localeCompare(y.agent));
  const pairRows = [...pairs.values()]
    .map(({ p, s, c, t, agent, model, effort, name }) => ({ agent, model, effort, name, prompts: p, steps: s, cost: c, tokens: t }))
    .sort((x, y) => (y.cost - x.cost) || (y.steps - x.steps) || (x.agent + x.model).localeCompare(y.agent + y.model));

  return {
    period,
    generatedAt: now,
    granularity,
    cutoffMs: cutoff,
    series,
    totals: { ...totals, cost: Math.round(totals.cost * 1e6) / 1e6 },
    agents: agentRows,
    pairs: pairRows,
    incomplete: state.incomplete,
  };
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function handleStats(sp: URLSearchParams, res: http.ServerResponse): Promise<void> {
  const periodParam = sp.get('period') ?? '30d';
  const period = ['all', 'today', 'shamsi', '7d', '30d'].includes(periodParam) ? periodParam : '30d';
  const fresh = sp.get('fresh') === '1';
  const scanId = sp.get('scan');

  // Fast path: a finished snapshot answers instantly. A poll carrying the id of
  // a scan that already finished also lands here instead of rescanning.
  if (!fresh && state.complete && (!scanId || scanId === lastFinishedScanId)) {
    send(res, 200, { complete: true, ageMs: Math.max(0, Date.now() - state.savedAt), data: aggregate(period) });
    return;
  }

  // Otherwise scan: start a new one on explicit refresh or when none is running,
  // otherwise join the scan in flight (stale ids included) instead of restarting it.
  if (fresh || !scan) scan = newScan();
  const s = scan;

  try {
    if (!s.listDone || s.queue.length) {
      await scanSlice(s);
      saveState();
    }
  } catch (err) {
    scan = null; // next call starts a new scan; collected sessions stay saved
    send(res, 502, { error: String((err as Error)?.message || err) });
    return;
  }

  if (!s.listDone || s.queue.length) {
    send(res, 200, {
      complete: false,
      scan: s.id,
      progress: { scanned: s.scanned, pending: s.queue.length, listing: !s.listDone },
    });
    return;
  }

  if (!s.listCapped) {
    for (const id of Object.keys(state.sessions)) {
      if (!s.seen.has(id)) delete state.sessions[id]; // sessions deleted in OpenCode
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
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') {
    send(res, 200, { ok: true });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/stats') {
    chain = chain.then(() => handleStats(url.searchParams, res)).catch((err) => {
      console.error('agent-stats: unhandled', err);
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
    });
    return;
  }
  res.writeHead(404).end('{}');
}).listen(PORT, '127.0.0.1');
