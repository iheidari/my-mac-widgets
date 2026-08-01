'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`      ${(err && err.message) || err}`);
  }
}

// ---- Build a temporary ~/.claude fixture ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-stats-test-'));
const projectsDir = path.join(tmp, 'projects', 'my-project');
fs.mkdirSync(projectsDir, { recursive: true });

// Two active days: yesterday and today, so streak logic exercises.
const today = new Date();
const yesterday = new Date(Date.now() - 86_400_000);
function at(base, h) {
  const d = new Date(base);
  d.setHours(h, 0, 0, 0);
  return d.toISOString();
}

const sessionA = [
  { type: 'user', sessionId: 'sess-a', cwd: '/home/me/proj', timestamp: at(yesterday, 14), message: { role: 'user' } },
  {
    type: 'assistant',
    sessionId: 'sess-a',
    timestamp: at(yesterday, 14),
    message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 100 } },
  },
  'this is not valid json and should be skipped',
  { type: 'user', sessionId: 'sess-a', timestamp: at(today, 14), message: { role: 'user' } },
  {
    type: 'assistant',
    sessionId: 'sess-a',
    timestamp: at(today, 14),
    message: { role: 'assistant', model: 'claude-sonnet-5', usage: { input_tokens: 400, output_tokens: 200 } },
  },
];

const sessionB = [
  {
    type: 'assistant',
    sessionId: 'sess-b',
    timestamp: at(today, 14),
    message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 50 } },
  },
];

fs.writeFileSync(
  path.join(projectsDir, 'sess-a.jsonl'),
  sessionA.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n'
);
fs.writeFileSync(path.join(projectsDir, 'sess-b.jsonl'), sessionB.map((r) => JSON.stringify(r)).join('\n') + '\n');

fs.writeFileSync(
  path.join(tmp, 'history.jsonl'),
  [
    JSON.stringify({ display: 'fix the bug', project: '/home/me/proj', timestamp: at(today, 14) }),
    JSON.stringify({ display: 'add tests', project: '/home/me/proj' }),
    '',
  ].join('\n')
);

fs.writeFileSync(path.join(tmp, 'stats-cache.json'), JSON.stringify({ totalSessions: 2 }));

process.env.CLAUDE_CONFIG_DIR = tmp;

// ---- Hermetic credential environment ----
//
// planLimits discovers a credential in three steps: CLAUDE_CODE_OAUTH_TOKEN →
// macOS Keychain → $CLAUDE_CONFIG_DIR/.credentials.json. The env var and the
// file are already neutralized (the fixture dir above has no credentials file),
// but the Keychain step shells out to `security` and, on a machine that runs
// Claude Code, finds a live token — which used to flip every "no credential"
// assertion in this suite and made three tests fail on developer laptops only.
//
// Stub that one subprocess so the suite sees the same empty environment
// everywhere. This must happen BEFORE any provider module is required:
// planLimits destructures `execFileSync` at load time, so a later patch to
// child_process would not be seen by it.
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
const childProcess = require('child_process');
const realExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = (file, args, opts) => {
  if (file === 'security') {
    // What `security find-generic-password` does when the item isn't there.
    const err = new Error('SecKeychainSearchCopyNext: The specified item could not be found in the keychain.');
    err.status = 44;
    throw err;
  }
  // `claude --version`, used to build the User-Agent — pin it instead of
  // depending on which Claude Code the developer happens to have installed.
  if (file === 'claude') return '9.9.9 (Claude Code)\n';
  return realExecFileSync(file, args, opts);
};

// ---- Tests ----
(async () => {
  console.log('\nParser');

  const { parseSessions } = require('../src/providers/claude-stats/parser/sessions');
  const stats = await parseSessions(projectsDir);

  await test('counts distinct sessions', () => assert.strictEqual(stats.sessions, 2));
  await test('counts user + assistant messages', () => {
    assert.strictEqual(stats.userMessages, 2);
    assert.strictEqual(stats.assistantMessages, 3);
    assert.strictEqual(stats.messages, 5);
  });
  await test('skips malformed lines without crashing', () =>
    assert.strictEqual(stats._meta.skipped, 1));
  await test('sums tokens across models', () => {
    assert.strictEqual(stats.tokens.input, 1500);
    assert.strictEqual(stats.tokens.output, 750);
    assert.strictEqual(stats.tokens.cacheRead, 2000);
    assert.strictEqual(stats.tokens.cacheCreation, 100);
  });
  await test('computes 2-day active streak', () => {
    assert.strictEqual(stats.activeDays, 2);
    assert.strictEqual(stats.currentStreak, 2);
    assert.strictEqual(stats.longestStreak, 2);
  });
  await test('finds peak hour (14:00)', () => assert.strictEqual(stats.peakHour, 14));
  await test('favorite model is the most-used', () =>
    assert.strictEqual(stats.favoriteModel, 'claude-opus-4-8'));
  await test('estimates a positive cost', () => assert.ok(stats.cost > 0));

  // Verify cost math precisely for the opus records:
  // yesterday: in 1000*5/1e6 + out 500*25/1e6 + cacheRead 2000*0.5/1e6 + cacheWrite 100*6.25/1e6
  //          = 0.005 + 0.0125 + 0.001 + 0.000625 = 0.019125
  // today opus b: in 100*5/1e6 + out 50*25/1e6 = 0.0005 + 0.00125 = 0.00175
  await test('opus cost breakdown matches pricing', () => {
    const opus = stats.byModel['claude-opus-4-8'];
    assert.ok(opus, 'opus entry exists');
    // byModel.cost is rounded to 4 decimals in finalize(), so allow for that.
    assert.ok(Math.abs(opus.cost - (0.019125 + 0.00175)) < 5e-5, `got ${opus.cost}`);
  });

  console.log('\nPricing');
  const pricing = require('../src/providers/claude-stats/pricing');
  await test('matches model id with date suffix', () =>
    assert.ok(pricing.priceForModel('claude-opus-4-8-20260101')));
  await test('matches bedrock-prefixed model id', () =>
    assert.ok(pricing.priceForModel('anthropic.claude-sonnet-5')));
  await test('unknown model returns null price', () =>
    assert.strictEqual(pricing.priceForModel('gpt-4'), null));

  console.log('\nHistory');
  const { parseHistory } = require('../src/providers/claude-stats/parser/history');
  const hist = await parseHistory(path.join(tmp, 'history.jsonl'));
  await test('counts prompts', () => assert.strictEqual(hist.totalPrompts, 2));

  console.log('\nTelemetry (OTLP http/json)');
  const { TelemetryStore } = require('../src/providers/claude-stats/telemetry/otlpReceiver');
  const store = new TelemetryStore();
  store.ingest({
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: 'claude_code.token.usage',
                sum: {
                  isMonotonic: true,
                  dataPoints: [
                    { asInt: '1200', attributes: [{ key: 'type', value: { stringValue: 'input' } }] },
                    { asInt: '340', attributes: [{ key: 'type', value: { stringValue: 'output' } }] },
                  ],
                },
              },
              { name: 'claude_code.cost.usage', sum: { dataPoints: [{ asDouble: 0.42 }] } },
              { name: 'claude_code.session.count', sum: { dataPoints: [{ asInt: '3' }] } },
            ],
          },
        ],
      },
    ],
  });
  const snap = store.snapshot();
  await test('decodes token.usage by type', () => {
    assert.strictEqual(snap.tokens.input, 1200);
    assert.strictEqual(snap.tokens.output, 340);
  });
  await test('decodes cost + session count', () => {
    assert.strictEqual(snap.costUsage, 0.42);
    assert.strictEqual(snap.sessionCount, 3);
  });
  await test('reports availability after ingest', () => assert.strictEqual(snap.available, true));

  console.log('\nPlan limits (/api/oauth/usage parsing, no network)');
  const pl = require('../src/providers/claude-stats/planLimits');
  // If this fails, the stub at the top of this file stopped covering a lookup
  // path and the "no credential" tests below are testing the developer's real
  // token instead of the empty case.
  await test('credential discovery finds nothing (hermetic environment)', () =>
    assert.strictEqual(pl.findCredential(), null));
  await test('usageToBars parses /api/oauth/usage JSON (35/10/3)', () => {
    const future = new Date(Date.now() + 36 * 60 * 1000).toISOString();
    const { bars, overage } = pl.usageToBars({
      five_hour: { utilization: 35.0, resets_at: future },
      seven_day: { utilization: 10.0, resets_at: future },
      seven_day_opus: { utilization: null, resets_at: null },
      seven_day_sonnet: { utilization: 3.0, resets_at: future },
      extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
    });
    // five_hour + seven_day + seven_day_sonnet (opus is null → dropped)
    assert.strictEqual(bars.length, 3);
    assert.strictEqual(bars[0].label, 'Current session');
    assert.strictEqual(bars[0].usedPercent, 35);
    assert.ok(bars[0].resetInSeconds > 2100 && bars[0].resetInSeconds <= 2160);
    assert.strictEqual(bars[1].label, 'Weekly · All models');
    assert.strictEqual(bars[1].usedPercent, 10);
    assert.strictEqual(bars[2].label, 'Weekly · Sonnet');
    assert.strictEqual(bars[2].usedPercent, 3);
    assert.strictEqual(overage, 'disabled');
  });
  await test('usageToBars keeps a bar with utilization but no reset (resetAt null)', () => {
    const { bars } = pl.usageToBars({ five_hour: { utilization: 42, resets_at: null } });
    assert.strictEqual(bars.length, 1);
    assert.strictEqual(bars[0].usedPercent, 42);
    assert.strictEqual(bars[0].resetAt, null);
    assert.strictEqual(bars[0].resetInSeconds, null);
  });
  await test('usageToBars maps extra_usage.is_enabled -> overage "enabled"', () => {
    const { overage } = pl.usageToBars({ extra_usage: { is_enabled: true } });
    assert.strictEqual(overage, 'enabled');
  });
  await test('usageToBars does not leak the internal order sort key', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const { bars } = pl.usageToBars({ five_hour: { utilization: 5, resets_at: future } });
    assert.ok(!('order' in bars[0]), 'order stripped from serialized bar');
    assert.ok(!('status' in bars[0]), 'no dead status field on serialized bar');
  });
  await test('parseReset accepts RFC3339, epoch seconds, and epoch ms', () => {
    const iso = pl.parseReset('2030-01-01T00:00:00Z');
    assert.ok(iso.resetInSeconds > 0 && iso.resetAt.startsWith('2030-01-01'));
    const secs = pl.parseReset(String(Math.floor(Date.now() / 1000) + 3600));
    assert.ok(secs.resetInSeconds > 3400 && secs.resetInSeconds <= 3600, `epoch seconds: ${secs.resetInSeconds}`);
    const ms = pl.parseReset(Date.now() + 3600_000); // numeric epoch ms
    assert.ok(ms.resetInSeconds > 3400 && ms.resetInSeconds <= 3600, `epoch ms: ${ms.resetInSeconds}`);
    assert.deepStrictEqual(pl.parseReset(null), { resetAt: null, resetInSeconds: null });
    assert.deepStrictEqual(pl.parseReset('not-a-date'), { resetAt: null, resetInSeconds: null });
  });
  await test('extractToken reads Claude Code oauth json', () => {
    const t = pl.extractToken(JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-x', expiresAt: 1, subscriptionType: 'max' } }));
    assert.strictEqual(t.accessToken, 'sk-ant-oat01-x');
    assert.strictEqual(t.plan, 'max');
  });
  await test('runFetch retries once with a fresh token when the endpoint 401s (rotation race)', async () => {
    // Claude Code rotates the OAuth token on refresh, invalidating the previous
    // access token server-side immediately. The first keychain read hands us the
    // stale token (401); the retry re-reads and gets the rotated one (200).
    let reads = 0;
    const findCred = () => ({ accessToken: reads++ === 0 ? 'sk-ant-STALE' : 'sk-ant-FRESH', source: 'keychain', plan: 'max' });
    const seen = [];
    const fetchUsageFn = async (tok) => {
      seen.push(tok);
      if (tok === 'sk-ant-STALE') return { status: 401, body: '' };
      return { status: 200, body: JSON.stringify({ five_hour: { utilization: 12, resets_at: new Date(Date.now() + 60_000).toISOString() } }) };
    };
    const res = await pl.runFetch(findCred, fetchUsageFn);
    assert.deepStrictEqual(seen, ['sk-ant-STALE', 'sk-ant-FRESH'], 'retried once with the re-read token');
    assert.strictEqual(res.available, true);
    assert.strictEqual(res.bars[0].usedPercent, 12);
  });
  await test('runFetch does NOT retry when the re-read token is unchanged (no spin)', async () => {
    const findCred = () => ({ accessToken: 'sk-ant-SAME', source: 'keychain' });
    const seen = [];
    const fetchUsageFn = async (tok) => { seen.push(tok); return { status: 401, body: '' }; };
    const res = await pl.runFetch(findCred, fetchUsageFn);
    assert.strictEqual(seen.length, 1, 'a genuinely-bad token is not retried');
    assert.strictEqual(res.available, false);
    assert.ok(/token rejected \(401\)/.test(res.error));
  });
  await test('ttlFor caches transient errors briefly but successes and 429 for the full window', () => {
    const ok = pl.ttlFor({ available: true, bars: [{}] });
    const rejected = pl.ttlFor({ available: false, error: 'token rejected (401) — run any Claude Code command to refresh it' });
    const limited = pl.ttlFor({ available: false, status: 429, error: 'rate limited (429) — usage endpoint polled too fast; backing off' });
    assert.ok(rejected < ok, 'transient errors expire sooner than successes');
    assert.strictEqual(limited, ok, '429 keeps the full backoff window');
  });
  await test('getPlanLimitsCached does not pin a transient error for the full TTL', async () => {
    process.env.CLAUDE_STATS_LIMITS_ERROR_TTL_MS = '0'; // errors immediately stale
    pl._resetCache();
    let n = 0;
    const fakeFetch = async () => {
      n += 1;
      if (n === 1) return { available: false, error: 'token rejected (401) — run any Claude Code command to refresh it', bars: [], source: 'keychain' };
      return { available: true, error: null, bars: [{ id: 'five_hour', usedPercent: 5 }], source: 'keychain' };
    };
    const a = await pl.getPlanLimitsCached(fakeFetch);
    assert.strictEqual(a.available, false); // first call: the transient 401
    const b = await pl.getPlanLimitsCached(fakeFetch);
    assert.strictEqual(b.available, true); // NOT pinned 180s → re-fetched and recovered
    assert.strictEqual(n, 2);
    const c = await pl.getPlanLimitsCached(fakeFetch);
    assert.strictEqual(c.available, true);
    assert.strictEqual(n, 2, 'a successful result IS served from cache');
    delete process.env.CLAUDE_STATS_LIMITS_ERROR_TTL_MS;
    pl._resetCache();
  });
  await test('isExpired honours the skew window and unknown expiries', () => {
    assert.strictEqual(pl.isExpired({ expiresAt: Date.now() + 3600_000 }), false, 'fresh token');
    assert.strictEqual(pl.isExpired({ expiresAt: Date.now() - 1000 }), true, 'past expiry');
    assert.strictEqual(pl.isExpired({ expiresAt: Date.now() + 30_000 }), true, 'inside the 60s skew');
    assert.strictEqual(pl.isExpired({ expiresAt: null }), false, 'unknown expiry is assumed usable');
  });
  await test('mergeEnvelope rotates tokens without dropping unknown fields', () => {
    const cred = {
      wrapper: 'claudeAiOauth',
      envelope: { claudeAiOauth: { accessToken: 'old', refreshToken: 'r-old', expiresAt: 1, scopes: ['a'], rateLimitTier: 'x' } },
    };
    const out = pl.mergeEnvelope(cred, { accessToken: 'new', refreshToken: 'r-new', expiresAt: 999 });
    assert.strictEqual(out.claudeAiOauth.accessToken, 'new');
    assert.strictEqual(out.claudeAiOauth.refreshToken, 'r-new');
    assert.strictEqual(out.claudeAiOauth.expiresAt, 999);
    assert.deepStrictEqual(out.claudeAiOauth.scopes, ['a'], 'unknown fields preserved');
    assert.strictEqual(out.claudeAiOauth.rateLimitTier, 'x');
    assert.strictEqual(cred.envelope.claudeAiOauth.accessToken, 'old', 'source envelope not mutated');
  });
  await test('refreshCredential is inert unless CLAUDE_STATS_AUTO_REFRESH is set', async () => {
    delete process.env.CLAUDE_STATS_AUTO_REFRESH;
    let called = false;
    const post = async () => { called = true; return { status: 200, body: '{}' }; };
    const out = await pl.refreshCredential({ refreshToken: 'r', source: 'keychain' }, post);
    assert.strictEqual(out, null);
    assert.strictEqual(called, false, 'no refresh request without the opt-in flag');
  });
  await test('refreshCredential refuses to return a token it could not persist', async () => {
    process.env.CLAUDE_STATS_AUTO_REFRESH = '1';
    // source 'keychain' with no service/account -> writeBackCredential fails.
    const post = async () => ({ status: 200, body: JSON.stringify({ access_token: 'new', refresh_token: 'r-new', expires_in: 28800 }) });
    const out = await pl.refreshCredential({ refreshToken: 'r-old', source: 'keychain', wrapper: null, envelope: {} }, post);
    assert.strictEqual(out, null, 'a rotated token that cannot be stored is not used');
    delete process.env.CLAUDE_STATS_AUTO_REFRESH;
  });
  await test('runFetch renews pre-emptively when the stored token is already expired', async () => {
    const cred = { accessToken: 'sk-ant-DEAD', expiresAt: Date.now() - 1000, source: 'keychain' };
    const seen = [];
    const fetchUsageFn = async (tok) => {
      seen.push(tok);
      if (tok !== 'sk-ant-RENEWED') return { status: 401, body: '' };
      return { status: 200, body: JSON.stringify({ five_hour: { utilization: 7, resets_at: new Date(Date.now() + 60_000).toISOString() } }) };
    };
    const refreshFn = async (c) => ({ ...c, accessToken: 'sk-ant-RENEWED', expiresAt: Date.now() + 3600_000 });
    const res = await pl.runFetch(() => cred, fetchUsageFn, refreshFn);
    assert.deepStrictEqual(seen, ['sk-ant-RENEWED'], 'no request spent on the known-expired token');
    assert.strictEqual(res.available, true);
    assert.strictEqual(res.bars[0].usedPercent, 7);
  });
  await test('runFetch renews after a 401 the keychain re-read could not resolve', async () => {
    const cred = { accessToken: 'sk-ant-SAME', expiresAt: Date.now() + 3600_000, source: 'keychain' };
    const seen = [];
    const fetchUsageFn = async (tok) => {
      seen.push(tok);
      if (tok !== 'sk-ant-RENEWED') return { status: 401, body: '' };
      return { status: 200, body: JSON.stringify({ five_hour: { utilization: 9, resets_at: new Date(Date.now() + 60_000).toISOString() } }) };
    };
    let refreshes = 0;
    const refreshFn = async (c) => { refreshes += 1; return { ...c, accessToken: 'sk-ant-RENEWED' }; };
    const res = await pl.runFetch(() => cred, fetchUsageFn, refreshFn);
    assert.deepStrictEqual(seen, ['sk-ant-SAME', 'sk-ant-RENEWED']);
    assert.strictEqual(refreshes, 1, 'refreshed exactly once');
    assert.strictEqual(res.available, true);
  });
  await test('runFetch does not loop when the renewed token is also rejected', async () => {
    const cred = { accessToken: 'sk-ant-DEAD', expiresAt: Date.now() - 1000, source: 'keychain' };
    let calls = 0;
    const fetchUsageFn = async () => { calls += 1; return { status: 401, body: '' }; };
    let refreshes = 0;
    const refreshFn = async (c) => { refreshes += 1; return { ...c, accessToken: `sk-ant-R${refreshes}` }; };
    const res = await pl.runFetch(() => cred, fetchUsageFn, refreshFn);
    assert.strictEqual(refreshes, 1, 'pre-emptive renewal blocks a second refresh on 401');
    assert.ok(calls <= 2, `bounded request count, got ${calls}`);
    assert.strictEqual(res.available, false);
  });
  // Anthropic invalidates a refresh token the moment it is redeemed, so a refresh
  // that FAILED has still burned it. Counting only successes as "refreshed" would
  // replay that dead token on the 401 path of every single poll.
  await test('runFetch does not replay the refresh token after a failed pre-emptive renewal', async () => {
    const cred = { accessToken: 'sk-ant-DEAD', expiresAt: Date.now() - 1000, source: 'keychain' };
    let calls = 0;
    const fetchUsageFn = async () => { calls += 1; return { status: 401, body: '' }; };
    let refreshes = 0;
    const refreshFn = async () => { refreshes += 1; return null; }; // e.g. write-back failed
    const res = await pl.runFetch(() => cred, fetchUsageFn, refreshFn);
    assert.strictEqual(refreshes, 1, 'an attempted refresh counts, even when it fails');
    assert.ok(calls <= 2, `bounded request count, got ${calls}`);
    assert.strictEqual(res.available, false);
  });
  await test('a failed poll degrades to stale bars instead of blanking the widget', async () => {
    process.env.CLAUDE_STATS_LIMITS_ERROR_TTL_MS = '0';
    pl._resetCache();
    let n = 0;
    const fakeFetch = async () => {
      n += 1;
      if (n === 1) {
        return { available: true, error: null, bars: [{ id: 'five_hour', usedPercent: 44 }], plan: 'max', source: 'keychain', updatedAt: new Date().toISOString() };
      }
      return { available: false, error: 'token rejected (401)', bars: [], source: 'keychain', status: 401 };
    };
    const good = await pl.getPlanLimitsCached(fakeFetch);
    assert.strictEqual(good.available, true);
    assert.ok(!good.stale, 'a live reading is not marked stale');
    pl._expireCache(); // drop the memoized success but keep lastGood
    const stale = await pl.getPlanLimitsCached(fakeFetch);
    assert.strictEqual(stale.available, false, 'still reported as not live');
    assert.strictEqual(stale.stale, true);
    assert.strictEqual(stale.bars.length, 1, 'last-good bars retained');
    assert.strictEqual(stale.bars[0].usedPercent, 44);
    assert.strictEqual(stale.plan, 'max');
    assert.ok(stale.staleSince, 'staleSince timestamp present');
    delete process.env.CLAUDE_STATS_LIMITS_ERROR_TTL_MS;
    delete process.env.CLAUDE_STATS_LIMITS_TTL_MS;
    pl._resetCache();
  });
  await test('no credential -> unavailable, no network call', async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    // The "no network call" half of the name was never actually asserted.
    // Count https.request calls so a regression that fetches without a
    // credential fails here rather than silently hitting the endpoint.
    const https = require('https');
    const realRequest = https.request;
    let requests = 0;
    https.request = (...args) => {
      requests += 1;
      return realRequest.apply(https, args);
    };
    try {
      const res = await pl.fetchPlanLimits();
      assert.strictEqual(res.available, false);
      assert.ok(/no Claude Code credential/.test(res.error));
      assert.strictEqual(requests, 0, 'made no network request');
    } finally {
      https.request = realRequest;
    }
  });

  console.log('\nCore cache');
  const { memoizeAsync } = require('../src/core/cache');
  await test('reuses the value inside the ttl, refetches after invalidate', async () => {
    let calls = 0;
    const read = memoizeAsync(async () => ++calls, { ttlMs: 60_000 });
    assert.strictEqual(await read(), 1);
    assert.strictEqual(await read(), 1);
    read.invalidate();
    assert.strictEqual(await read(), 2);
  });
  await test('de-duplicates concurrent callers into one fetch', async () => {
    let calls = 0;
    const read = memoizeAsync(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return calls;
    });
    const [a, b, c] = await Promise.all([read(), read(), read()]);
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual([a, b, c], [1, 1, 1]);
  });
  await test('a rejected fetch is not cached', async () => {
    let calls = 0;
    const read = memoizeAsync(async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return 'ok';
    });
    await assert.rejects(read(), /boom/);
    assert.strictEqual(await read(), 'ok');
  });
  // Providers are told to degrade to null rather than throw, so null is a
  // legitimate payload — sniffing the value for freshness would never cache it.
  await test('caches a null payload instead of refetching forever', async () => {
    let calls = 0;
    const read = memoizeAsync(async () => {
      calls += 1;
      return null;
    });
    assert.strictEqual(await read(), null);
    assert.strictEqual(await read(), null);
    assert.strictEqual(calls, 1);
  });

  console.log('\nProvider registry');
  const { loadProviders, indexById } = require('../src/core/registry');
  const registry = loadProviders();
  await test('discovers claude-stats from src/providers/', () => {
    const byId = indexById(registry.providers);
    assert.ok(byId.has('claude-stats'), 'claude-stats registered');
    assert.strictEqual(typeof byId.get('claude-stats').module.collect, 'function');
  });
  await test('no provider failed to load', () =>
    assert.deepStrictEqual(registry.failed, []));
  await test('rejects a provider without collect()', () => {
    const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'providers-'));
    fs.mkdirSync(path.join(bad, 'broken'));
    fs.writeFileSync(path.join(bad, 'broken', 'index.js'), 'module.exports = {};');
    const res = loadProviders(bad);
    assert.deepStrictEqual(res.providers, []);
    assert.strictEqual(res.failed.length, 1);
    assert.match(res.failed[0].error, /collect/);
  });
  // ttlMs: 0 means "don't cache", not "unset" — a provider whose payload has a
  // live component (claude-stats' telemetry snapshot) relies on it.
  await test('ttlMs: 0 disables host caching instead of falling back to the default', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'providers-'));
    fs.mkdirSync(path.join(dir, 'live'));
    fs.writeFileSync(
      path.join(dir, 'live', 'index.js'),
      'let n = 0;\nmodule.exports = { ttlMs: 0, async collect() { n += 1; return { n }; } };'
    );
    const [p] = loadProviders(dir).providers;
    assert.strictEqual(p.ttlMs, 0);
    assert.strictEqual((await p.read()).n, 1);
    assert.strictEqual((await p.read()).n, 2, 'each read re-collects');
  });
  await test('an absent ttlMs still gets the 30s default', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'providers-'));
    fs.mkdirSync(path.join(dir, 'plain'));
    fs.writeFileSync(path.join(dir, 'plain', 'index.js'), 'module.exports = { async collect() { return {}; } };');
    assert.strictEqual(loadProviders(dir).providers[0].ttlMs, 30_000);
  });

  console.log('\nServer (end to end)');
  const { start, isReservedRoute } = require('../src/core/server');

  // /stats is dispatched by prefix, so reserving it as an exact key would let
  // `GET /stats/weather` register cleanly and then shadow the weather provider.
  await test('the host reserves /stats by prefix, not just as an exact path', () => {
    assert.ok(isReservedRoute('GET', '/stats'));
    assert.ok(isReservedRoute('GET', '/stats/weather'));
    assert.ok(isReservedRoute('GET', '/health'));
    assert.ok(isReservedRoute('GET', '/'));
    assert.ok(!isReservedRoute('GET', '/limits'), 'provider routes outside the host space are fine');
    assert.ok(!isReservedRoute('POST', '/v1/metrics'));
    assert.ok(!isReservedRoute('GET', '/statsomething'), 'prefix match must respect the separator');
  });

  const { server, port } = await start({ port: 0, host: '127.0.0.1' });

  function req(method, p, body) {
    return new Promise((resolve, reject) => {
      const data = body ? Buffer.from(JSON.stringify(body)) : null;
      const r = http.request(
        { method, host: '127.0.0.1', port, path: p, headers: data ? { 'Content-Type': 'application/json' } : {} },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
        }
      );
      r.on('error', reject);
      if (data) r.write(data);
      r.end();
    });
  }

  const health = await req('GET', '/health');
  await test('/health returns ok', () => assert.strictEqual(health.body.ok, true));

  const post = await req('POST', '/v1/metrics', {
    resourceMetrics: [
      { scopeMetrics: [{ metrics: [{ name: 'claude_code.cost.usage', sum: { dataPoints: [{ asDouble: 1.5 }] } }] }] },
    ],
  });
  await test('POST /v1/metrics accepts OTLP json', () => assert.strictEqual(post.status, 200));

  const statsRes = await req('GET', '/stats');
  await test('/stats merges files + telemetry + planLimits', () => {
    assert.ok(statsRes.body.sessions >= 0);
    assert.strictEqual(statsRes.body.telemetry.costUsage, 1.5);
    assert.strictEqual(statsRes.body.telemetry.available, true);
    assert.ok(statsRes.body.planLimits, 'planLimits present');
    assert.strictEqual(statsRes.body.planLimits.available, false); // no token in test env
  });

  const byIdRes = await req('GET', '/stats/claude-stats');
  await test('/stats/<id> serves the same payload as the /stats alias', () => {
    assert.strictEqual(byIdRes.status, 200);
    assert.strictEqual(byIdRes.body.sessions, statsRes.body.sessions);
    assert.strictEqual(byIdRes.body.telemetry.costUsage, 1.5);
  });

  const missingRes = await req('GET', '/stats/nope');
  await test('/stats/<unknown> 404s and lists what is available', () => {
    assert.strictEqual(missingRes.status, 404);
    assert.ok(missingRes.body.available.includes('claude-stats'));
  });

  const provRes = await req('GET', '/providers');
  await test('/providers describes the registry', () => {
    assert.strictEqual(provRes.body.default, 'claude-stats');
    const p = provRes.body.providers.find((x) => x.id === 'claude-stats');
    assert.ok(p, 'claude-stats listed');
    assert.strictEqual(p.url, '/stats/claude-stats');
    assert.ok(p.routes.includes('POST /v1/metrics'), 'provider routes reported');
  });

  const limitsRes = await req('GET', '/limits');
  await test('/limits degrades safely without a credential', () => {
    assert.strictEqual(limitsRes.status, 200);
    assert.strictEqual(limitsRes.body.available, false);
    assert.ok(Array.isArray(limitsRes.body.bars));
  });

  server.close();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
