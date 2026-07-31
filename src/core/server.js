'use strict';

const http = require('http');
const { PORT, HOST, DEFAULT_PROVIDER } = require('./config');
const { loadProviders, indexById } = require('./registry');

// The host's own endpoints, as a predicate rather than a list of exact keys:
// /stats is dispatched by PREFIX, so `GET /stats/weather` would never collide on
// an exact key yet would shadow the weather provider's payload. A provider may
// not claim any of this space.
function isReservedRoute(method, routePath) {
  if (method !== 'GET') return false;
  if (routePath === '/stats' || routePath.startsWith('/stats/')) return true;
  return routePath === '/providers' || routePath === '/health' || routePath === '/';
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    // Übersicht widgets shell out to `curl`, but allow browser/fetch clients too.
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req, limitBytes = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// One HTTP host for every widget. Routing is derived from the provider registry,
// so a new widget needs no changes here.
//
//   GET  /stats/<id>   the provider's payload (cached per its ttlMs)
//   GET  /stats        the default provider, for widgets written before ids
//   GET  /providers    what's registered, and what failed to load
//   GET  /health       liveness
//   <provider routes>  anything a provider declares, e.g. POST /v1/metrics
function createServer() {
  const { providers, failed } = loadProviders();
  const byId = indexById(providers);

  // Custom provider routes, flattened once at boot: "METHOD /path" -> handler.
  const routes = new Map();
  for (const provider of providers) {
    for (const route of provider.routes) {
      const method = (route.method || 'GET').toUpperCase();
      const key = `${method} ${route.path}`;
      if (isReservedRoute(method, route.path)) {
        // Silently shadowing /health, or one provider's /stats/<id> with another
        // provider's handler, is the worst outcome available — refuse and say so.
        console.error(`[widget-host] "${key}" is reserved by the host (provider ${provider.id} ignored)`);
        continue;
      }
      if (routes.has(key)) {
        // First one wins; a later provider claiming the same path is a config
        // bug, and silently shadowing it would be worse than saying so.
        console.error(`[widget-host] route conflict on "${key}" (provider ${provider.id} ignored)`);
        continue;
      }
      routes.set(key, { provider, handler: route.handler });
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const method = (req.method || 'GET').toUpperCase();

    try {
      const custom = routes.get(`${method} ${pathname}`);
      if (custom) {
        await custom.handler(req, res, { sendJson, readBody, url, provider: custom.provider });
        return;
      }

      if (method === 'GET' && (pathname === '/stats' || pathname.startsWith('/stats/'))) {
        const id = pathname === '/stats' ? DEFAULT_PROVIDER : pathname.slice('/stats/'.length);
        const provider = byId.get(id);
        if (!provider) {
          sendJson(res, 404, { error: 'unknown provider', id, available: [...byId.keys()] });
          return;
        }
        sendJson(res, 200, await provider.read());
        return;
      }

      if (method === 'GET' && pathname === '/providers') {
        sendJson(res, 200, {
          default: DEFAULT_PROVIDER,
          providers: providers.map((p) => ({
            id: p.id,
            title: p.title,
            ttlMs: p.ttlMs,
            url: `/stats/${p.id}`,
            routes: p.routes.map((r) => `${(r.method || 'GET').toUpperCase()} ${r.path}`),
          })),
          failed,
        });
        return;
      }

      if (method === 'GET' && (pathname === '/health' || pathname === '/')) {
        sendJson(res, 200, {
          ok: true,
          service: 'uebersicht-widget-host',
          providers: providers.map((p) => p.id),
          failed,
        });
        return;
      }

      sendJson(res, 404, { error: 'not found', path: pathname });
    } catch (err) {
      sendJson(res, 500, { error: String((err && err.message) || err) });
    }
  });

  return { server, providers, byId };
}

function start({ port = PORT, host = HOST } = {}) {
  const created = createServer();
  return new Promise((resolve, reject) => {
    created.server.once('error', reject);
    created.server.listen(port, host, () => {
      const bound = created.server.address().port; // resolves port 0 to the actual assignment
      resolve({ ...created, port: bound, host });
    });
  });
}

module.exports = { createServer, start, sendJson, readBody, isReservedRoute };
