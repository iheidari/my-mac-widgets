'use strict';

// Live "Plan usage limits" (the /usage panel: current-session + weekly bars).
//
// IMPORTANT: this uses an UNDOCUMENTED mechanism. Anthropic exposes no official
// personal-usage API, so — like the community tools (Claude-Usage-Tracker,
// Claude-Code-Usage-Monitor) — we read the OAuth token Claude Code stored and
// GET the same `/api/oauth/usage` endpoint the `/usage` panel uses, which returns
// per-window utilization percentages. It can break if Anthropic changes that
// endpoint. If no token is found we make NO network call and simply report the
// feature as unavailable.

const os = require('os');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { execFileSync } = require('child_process');

const API_HOST = 'api.anthropic.com';
const USAGE_PATH = '/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';

// The usage endpoint gates on a claude-code User-Agent — without it you get
// aggressive 429s. We detect the installed Claude Code version when possible.
let cachedUserAgent = null;
function userAgent() {
  if (process.env.CLAUDE_STATS_USER_AGENT) return process.env.CLAUDE_STATS_USER_AGENT;
  if (cachedUserAgent) return cachedUserAgent;
  let version = '2.1.0';
  try {
    const out = execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/(\d+\.\d+\.\d+)/);
    if (m) version = m[1];
  } catch (_) {
    /* claude not on PATH — fall back to default version */
  }
  cachedUserAgent = `claude-code/${version}`;
  return cachedUserAgent;
}

// ---- Credential discovery ---------------------------------------------------

function extractToken(rawJsonOrToken) {
  if (!rawJsonOrToken) return null;
  const s = String(rawJsonOrToken).trim();
  // Already a bare token?
  if (s.startsWith('sk-ant-')) return { accessToken: s, refreshToken: null, expiresAt: null, plan: null };
  try {
    const obj = JSON.parse(s);
    // Remember which key wrapped the credential so a refresh can write the
    // envelope back in exactly the shape Claude Code expects to read.
    const wrapper = obj.claudeAiOauth ? 'claudeAiOauth' : obj.oauth ? 'oauth' : null;
    const o = wrapper ? obj[wrapper] : obj;
    const accessToken = o.accessToken || o.access_token;
    if (!accessToken) return null;
    return {
      accessToken,
      refreshToken: o.refreshToken || o.refresh_token || null,
      expiresAt: o.expiresAt || o.expires_at || null,
      plan: o.subscriptionType || o.subscription_type || null,
      envelope: obj,
      wrapper,
    };
  } catch (_) {
    return null;
  }
}

// The account name on the keychain item — needed to write an updated credential
// back to the SAME item (`add-generic-password -U` matches on service+account).
// Only the opt-in refresh path ever writes, so this second `security` call (a
// blocking subprocess on the helper's single event loop) stays behind that gate.
function keychainAccount(svc) {
  try {
    const out = execFileSync('security', ['find-generic-password', '-s', svc], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = /"acct"<blob>="((?:[^"\\]|\\.)*)"/.exec(out);
    return m ? m[1] : null;
  } catch (_) {
    return null;
  }
}

function fromKeychain() {
  if (process.platform !== 'darwin') return null;
  const services = ['Claude Code-credentials', 'Claude Code', 'claude-code'];
  for (const svc of services) {
    try {
      const out = execFileSync('security', ['find-generic-password', '-s', svc, '-w'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const tok = extractToken(out);
      if (tok) return { ...tok, service: svc, account: autoRefreshEnabled() ? keychainAccount(svc) : null };
    } catch (_) {
      // service not found / access denied — try the next candidate
    }
  }
  return null;
}

// Read and write must resolve the same path — a rotated refresh token persisted
// somewhere it won't be re-read burns Claude Code's login. Resolved per call
// because tests relocate CLAUDE_CONFIG_DIR after this module loads.
function credentialsFile() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(dir, '.credentials.json');
}

function fromCredentialsFile() {
  try {
    return extractToken(fs.readFileSync(credentialsFile(), 'utf8'));
  } catch (_) {
    return null;
  }
}

function findCredential() {
  // Explicit env token wins (used by the "token I provide" setup, and testing).
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    const tok = extractToken(process.env.CLAUDE_CODE_OAUTH_TOKEN);
    if (tok) return { ...tok, source: 'env' };
  }
  const kc = fromKeychain();
  if (kc) return { ...kc, source: 'keychain' };
  const file = fromCredentialsFile();
  if (file) return { ...file, source: 'file' };
  return null;
}

// ---- OAuth refresh (OPT-IN) -------------------------------------------------
//
// The access token lives ~8h and only Claude Code renews it — so if you don't run
// Claude Code for a day, the token expires and the usage endpoint 401s until you
// do. Refreshing it ourselves closes that gap, but it is NOT free of risk:
// Anthropic ROTATES the refresh token on every refresh and invalidates the old
// one. Claude Code owns this keychain item, so if our write-back is lost (or
// races a concurrent Claude Code refresh) its stored refresh token is dead and
// you have to log in again. That is why this is off unless
// CLAUDE_STATS_AUTO_REFRESH is set — never enable it by default.

const REFRESH_HOST = 'console.anthropic.com';
const REFRESH_PATH = '/v1/oauth/token';
// The public Claude Code OAuth client id (same one the CLI's own login uses).
const CLIENT_ID = process.env.CLAUDE_STATS_OAUTH_CLIENT_ID || '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

function autoRefreshEnabled() {
  const v = process.env.CLAUDE_STATS_AUTO_REFRESH;
  return v === '1' || v === 'true' || v === 'on';
}

// Treat a token as expired 60s early — clock skew plus request latency mean a
// token expiring "in 5 seconds" is not worth spending a request on.
function isExpired(cred, skewMs = 60_000) {
  if (!cred || cred.expiresAt == null) return false; // unknown expiry → assume usable
  const ms = Number(cred.expiresAt);
  if (!Number.isFinite(ms)) return false;
  return ms - Date.now() <= skewMs;
}

function postRefresh(refreshToken, timeoutMs = 8000) {
  const payload = JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID });
  const options = {
    host: REFRESH_HOST,
    path: REFRESH_PATH,
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      'user-agent': userAgent(),
    },
  };
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (err) => resolve({ error: String(err && err.message) }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ error: 'refresh request timed out' });
    });
    req.end(payload);
  });
}

// Merge new tokens into the credential envelope, preserving every field we don't
// understand (rateLimitTier, scopes, …) so we never truncate Claude Code's record.
function mergeEnvelope(cred, tokens) {
  const envelope = cred.envelope ? JSON.parse(JSON.stringify(cred.envelope)) : {};
  if (cred.wrapper) envelope[cred.wrapper] = { ...(envelope[cred.wrapper] || {}) };
  const target = cred.wrapper ? envelope[cred.wrapper] : envelope;
  target.accessToken = tokens.accessToken;
  if (tokens.refreshToken) target.refreshToken = tokens.refreshToken;
  if (tokens.expiresAt) target.expiresAt = tokens.expiresAt;
  return envelope;
}

// Persist the rotated credential back where we found it. Returns true only on a
// confirmed write — the caller must NOT use a rotated token it failed to store,
// or the old refresh token is burned with nothing durable to show for it.
function writeBackCredential(cred, envelope) {
  const json = JSON.stringify(envelope);
  if (cred.source === 'keychain') {
    if (!cred.service || !cred.account) return false;
    try {
      // -U updates the existing item in place rather than erroring on duplicate.
      // `-w` LAST and no value: security then reads the secret from stdin (asking
      // twice) instead of taking it from argv, where every local process could
      // read the OAuth tokens straight out of `ps`. JSON.stringify escapes any
      // newline, so the two-line framing can't be broken by the payload.
      execFileSync('security', ['add-generic-password', '-U', '-a', cred.account, '-s', cred.service, '-w'], {
        input: `${json}\n${json}\n`,
        timeout: 5000,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      return true;
    } catch (_) {
      return false;
    }
  }
  if (cred.source === 'file') {
    // Write-then-rename. A truncating in-place write that dies mid-flight leaves
    // Claude Code with an empty credentials file *and* a refresh token already
    // rotated server-side — an unrecoverable logout. `mode` only applies when the
    // temp file is created, which it always is here.
    const file = credentialsFile();
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, json, { mode: 0o600 });
      fs.renameSync(tmp, file);
      return true;
    } catch (_) {
      try {
        fs.unlinkSync(tmp);
      } catch (_) {}
      return false;
    }
  }
  return false; // env-var source: nothing to write back to
}

// Refresh + persist, all-or-nothing. Resolves to a new credential or null.
// `post` is injected so the rotation logic is testable without burning a real token.
async function refreshCredential(cred, post = postRefresh) {
  if (!autoRefreshEnabled()) return null;
  if (!cred || !cred.refreshToken || cred.source === 'env') return null;
  const res = await post(cred.refreshToken);
  if (res.error || res.status !== 200) return null;
  let json;
  try {
    json = JSON.parse(res.body);
  } catch (_) {
    return null;
  }
  const accessToken = json.access_token || json.accessToken;
  if (!accessToken) return null;
  const refreshToken = json.refresh_token || json.refreshToken || null;
  const expiresIn = Number(json.expires_in || json.expiresIn);
  const tokens = {
    accessToken,
    refreshToken,
    expiresAt: Number.isFinite(expiresIn) ? Date.now() + expiresIn * 1000 : null,
  };
  const envelope = mergeEnvelope(cred, tokens);
  // If we rotated the refresh token but can't persist it, Claude Code's copy is
  // already dead server-side. Nothing we can do about that except not compound it
  // by pretending the refresh worked — report failure and let the 401 surface.
  if (!writeBackCredential(cred, envelope)) return null;
  return { ...cred, ...tokens, envelope };
}

// ---- Usage endpoint ---------------------------------------------------------

// Turn a reset value into { resetAt(ISO), resetInSeconds }. The endpoint returns
// RFC3339 today, but the source is undocumented — stay defensive and also accept
// numeric epoch (ms/seconds) and seconds-from-now, whether typed as number or string.
function parseReset(value) {
  if (value == null) return { resetAt: null, resetInSeconds: null };
  const now = Date.now();
  const asNum = Number(value);
  let ms;
  if (!isNaN(asNum) && String(value).trim() !== '') {
    if (asNum > 1e12) ms = asNum; // epoch ms
    else if (asNum > 1e9) ms = asNum * 1000; // epoch seconds
    else ms = now + asNum * 1000; // seconds-from-now
  } else {
    const d = new Date(value); // RFC3339 timestamp
    if (isNaN(d.getTime())) return { resetAt: null, resetInSeconds: null };
    ms = d.getTime();
  }
  return { resetAt: new Date(ms).toISOString(), resetInSeconds: Math.max(0, Math.round((ms - now) / 1000)) };
}

// GET the undocumented /api/oauth/usage endpoint Claude Code's /usage panel uses.
// It's a usage *query* (no message tokens billed) and returns actual percentages.
function fetchUsage(accessToken, timeoutMs = 8000) {
  const options = {
    host: API_HOST,
    path: USAGE_PATH,
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
      'anthropic-beta': OAUTH_BETA,
      'user-agent': userAgent(), // MANDATORY — without a claude-code UA you get 429s
    },
  };
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (err) => resolve({ error: String(err && err.message) }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ error: 'usage request timed out' });
    });
    req.end();
  });
}

function windowBar(id, label, order, w) {
  if (!w || typeof w !== 'object') return null;
  const usedPercent = typeof w.utilization === 'number' ? Math.round(w.utilization) : null;
  const rawReset = w.resets_at || w.resetsAt || null;
  if (usedPercent == null && !rawReset) return null;
  const { resetAt, resetInSeconds } = parseReset(rawReset);
  // `order` is a sort key only — stripped before serialization (see usageToBars).
  return { id, label, usedPercent, resetAt, resetInSeconds, order };
}

// Turn the /api/oauth/usage JSON into normalized bars.
function usageToBars(json) {
  const bars = [];
  const push = (id, label, order, w) => {
    const b = windowBar(id, label, order, w);
    if (b) bars.push(b);
  };
  push('five_hour', 'Current session', 0, json.five_hour);
  push('seven_day', 'Weekly · All models', 1, json.seven_day);
  // Per-model weekly windows: seven_day_opus, seven_day_sonnet, seven_day_fable, …
  for (const key of Object.keys(json)) {
    const m = /^seven_day_(.+)$/.exec(key);
    if (!m) continue;
    const model = m[1];
    push(key, `Weekly · ${model.charAt(0).toUpperCase()}${model.slice(1)}`, 2, json[key]);
  }
  // `overage` reflects whether extra/overage usage is turned on for the account
  // ('enabled' | 'disabled'). NOTE: this is not the old header-path meaning
  // ('allowed' | 'rejected', i.e. whether a request was blocked) — the value now
  // describes a setting, not a per-request outcome.
  let overage = null;
  if (json.extra_usage && typeof json.extra_usage === 'object') {
    overage = json.extra_usage.is_enabled ? 'enabled' : 'disabled';
  }
  bars.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  // `order` is internal to the sort above — drop it so it never leaks into the
  // /stats JSON contract the widget consumes.
  for (const b of bars) delete b.order;
  return { bars, overage };
}

// Perform one live fetch. Returns a normalized planLimits object. `findCred` and
// `fetchUsageFn` are injected so the rotation-retry path and failure classification
// can be tested without a real keychain or network (see test/run.js).
async function runFetch(findCred, fetchUsageFn, refreshFn = refreshCredential) {
  if (process.env.CLAUDE_STATS_PLAN_LIMITS === 'off') {
    return { available: false, error: 'disabled', bars: [] };
  }
  let cred = findCred();
  if (!cred) {
    return { available: false, error: 'no Claude Code credential found', bars: [] };
  }

  // Pre-emptive renewal: the stored token is already past (or within a minute of)
  // its expiry, so a fetch would certainly 401. Renew first instead of spending a
  // guaranteed-failing request. No-ops unless CLAUDE_STATS_AUTO_REFRESH is set.
  // `refreshed` records the ATTEMPT, not its success. A refresh that fails has
  // still spent the stored refresh token — Anthropic invalidates it the moment it
  // is redeemed — so replaying it below would just POST a dead token every poll.
  let refreshed = false;
  if (isExpired(cred)) {
    refreshed = true;
    const next = await refreshFn(cred);
    if (next) cred = next;
  }

  let res = await fetchUsageFn(cred.accessToken);

  // Rotation race: Claude Code owns the keychain credential and rotates the OAuth
  // token on refresh, which invalidates the PREVIOUS access token server-side
  // immediately — before its expiresAt. If we happened to read a token that was
  // just superseded, the endpoint 401s even though the credential looks valid.
  // Re-read the keychain and retry ONCE, but only if the token actually changed,
  // so a genuinely-bad token can't spin the endpoint.
  if (res.status === 401 || res.status === 403) {
    const fresh = findCred();
    if (fresh && fresh.accessToken && fresh.accessToken !== cred.accessToken) {
      cred = fresh;
      res = await fetchUsageFn(cred.accessToken);
    }
  }

  // Still rejected, and the keychain had nothing newer — the token is genuinely
  // dead rather than mid-rotation. Renew it ourselves and retry once. Guarded by
  // `refreshed` so a refresh that yields an equally-rejected token can't loop.
  if ((res.status === 401 || res.status === 403) && !refreshed) {
    const next = await refreshFn(cred);
    if (next && next.accessToken !== cred.accessToken) {
      cred = next;
      res = await fetchUsageFn(cred.accessToken);
    }
  }

  // Carry the HTTP status onto failures too (the success path already does) so the
  // cache can classify backoff structurally instead of re-parsing the error prose.
  const fail = (error, status = null) => ({ available: false, error, bars: [], source: cred.source, status });
  if (res.error) return fail(res.error);
  if (res.status === 401 || res.status === 403) {
    return fail(`token rejected (${res.status}) — run any Claude Code command to refresh it`, res.status);
  }
  if (res.status === 429) {
    return fail('rate limited (429) — usage endpoint polled too fast; backing off', res.status);
  }
  let json;
  try {
    json = JSON.parse(res.body);
  } catch (_) {
    return fail(`usage endpoint returned non-JSON (status ${res.status})`, res.status);
  }

  const { bars, overage } = usageToBars(json);
  return {
    available: bars.length > 0,
    error: bars.length ? null : 'usage endpoint returned no windows',
    bars,
    overage,
    plan: cred.plan || null,
    source: cred.source,
    status: res.status,
    updatedAt: new Date().toISOString(),
  };
}

// Live fetch against the real keychain + network.
async function fetchPlanLimits() {
  return runFetch(findCredential, fetchUsage);
}

// ---- Adaptive cache ---------------------------------------------------------

let cache = { value: null, at: 0, inflight: null };

// Last successful reading, kept so a failed poll degrades to "stale bars" instead
// of blanking the widget. Bars are 5h/7d windows — a 10-minute-old number is far
// more useful than nothing — but we stop serving them after STALE_MAX_MS, past
// which the session window may have reset and the percentages become misleading.
let lastGood = null; // { value, at }
const STALE_MAX_MS = 2 * 60 * 60 * 1000;

// Record successes; on failure, fall back to the last good bars marked `stale`.
// `available` stays false so consumers can tell this is not a live reading.
function withStale(value) {
  if (value?.available && value.bars?.length) {
    lastGood = { value, at: Date.now() };
    return value;
  }
  if (!lastGood || Date.now() - lastGood.at >= STALE_MAX_MS) return value;
  return {
    ...value,
    bars: lastGood.value.bars,
    plan: lastGood.value.plan || null,
    overage: lastGood.value.overage || null,
    stale: true,
    staleSince: lastGood.value.updatedAt || new Date(lastGood.at).toISOString(),
  };
}
// Success TTL: the /api/oauth/usage endpoint is aggressively rate-limited; ~180s
// is the safe floor. We enforce that minimum even if a smaller value is configured.
const TTL_MS = Math.max(180_000, Number(process.env.CLAUDE_STATS_LIMITS_TTL_MS) || 180_000);

// Error TTL: a transient failure (a token-rotation 401/403, a timeout, or "no
// credential yet") must NOT be pinned for the full 180s — otherwise one blip keeps
// the widget reporting an error for minutes after the keychain already holds a
// working token. Re-checking soon is cheap for these. Unlike TTL_MS (frozen at load),
// this re-reads the env each call so a test can flip CLAUDE_STATS_LIMITS_ERROR_TTL_MS.
function errorTtlMs() {
  const v = Number(process.env.CLAUDE_STATS_LIMITS_ERROR_TTL_MS);
  return Number.isFinite(v) && v >= 0 ? v : 20_000;
}

// How long a resolved value stays fresh: successes get the full window, and so does
// a 429 (it means "you polled too fast" — keep backing off). Every other failure is
// treated as transient and expires quickly. Derived from the value, not stored.
function ttlFor(value) {
  if (!value) return 0;
  if (value.available || value.status === 429) return TTL_MS;
  return errorTtlMs();
}

// `_fetch` is injectable so the adaptive-TTL behavior can be tested without a real
// keychain or network (see test/run.js).
async function getPlanLimitsCached(_fetch = fetchPlanLimits) {
  const now = Date.now();
  if (cache.value && now - cache.at < ttlFor(cache.value)) return cache.value;
  if (cache.inflight) return cache.inflight;
  cache.inflight = _fetch()
    .then((raw) => {
      const value = withStale(raw);
      cache = { value, at: Date.now(), inflight: null };
      return value;
    })
    // fetchPlanLimits catches all its own failures and always resolves a
    // normalized object, so this .catch is effectively unreachable. It's kept
    // deliberately to mirror the shared memoization shape in parser/index.js
    // (see CLAUDE.md "Caching") — do not remove it as dead code. The value has no
    // `status`, so ttlFor treats it as a short-lived error — it never pins the cache.
    .catch((err) => {
      const value = { available: false, error: String((err && err.message) || err), bars: [] };
      cache = { value, at: Date.now(), inflight: null };
      return value;
    });
  return cache.inflight;
}

// Test hook: drop the memoized value so cache-behavior tests start clean.
function _resetCache() {
  cache = { value: null, at: 0, inflight: null };
  lastGood = null;
}

// Test hook: expire the memoized value but KEEP lastGood, so the stale-fallback
// path can be exercised (TTL_MS is frozen at load, so env can't force a re-fetch).
function _expireCache() {
  cache = { value: null, at: 0, inflight: null };
}

module.exports = {
  getPlanLimitsCached,
  fetchPlanLimits,
  // exported for testing:
  runFetch,
  ttlFor,
  isExpired,
  refreshCredential,
  mergeEnvelope,
  _resetCache,
  _expireCache,
  usageToBars,
  parseReset,
  extractToken,
  findCredential,
};
