'use strict';

const fsp = require('fs/promises');
const { STATS_CACHE_FILE } = require('../config');
const { parseSessions, projectsDirExists } = require('./sessions');
const { parseHistory } = require('./history');

async function readStatsCache(file = STATS_CACHE_FILE) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

// Full parse of all local sources. Returns a single stats object.
//
// Deliberately uncached: the core registry memoizes the provider payload at the
// provider's ttlMs (with in-flight de-duplication), so a second cache here would
// only add a second stale window on top of it.
async function collectStats() {
  const [sessions, history, statsCache] = await Promise.all([
    parseSessions(),
    parseHistory(),
    readStatsCache(),
  ]);

  return {
    ...sessions,
    history,
    statsCache: statsCache || null,
    dataAvailable: projectsDirExists(),
    generatedAt: new Date().toISOString(),
    source: 'files',
  };
}

module.exports = { collectStats, readStatsCache };
