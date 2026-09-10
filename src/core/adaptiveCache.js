'use strict';

// Cache a normalized provider result with per-result TTLs, in-flight
// de-duplication, and an optional last-good projection for degraded reads.
function createAdaptiveCache({ load, ttlFor, isGood, mergeStale, errorValue, now = Date.now }) {
  let cache = { value: null, at: 0, inflight: null };
  let lastGood = null;
  let generation = 0;

  function project(value) {
    const at = now();
    if (isGood(value)) {
      lastGood = { value, at };
      return value;
    }
    return lastGood && mergeStale ? mergeStale(value, lastGood, at) : value;
  }

  async function get(fetcher = load) {
    const at = now();
    if (cache.value && at - cache.at < ttlFor(cache.value)) return cache.value;
    if (cache.inflight) return cache.inflight;
    const requestGeneration = generation;
    cache.inflight = Promise.resolve()
      .then(fetcher)
      .then(project, (err) => project(errorValue(err)))
      .then((value) => {
        if (generation === requestGeneration) cache = { value, at: now(), inflight: null };
        return value;
      });
    return cache.inflight;
  }

  function reset() {
    generation += 1;
    cache = { value: null, at: 0, inflight: null };
    lastGood = null;
  }

  function expire({ preserveInflight = false } = {}) {
    if (!preserveInflight) generation += 1;
    cache = { value: null, at: 0, inflight: preserveInflight ? cache.inflight : null };
  }

  return { get, reset, expire };
}

module.exports = { createAdaptiveCache };
