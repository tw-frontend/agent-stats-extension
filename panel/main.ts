import { connectHost } from '@openchamber/sdk';
import { applyHostReady, mountBanner, mountButton, mountEmpty, mountSpinner, mountTabs } from '@openchamber/sdk/ui';

const host = connectHost();
const body = document.getElementById('body') as HTMLElement;

type AgentRow = { agent: string; prompts: number; steps: number; cost: number; tokens: number };
type PairRow = { agent: string; model: string; effort?: string; name?: string; prompts: number; steps: number; cost: number; tokens: number };
type Bucket = { startMs: number; prompts: number; steps: number; cost: number; tokens: number };
type StatsData = {
  period: string;
  granularity?: string;
  series?: Bucket[];
  totals: { cost: number; prompts: number; steps: number; tokens: number; sessions: number };
  agents: AgentRow[];
  pairs: PairRow[];
  incomplete?: boolean;
};
type Payload = { complete?: boolean; scan?: string; error?: string; ageMs?: number; data?: StatsData; progress?: { scanned: number; pending: number; listing: boolean } };

type Metric = 'cost' | 'steps' | 'prompts' | 'sps' | 'pps';
const SORT_ITEMS: Array<{ id: Metric; label: string }> = [
  { id: 'cost', label: 'Cost' },
  { id: 'steps', label: 'Steps' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'sps', label: 'Steps / $' },
  { id: 'pps', label: 'Prompts / $' },
];

let period = '30d';
let sortBy: Metric = 'cost';
let lastData: StatsData | null = null;
let lastAgeMs = 0;
let mounted = false;
let loadSeq = 0;
let agoTimer: ReturnType<typeof setInterval> | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function fmtCost(c: number): string {
  if (!c) return '$0';
  if (c >= 100) return `$${c.toFixed(0)}`;
  if (c >= 1) return `$${c.toFixed(2)}`;
  if (c >= 0.01) return `$${c.toFixed(3)}`;
  return `$${c.toFixed(5)}`;
}

function fmtTok(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return fmtInt(n);
}

function fmtRate(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  if (v >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

function metricOf(row: { cost: number; steps: number; prompts: number }, m: Metric): number | null {
  if (m === 'cost') return row.cost;
  if (m === 'steps') return row.steps;
  if (m === 'prompts') return row.prompts;
  if (m === 'sps') return row.cost > 0 ? row.steps / row.cost : null;
  return row.cost > 0 ? row.prompts / row.cost : null;
}

function fmtMetric(m: Metric, v: number | null): string {
  if (m === 'cost') return fmtCost(v ?? 0);
  if (m === 'steps' || m === 'prompts') return fmtInt(v ?? 0);
  return fmtRate(v);
}

function fmtAgo(ms: number): string {
  if (ms < 45e3) return 'just now';
  const m = Math.round(ms / 60e3);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function renderLoading(text: string): void {
  clear(body);
  const row = el('div', 'loading');
  mountSpinner(row, { size: 'sm' });
  row.appendChild(el('span', undefined, text));
  body.appendChild(row);
}

function renderError(message: string): void {
  clear(body);
  mountBanner(body, {
    tone: 'error',
    title: 'Could not load agent stats',
    body: message,
    action: { label: 'Retry', onClick: () => void load(true) },
  });
}

function statCard(label: string, value: string, hint?: string): HTMLElement {
  const card = el('div', 'card');
  card.appendChild(el('div', 'label', label));
  card.appendChild(el('div', 'value', value));
  if (hint) card.appendChild(el('div', 'hint', hint));
  return card;
}

function section(title: string, caption?: string): { card: HTMLElement } {
  const head = el('div', 'section');
  const h2 = document.createElement('h2');
  h2.textContent = title;
  head.appendChild(h2);
  if (caption) head.appendChild(el('div', 'micro', caption));
  body.appendChild(head);
  const card = el('div', 'panel-card');
  body.appendChild(card);
  return { card };
}

function metricCell(value: string): HTMLElement {
  return el('div', 'num', value);
}

function gridRow(cells: string[], cls: string, first: HTMLElement): HTMLElement {
  const row = el('div', `gt ${cls}`);
  row.appendChild(first);
  for (const c of cells) row.appendChild(metricCell(c));
  return row;
}

function renderAgentTable(data: StatsData): void {
  const { card } = section('By agent', `${fmtInt(data.totals.prompts)} prompts · ${fmtInt(data.totals.steps)} steps`);
  const sorted = [...data.agents].sort((a, b) => (metricOf(b, sortBy) ?? -1) - (metricOf(a, sortBy) ?? -1));
  const max = Math.max(...sorted.map((a) => metricOf(a, sortBy) ?? 0), 0);
  const wrap = el('div', 'tblwrap');
  const head = gridRow(SORT_ITEMS.map((s) => s.label), 'head', el('div', undefined, 'Agent'));
  wrap.appendChild(head);
  for (const a of sorted) {
    const name = el('div', 'namecell');
    const line = el('div', 'nameline');
    const dot = el('span', 'dot');
    dot.style.background = 'var(--oc-primary)';
    line.appendChild(dot);
    line.appendChild(el('span', 'nm', a.agent));
    name.appendChild(line);
    const meterWrap = el('div', 'meterwrap');
    const meter = el('div', 'meter');
    const v = metricOf(a, sortBy) ?? 0;
    meter.style.width = max > 0 ? `${Math.max(3, (v / max) * 100)}%` : '0';
    meterWrap.appendChild(meter);
    name.appendChild(meterWrap);
    const cells = SORT_ITEMS.map((s) => fmtMetric(s.id, metricOf(a, s.id)));
    wrap.appendChild(gridRow(cells, 'row', name));
  }
  card.appendChild(wrap);
}

// OpenRouter ids carry the vendor namespace (openrouter/z-ai/glm-5.3:floor);
// show the bare model id. Name suffixes like :floor/:nitro are part of the
// model name, not thinking effort — effort travels in its own field.
function modelName(m: string): string {
  return m.startsWith('openrouter/') ? (m.slice('openrouter/'.length).split('/').pop() || m) : m;
}

function renderPairTable(data: StatsData): void {
  if (!data.pairs.length) return;
  const agentMetric = new Map(data.agents.map((a) => [a.agent, metricOf(a, sortBy) ?? -1]));
  const groups = data.agents
    .map((a) => ({ agent: a.agent, models: data.pairs.filter((p) => p.agent === a.agent) }))
    .filter((g) => g.models.length)
    .sort((x, y) => (agentMetric.get(y.agent) ?? -1) - (agentMetric.get(x.agent) ?? -1));
  if (!groups.length) return;
  const { card } = section('By agent and model');
  const wrap = el('div', 'tblwrap');
  wrap.appendChild(gridRow(['Effort', ...SORT_ITEMS.map((s) => s.label)], 'head pairs', el('div', undefined, 'Model')));
  for (const g of groups) {
    wrap.appendChild(el('div', 'subhead', g.agent));
    const sorted = [...g.models].sort((a, b) => (metricOf(b, sortBy) ?? -1) - (metricOf(a, sortBy) ?? -1));
    for (const p of sorted) {
      const name = el('div', 'namecell');
      const line = el('div', 'nameline');
      line.appendChild(el('span', 'nm model', p.name ?? modelName(p.model)));
      name.appendChild(line);
      const cells = [p.effort || '—', ...SORT_ITEMS.map((s) => fmtMetric(s.id, metricOf(p, s.id)))];
      wrap.appendChild(gridRow(cells, 'row pairs', name));
    }
  }
  card.appendChild(wrap);
}

function renderShare(data: StatsData): void {
  const byCost = data.totals.cost > 0;
  const total = byCost ? data.totals.cost : data.totals.steps;
  if (total <= 0) return;
  const { card } = section(byCost ? 'Cost share by agent' : 'Activity share by agent');
  const rows = [...data.agents].sort((a, b) => (byCost ? b.cost - a.cost : b.steps - a.steps));
  const top = rows.slice(0, 5);
  const rest = rows.slice(5);
  const segs = el('div', 'share');
  const legend = el('div', 'legend');
  const opacities = [1, 0.72, 0.5, 0.34, 0.22];
  const color = (i: number) => (i < 5
    ? `color-mix(in srgb, var(--oc-primary) ${Math.round(opacities[i] * 100)}%, var(--oc-muted))`
    : 'var(--oc-muted)');
  const add = (name: string, value: number, i: number) => {
    const share = total > 0 ? value / total : 0;
    const seg = el('div', 'seg');
    seg.style.width = `${Math.max(0.5, share * 100)}%`;
    seg.style.background = color(i);
    segs.appendChild(seg);
    const item = el('div', 'item');
    const dot = el('span', 'dot');
    dot.style.background = color(i);
    item.appendChild(dot);
    item.appendChild(el('span', 'name', name));
    item.appendChild(el('span', 'val', byCost
      ? `${fmtCost(value)} (${Math.round(share * 100)}%)`
      : `${fmtInt(value)} (${Math.round(share * 100)}%)`));
    legend.appendChild(item);
  };
  top.forEach((a, i) => add(a.agent, byCost ? a.cost : a.steps, i));
  if (rest.length) {
    const agg = rest.reduce((acc, a) => ({ cost: acc.cost + a.cost, steps: acc.steps + a.steps }), { cost: 0, steps: 0 });
    add('other', byCost ? agg.cost : agg.steps, 5);
  }
  card.appendChild(segs);
  card.appendChild(legend);
}

let tip: HTMLElement | null = null;

function fmtBucketLabel(t: number, granularity: string): string {
  try {
    if (period === 'shamsi') {
      const f = new Intl.DateTimeFormat('en-u-ca-persian', granularity === 'hour'
        ? { month: 'short', day: 'numeric', hour: 'numeric' }
        : { month: 'short', day: 'numeric', year: 'numeric' });
      return f.format(new Date(t));
    }
    const f = new Intl.DateTimeFormat('en-US', granularity === 'hour'
      ? { month: 'short', day: 'numeric', hour: 'numeric' }
      : { month: 'short', day: 'numeric' });
    return f.format(new Date(t));
  } catch {
    return new Date(t).toLocaleDateString();
  }
}

function renderChart(data: StatsData): void {
  const series = data.series ?? [];
  if (!series.length) return;
  const { card } = section('Activity', data.granularity === 'hour' ? 'steps per hour' : 'steps per day');
  const max = Math.max(...series.map((b) => b.steps), 0);
  const bars = el('div', 'bars');
  tip = el('div', 'tip');
  bars.appendChild(tip);
  series.forEach((b, i) => {
    const col = el('div', 'bcol');
    col.tabIndex = 0;
    const bar = el('div', b.steps > 0 ? 'bar' : 'bar zero');
    const h = max > 0 && b.steps > 0 ? Math.max(4, (b.steps / max) * 100) : 0;
    bar.style.height = b.steps > 0 ? `${h}%` : '1px';
    col.appendChild(bar);
    const label = `${fmtBucketLabel(b.startMs, data.granularity ?? 'day')}: ${fmtInt(b.steps)} steps · ${fmtInt(b.prompts)} prompts · ${fmtCost(b.cost)}`;
    col.setAttribute('aria-label', label);
    col.title = '';
    const show = () => {
      if (!tip) return;
      tip.textContent = label;
      tip.style.display = 'block';
      tip.classList.remove('edge-l', 'edge-r');
      const x = col.offsetLeft + col.offsetWidth / 2;
      if (i < 2) tip.classList.add('edge-l');
      else if (i > series.length - 3) tip.classList.add('edge-r');
      else tip.style.left = `${x}px`;
    };
    const hide = () => { if (tip) tip.style.display = 'none'; };
    col.addEventListener('pointerenter', show);
    col.addEventListener('pointerleave', hide);
    col.addEventListener('focus', show);
    col.addEventListener('blur', hide);
    bars.appendChild(col);
  });
  card.appendChild(bars);
  const axis = el('div', 'xaxis');
  axis.appendChild(el('span', undefined, fmtBucketLabel(series[0].startMs, 'day')));
  if (series.length > 1) axis.appendChild(el('span', undefined, fmtBucketLabel(series[series.length - 1].startMs, 'day')));
  card.appendChild(axis);
}

function renderData(data: StatsData, ageMs: number): void {
  lastData = data;
  lastAgeMs = ageMs;
  clear(body);
  if (agoTimer) clearInterval(agoTimer);

  if (data.incomplete) {
    mountBanner(body, {
      tone: 'warning',
      title: 'Partial results',
      body: 'Some sessions could not be fully read, so totals may be understated.',
    });
  }

  const cards = el('div', 'cards');
  cards.appendChild(statCard('Cost', fmtCost(data.totals.cost), `${fmtTok(data.totals.tokens)} tokens`));
  cards.appendChild(statCard('Steps', fmtInt(data.totals.steps)));
  cards.appendChild(statCard('Prompts', fmtInt(data.totals.prompts)));
  cards.appendChild(statCard('Steps / $', fmtRate(data.totals.cost > 0 ? data.totals.steps / data.totals.cost : null)));
  cards.appendChild(statCard('Prompts / $', fmtRate(data.totals.cost > 0 ? data.totals.prompts / data.totals.cost : null)));
  body.appendChild(cards);

  renderChart(data);
  renderShare(data);

  if (!data.agents.length) {
    mountEmpty(body, {
      title: 'No agent activity yet',
      body: 'Cost, prompts and steps appear once sessions have run.',
    });
    return;
  }

  renderAgentTable(data);
  renderPairTable(data);

  const updated = document.getElementById('updated');
  if (updated) updated.textContent = `Updated ${fmtAgo(ageMs)}`;
  agoTimer = setInterval(() => {
    const u = document.getElementById('updated');
    if (u) u.textContent = `Updated ${fmtAgo(Date.now() - loadedAt)}`;
  }, 30e3);
}

let loadedAt = Date.now();

function progressText(p: { scanned: number; pending: number; listing: boolean }): string {
  if (p.listing) return 'Listing sessions…';
  return `Scanning sessions… ${fmtInt(p.scanned)} done, ${fmtInt(p.pending)} to go`;
}

async function load(fresh: boolean): Promise<void> {
  const seq = ++loadSeq;
  let scanId: string | undefined;
  for (;;) {
    if (seq !== loadSeq) return;
    renderLoading(scanId ? 'Scanning sessions…' : 'Loading…');
    const query: Record<string, string> = { period };
    if (fresh) query.fresh = '1';
    if (scanId) query.scan = scanId;
    let res: { status: number; body: unknown };
    try {
      res = await host.serviceRequest({ method: 'GET', path: '/stats', query });
    } catch (err) {
      if (seq !== loadSeq) return;
      renderError(String((err as Error)?.message ?? err));
      return;
    }
    if (seq !== loadSeq) return;
    let payload: Payload | null = null;
    try {
      payload = (typeof res.body === 'string' ? JSON.parse(res.body) : res.body) as Payload;
    } catch {
      payload = null;
    }
    if (res.status !== 200 || !payload) {
      renderError(payload?.error ?? `Service returned status ${res.status}`);
      return;
    }
    if (payload.complete) {
      if (payload.data) {
        loadedAt = Date.now();
        renderData(payload.data, payload.ageMs ?? 0);
      } else {
        renderError('Service returned no data');
      }
      return;
    }
    if (!payload.scan) {
      renderError(payload.error ?? 'Service did not return a scan id');
      return;
    }
    scanId = payload.scan;
    if (payload.progress) renderLoading(progressText(payload.progress));
    await sleep(400);
  }
}

host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  if (mounted) return;
  mounted = true;
  const tabs = mountTabs(document.getElementById('tabs') as HTMLElement, {
    items: [
      { id: 'today', label: 'Today' },
      { id: 'shamsi', label: 'Shamsi month' },
      { id: '7d', label: '7 days' },
      { id: '30d', label: '30 days' },
    ],
    activeId: period,
    onChange: (next: string) => {
      period = next;
      tabs.update({ activeId: next });
      void load(false);
    },
  });
  const sortTabs = mountTabs(document.getElementById('sort') as HTMLElement, {
    items: SORT_ITEMS.map((s) => ({ id: s.id, label: s.label })),
    activeId: sortBy,
    onChange: (next: string) => {
      sortBy = next as Metric;
      sortTabs.update({ activeId: sortBy });
      if (lastData) renderData(lastData, lastAgeMs);
    },
  });
  mountButton(document.getElementById('refresh') as HTMLElement, {
    label: 'Refresh',
    variant: 'outline',
    size: 'sm',
    onClick: () => void load(true),
  });
  void load(true);
});
