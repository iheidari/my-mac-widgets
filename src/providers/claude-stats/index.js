'use strict';

// Claude Code usage statistics — fuses three independent sources into one
// payload: parsed local ~/.claude files, live OTLP telemetry Claude Code posts
// to this same server, and the account's plan usage limits.

const { memoizeAsync } = require('../../core/cache');
const { STATS_TTL_MS, CLAUDE_DIR } = require('./config');
const { collectStats } = require('./parser');
const { TelemetryStore } = require('./telemetry/otlpReceiver');
const { getPlanLimitsCached } = require('./planLimits');

// In-memory only, for the life of the process — nothing is persisted.
const telemetry = new TelemetryStore();

// The three sources have three different natural cadences, so this provider owns
// its own caching (ttlMs: 0 below) instead of letting the host freeze the whole
// payload: the file scan is expensive and happily 30s stale, plan limits keep
// their own 180s cache, but the telemetry snapshot is free and must be live —
// Claude Code posts metrics every 15s and the widget's "live" dot reads them.
const readFileStats = memoizeAsync(() => collectStats(), { ttlMs: STATS_TTL_MS });

function fmtNum(n) {
  if (n == null) return '—';
  return n.toLocaleString('en-US');
}
function fmtUsd(n) {
  if (n == null) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtHour(h) {
  if (h == null) return '—';
  const am = h < 12 ? 'AM' : 'PM';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr} ${am}`;
}

module.exports = {
  id: 'claude-stats',
  title: 'Claude Code',
  ttlMs: 0, // cached per-source above, not per-payload

  async collect() {
    const [fileStats, planLimits] = await Promise.all([readFileStats(), getPlanLimitsCached()]);
    return { ...fileStats, telemetry: telemetry.snapshot(), planLimits };
  },

  routes: [
    // OTLP metrics ingestion, from Claude Code's OTEL exporter.
    {
      method: 'POST',
      path: '/v1/metrics',
      async handler(req, res, { sendJson, readBody }) {
        const raw = await readBody(req);
        let payload = null;
        try {
          payload = JSON.parse(raw.toString('utf8'));
        } catch (_) {
          // Binary protobuf or malformed JSON — we only accept http/json.
          sendJson(res, 415, {
            error: 'Only OTLP http/json is supported. Set OTEL_EXPORTER_OTLP_PROTOCOL=http/json',
          });
          return;
        }
        telemetry.ingest(payload);
        sendJson(res, 200, { partialSuccess: {} }); // OTLP success shape
      },
    },
    // OTLP also probes /v1/traces and /v1/logs; accept and ignore them.
    ...['/v1/traces', '/v1/logs'].map((path) => ({
      method: 'POST',
      path,
      async handler(req, res, { sendJson, readBody }) {
        await readBody(req).catch(() => {});
        sendJson(res, 200, { partialSuccess: {} });
      },
    })),
    // Live plan usage limits (session + weekly bars). Undocumented source.
    {
      method: 'GET',
      path: '/limits',
      async handler(req, res, { sendJson }) {
        sendJson(res, 200, await getPlanLimitsCached());
      },
    },
    {
      method: 'GET',
      path: '/telemetry',
      handler(req, res, { sendJson }) {
        sendJson(res, 200, { snapshot: telemetry.snapshot(), series: telemetry.dump() });
      },
    },
  ],

  print(s) {
    const line = (label, val) => console.log(label.padEnd(18) + val);

    console.log('\n  Claude Code Statistics');
    console.log('  ' + '─'.repeat(34));
    if (!s.dataAvailable) {
      console.log(`  No data found at ${CLAUDE_DIR}/projects`);
      console.log('  (Have you used Claude Code on this machine yet?)\n');
      return;
    }
    line('  Sessions', fmtNum(s.sessions));
    line('  Messages', fmtNum(s.messages));
    line('  Prompts', fmtNum(s.history.totalPrompts));
    line('  Active days', fmtNum(s.activeDays));
    line('  Current streak', `${fmtNum(s.currentStreak)} day(s)`);
    line('  Longest streak', `${fmtNum(s.longestStreak)} day(s)`);
    line('  Peak hour', fmtHour(s.peakHour));
    line('  Favorite model', s.favoriteModel || '—');
    line('  Total tokens', fmtNum(s.tokens.total));
    line('  Est. cost', fmtUsd(s.cost));
    console.log('  ' + '─'.repeat(34));
    console.log(`  Parsed ${fmtNum(s._meta.records)} records from ${fmtNum(s._meta.files)} session files\n`);
  },
};
