'use strict';

// Core config — deliberately data-agnostic. Anything specific to one data
// source (paths, credentials, endpoints) belongs in that provider's own config.

module.exports = {
  // The helper service listens here. It is both the widget API (GET /stats/<id>)
  // and, for providers that need it, an ingestion endpoint — e.g. claude-stats
  // receives Claude Code's OTLP metrics on POST /v1/metrics, which is why the
  // default port is the OTLP/HTTP default.
  PORT: Number(process.env.WIDGET_HOST_PORT || process.env.CLAUDE_STATS_PORT) || 4318,
  HOST: process.env.WIDGET_HOST_HOST || process.env.CLAUDE_STATS_HOST || '127.0.0.1',

  // GET /stats (no id) serves this provider, so widgets predating the multi-
  // provider layout keep working.
  DEFAULT_PROVIDER: process.env.WIDGET_HOST_DEFAULT_PROVIDER || 'claude-stats',

  // Comma-separated allow/deny lists, e.g. WIDGET_HOST_PROVIDERS=weather,git
  ONLY_PROVIDERS: splitList(process.env.WIDGET_HOST_PROVIDERS),
  DISABLED_PROVIDERS: splitList(process.env.WIDGET_HOST_DISABLE),
};

function splitList(raw) {
  if (!raw) return null;
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : null;
}
