# macOS Desktop Widgets — Übersicht Widget Host

A small, reusable host for [Übersicht](https://tracesof.net/uebersicht/) desktop
widgets: **one** local Node helper serves **many** widgets, and a shared widget
kit means a new widget is a data function plus a layout — not another 300 lines
of CSS.

The widget it ships with shows your **Claude Code** usage statistics — sessions,
messages, tokens, estimated cost, streaks, peak hour, favorite model, and live
plan-limit bars — right on your wallpaper.

**Adding a widget is two commands:**

```bash
./scripts/new-widget.sh weather        # scaffolds provider + widget
./scripts/deploy.sh weather            # copies it into Übersicht
```

`new-widget.sh` writes `src/providers/weather/index.js` (fill in `collect()`) and
`widgets/weather.widget/index.jsx` (fill in the layout). The helper discovers the
provider automatically and serves it at `/stats/weather` — no registration, no
edits to the server, no new launchd service.

---

## How it fits together

The Claude Code widget fuses **three** independent sources, which is a good
illustration of what a provider can do:

1. **Parses your local files** — `~/.claude/projects/**/*.jsonl`,
   `~/.claude/history.jsonl`, and `~/.claude/stats-cache.json`. This is the only
   way to get the full picture (streaks, peak hour, favorite model).
2. **Receives live OpenTelemetry metrics** — Claude Code can emit
   `claude_code.token.usage`, `claude_code.cost.usage`, `claude_code.session.count`,
   `claude_code.active_time.total`, etc. The helper ingests them live so the
   widget updates as you work.
3. **Reads your plan usage limits** — the live session and weekly rate-limit
   windows, so the widget can show how much of each you have left.

```
src/providers/claude-stats/  ─┐
  ~/.claude/*.jsonl  (parse)  │      ┌──────────────────────────────┐
  OTLP metrics       (push)   ├─────▶│  widget helper               │
  /api/oauth/usage   (fetch)  │      │  (Node, zero deps, one port) │
                             ─┘      │                              │
src/providers/<yours>/  ─────────────▶│  GET /stats/<id> ───────────┼──▶ widgets/<id>.widget
                                      │  GET /stats      (default)  │      + widget-kit/
                                      │  POST /v1/metrics ◀─────────┼── Claude Code (OTEL)
                                      └──────────────────────────────┘
```

The helper is **pure Node.js with no dependencies** — nothing to `npm install`.

---

## Requirements

- macOS
- [Node.js 18+](https://nodejs.org) (`brew install node`)
- [Übersicht](https://tracesof.net/uebersicht/) (free desktop-widget host)

---

## Quick start

```bash
git clone <this-repo> my-mac-widgets
cd my-mac-widgets

# See your stats right now in the terminal (no service needed):
node src/cli.js print

# Install: runs the helper at login + copies every widget into Übersicht
./scripts/install.sh

# Turn on live telemetry from Claude Code (optional but recommended):
./scripts/enable-telemetry.sh
# then open a new terminal so the env vars take effect
```

Refresh Übersicht (menu-bar icon → **Refresh All**) and the widget appears in the
top-left of your desktop.

---

## Layout

Everything reusable lives in `src/core/` and `widget-kit/`; everything specific
to one data source lives in its own provider folder.

| Path | What it is |
|------|-----------|
| `src/core/server.js` | Generic HTTP host — routes are derived from the registry |
| `src/core/registry.js` | Discovers `src/providers/*/`, defines the provider contract |
| `src/core/cache.js` | TTL memoization with in-flight de-duplication |
| `src/core/config.js` | Port, host, default provider, allow/deny lists |
| `src/cli.js` | CLI: `serve` (default), `list`, `print`, `parse`, `help` |
| `src/providers/claude-stats/` | The Claude Code data source (parser, telemetry, pricing, plan limits) |
| `widgets/<id>.widget/` | One Übersicht widget per folder |
| `widget-kit/kit.jsx` | Shared CSS + `Card`/`Tile`/`Bar`/`Section` components + formatters |
| `scripts/new-widget.sh` | Scaffolds a provider + widget from `scripts/templates/` |
| `scripts/deploy.sh` | Copies widgets into Übersicht |
| `scripts/install.sh` | launchd service + deploy |
| `scripts/enable-telemetry.sh` | Adds the OTEL env vars to your shell rc |

---

## Writing a widget

```bash
./scripts/new-widget.sh weather --title "Weather"
```

**1. The provider** (`src/providers/weather/index.js`) — anything `collect()`
returns is served at `/stats/weather`, cached for `ttlMs` with concurrent
callers de-duplicated into one fetch:

```js
module.exports = {
  id: 'weather',
  title: 'Weather',
  ttlMs: 600_000,
  async collect() {
    return { tempC: 18, condition: 'cloudy', generatedAt: new Date().toISOString() };
  },
  // optional: extra endpoints, e.g. to receive pushed data
  routes: [{ method: 'POST', path: '/weather/ingest', async handler(req, res, ctx) { … } }],
  // optional: how `widget-helper print weather` renders it
  print(data) { console.log(data.tempC); },
};
```

That's the whole contract. Nothing registers it — the folder *is* the
registration. `widget-helper list` shows what was found, and a provider that
fails to load is reported at `/providers` instead of taking the host down.

**2. The widget** (`widgets/weather.widget/index.jsx`) — the kit supplies the
polling command, the frosted-card chrome, and the pieces:

```jsx
import { statsCommand, parseOutput, baseCss, Card, Grid, Tile, Offline } from "./kit.jsx";

export const command = statsCommand("weather");
export const refreshFrequency = 10000;
export const className = `top: 40px; left: 380px; width: 320px; ${baseCss}`;

export const render = ({ output }) => {
  const { offline, data } = parseOutput(output);
  if (offline) return <Offline title="Weather" />;
  return (
    <Card title="Weather" live>
      <Grid columns={2}>
        <Tile value={`${data.tempC}°`} label="Now" />
        <Tile value={data.condition} label="Sky" />
      </Grid>
    </Card>
  );
};
```

Kit exports: `statsCommand`, `parseOutput`, `baseCss`, `Card`, `Grid`, `Tile`,
`Bar`, `Section`, `Foot`, `Offline`, `Message`, and the formatters `fmt`, `usd`,
`hour`, `relTime`, `pctColor`.

`kit.jsx` in each widget folder is a symlink to `widget-kit/kit.jsx`; `deploy.sh`
copies with `-L` so the deployed bundle is self-contained (Übersicht bundles each
widget folder independently).

**3. Deploy:** `./scripts/deploy.sh weather`. Übersicht runs the *copy* in its
widgets folder, so an edit in the repo is invisible until you deploy.

---

## The CLI

```
widget-helper serve              Start the helper (serves every provider). Default.
widget-helper list               List registered providers.
widget-helper print [provider]   Human-readable summary.
widget-helper parse [provider]   Full payload as JSON.
widget-helper help               Usage.
```

Run without installing anything:

```bash
node src/cli.js print
```

```
  Claude Code Statistics
  ──────────────────────────────────
  Sessions        128
  Messages        4,102
  Prompts         1,530
  Active days     43
  Current streak  6 day(s)
  Longest streak  19 day(s)
  Peak hour       10 PM
  Favorite model  claude-opus-4-8
  Total tokens    58,204,113
  Est. cost       $214.87
  ──────────────────────────────────
```

---

## Endpoints

| Route | What it returns |
|-------|-----------------|
| `GET /stats/<id>` | One provider's payload |
| `GET /stats` | The default provider (`claude-stats`), for widgets written before ids |
| `GET /providers` | The registry: ids, TTLs, routes, and anything that failed to load |
| `GET /health` | Liveness + provider ids |
| *provider routes* | e.g. `POST /v1/metrics`, `GET /limits`, `GET /telemetry` from `claude-stats` |

`GET http://127.0.0.1:4318/stats/claude-stats` returns everything that widget needs:

```jsonc
{
  "sessions": 128,
  "messages": 4102,
  "userMessages": 1530,
  "assistantMessages": 2572,
  "activeDays": 43,
  "currentStreak": 6,
  "longestStreak": 19,
  "peakHour": 22,
  "favoriteModel": "claude-opus-4-8",
  "tokens": { "input": 0, "output": 0, "cacheRead": 0, "cacheCreation": 0, "total": 0 },
  "cost": 214.87,
  "byModel": { "claude-opus-4-8": { "messages": 2100, "tokens": {…}, "cost": 190.2 } },
  "perDay": { "2026-06-30": 88 },
  "perHour": [0, 0, …],                 // 24 buckets
  "history": { "totalPrompts": 1530, "promptsByProject": {…} },
  "telemetry": {                         // live OTEL metrics (null-ish until Claude Code emits)
    "available": true,
    "costUsage": 3.11,
    "sessionCount": 4,
    "tokens": { "input": 12000, "output": 3400, … },
    "activeTimeSeconds": 900
  },
  "generatedAt": "2026-07-03T…Z"
}
```

Each provider payload is cached for its `ttlMs` (30s here, `CLAUDE_STATS_TTL_MS`), and
concurrent pollers share one fetch, so polling every 10s is cheap.

---

## Live telemetry details

Claude Code exports OTEL metrics when these env vars are set (this is exactly
what `scripts/enable-telemetry.sh` adds):

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json      # important — we accept http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_METRIC_EXPORT_INTERVAL=15000
```

> **Why `http/json`?** OTEL's default is gRPC (port 4317) or protobuf-over-HTTP,
> both of which need heavy dependencies to decode. `http/json` is plain JSON, so
> the helper stays dependency-free. Claude Code posts metrics to
> `…/v1/metrics`, which the helper handles.

The two data paths are complementary: **files** give you the historical,
derived stats (streaks, peak hour, favorite model — never emitted as metrics),
while **telemetry** gives you a live, low-latency feed of tokens/cost/sessions
as you work. The widget's status dot turns green when live telemetry is flowing.

---

## Plan usage limits (live session + weekly bars)

The widget can also show your **plan rate-limit** status — the same bars as
Claude Code's `/usage` panel: current-session %, weekly (all models) %, and
per-model weekly %, each with a reset time.

> ⚠️ **This uses an undocumented endpoint.** Anthropic exposes **no official
> personal-usage API**. The helper reads the OAuth token Claude Code stored and
> calls the same **undocumented** endpoint Claude Code's own `/usage` panel uses —
> `GET https://api.anthropic.com/api/oauth/usage` — which returns the actual
> utilization percentages and reset times. It can change or break without notice.
> **If no token is found, the helper makes no network call at all** and the
> section simply doesn't appear.

Each limit renders as **two stacked bars**, and they fill in different directions:

- **The usage bar** (thick, coloured) — how much of the quota you've *consumed*.
- **The time bar** (thin, below it) — how much of the rate-limit window has
  *elapsed*, so both bars fill left-to-right as the window progresses. Empty at
  the start of a window, full at the reset. The `Resets in …` caption underneath
  still counts down the time *remaining*.

Reading them together tells you whether you're on pace: usage well ahead of time
means you're burning quota faster than the window replenishes it.

Two things this endpoint requires (both handled for you):

- **A `claude-code/<version>` User-Agent** — without it the endpoint returns hard
  `429`s. The helper detects your installed version via `claude --version` and
  falls back to a default; override with `CLAUDE_STATS_USER_AGENT`.
- **Slow polling** — it's aggressively rate-limited, so the helper refreshes at
  most **every 180s** (the enforced floor). This is a usage *query*, so it does
  **not** consume any message/token quota.

How the token is located (first match wins):

1. `CLAUDE_CODE_OAUTH_TOKEN` env var (a token from `claude setup-token`, or any
   access token) — set this if you'd rather not have the helper touch Keychain.
2. **macOS Keychain** — the `Claude Code-credentials` item (macOS may show a
   one-time "allow access" prompt the first time).
3. `~/.claude/.credentials.json` (Linux/Windows).

Turn the whole feature off with `CLAUDE_STATS_PLAN_LIMITS=off`.

Inspect it directly:

```bash
curl -s http://127.0.0.1:4318/limits | node -e 'process.stdin.on("data",d=>console.log(d.toString()))'
```

```jsonc
{
  "available": true,
  "plan": "max",
  "bars": [
    { "id": "five_hour",        "label": "Current session",     "usedPercent": 35, "resetInSeconds": 2160, "resetAt": "…" },
    { "id": "seven_day",        "label": "Weekly · All models",  "usedPercent": 10, "resetAt": "…" },
    { "id": "seven_day_sonnet", "label": "Weekly · Sonnet",      "usedPercent": 3,  "resetAt": "…" }
  ],
  "overage": "disabled",
  "source": "keychain"
}
```

> Each bar shows its utilization `%` (with a colored fill) and, when the endpoint
> provides one, a reset countdown. A window with no numeric utilization shows just
> its reset time.

If the token has expired, the helper reports that (`run any Claude Code command
to refresh it`) instead of failing silently, and keeps showing the last good
reading dimmed and time-stamped for up to two hours.

Renewing the token is Claude Code's job by default — the helper will not touch
your credentials unless you set `CLAUDE_STATS_AUTO_REFRESH=1`. With that opted
in, it redeems the stored refresh token itself and writes the rotated credential
back to the Keychain. That is off by default deliberately: Anthropic invalidates
the old refresh token the instant a new one is issued, so a write-back that
fails — or that races Claude Code doing its own refresh — can log Claude Code
out and force you to sign in again.

---

## Configuration

**Host** (applies to every widget):

| Env var | Default | Meaning |
|---------|---------|---------|
| `WIDGET_HOST_PORT` | `4318` | Helper listen port (widgets + OTEL must match) |
| `WIDGET_HOST_HOST` | `127.0.0.1` | Helper bind address |
| `WIDGET_HOST_DEFAULT_PROVIDER` | `claude-stats` | Which provider `GET /stats` serves |
| `WIDGET_HOST_PROVIDERS` | (all) | Comma-separated allow-list of provider ids |
| `WIDGET_HOST_DISABLE` | (none) | Comma-separated deny-list of provider ids |

`CLAUDE_STATS_PORT` / `CLAUDE_STATS_HOST` still work as fallbacks.

**The `claude-stats` provider:**

| Env var | Default | Meaning |
|---------|---------|---------|
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where to read the JSONL data from |
| `CLAUDE_STATS_TTL_MS` | `30000` | File-parse cache lifetime |
| `CLAUDE_STATS_PLAN_LIMITS` | (on) | Set to `off` to disable live plan-limit probing entirely |
| `CLAUDE_STATS_LIMITS_TTL_MS` | `180000` | Plan-limit refresh interval (min 180s — enforced) |
| `CLAUDE_CODE_OAUTH_TOKEN` | (unset) | Provide the OAuth token yourself instead of reading Keychain |
| `CLAUDE_STATS_LIMITS_ERROR_TTL_MS` | `20000` | Back-off before retrying after a failed plan-limit poll |
| `CLAUDE_STATS_USER_AGENT` | `claude-code/<detected>` | User-Agent sent to the usage endpoint |
| `CLAUDE_STATS_AUTO_REFRESH` | (off) | Set to `1` to let the helper renew and re-store the OAuth token — see the warning above |
| `CLAUDE_STATS_OAUTH_CLIENT_ID` | (Claude Code's) | OAuth client id used when auto-refresh redeems the refresh token |

If you change the port, update `DEFAULT_PORT` at the top of `widget-kit/kit.jsx`
(every widget reads it from there) and re-run `./scripts/deploy.sh`.

**Custom pricing:** drop a `src/providers/claude-stats/pricing.json` (same shape
as the `PRICING` table in `pricing.js`) to override or add model prices.

---

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.uebersicht-widgets.helper.plist
rm ~/Library/LaunchAgents/com.uebersicht-widgets.helper.plist
rm -rf "$HOME/Library/Application Support/Übersicht/widgets/claude-stats.widget"
```

Remove the telemetry block from your shell rc file (marked with
`uebersicht-widgets`).

To remove a single widget, delete its `src/providers/<id>/` and
`widgets/<id>.widget/` folders and its copy in the Übersicht widgets directory —
or keep the code and hide it with `WIDGET_HOST_DISABLE=<id>`.

---

## Notes & caveats

- **The JSONL schema is internal to Claude Code and can change between releases.**
  The parser is deliberately defensive (it tolerates missing fields and skips
  malformed lines), but a future format change may need a small update to
  `src/providers/claude-stats/parser/aggregate.js`.
- **Costs are estimates.** They use public list pricing and don't know about
  subscription plans, batch discounts, or promotional rates.
- The helper binds to `127.0.0.1` only — nothing is exposed off your machine.

---

## Development

```bash
node test/run.js     # unit + end-to-end tests (no network, no deps)
node src/cli.js list # what the registry found
```

The suite is hermetic — no network, no dependencies, and it stubs the Keychain
lookup so it behaves the same on a machine that has a live Claude Code token as
on one that doesn't.
