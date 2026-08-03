'use strict';

// Connectivity for the system-status widget.
//
// The widget's curl gives the helper 4 seconds to answer, so the "retry 3
// times, 5 seconds apart" confirmation cannot happen inside collect() — a
// 15-second ladder would blow the timeout and the widget would render its
// "helper offline" card, hiding uptime, memory and disk along with it.
//
// Instead a background prober owns the network and keeps a verdict in memory;
// collect() reads that verdict instantly. The prober only runs while something
// is actually reading it (see IDLE_STOP_MS) — the helper lives at login, and a
// widget nobody is looking at should not poll the internet forever.

const http = require('http');

// Apple's captive-portal endpoint: tiny, unauthenticated, and the body is a
// fixed string. Checking for that string rather than a 200 is what makes a
// hotel/airport portal — which happily returns 200 with a login page — read as
// offline, because from the user's point of view it is.
// http only — `http.get` throws on an https: URL, which this file turns into a
// permanent "offline" rather than a crash. The endpoint is plain HTTP by design.
const PROBE_URL = process.env.SYSTEM_STATUS_PROBE_URL || 'http://captive.apple.com/hotspot-detect.html';
const PROBE_MARKER = 'Success';
const PROBE_TIMEOUT_MS = 3_000;
const MAX_BODY_BYTES = 4096; // the marker is in the first bytes of a healthy response

// The intervals take a floor of 1ms: `Number('')` is 0, so an empty or
// zero-valued env var would otherwise mean setTimeout(cycle, 0) — a probe loop
// hammering the endpoint as fast as the network allows. Zero *is* meaningful
// for the other two (no retries; never park), so they keep a floor of 0.
const ONLINE_INTERVAL_MS = envInt('SYSTEM_STATUS_PROBE_INTERVAL_MS', 30_000, 1);
const OFFLINE_INTERVAL_MS = envInt('SYSTEM_STATUS_PROBE_OFFLINE_INTERVAL_MS', 10_000, 1);
const RETRY_DELAY_MS = envInt('SYSTEM_STATUS_RETRY_DELAY_MS', 5_000, 1);
const RETRIES = envInt('SYSTEM_STATUS_RETRIES', 3);
const IDLE_STOP_MS = envInt('SYSTEM_STATUS_IDLE_STOP_MS', 120_000);

function envInt(name, fallback, min = 0) {
  const raw = process.env[name];
  if (!raw) return fallback; // unset or empty means "use the default", not zero
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (t.unref) t.unref(); // a pause between retries must not hold the process open
  });
}

// One request. Resolves true/false and never rejects — DNS failure, refused
// connection, timeout and a portal's login page are all just "not online".
//
// Every path must settle. A promise left pending here does not merely lose one
// reading: it suspends cycle()'s await forever, so `running` stays true, the
// loop never reschedules, and start() can never revive it. That is a dead
// connectivity tile until the helper restarts, which under launchd means days.
function probeOnce(url = PROBE_URL) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(value);
    };

    // A wall-clock budget on top of the socket timeout, which only measures
    // *inactivity*: a server trickling one byte a second never trips it.
    const deadline = setTimeout(() => {
      if (req) req.destroy();
      done(false);
    }, PROBE_TIMEOUT_MS);
    if (deadline.unref) deadline.unref();

    let req;
    try {
      req = http.get(url, { timeout: PROBE_TIMEOUT_MS }, (res) => {
        let body = '';
        const verdict = () => res.statusCode === 200 && body.includes(PROBE_MARKER);
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          // Decide *before* hanging up. res.destroy() emits 'close', never
          // 'end', so tearing down first and reading the verdict from an 'end'
          // that will never arrive is exactly how this wedges.
          if (body.length > MAX_BODY_BYTES) {
            // Settle before tearing down, not after: destroy() arms the
            // 'close' backstop below, and only Node's deferral of emitClose
            // keeps that from clobbering a genuine "online".
            done(verdict());
            res.destroy();
          }
        });
        res.on('end', () => done(verdict()));
        res.on('error', () => done(false));
        // Backstop: 'close' always fires, including on an aborted response.
        res.on('close', () => done(false));
      });
    } catch (_) {
      return done(false);
    }

    // Once connected, the socket must not keep the process alive on its own.
    // (An in-flight TCP *connect* is a libuv request, not a handle, so a
    // one-shot `widget-helper print system-status` can still linger up to the
    // probe timeout on a blackholed route. Bounded, so it stays a wart.)
    req.on('socket', (s) => {
      if (s.unref) s.unref();
    });
    req.on('timeout', () => {
      req.destroy();
      done(false);
    });
    req.on('error', () => done(false));
  });
}

// One failed probe is a blip, not an outage. Re-probe up to `retries` more
// times, `delayMs` apart, and only call it offline if every attempt fails.
// Returns as soon as any attempt succeeds, so a real blip costs one extra
// request rather than the full ladder.
//
// `sleep` is injected so the tests can run the ladder without waiting 15s.
async function resolveOnline(probe, { retries = RETRIES, delayMs = RETRY_DELAY_MS, sleep: wait = sleep } = {}) {
  let attempts = 0;
  for (let i = 0; i <= retries; i += 1) {
    attempts += 1;
    if (await probe()) return { online: true, attempts };
    if (i < retries) await wait(delayMs);
  }
  return { online: false, attempts };
}

// Holds the verdict and the timer that keeps it fresh.
class ConnectivityMonitor {
  constructor({
    probe = probeOnce,
    retries = RETRIES,
    retryDelayMs = RETRY_DELAY_MS,
    onlineIntervalMs = ONLINE_INTERVAL_MS,
    offlineIntervalMs = OFFLINE_INTERVAL_MS,
    idleStopMs = IDLE_STOP_MS,
    now = Date.now,
    sleep: wait = sleep,
  } = {}) {
    Object.assign(this, { probe, retries, retryDelayMs, onlineIntervalMs, offlineIntervalMs, idleStopMs, now });
    this.sleep = wait;

    this.online = null; // null until the first probe lands — "—", not "Offline"
    this.checkedAt = null;
    this.timer = null;
    this.running = false;
    this.lastRead = 0;
    // Bumped by every start/stop so a cycle that was in flight across a
    // restart retires instead of scheduling a second loop alongside the new one.
    this.generation = 0;
  }

  // What collect() serializes. `online: null` is the cold-start state and the
  // widget must render it as unknown rather than guessing either way.
  snapshot() {
    return { online: this.online, checkedAt: this.checkedAt };
  }

  // Called by collect(). Doubles as the liveness signal that keeps the prober
  // running: no reads for idleStopMs and the loop parks itself.
  read() {
    this.lastRead = this.now();
    this.start();
    return this.snapshot();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.generation += 1;
    this.cycle(this.generation);
  }

  stop() {
    this.running = false;
    this.generation += 1;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async cycle(generation) {
    if (!this.running || generation !== this.generation) return;

    let verdict = null;
    try {
      // Once already offline a poll is a single request asking whether we are
      // back — re-confirming a state we are in would just spend 15 seconds
      // arriving at the same answer.
      verdict = await resolveOnline(this.probe, {
        retries: this.online === false ? 0 : this.retries,
        delayMs: this.retryDelayMs,
        sleep: this.sleep,
      });
    } catch (_) {
      // `probe` is an injected seam and must be assumed to reject. Keep the
      // last verdict and try again on the next tick — one bad poll must not end
      // connectivity for the life of the process.
      //
      // A probe that *hangs* is not caught here, and cannot be: this await is
      // the loop's only forward edge. Liveness therefore rests on the probe
      // settling on its own, which is what probeOnce's absolute deadline
      // guarantees. Any replacement probe owes the same guarantee.
    }
    if (!this.running || generation !== this.generation) return;

    const at = this.now();
    if (verdict) {
      this.online = verdict.online;
      this.checkedAt = new Date(at).toISOString();
    }

    if (this.idleStopMs > 0 && at - this.lastRead > this.idleStopMs) {
      this.stop();
      return;
    }

    const wait = this.online ? this.onlineIntervalMs : this.offlineIntervalMs;
    this.timer = setTimeout(() => this.cycle(generation), wait);
    // A pending probe must not hold the process open on its own.
    if (this.timer.unref) this.timer.unref();
  }
}

module.exports = { ConnectivityMonitor, resolveOnline, probeOnce };
