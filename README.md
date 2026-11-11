# Agent Stats

> Per-agent and per-agent × model usage stats for OpenChamber, styled like the built-in stats page.

[![OpenChamber](https://img.shields.io/badge/OpenChamber-extension-66800b)](https://openchamber.dev)
[![OpenCode](https://img.shields.io/badge/OpenCode-stats-555)](https://opencode.ai)
[![License](https://img.shields.io/github/license/tw-frontend/agent-stats-extension)](LICENSE)

An [OpenChamber](https://openchamber.dev) extension that shows cost, prompts and steps broken down **per agent** and **per agent × model pair** — the numbers OpenCode's own stats page does not expose.

## Features

- Five metrics everywhere: **Cost**, **Steps**, **Prompts**, **Steps / $**, **Prompts / $**
- **Activity chart** with a hover tooltip (steps, prompts, cost per day or per hour)
- **Cost share by agent** stacked bar with legend
- **By agent** and **By agent and model** tables, switchable sort by any metric
- Periods: **Today**, **Shamsi month** (Jalali, from the 1st of the current Persian month), **7 days**, **30 days**
- Bare model names (`glm-5.3:floor`, not `openrouter/z-ai/glm-5.3:floor`) and a separate **Effort** column — `:floor` / `:nitro` stay part of the model name, only real reasoning-effort variants land in Effort
- Subagent sessions are included, so their agents (e.g. `plan`, `general`) get their own rows

## Install

In OpenChamber: **Settings → Extensions → Folder, ZIP or URL**, paste:

```
https://github.com/tw-frontend/agent-stats-extension.git
```

then choose **Add** and approve the local service (read-only access to your OpenCode sessions and messages). Or click:

[Install Agent Stats](openchamber://extensions/install?url=https://github.com/tw-frontend/agent-stats-extension.git)

Install from a local clone instead:

```bash
git clone https://github.com/tw-frontend/agent-stats-extension.git
```

and paste the absolute path of the cloned folder into the same field.

### Install from a release

Every version is published as a [GitHub Release](https://github.com/tw-frontend/agent-stats-extension/releases)
with one asset:

- `agent-stats-extension-<version>.zip` — the extension folder, laid out for the **ZIP** install

`<version>` is the release tag, for example `1.0.0`. Download the ZIP and use
**Settings → Extensions → ZIP**.

The releases are the same build that CI checks: the committed `panel/main.js` and
`service/main.js` are what OpenChamber loads, so no build step is needed on install.

## Usage

1. Open **Agent Stats** on the rail panel.
2. Pick a period: Today, Shamsi month, 7 days or 30 days.
3. Pick **Sort by** to re-order the tables by any metric.

On first open it scans your OpenCode sessions (progress is shown), then answers
instantly from a local snapshot. **Refresh** re-syncs only new or changed sessions.
Prompts are user messages credited to the agent that answered them; steps are model
responses. Times are local; the Shamsi window starts on the 1st of the current
Persian month.

## How it works

OpenCode has no per-agent usage endpoint, so the extension's local service reads
the two allowlisted OpenCode routes (`/api/session`, `/api/session/:id/message`)
in small bounded slices, keeps a per-message record (`time, kind, agent, provider,
model, cost, tokens, variant`) in its own extension data dir, and aggregates on
demand. Read-only; it never writes to OpenCode. If a session is too large to read
fully, the panel says so instead of silently understating the totals.

## Development

```bash
npm install
npm run check   # typecheck + test + build + openchamber-guest-check
```

The runtime test suite (`test/run.mjs`) spins up a mock OpenCode server and
asserts pagination, page-size adaptation, overflow flags, attribution, period
cutoffs, fast path, incremental rescans, restart persistence and auth.

Build outputs (`panel/main.js`, `service/main.js`) are committed — if you
change the TypeScript sources, run `npm run build` and commit the bundles.

## Releasing

Bump `version` in `package.json`, run `npm run check`, commit, tag `v<version>`,
then create the GitHub Release with the ZIP asset described above.
