// Runtime test: mock OpenCode server + built service, assert aggregation.
import http from 'node:http';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const DAY = 86_400_000;
const now = Date.now();
const old = now - 10 * DAY;

const sessions = [
  { id: 's1', title: 'old session', parentID: null, time: { created: old, updated: old } },
  { id: 's2', title: 'fresh session', parentID: null, time: { created: now - 3600e3, updated: now - 3600e3 } },
  { id: 's3', title: 'subagent', parentID: 's2', time: { created: now - 60e3, updated: now - 60e3 } },
  { id: 's4', title: 'big session', parentID: null, time: { created: now - 2000, updated: now - 2000 } },
  { id: 's5', title: 'unreadable', parentID: null, time: { created: now - 1000, updated: now - 1000 } },
];

const messages = {
  s1: [
    { id: 'm1', type: 'user', time: { created: old }, text: 'hi' },
    { id: 'm2', type: 'assistant', agent: 'build', model: { id: 'claude-sonnet-4', providerID: 'anthropic' }, time: { created: old + 1 }, cost: 0.01, tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 10, write: 5 } } },
    { id: 'm3', type: 'assistant', agent: 'plan', model: { id: 'gpt-5', providerID: 'openai' }, time: { created: old + 2 }, cost: 0.02, tokens: { input: 200, output: 100, reasoning: 0, cache: { read: 20, write: 10 } } },
  ],
  s2: [
    { id: 'm4', type: 'synthetic', time: { created: now - 3600e3 } },
    { id: 'm5', type: 'user', time: { created: now - 3500e3 }, text: 'do it' },
    { id: 'm6', type: 'assistant', agent: 'build', model: { id: 'claude-sonnet-4', providerID: 'anthropic' }, time: { created: now - 3400e3 }, cost: 0.005, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } },
  ],
  s3: [{ id: 'm7', type: 'user', time: { created: now - 60e3 }, text: 'anyone there?' }],
  // 30 messages; served only when limit <= 25 (forces page-size halving)
  s4: Array.from({ length: 30 }, (_, i) => i % 2 === 0
    ? { id: `u${i}`, type: 'user', time: { created: now - 2000 + i }, text: 'go' }
    : { id: `a${i}`, type: 'assistant', agent: 'build', model: { id: 'claude-sonnet-4', providerID: 'anthropic' }, time: { created: now - 2000 + i }, cost: 0.0001, tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
  s5: [{ id: 'x1', type: 'user', time: { created: now - 1000 }, text: 'boom' }],
};

let extraS2 = false;

const oc = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (body) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const boom = () => { res.writeHead(500); res.end('{}'); };
  if (url.pathname === '/api/session') {
    const cursor = url.searchParams.get('cursor');
    if (!cursor) return json({ data: [sessions[0], sessions[1]], cursor: { next: 'page2' } });
    return json({ data: [sessions[2], sessions[3], sessions[4]], cursor: {} });
  }
  const m = url.pathname.match(/^\/api\/session\/([^/]+)\/message$/);
  if (m) {
    const sid = decodeURIComponent(m[1]);
    let msgs = messages[sid] ?? [];
    if (sid === 's2' && extraS2) {
      msgs = [...msgs, { id: 'm8', type: 'assistant', agent: 'review', model: { id: 'gemini-3', providerID: 'google' }, time: { created: now - 30e3 }, cost: 0.03, tokens: { input: 700, output: 200, reasoning: 50, cache: { read: 30, write: 20 } } }];
    }
    if (sid === 's5') return boom(); // never readable -> overflow
    if (sid === 's4' && Number(url.searchParams.get('limit') ?? 0) > 25) return boom(); // force halving
    const cursor = url.searchParams.get('cursor');
    if (sid === 's1' && !cursor) return json({ data: msgs.slice(0, 2), cursor: { next: 'm2' } });
    if (sid === 's1' && cursor === 'm2') return json({ data: msgs.slice(2), cursor: {} });
    if (sid === 's4') {
      if (!cursor) return json({ data: msgs.slice(0, 25), cursor: { next: 's4b' } });
      return json({ data: msgs.slice(25), cursor: {} });
    }
    return json({ data: msgs, cursor: {} });
  }
  res.writeHead(404).end('{}');
});

await new Promise((r) => oc.listen(0, '127.0.0.1', r));
const ocPort = oc.address().port;

const dataDir = '/tmp/opencode/agent-stats-test';
fs.rmSync(dataDir, { recursive: true, force: true });

const svcPort = 4599;
let svc;
function startSvc() {
  svc = spawn('node', ['service/main.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPENCHAMBER_SERVICE_PORT: String(svcPort),
      OPENCHAMBER_SERVICE_TOKEN: 't',
      OPENCHAMBER_OPENCODE_URL: `http://127.0.0.1:${ocPort}`,
      OPENCHAMBER_SERVICE_DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  svc.stderr.on('data', (d) => process.stderr.write(`[svc] ${d}`));
  return svc;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const localMidnight = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const persianCutoff = (now) => {
  const f = new Intl.DateTimeFormat('en-u-ca-persian', { year: 'numeric', month: 'numeric', day: 'numeric' });
  const day = Number(f.formatToParts(new Date(now)).find((p) => p.type === 'day').value);
  const d = new Date(localMidnight(now));
  d.setDate(d.getDate() - (day - 1));
  return d.getTime();
};
const sumSeries = (s, k) => s.reduce((acc, b) => acc + b[k], 0);
const approx = (a, b) => Math.abs(a - b) < 1e-6;

async function svcGet(pathname) {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${svcPort}${pathname}`, { headers: { Authorization: 'Bearer t' } });
      return { status: res.status, body: await res.json() };
    } catch {
      await sleep(200); // service not up yet
    }
  }
  throw new Error('service did not come up');
}

async function statsUntilComplete(query) {
  let scanId = null;
  for (let i = 0; i < 120; i++) {
    const q = new URLSearchParams(query);
    if (scanId) q.set('scan', scanId);
    const { status, body } = await svcGet(`/stats?${q}`);
    assert.equal(status, 200, `stats status ${status}: ${JSON.stringify(body)}`);
    if (body.complete) return body;
    assert.ok(body.scan, 'scan id present');
    scanId = body.scan;
  }
  throw new Error('scan never completed');
}

try {
  startSvc();
  await sleep(600);

  // health
  const h = await svcGet('/health');
  assert.equal(h.status, 200);
  assert.equal(h.body.ok, true);

  // auth
  const anon = await fetch(`http://127.0.0.1:${svcPort}/stats`);
  assert.equal(anon.status, 401);

  // first full scan (fresh)
  const all = await statsUntilComplete({ period: 'all', fresh: '1' });
  const d = all.data;
  assert.equal(d.incomplete, true, `incomplete flag: ${JSON.stringify(d.totals)}`); // s5 unreadable
  assert.equal(d.totals.prompts, 18, `prompts: ${JSON.stringify(d.totals)}`);
  assert.equal(d.totals.steps, 18, `steps: ${JSON.stringify(d.totals)}`);
  assert.equal(d.totals.sessions, 4, `sessions: ${JSON.stringify(d.totals)}`);
  assert.ok(Math.abs(d.totals.cost - 0.0365) < 1e-9, `cost: ${d.totals.cost}`);
  assert.equal(d.totals.tokens, 525, `tokens: ${d.totals.tokens}`);

  const byAgent = Object.fromEntries(d.agents.map((a) => [a.agent, a]));
  assert.equal(byAgent.build.prompts, 17);
  assert.equal(byAgent.build.steps, 17);
  assert.equal(byAgent.build.tokens, 195);
  assert.ok(Math.abs(byAgent.build.cost - 0.0165) < 1e-9, `build cost: ${byAgent.build.cost}`);
  assert.equal(byAgent.plan.steps, 1);
  assert.equal(byAgent.plan.cost, 0.02);
  assert.equal(byAgent.unanswered.prompts, 1);
  assert.equal(byAgent.unanswered.steps, 0);

  assert.equal(d.pairs.length, 2, `pairs: ${JSON.stringify(d.pairs)}`);
  assert.equal(d.pairs[0].agent, 'plan'); // highest cost first
  assert.equal(d.pairs[0].model, 'openai/gpt-5');
  const buildPair = d.pairs.find((p) => p.agent === 'build');
  assert.equal(buildPair.model, 'anthropic/claude-sonnet-4');
  assert.equal(buildPair.effort, 'high', `default effort for claude: ${JSON.stringify(buildPair)}`); // no variant -> provider default
  assert.equal(buildPair.name, 'Claude Sonnet 4.5', `display name: ${JSON.stringify(buildPair)}`);
  assert.equal(d.pairs.find((p) => p.agent === 'plan').effort, 'medium', `default effort for gpt-5: ${JSON.stringify(d.pairs)}`);
  assert.equal(buildPair.prompts, 17);
  assert.equal(buildPair.steps, 17);

  // 7d excludes the 10-day-old session
  const week = await statsUntilComplete({ period: '7d' });
  assert.equal(week.data.totals.prompts, 17, `7d prompts: ${JSON.stringify(week.data.totals)}`);
  assert.equal(week.data.totals.steps, 16, `7d steps: ${JSON.stringify(week.data.totals)}`);
  assert.equal(week.data.totals.sessions, 3, `7d sessions: ${JSON.stringify(week.data.totals)}`);
  assert.ok(Math.abs(week.data.totals.cost - 0.0065) < 1e-9, `7d cost: ${week.data.totals.cost}`);
  assert.equal(week.data.pairs.length, 1);
  assert.equal(week.data.pairs[0].model, 'anthropic/claude-sonnet-4');

  // 7d series: 7 daily buckets, calendar-aligned, sums match totals
  assert.equal(week.data.granularity, 'day');
  assert.equal(week.data.series.length, 7, `7d series: ${week.data.series.length}`);
  assert.equal(week.data.series[0].startMs, localMidnight(Date.now()) - 6 * DAY);
  assert.equal(sumSeries(week.data.series, 'prompts'), 17);
  assert.equal(sumSeries(week.data.series, 'steps'), 16);
  assert.ok(approx(sumSeries(week.data.series, 'cost'), 0.0065), `7d series cost: ${sumSeries(week.data.series, 'cost')}`);

  // 30d series: 30 buckets covering everything (fixtures are all < 30d old)
  const month = await statsUntilComplete({ period: '30d' });
  assert.equal(month.data.period, '30d');
  assert.equal(month.data.series.length, 30, `30d series: ${month.data.series.length}`);
  assert.equal(month.data.series[0].startMs, localMidnight(Date.now()) - 29 * DAY);
  assert.equal(sumSeries(month.data.series, 'prompts'), 18);
  assert.equal(sumSeries(month.data.series, 'steps'), 18);
  assert.ok(approx(sumSeries(month.data.series, 'cost'), 0.0365), `30d series cost: ${sumSeries(month.data.series, 'cost')}`);

  // today: hourly buckets from local midnight, consistent with its own totals
  const today = await statsUntilComplete({ period: 'today' });
  assert.equal(today.data.period, 'today');
  assert.equal(today.data.granularity, 'hour');
  assert.equal(today.data.cutoffMs, localMidnight(Date.now()));
  assert.equal(today.data.series.length, new Date().getHours() + 1, `today buckets: ${today.data.series.length}`);
  assert.equal(sumSeries(today.data.series, 'prompts'), today.data.totals.prompts);
  assert.equal(sumSeries(today.data.series, 'steps'), today.data.totals.steps);
  assert.ok(approx(sumSeries(today.data.series, 'cost'), today.data.totals.cost));
  assert.ok(today.data.totals.prompts <= 18);

  // shamsi month: cutoff = start of current Jalali month (local time)
  const sh = await statsUntilComplete({ period: 'shamsi' });
  assert.equal(sh.data.period, 'shamsi');
  assert.equal(sh.data.cutoffMs, persianCutoff(Date.now()), `shamsi cutoff: ${sh.data.cutoffMs} vs ${persianCutoff(Date.now())}`);
  assert.equal(sh.data.granularity, Date.now() - persianCutoff(Date.now()) <= 48 * 3600e3 ? 'hour' : 'day');
  assert.equal(sumSeries(sh.data.series, 'prompts'), sh.data.totals.prompts);
  assert.equal(sumSeries(sh.data.series, 'steps'), sh.data.totals.steps);

  // unknown period falls back to 30d
  const bogus = await svcGet('/stats?period=bogus');
  assert.equal(bogus.body.data.period, '30d');

  // fast path serves without scan id
  const fast = await svcGet('/stats?period=all');
  assert.equal(fast.body.complete, true);
  assert.equal(fast.body.data.totals.prompts, 18);

  // incremental: s2 gains a message, bump its updated stamp
  extraS2 = true;
  sessions[1].time.updated = now;
  const inc = await statsUntilComplete({ period: 'all', fresh: '1' });
  assert.equal(inc.data.totals.steps, 19, `incremental steps: ${JSON.stringify(inc.data.totals)}`);
  assert.ok(Math.abs(inc.data.totals.cost - 0.0665) < 1e-9, `incremental cost: ${inc.data.totals.cost}`);
  const reviewPair = inc.data.pairs.find((p) => p.agent === 'review');
  assert.ok(reviewPair && reviewPair.model === 'google/gemini-3' && reviewPair.steps === 1, `review pair: ${JSON.stringify(inc.data.pairs)}`);
  assert.equal(inc.data.pairs.length, 3);

  // persistence: restart service, fast path answers from disk
  svc.kill('SIGKILL');
  await sleep(300);
  startSvc();
  await sleep(600);
  const afterRestart = await svcGet('/stats?period=all');
  assert.equal(afterRestart.body.complete, true);
  assert.equal(afterRestart.body.data.totals.steps, 19, `restart steps: ${JSON.stringify(afterRestart.body.data)}`);
  assert.ok(afterRestart.body.ageMs >= 0);

  console.log('ALL TESTS PASSED');
} finally {
  svc?.kill('SIGKILL');
  oc.close();
}
