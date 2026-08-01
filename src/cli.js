#!/usr/bin/env node
'use strict';

const { PORT, HOST, DEFAULT_PROVIDER } = require('./core/config');
const { loadProviders, indexById } = require('./core/registry');

function resolveProvider(id) {
  const { providers, failed } = loadProviders();
  const byId = indexById(providers);
  const wanted = id || DEFAULT_PROVIDER;
  const provider = byId.get(wanted);
  if (!provider) {
    const names = [...byId.keys()].join(', ') || '(none)';
    console.error(`Unknown provider "${wanted}". Registered: ${names}`);
    for (const f of failed) console.error(`  failed to load: ${f.id} — ${f.error}`);
    process.exitCode = 1;
    return null;
  }
  return provider;
}

function cmdList() {
  const { providers, failed } = loadProviders();
  console.log('\n  Registered providers');
  console.log('  ' + '─'.repeat(46));
  if (!providers.length) console.log('  (none — add a folder under src/providers/)');
  for (const p of providers) {
    const star = p.id === DEFAULT_PROVIDER ? '*' : ' ';
    console.log(`  ${star} ${p.id.padEnd(18)} ${p.title}`);
    console.log(`  ${' '.repeat(20)}GET /stats/${p.id}  (ttl ${Math.round(p.ttlMs / 1000)}s)`);
  }
  for (const f of failed) console.log(`  ! ${f.id.padEnd(18)} failed to load — ${f.error}`);
  console.log('\n  * = default, also served at GET /stats\n');
}

// `print` and `parse` differ only in whether the provider gets to format the
// payload. Both go through provider.read(), the registry's one way in.
async function cmdShow(id, { raw }) {
  const provider = resolveProvider(id);
  if (!provider) return;
  const data = await provider.read();
  if (!raw && provider.print) provider.print(data);
  else console.log(JSON.stringify(data, null, 2));
}

async function cmdServe() {
  const { start } = require('./core/server');
  const { port, host, providers } = await start();
  console.log(`widget helper listening on http://${host}:${port}`);
  for (const p of providers) {
    const alias = p.id === DEFAULT_PROVIDER ? '   (also /stats)' : '';
    console.log(`  • ${p.title.padEnd(14)} http://${host}:${port}/stats/${p.id}${alias}`);
    for (const r of p.routes) {
      console.log(`      ${(r.method || 'GET').toUpperCase()} ${r.path}`);
    }
  }
  if (!providers.length) console.log('  (no providers registered — see ./scripts/new-widget.sh)');
  console.log('Press Ctrl+C to stop.');
}

async function main() {
  const [cmd = 'serve', arg] = process.argv.slice(2);
  switch (cmd) {
    case 'serve':
      return cmdServe();
    case 'list':
      return cmdList();
    case 'parse':
      return cmdShow(arg, { raw: true });
    case 'print':
      return cmdShow(arg, { raw: false });
    case '-h':
    case '--help':
    case 'help':
      console.log(`
widget-helper — one local service backing every Übersicht widget in this repo

Usage:
  widget-helper serve              Start the service (default). Serves every
                                   provider at /stats/<id>. Port ${PORT}.
  widget-helper list               List registered providers.
  widget-helper print [provider]   Human-readable summary (default: ${DEFAULT_PROVIDER}).
  widget-helper parse [provider]   Full payload as JSON.
  widget-helper help               Show this help.

Env:
  WIDGET_HOST_PORT                 Listen port (default ${PORT}).
  WIDGET_HOST_HOST                 Listen host (default ${HOST}).
  WIDGET_HOST_DEFAULT_PROVIDER     Provider served at /stats (default ${DEFAULT_PROVIDER}).
  WIDGET_HOST_PROVIDERS            Comma-separated allow-list of provider ids.
  WIDGET_HOST_DISABLE              Comma-separated deny-list of provider ids.

Providers declare their own env vars — see src/providers/<id>/.
`);
      return;
    default:
      console.error(`Unknown command: ${cmd}\nRun "widget-helper help" for usage.`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Error:', (err && err.stack) || err);
  process.exitCode = 1;
});
