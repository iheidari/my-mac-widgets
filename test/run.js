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

  console.log('\nSystem status');
  //
  // Every assertion below feeds a fixture into a pure function. Nothing here
  // shells out, reads a real volume, touches the network or sleeps — the
  // numbers this widget shows are machine-specific, so a test that measured
  // the developer's actual machine could only assert that arithmetic is
  // arithmetic.
  const sys = require('../src/providers/system-status/system');

  await test('parses kern.boottime into an epoch', () => {
    assert.strictEqual(sys.parseBootTime('{ sec = 1785611624, usec = 206644 } Sat Aug  1 12:13:44 2026'), 1785611624000);
    assert.strictEqual(sys.parseBootTime('nonsense'), null);
  });

  await test('formats uptime one step below the leading unit', () => {
    assert.strictEqual(sys.formatUptime(12 * 60), '12m');
    assert.strictEqual(sys.formatUptime(3 * 3600 + 12 * 60), '3h 12m');
    assert.strictEqual(sys.formatUptime(86400 + 11 * 3600), '1d 11h');
    assert.strictEqual(sys.formatUptime(null), null);
  });

  await test('uptime is measured from boot to now', () => {
    const boot = 1785611624000;
    const up = sys.uptimeFrom(boot, boot + 90 * 60 * 1000);
    assert.strictEqual(up.seconds, 5400);
    assert.strictEqual(up.text, '1h 30m');
    assert.strictEqual(up.bootAt, new Date(boot).toISOString());
  });

  // 4000 pages of 4 KiB = 16,384,000 bytes total. App Memory is anonymous less
  // purgeable (1800 − 300 = 1500), plus 400 wired and 100 compressed = 2000
  // pages used, exactly half. 1500 pages are idle (free + speculative), leaving
  // 500 as file cache.
  const VM_STAT = [
    'Mach Virtual Memory Statistics: (page size of 4096 bytes)',
    'Pages free:                                     1000.',
    'Pages active:                                   1700.',
    'Pages inactive:                                  800.',
    'Pages speculative:                               500.',
    'Pages wired down:                                400.',
    'Pages purgeable:                                 300.',
    'Anonymous pages:                                1800.',
    'Pages stored in compressor:                      900.',
    'Pages occupied by compressor:                    100.',
  ].join('\n');

  // The number to beat is `top`'s "PhysMem used" — total − free − speculative —
  // which counts the whole file-backed cache as used and reads ~30 points high
  // (71% vs 40% on a real machine). That would leave the bar permanently amber
  // or red on a Mac under no memory pressure. If this assertion ever reads 2500
  // pages, the shortcut has crept back in.
  await test('memory used matches Activity Monitor (App + Wired + Compressed)', () => {
    const mem = sys.parseVmStat(VM_STAT, 4000 * 4096);
    assert.strictEqual(mem.usedBytes, 2000 * 4096);
    assert.strictEqual(mem.usedPercent, 50);
  });

  // Cached files are neither used nor idle, and Activity Monitor reports them
  // on their own line for exactly that reason.
  await test('memory reports the file cache separately from used', () => {
    const mem = sys.parseVmStat(VM_STAT, 4000 * 4096);
    assert.strictEqual(mem.cachedBytes, 500 * 4096);
    assert.strictEqual(mem.freeBytes, 2000 * 4096, 'everything not used is available to apps');
    assert.strictEqual(mem.usedBytes + mem.freeBytes, mem.totalBytes, 'the payload reconciles');
  });

  await test('memory degrades to null on unparseable vm_stat', () => {
    assert.strictEqual(sys.parseVmStat('garbage', 4000 * 4096), null);
    assert.strictEqual(sys.parseVmStat(VM_STAT, 0), null);
    // A vm_stat missing one of the fields the formula needs is not a reason to
    // report a number computed from the rest.
    assert.strictEqual(sys.parseVmStat(VM_STAT.replace(/Pages wired down:.*/, ''), 4000 * 4096), null);
  });

  // Capacity is measured against what this user can claim, matching df: the
  // blocks reserved for root are neither used nor available.
  await test('disk capacity excludes root-reserved blocks, like df', () => {
    const d = sys.diskFromStatfs({ bsize: 4096, blocks: 1000, bfree: 400, bavail: 300 }, '/vol');
    assert.strictEqual(d.usedPercent, 66.7); // 600 used / (600 used + 300 avail)
    assert.strictEqual(d.totalBytes, 1000 * 4096);
    assert.strictEqual(d.freeBytes, 300 * 4096);
    assert.strictEqual(d.volume, '/vol');
    // usedBytes/totalBytes is deliberately NOT usedPercent, so the denominator
    // ships too — otherwise a consumer recomputing the bar gets a different
    // number than the widget draws.
    assert.strictEqual(d.capacityBytes, 900 * 4096);
  });

  await test('disk degrades to null rather than throwing', () => {
    assert.strictEqual(sys.diskFromStatfs(null, '/vol'), null);
    assert.strictEqual(sys.diskFromStatfs({ bsize: 4096, blocks: 0, bfree: 0, bavail: 0 }, '/vol'), null);
  });

  // The default volume must not be `/`: on APFS that is the sealed read-only
  // system snapshot, which reports a fixed ~15% no matter how full the Mac is.
  await test('the disk reading targets the Data volume, not the sealed snapshot', () =>
    assert.strictEqual(sys.DEFAULT_VOLUME, '/System/Volumes/Data'));

  const { resolveOnline, ConnectivityMonitor } = require('../src/providers/system-status/connectivity');

  // A scripted probe plus a no-op sleep: the ladder's logic is tested without
  // spending the 15 seconds it takes in real life, and without the network —
  // the `execFileSync` stub at the top of this file does not cover `http`, so
  // anything that lets the real prober run would reach out to Apple.
  function scripted(results) {
    let i = 0;
    return () => Promise.resolve(results[i++]);
  }

  await test('a single failed probe is not offline — it is retried 3 times, 5s apart', async () => {
    const waits = [];
    const verdict = await resolveOnline(scripted([false, false, false, false]), {
      retries: 3,
      delayMs: 5000,
      sleep: async (ms) => waits.push(ms),
    });
    assert.strictEqual(verdict.online, false);
    assert.strictEqual(verdict.attempts, 4, 'the first probe plus three retries');
    assert.deepStrictEqual(waits, [5000, 5000, 5000]);
  });

  await test('a blip resolves as online and stops the ladder early', async () => {
    const waits = [];
    const verdict = await resolveOnline(scripted([false, true]), {
      retries: 3,
      delayMs: 5000,
      sleep: async (ms) => waits.push(ms),
    });
    assert.strictEqual(verdict.online, true);
    assert.strictEqual(verdict.attempts, 2, 'stops as soon as one probe succeeds');
    assert.deepStrictEqual(waits, [5000], 'no further waiting once the answer is known');
  });

  // Re-confirming a state we are already in would spend 15 seconds arriving at
  // the same answer, so an offline monitor polls with a single request.
  await test('retries: 0 makes one probe and no waiting', async () => {
    const waits = [];
    const verdict = await resolveOnline(scripted([false]), {
      retries: 0,
      delayMs: 5000,
      sleep: async (ms) => waits.push(ms),
    });
    assert.strictEqual(verdict.attempts, 1);
    assert.deepStrictEqual(waits, []);
  });

  // Constructing the monitor must not start the loop — the prober arms on the
  // first read(), which is what keeps a one-shot CLI call off the network.
  await test('connectivity starts unknown, not offline', () =>
    assert.strictEqual(new ConnectivityMonitor().snapshot().online, null));

  // Drive one full cycle by hand with an injected clock, and park it in the
  // same pass (lastRead is ancient) so no live timer outlives the test.
  function oneCycle(probe) {
    const m = new ConnectivityMonitor({ probe, now: () => 1_000, idleStopMs: 1, sleep: async () => {} });
    m.lastRead = 0;
    m.running = true;
    m.generation = 1;
    return m.cycle(1).then(() => m);
  }

  await test('a cycle records the verdict and then parks when nothing is reading', async () => {
    const m = await oneCycle(async () => true);
    assert.strictEqual(m.online, true);
    assert.ok(m.checkedAt, 'checkedAt is stamped so the widget can age the reading');
    assert.strictEqual(m.running, false, 'parks itself rather than polling the internet forever');
    assert.strictEqual(m.timer, null);
  });

  // A probe that rejects must not end connectivity for the life of the process:
  // before this, an unhandled rejection left `running` true, so the loop never
  // rescheduled and start() could never revive it.
  await test('a rejecting probe leaves the monitor restartable', async () => {
    const m = await oneCycle(async () => {
      throw new Error('boom');
    });
    assert.strictEqual(m.online, null, 'keeps the last verdict rather than inventing one');
    assert.strictEqual(m.running, false);
    m.read();
    assert.strictEqual(m.running, true, 'a later read() re-arms the loop');
    m.stop();
  });

  // Regression for the defect that made this whole thing worth testing: the
  // 4 KiB body cap used to call res.destroy() and then wait for an 'end' event
  // that a destroyed stream never emits. The promise stayed pending, cycle()'s
  // await never returned, and connectivity was dead until the helper restarted.
  // A captive portal — the exact case the marker check exists for — is always
  // bigger than 4 KiB and arrives in ~1.4 KiB chunks over a real link.
  //
  // Hermetic: the server is on 127.0.0.1, like the end-to-end section below.
  await test('an oversized chunked response still settles instead of wedging', async () => {
    const { probeOnce } = require('../src/providers/system-status/connectivity');
    const serve = (body) =>
      new Promise((resolve) => {
        const srv = http.createServer((_req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          let sent = 0;
          const tick = setInterval(() => {
            res.write(body.slice(sent, sent + 1400));
            sent += 1400;
            if (sent >= body.length) {
              clearInterval(tick);
              res.end();
            }
          }, 1);
          // The probe hangs up at 4 KiB, so stop writing then — otherwise the
          // rest of the body lands on a destroyed response and the test passes
          // only because Node swallows write-after-destroy when nobody listens.
          res.on('close', () => clearInterval(tick));
        });
        srv.listen(0, '127.0.0.1', () => resolve(srv));
      });

    const portal = await serve('<html>' + 'x'.repeat(20_000) + '</html>'); // no marker
    const healthy = await serve('<HTML><BODY>Success</BODY></HTML>' + 'x'.repeat(20_000));
    const url = (s) => `http://127.0.0.1:${s.address().port}/`;
    try {
      const verdict = await Promise.race([
        Promise.all([probeOnce(url(portal)), probeOnce(url(healthy))]),
        new Promise((_r, reject) => setTimeout(() => reject(new Error('probe never settled')), 5_000)),
      ]);
      assert.deepStrictEqual(verdict, [false, true], 'a portal page is offline; an early marker is online');
    } finally {
      portal.close();
      healthy.close();
    }
  });

  console.log('\nLinear stats');

  // The counting rules live in a pure function precisely so they can be checked
  // against a fixture rather than against whatever the workspace happens to hold
  // today. Shapes mirror the GraphQL selection in linear.js.
  const { aggregate } = require('../src/providers/linear-stats/aggregate');

  const ln = {
    project: (id, name, statusType) => ({ id, name, url: `https://linear.app/x/project/${id}`, status: { type: statusType || 'planned' } }),
    issue: (projectId, stateName, stateType, labels) => ({
      id: `i-${Math.random()}`,
      state: { name: stateName, type: stateType },
      project: projectId ? { id: projectId } : null,
      labels: { nodes: (labels || []).map((name) => ({ name })) },
    }),
  };

  const READY = 'Ready to play';
  const workspace = {
    projects: [ln.project('p1', 'Fexi'), ln.project('p2', 'Cadence'), ln.project('p3', 'Tubekeep'), ln.project('p4', 'Old', 'completed')],
    states: [
      { name: 'Backlog', type: 'backlog' },
      { name: 'Todo', type: 'unstarted' },
      { name: 'In Progress', type: 'started' },
      { name: 'In Review', type: 'started' },
    ],
    issues: [
      ln.issue('p1', 'Backlog', 'backlog', [READY]),
      ln.issue('p1', 'Backlog', 'backlog', ['bug']),
      ln.issue('p1', 'Todo', 'unstarted', [READY]),
      ln.issue('p1', 'In Review', 'started', []),
      ln.issue('p1', 'In Progress', 'started', [READY]),
      ln.issue('p3', 'Backlog', 'backlog', []),
      ln.issue('p4', 'Backlog', 'backlog', [READY]), // completed project — no row
      ln.issue(null, 'Todo', 'unstarted', []), // no project
      ln.issue('p1', 'Done', 'completed', [READY]), // never counted
    ],
  };

  const agg = aggregate(workspace, {});
  const rowFor = (name) => agg.rows.find((r) => r.name === name);

  await test('counts review, backlog and ready per project', () => {
    const fexi = rowFor('Fexi');
    assert.strictEqual(fexi.review, 1, 'only the In Review issue');
    assert.strictEqual(fexi.backlog, 3, 'two Backlog + one Todo');
    assert.strictEqual(fexi.ready, 2, 'labelled backlog issues only');
  });

  await test('Todo (unstarted) counts toward the backlog column', () => {
    // The user reads Linear's Todo as backlog even though Linear files it under
    // Active — so `unstarted` is counted alongside `backlog`.
    const unassigned = rowFor('— no project');
    assert.strictEqual(unassigned.backlog, 1);
  });

  await test('ready is a subset of backlog, never a third bucket', () => {
    // p1 has an In Progress and a Done issue both carrying the label; neither
    // may lift `ready` above the number of labelled backlog issues.
    assert.ok(rowFor('Fexi').ready <= rowFor('Fexi').backlog);
  });

  await test('completed and canceled work is excluded entirely', () => {
    assert.strictEqual(rowFor('Fexi').review + rowFor('Fexi').backlog, 4, 'the Done issue is not counted');
  });

  await test('a project with no issues still gets a zero row', () => {
    const cadence = rowFor('Cadence');
    assert.ok(cadence, 'Cadence is listed');
    assert.deepStrictEqual([cadence.review, cadence.backlog, cadence.ready], [0, 0, 0]);
  });

  await test('a completed project gets no row and its issues are dropped', () => {
    assert.strictEqual(rowFor('Old'), undefined, 'no row for a completed project');
    // Only Fexi's two labelled backlog issues remain: the completed project's
    // third one would push this to 3 if closed work leaked into the counts.
    assert.strictEqual(agg.totals.ready, 2, "the completed project's labelled issue is not in the totals");
  });

  await test('issues with no project land in one bucket, counted apart from projects', () => {
    assert.ok(rowFor('— no project'), 'bucket present when non-empty');
    assert.strictEqual(agg.totals.projects, 3, 'the bucket is not counted as a project');
  });

  await test('the no-project bucket is absent when nothing is in it', () => {
    const clean = aggregate({ ...workspace, issues: workspace.issues.filter((i) => i.project) }, {});
    assert.strictEqual(clean.rows.find((r) => r.name === '— no project'), undefined);
  });

  await test('rows are ordered busiest-first', () => {
    const backlogs = agg.rows.map((r) => r.backlog);
    assert.deepStrictEqual(backlogs, [...backlogs].sort((a, b) => b - a), 'backlog descending');
  });

  await test('totals are the sum of the rows', () => {
    const sum = (k) => agg.rows.reduce((n, r) => n + r[k], 0);
    assert.deepStrictEqual(agg.totals, { review: sum('review'), backlog: sum('backlog'), ready: sum('ready'), projects: 3 });
  });

  await test('a renamed review state is reported rather than silently zero', () => {
    const renamed = aggregate({ ...workspace, states: [{ name: 'Peer Review', type: 'started' }] }, {});
    assert.strictEqual(renamed.reviewStateKnown, false);
    const ok = aggregate(workspace, {});
    assert.strictEqual(ok.reviewStateKnown, true);
  });

  await test('LINEAR_STATS_REVIEW_STATES redefines the review column', () => {
    const custom = aggregate(workspace, { LINEAR_STATS_REVIEW_STATES: 'In Progress, In Review' });
    assert.strictEqual(custom.rows.find((r) => r.name === 'Fexi').review, 2);
  });

  await test('LINEAR_STATS_READY_LABEL redefines the ready column', () => {
    const custom = aggregate(workspace, { LINEAR_STATS_READY_LABEL: 'bug' });
    assert.strictEqual(custom.rows.find((r) => r.name === 'Fexi').ready, 1);
  });

  // ---- Fetching and caching (no network) ----

  const linearProvider = require('../src/providers/linear-stats');
  const linearApi = require('../src/providers/linear-stats/linear');

  await test('credential discovery finds nothing (hermetic environment)', () => {
    // Canary, like the claude-stats one above: LINEAR_API_KEY is cleared and the
    // `security` stub at the top of this file makes the Keychain come up empty.
    // If this fails, a lookup path escaped the stub and the assertions below —
    // which all rest on "no key" — are meaningless.
    delete process.env.LINEAR_API_KEY;
    const { findApiKey } = require('../src/providers/linear-stats/credential');
    assert.strictEqual(findApiKey(), null);
  });

  await test('no credential means no network call at all', async () => {
    delete process.env.LINEAR_API_KEY;
    let called = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => {
      called += 1;
      throw new Error('the provider must not reach the network without a key');
    };
    try {
      const res = await linearProvider.runFetch();
      assert.strictEqual(called, 0, 'fetch was never invoked');
      assert.strictEqual(res.available, false);
      assert.deepStrictEqual(res.rows, []);
      assert.ok(/no Linear API key/.test(res.error), res.error);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await test('a GraphQL error is surfaced, and an auth failure is flagged', async () => {
    const find = () => ({ key: 'lin_api_test', source: 'env' });
    const bad = await linearProvider.runFetch(find, async () => ({ error: 'Authentication required (AUTHENTICATION_ERROR)' }));
    assert.strictEqual(bad.available, false);
    assert.strictEqual(bad.auth, true, 'classified as auth so the cache backs off');

    const blip = await linearProvider.runFetch(find, async () => ({ error: 'Linear request timed out' }));
    assert.strictEqual(blip.auth, false, 'a timeout is transient, not auth');
  });

  await test('a rejected key backs off; a transient failure retries soon', () => {
    const long = linearProvider.ttlFor({ available: false, auth: true });
    const rate = linearProvider.ttlFor({ available: false, status: 429 });
    const short = linearProvider.ttlFor({ available: false, error: 'timed out' });
    assert.ok(long >= 300_000, `auth failure holds for the full window, got ${long}`);
    assert.strictEqual(rate, long, '429 backs off like a rejected key');
    assert.ok(short < long, `a transient failure expires sooner (${short} < ${long})`);
  });

  await test('a failed poll keeps the last good counts, marked stale', async () => {
    linearProvider._resetCache();
    const find = () => ({ key: 'lin_api_test', source: 'env' });
    const good = await linearProvider.getCached(() => linearProvider.runFetch(find, async () => workspace));
    assert.strictEqual(good.available, true);
    assert.ok(good.rows.length, 'first poll produced rows');

    linearProvider._expireCache(); // keeps lastGood
    const failed = await linearProvider.getCached(() => linearProvider.runFetch(find, async () => ({ error: 'boom' })));
    assert.strictEqual(failed.available, false, 'not presented as a live reading');
    assert.strictEqual(failed.stale, true);
    assert.ok(failed.staleSince, 'says when the retained counts were taken');
    assert.deepStrictEqual(failed.rows, good.rows, 'the counts survive the failure');
    linearProvider._resetCache();
  });

  await test('issue paging follows the cursor to the end', async () => {
    const pages = [
      { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [ln.issue('p1', 'Backlog', 'backlog', [])] },
      { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [ln.issue('p1', 'Backlog', 'backlog', [])] },
    ];
    const seen = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      seen.push(body.variables.after || null);
      return { status: 200, text: async () => JSON.stringify({ data: { issues: pages[seen.length - 1] } }) };
    };
    try {
      const res = await linearApi.fetchIssues('lin_api_test');
      assert.strictEqual(res.nodes.length, 2, 'both pages collected');
      assert.deepStrictEqual(seen, [null, 'c1'], 'second request carried the cursor');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await test('a GraphQL 200 carrying errors[] is treated as a failure', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      status: 200,
      text: async () => JSON.stringify({ errors: [{ message: 'Query too complex', extensions: { code: 'COMPLEXITY' } }] }),
    });
    try {
      const res = await linearApi.post('lin_api_test', 'query {}', {});
      assert.ok(res.error, 'errors[] on a 200 is still an error');
      assert.ok(/Query too complex \(COMPLEXITY\)/.test(res.error), res.error);
    } finally {
      globalThis.fetch = realFetch;
    }
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
