'use strict';

const fs = require('fs');
const path = require('path');
const { memoizeAsync } = require('./cache');
const { ONLY_PROVIDERS, DISABLED_PROVIDERS } = require('./config');

const PROVIDERS_DIR = path.join(__dirname, '..', 'providers');
const DEFAULT_TTL_MS = 30_000;

// A provider is the unit of reuse: one data source, one cached JSON payload,
// served at GET /stats/<id>. Adding a widget means dropping a folder in
// src/providers/ — nothing here or in server.js needs editing.
//
//   module.exports = {
//     id: 'weather',              // URL segment; defaults to the folder name
//     title: 'Weather',           // human label for `list` / /providers
//     ttlMs: 600_000,             // how long a payload is reused (default 30s; 0 = don't)
//     async collect() { ... },    // -> the JSON the widget renders
//     routes: [                   // optional extra endpoints, e.g. ingestion
//       { method: 'POST', path: '/v1/metrics', handler(req, res, ctx) {} },
//     ],
//     print(data) { ... },        // optional CLI pretty-printer
//     enabled: true,              // or a function; false hides the provider
//   };

function loadModule(dir, id) {
  const mod = require(dir);
  if (!mod || typeof mod.collect !== 'function') {
    throw new Error(`provider "${id}" must export an async collect()`);
  }
  return mod;
}

// Checked against the folder name before the module is required, and again
// against mod.id afterwards — a disabled provider shouldn't pay for its own
// top-level require (parsers, telemetry stores, credential lookups).
function isListed(id) {
  if (ONLY_PROVIDERS && !ONLY_PROVIDERS.includes(id)) return false;
  return !DISABLED_PROVIDERS?.includes(id);
}

// `ttlMs: 0` is meaningful, not missing: it opts a provider out of host-level
// caching (in-flight de-duplication still applies) for payloads with a live
// component that must not be frozen for a whole TTL — see claude-stats, whose
// telemetry snapshot has to reflect the metrics posted a second ago.
function resolveTtl(value) {
  if (value == null) return DEFAULT_TTL_MS;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_MS;
}

function isEnabled(mod) {
  const flag = typeof mod.enabled === 'function' ? mod.enabled() : mod.enabled;
  return flag === undefined || !!flag;
}

// Discover every subdirectory of src/providers/ that resolves as a module.
// A provider that throws on load is reported rather than taking the host down —
// one broken widget shouldn't stop the others from rendering.
function loadProviders(providersDir = PROVIDERS_DIR) {
  const providers = [];
  const failed = [];

  let entries = [];
  try {
    entries = fs.readdirSync(providersDir, { withFileTypes: true });
  } catch (_) {
    return { providers, failed };
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
    if (!isListed(entry.name)) continue;
    const dir = path.join(providersDir, entry.name);
    let mod;
    try {
      mod = loadModule(dir, entry.name);
    } catch (err) {
      failed.push({ id: entry.name, error: String((err && err.message) || err) });
      continue;
    }

    const id = mod.id || entry.name;
    if (!isListed(id) || !isEnabled(mod)) continue;

    const ttlMs = resolveTtl(mod.ttlMs);
    providers.push({
      id,
      title: mod.title || id,
      dir,
      ttlMs,
      routes: Array.isArray(mod.routes) ? mod.routes : [],
      print: typeof mod.print === 'function' ? mod.print.bind(mod) : null,
      // One cache per provider, shared by every widget polling it.
      read: memoizeAsync(() => mod.collect(), { ttlMs }),
      module: mod,
    });
  }

  return { providers, failed };
}

function indexById(providers) {
  const map = new Map();
  for (const p of providers) map.set(p.id, p);
  return map;
}

module.exports = { loadProviders, indexById, PROVIDERS_DIR };
