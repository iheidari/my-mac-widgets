# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
node test/run.js              # run the full test suite (also: npm test)
node src/cli.js serve         # start the helper HTTP service (default command; npm start)
node src/cli.js list          # list registered providers
node src/cli.js print [id]    # human-readable summary for a provider (default: claude-stats)
node src/cli.js parse [id]    # full provider payload as JSON

./scripts/new-widget.sh <id>  # scaffold a provider + widget from scripts/templates/
./scripts/deploy.sh [id]      # copy widget(s) into Übersicht
./scripts/install.sh          # launchd service (helper at login) + deploy all widgets
./scripts/enable-telemetry.sh # append OTEL env vars to shell rc so Claude Code emits live metrics
```

**After editing anything under `widgets/` or `widget-kit/`, deploy it without being asked:**

```bash
./scripts/deploy.sh
```

Übersicht runs the *copy* in its widgets folder, not the repo — an edit here is invisible until deployed, so a change that looks broken on screen is usually just undeployed. Übersicht watches that folder and re-renders within a second or two (menu-bar icon → **Refresh All** if it doesn't). Widget-only edits need no helper restart; `./scripts/install.sh` also deploys, but it reloads the launchd service too, which a JSX change doesn't need. Editing `widget-kit/kit.jsx` affects **every** widget, so deploy all of them (no argument), not just one.

There is no build step, no linter, and **zero runtime dependencies** — the helper is pure Node.js (>=18.15, for `fs.statfsSync`; CommonJS). Keep it that way: do not add npm dependencies. The test runner is hand-rolled on `node:assert` (no Jest/Mocha); there is no single-test filter — `test/run.js` runs everything sequentially and exits non-zero on any failure. Add new tests to that file.

**The suite is hermetic — keep it that way.** `test/run.js` stubs `child_process.execFileSync` near the top so `findCredential()`'s Keychain lookup finds nothing and `claude --version` returns a fixed string; with `CLAUDE_CONFIG_DIR` pointed at a temp fixture, all three credential sources come up empty on any machine. Without that stub the three "no credential → unavailable" tests fail on a developer's laptop (a live token flips `available` to `true`) — which is why the fix belongs in the test's environment, **not** in `planLimits.js`. The stub must stay above every provider `require`: `planLimits.js` destructures `execFileSync` at load time, so a later patch would not be seen. `credential discovery finds nothing (hermetic environment)` is the canary — if it fails, a lookup path escaped the stub and the "no credential" tests below it are meaningless.

## Architecture

This repo is a **multi-widget host**, not a single widget. One long-running HTTP server (default `127.0.0.1:4318`) serves every widget in the repo, and the boundary between "reusable" and "specific" is the provider:

```
src/core/          data-agnostic host: server, registry, cache, config
src/providers/<id>/  one data source; owns its config, fetching, parsing
widgets/<id>.widget/ one Übersicht widget; imports the shared kit
widget-kit/kit.jsx   shared CSS + components + formatters for all widgets
```

**Adding a widget must not require editing `src/core/` or `src/cli.js`.** If it does, the abstraction leaked — fix the core instead of special-casing. `scripts/new-widget.sh` scaffolds both halves from `scripts/templates/`.

### The provider contract

A provider is any directory under `src/providers/` whose `index.js` exports an async `collect()`. `registry.js` discovers it by directory listing — there is no registration list to update.

```js
module.exports = {
  id: 'weather',          // URL segment; defaults to the folder name
  title: 'Weather',       // label for `list` / /providers
  ttlMs: 600_000,         // payload cache lifetime (default 30s)
  async collect() {},     // -> the JSON a widget renders
  routes: [],             // optional extra endpoints: {method, path, handler(req,res,ctx)}
  print(data) {},         // optional CLI pretty-printer
  enabled: true,          // or a function; false hides the provider
};
```

`ctx` in a route handler is `{ sendJson, readBody, url, provider }`. A provider that throws on load is reported in `/providers` and `list` rather than taking the host down — one broken widget must never stop the others.

Routes are flattened once at boot; a duplicate `METHOD /path` across providers logs a conflict and the first registration wins. The host's own space — `GET /`, `/health`, `/providers`, `/stats`, and everything under `/stats/` — is reserved and rejected at registration. `/stats/` must be reserved by *prefix*, not as an exact key: `GET /stats/weather` collides with no literal route yet would shadow the weather provider's payload.

### Routing

| Route | Meaning |
|-------|---------|
| `GET /stats/<id>` | that provider's cached payload |
| `GET /stats` | the default provider (`WIDGET_HOST_DEFAULT_PROVIDER`, `claude-stats`) — kept so widgets written before ids keep working |
| `GET /providers` | registry contents + load failures |
| `GET /health` | liveness |

Widgets shell out to `curl` and never import the source, so **the JSON shape of `/stats/<id>` is the contract** between a provider and its widget. Changing a field name in a provider means updating that widget's `index.jsx` too.

The port `4318` is deliberately the OTLP/HTTP default: the same server receives Claude Code's metrics (`POST /v1/metrics`) and serves widgets, so no separate collector is needed. It is defaulted in five places that must stay in sync: `src/core/config.js`, `widget-kit/kit.jsx` (`DEFAULT_PORT`), and the `PORT=` line in each of `scripts/enable-telemetry.sh`, `scripts/install.sh`, and `scripts/new-widget.sh`.

### Caching

`src/core/cache.js` (`memoizeAsync`) is the one place the TTL + in-flight-dedup pattern lives: return the cached value if fresh, return the in-flight promise if a fetch is already running, otherwise start one. The registry wraps every provider's `collect()` in it, so providers should **not** cache internally — `parser/index.js` deliberately doesn't.

A provider whose payload mixes cadences opts out with **`ttlMs: 0`**, which disables the host's TTL while keeping in-flight de-duplication, and caches each source itself. `claude-stats` does this: the file scan is memoized at `STATS_TTL_MS`, `planLimits.js` keeps its own cache (richer semantics — stale-while-error retention, error back-off; leave it alone), and the telemetry snapshot is deliberately **not** cached. Freezing that snapshot inside a whole-payload memo is a regression that looks like nothing: Claude Code posts metrics every 15s and the widget's live indicator reads them, so a 30s payload TTL makes "live" telemetry up to 30s stale, including the first ingest.

### The widget kit

`widget-kit/kit.jsx` holds the shared chrome: `baseCss` (all `wk-` prefixed), `Card`/`Grid`/`Tile`/`Bar`/`Section`/`Foot`/`Offline`/`Message`, the formatters (`fmt`, `usd`, `hour`, `relTime`, `pctColor`), `openUrl()` for click handlers, and `statsCommand()`/`parseOutput()` which build the `curl` poll and normalize its output. Widgets should contribute only positioning, layout, and their own data-shaping helpers.

`openUrl()` wraps `run` from the `uebersicht` module — Übersicht marks that module external when bundling (`server.js`: `bundle.external('uebersicht')`) and supplies it at runtime, so the import resolves from the shared kit exactly as it would from a widget's own file. It shells out, so the URL is **single-quoted, with embedded quotes escaped**, never interpolated bare: these strings come back from an API. Pair it with the `wk-click` class for the cursor and hover highlight.

Each `widgets/<id>.widget/kit.jsx` is a **symlink** to `widget-kit/kit.jsx`; `deploy.sh` copies with `cp -RL` so the deployed bundle is self-contained. This matters because Übersicht bundles each widget folder independently (browserify + babel, JSX pragma `html` = `React.createElement`, exposed as a true global). Two consequences:

- Components defined in the kit work exactly as in-widget ones.
- **Do not use JSX fragments** (`<>…</>`) anywhere in widgets or the kit — the fragment pragma resolves to `React.Fragment`, which is *not* global.

To verify a widget compiles without launching Übersicht, bundle it with Übersicht's own toolchain from `/Applications/Übersicht.app/Contents/Resources/node_modules` (browserify + babelify, presets `@babel/preset-env` targeting `last 4 Safari versions` and `@babel/preset-react` with `{pragma: 'html'}`).

## The `claude-stats` provider

Fuses **three independent data sources** into one payload:

1. **Local file parsing** (`parser/`) — the historical picture (streaks, peak hour, favorite model, lifetime tokens/cost). Reads `~/.claude/projects/**/*.jsonl`, `history.jsonl`, `stats-cache.json`.
2. **Live OTLP telemetry** (`telemetry/otlpReceiver.js`) — Claude Code POSTs OpenTelemetry metrics to `/v1/metrics` as they happen. Held in memory only (`TelemetryStore`); nothing is persisted.
3. **Plan usage limits** (`planLimits.js`) — live session/weekly rate-limit bars from Anthropic's `/api/oauth/usage` endpoint.

### Parsing is defensive by design

The Claude Code JSONL schema is internal and undocumented, so the parser never assumes a shape:
- `jsonl.js` skips malformed/partial lines (counts them in `_meta.skipped`) rather than throwing.
- `aggregate.js` has `extractUsage`/`extractModel`/`extractTimestamp`/`extractRole` that each probe several possible locations (`record.message.usage`, `record.usage`, `record.data.usage`, …). When adding a field, follow this multi-location fallback pattern instead of reading one path.
- Everything degrades to `null`/`—` rather than erroring when data is missing.

This is the model for any new provider: **degrade to nulls, never throw** — a thrown `collect()` becomes a 500 and the widget shows its offline card.

### Cost estimation (`pricing.js`)

Costs are estimated locally from token counts (Anthropic exposes no cost-per-record). Model IDs are matched as **substrings, longest-key-wins**, so date suffixes (`-20260101`) and provider prefixes (`anthropic.`, bedrock) still resolve. Cache tokens are priced relative to the model's input price (write ×1.25, read ×0.1). Prices are best-effort list pricing and can be overridden by dropping a git-ignored `src/providers/claude-stats/pricing.json` (same shape as the `PRICING` table).

### Plan limits use an undocumented endpoint

`planLimits.js` is the fragile part. Anthropic has no official personal-usage API, so it:
- Discovers the Claude Code OAuth token in priority order: `CLAUDE_CODE_OAUTH_TOKEN` env → macOS Keychain (`security find-generic-password`) → `~/.claude/.credentials.json`.
- If **no** credential is found, it makes **no network call** and reports `available: false`. Preserve this — never fetch without a discovered credential.
- Sends a `claude-code/<version>` User-Agent (mandatory; the endpoint 429s without it) and the `anthropic-beta: oauth-2025-04-20` header.
- Is cached with a hard **180s minimum TTL** because the endpoint is aggressively rate-limited. Do not lower this floor.
- `usageToBars()` parses the `/api/oauth/usage` JSON into normalized bars, covered by tests and kept in sync with the widget's bar-rendering expectations. (An earlier `headersToBars()` path that parsed `anthropic-ratelimit-*` response headers was removed when the endpoint switch landed.)

#### Token expiry, stale bars, and opt-in refresh

The access token lives ~8h and **only Claude Code renews it**. Go a day without running Claude Code and the token expires, the endpoint 401s, and the bars used to vanish entirely (the widget rendered the section only when `available === true`). Two mechanisms address that:

- **Stale fallback (always on).** The cache keeps the last successful reading in `lastGood` and, when a poll fails, returns those bars with `stale: true` + `staleSince` and `available: false`. The widget renders them dimmed with an "as of Xm ago" tag (kit: `Section dim` + `relTime`). Retention is capped at `STALE_MAX_MS` (2h) — past that the 5h session window may have reset and the percentages would mislead, so the bars are dropped.
- **Auto-refresh (opt-in, `CLAUDE_STATS_AUTO_REFRESH=1`).** Uses the stored `refreshToken` against `console.anthropic.com/v1/oauth/token` and writes the rotated credential back to the Keychain.

**Auto-refresh is off by default for a reason — do not flip that default.** Anthropic rotates the refresh token on every refresh and invalidates the old one immediately. Claude Code owns that Keychain item, so a lost write-back (or a race with a concurrent Claude Code refresh) kills its stored refresh token and forces a re-login. Two invariants protect against making that worse and must be preserved:

- `refreshCredential()` is **all-or-nothing**: if `writeBackCredential()` fails it returns `null` rather than using a rotated token it couldn't persist.
- `mergeEnvelope()` preserves unknown credential fields (`scopes`, `rateLimitTier`, …) so we never truncate Claude Code's record.

`runFetch()` renews in two places: pre-emptively when `isExpired(cred)` (avoids spending a guaranteed-401 request) and after a 401 the keychain re-read couldn't resolve. The `refreshed` flag makes these mutually exclusive so a persistently-rejected token can't loop — it must be set when the refresh is **attempted**, not when it succeeds. A failed refresh has already redeemed (and thereby invalidated) the stored refresh token, so treating failure as "not yet refreshed" replays a dead token on the second path of every poll.

`writeBackCredential()` avoids two ways to lose the credential outright: the Keychain branch passes the secret on **stdin** (`-w` last, no value, payload written twice for `security`'s confirm prompt) rather than in argv where any local process can read it out of `ps`; the file branch writes a temp file and `rename()`s it, because a truncating in-place write interrupted mid-flight leaves an empty `.credentials.json` with the refresh token already rotated server-side.

## The `linear-stats` provider

Per-project ticket counts from Linear's **documented** GraphQL API (`api.linear.app/graphql`) — two requests per refresh, no SDK, no `linearis` subprocess. The CLI was rejected on facts, not taste: it stores an encrypted token we cannot reuse, and its issue payload omits `state.type`, which is the field the backlog column is *defined* by.

### The three columns are not symmetrical — this is the part to get right

| Column | Rule | Why it is like that |
|--------|------|---------------------|
| `review` | `state.name` matches `In Review` (case-insensitive) | Linear types **both** `In Progress` and `In Review` as `started`, so the type cannot distinguish them. Name-matching is the only option. |
| `backlog` | `state.type` is `backlog` **or** `unstarted` | `backlog` is Linear's Backlog page; `unstarted` is the `Todo` status, which Linear files under Active but the user counts as backlog. Both, deliberately. |
| `ready` | a **backlog** issue carrying the `Ready to play` label | A strict subset of `backlog`, never a third independent bucket — a labelled `In Review` issue must not inflate it. |

Because `review` matches by name, renaming that status in Linear would silently report zero. `aggregate()` therefore also checks the workspace's `workflowStates` and returns `reviewStateKnown: false` when nothing matches, which the widget renders as a warning. Keep that — a zero the user cannot explain is worse than no number.

Completed, canceled and duplicate work is excluded server-side by the `state.type` filter. Projects whose status type is `completed`/`canceled` get no row, and their issues are dropped rather than reappearing under the `— no project` bucket (which exists only for issues with a genuinely null project, and is hidden when empty). Rows are sorted busiest-first: backlog desc, review desc, name.

### Credential

`LINEAR_API_KEY` env → macOS Keychain (`security find-generic-password -s linear-stats`). No file fallback: Linear writes no credential to disk for us to read, so a file would be one we invented and one more copy of a full-permission secret. **No key found ⇒ no network call**, `available: false` — preserve this. `install.sh` offers to store one (prompt is `read -rs`, and the secret goes to `security` on **stdin**, not argv).

A Linear personal API key carries the user's full workspace permissions — Linear has no read-only variant. This provider only ever issues queries; keep it that way.

### Caching

`ttlMs: 0` (host in-flight de-dup only) plus an internal adaptive cache, same shape as `planLimits.js`: 5-minute success TTL, 60s for transient failures, and the **full** window for auth failures and 429s so a revoked key isn't retried every poll. `lastGood` retains the previous counts and a failed poll returns them with `stale: true` + `staleSince`, rendered dimmed. Unlike the plan-limit bars there is deliberately **no** `STALE_MAX_MS` cap: a ticket count from this morning is still a true statement about this morning, whereas a usage percentage from before a window reset is actively wrong.

`PAGE_SIZE` (50) and `labels(first: 20)` are held below the API's maxima on purpose — Linear rejects requests over a complexity budget that counts nested selections, and `linearis` trips it at 100.

## Conventions

- All source uses `'use strict'` CommonJS. Match the existing terse, comment-the-why style.
- Host env overrides: `WIDGET_HOST_PORT`, `WIDGET_HOST_HOST`, `WIDGET_HOST_DEFAULT_PROVIDER`, `WIDGET_HOST_PROVIDERS` (allow-list), `WIDGET_HOST_DISABLE` (deny-list). `CLAUDE_STATS_PORT`/`CLAUDE_STATS_HOST` remain as fallbacks.
- `claude-stats` env overrides: `CLAUDE_CONFIG_DIR` (relocates `~/.claude`), `CLAUDE_STATS_TTL_MS`, `CLAUDE_STATS_LIMITS_TTL_MS`, `CLAUDE_STATS_LIMITS_ERROR_TTL_MS`, `CLAUDE_STATS_PLAN_LIMITS=off`, `CLAUDE_STATS_USER_AGENT`, `CLAUDE_STATS_AUTO_REFRESH`, `CLAUDE_STATS_OAUTH_CLIENT_ID`. Tests drive the parser by pointing `CLAUDE_CONFIG_DIR` at a temp fixture. New providers should namespace their own vars the same way.
- `system-status` env overrides: `SYSTEM_STATUS_DISK_VOLUME`, `SYSTEM_STATUS_PROBE_URL`, `SYSTEM_STATUS_PROBE_INTERVAL_MS`, `SYSTEM_STATUS_PROBE_OFFLINE_INTERVAL_MS`, `SYSTEM_STATUS_RETRY_DELAY_MS`, `SYSTEM_STATUS_RETRIES`, `SYSTEM_STATUS_IDLE_STOP_MS`.
- `linear-stats` env overrides: `LINEAR_API_KEY`, `LINEAR_STATS=off`, `LINEAR_STATS_TTL_MS`, `LINEAR_STATS_ERROR_TTL_MS`, `LINEAR_STATS_REVIEW_STATES` (comma-separated state names), `LINEAR_STATS_READY_LABEL`.
- The launchd service is `com.uebersicht-widgets.helper` (logs in `~/Library/Logs/uebersicht-widgets/`). `install.sh` removes the legacy `com.claude-stats.helper` so the two can't fight over the port.
- The server binds `127.0.0.1` only and reads local files/credentials — treat it as a localhost-only tool, not a network service.
