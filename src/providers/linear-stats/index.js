'use strict';

// Linear — per-project ticket counts (in review / backlog / ready to play).
// Served at GET /stats/linear-stats.
//
// Reads the documented Linear GraphQL API with a personal API key discovered in
// the environment or the macOS Keychain. With no key it makes NO network call
// and reports available: false, which the widget renders as a setup hint.

const { findApiKey, KEYCHAIN_SERVICE } = require('./credential');
const { fetchWorkspace, isAuthError } = require('./linear');
const { aggregate } = require('./aggregate');

// ---- Fetch ------------------------------------------------------------------

// One live poll. `find` and `fetchFn` are injected so the failure classification
// and the no-credential path can be tested without a Keychain or a network.
async function runFetch(find = findApiKey, fetchFn = fetchWorkspace) {
  if (process.env.LINEAR_STATS === 'off') {
    return { available: false, error: 'disabled', rows: [], totals: null };
  }
  const cred = find();
  if (!cred) {
    return {
      available: false,
      error: `no Linear API key found — set LINEAR_API_KEY or add one to the Keychain (${KEYCHAIN_SERVICE})`,
      rows: [],
      totals: null,
    };
  }

  const res = await fetchFn(cred.key);
  if (res.error) {
    return {
      available: false,
      error: res.error,
      // Carried so the cache can back off on a rejected key instead of retrying
      // it every poll, without having to re-parse the message.
      auth: isAuthError(res.error) || res.status === 401 || res.status === 403,
      status: res.status || null,
      rows: [],
      totals: null,
    };
  }

  const shaped = aggregate(res);
  return {
    available: true,
    error: null,
    source: cred.source,
    truncated: res.truncated || false,
    ...shaped,
    updatedAt: new Date().toISOString(),
  };
}

// ---- Adaptive cache ---------------------------------------------------------
//
// Not the host's whole-payload memo: this needs a different lifetime for
// successes and failures, and needs to keep serving the last good counts when a
// poll fails. `ttlMs: 0` below keeps the host's in-flight de-duplication.

let cache = { value: null, at: 0, inflight: null };

// Last successful reading. A failed poll degrades to these counts — dimmed and
// tagged with their age — rather than blanking the widget. Unlike the plan-limit
// bars there is no expiry cap: a ticket count from this morning is still a true
// statement about this morning, whereas a usage percentage from before a window
// reset is actively wrong.
let lastGood = null; // { value, at }

const TTL_MS = Math.max(30_000, Number(process.env.LINEAR_STATS_TTL_MS) || 300_000);

// Failure TTL, re-read per call so a test can flip it. A transient failure must
// not pin the widget in an error state for the full five minutes — and "no key
// yet" least of all, since the user is probably adding one right now.
function errorTtlMs() {
  const v = Number(process.env.LINEAR_STATS_ERROR_TTL_MS);
  return Number.isFinite(v) && v >= 0 ? v : 60_000;
}

function ttlFor(value) {
  if (!value) return 0;
  if (value.available) return TTL_MS;
  // A rejected key stays rejected until the user mints a new one, and a 429 is
  // the API asking us to slow down. Retrying either on the short error TTL just
  // burns requests, so both wait out the full window.
  if (value.auth || value.status === 429) return TTL_MS;
  return errorTtlMs();
}

function withStale(value) {
  if (value && value.available && value.rows && value.rows.length) {
    lastGood = { value, at: Date.now() };
    return value;
  }
  if (!lastGood) return value;
  return {
    ...value,
    rows: lastGood.value.rows,
    totals: lastGood.value.totals,
    reviewStates: lastGood.value.reviewStates,
    readyLabel: lastGood.value.readyLabel,
    reviewStateKnown: lastGood.value.reviewStateKnown,
    stale: true,
    staleSince: lastGood.value.updatedAt || new Date(lastGood.at).toISOString(),
  };
}

async function getCached(_fetch = runFetch) {
  const now = Date.now();
  if (cache.value && now - cache.at < ttlFor(cache.value)) return cache.value;
  if (cache.inflight) return cache.inflight;
  cache.inflight = _fetch()
    .then((raw) => {
      const value = withStale(raw);
      cache = { value, at: Date.now(), inflight: null };
      return value;
    })
    // runFetch normalizes its own failures, so this is defensive rather than
    // reachable — it mirrors the shape in planLimits.js. The value carries no
    // `auth`/`status`, so it expires on the short error TTL and never pins.
    .catch((err) => {
      const value = withStale({ available: false, error: String((err && err.message) || err), rows: [], totals: null });
      cache = { value, at: Date.now(), inflight: null };
      return value;
    });
  return cache.inflight;
}

function _resetCache() {
  cache = { value: null, at: 0, inflight: null };
  lastGood = null;
}

// Expire the memo but KEEP lastGood: the next read re-fetches, and if that fetch
// fails the retained counts are still there to degrade to. Used by the manual
// refresh route below, and by the stale-fallback test (TTL_MS is frozen at load,
// so env can't force a re-fetch).
//
// An in-flight fetch is carried over rather than dropped, so two refreshes in a
// row de-duplicate onto one Linear request instead of racing.
function invalidate() {
  cache = { value: null, at: 0, inflight: cache.inflight };
}

async function collect() {
  const data = await getCached();
  return { ...data, generatedAt: new Date().toISOString() };
}

module.exports = {
  id: 'linear-stats',
  title: 'Linear',

  // The provider caches internally (see above), so the host's whole-payload memo
  // is off; in-flight de-duplication still applies.
  ttlMs: 0,

  collect,

  routes: [
    // Manual refresh, from the widget's ↻ button. POST because it has an effect —
    // it drops the cache — and it lives outside /stats/, which the host reserves
    // for payloads. Deliberately ignores the back-off in ttlFor(): a user asking
    // for fresh numbers is usually a user who has just fixed something (a revoked
    // key, a ticket they moved), and the whole point is not to wait five minutes.
    {
      method: 'POST',
      path: '/linear-stats/refresh',
      async handler(req, res, { sendJson }) {
        invalidate();
        sendJson(res, 200, await collect());
      },
    },
  ],

  print(data) {
    console.log('\n  Linear');
    console.log('  ' + '─'.repeat(40));
    if (!data.rows || !data.rows.length) {
      console.log(`  ${data.error || 'no projects'}\n`);
      return;
    }
    if (data.stale) console.log(`  (stale — last updated ${data.staleSince})`);
    const width = Math.max(7, ...data.rows.map((r) => r.name.length));
    const cols = (r, a, b, c) => `  ${String(r).padEnd(width)}  ${String(a).padStart(6)}  ${String(b).padStart(7)}  ${String(c).padStart(5)}`;
    console.log(cols('project', 'review', 'backlog', 'ready'));
    for (const r of data.rows) console.log(cols(r.name, r.review, r.backlog, r.ready));
    const t = data.totals || { review: 0, backlog: 0, ready: 0 };
    console.log(cols('total', t.review, t.backlog, t.ready) + '\n');
  },

  // exported for testing:
  runFetch,
  getCached,
  ttlFor,
  _resetCache,
  _expireCache: invalidate,
};
