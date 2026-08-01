'use strict';

// Time-based memoization with in-flight de-duplication.
//
// Widgets poll on a timer and several widgets may share one provider, so the
// two things worth avoiding are (a) re-doing expensive work inside the TTL and
// (b) firing N concurrent fetches when N pollers arrive together. Callers that
// need richer semantics (stale-while-error retention, error back-off) keep
// their own cache — see the claude-stats plan-limits fetcher.
function memoizeAsync(fn, { ttlMs = 30_000 } = {}) {
  // `has` tracks freshness rather than sniffing the payload: providers are told
  // to degrade to nulls instead of throwing, so a null result is a legitimate
  // value to cache — testing `value !== null` would re-run collect() forever.
  let state = { value: null, has: false, at: 0, inflight: null };

  async function cached() {
    if (state.has && Date.now() - state.at < ttlMs) return state.value;
    if (state.inflight) return state.inflight;

    state.inflight = Promise.resolve()
      .then(fn)
      .then((value) => {
        state = { value, has: true, at: Date.now(), inflight: null };
        return value;
      })
      .catch((err) => {
        // Leave the previous value in place; only the in-flight slot is cleared,
        // so the next caller retries instead of inheriting a rejected promise.
        state.inflight = null;
        throw err;
      });
    return state.inflight;
  }

  cached.invalidate = () => {
    state = { value: null, has: false, at: 0, inflight: null };
  };

  return cached;
}

module.exports = { memoizeAsync };
