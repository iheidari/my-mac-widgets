'use strict';

const os = require('os');
const path = require('path');

// Provider-local config. The listen port/host belong to the core host
// (src/core/config.js) — everything here is specific to reading Claude Code.

// Root of the local Claude Code data directory. Overridable for testing.
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

module.exports = {
  CLAUDE_DIR,
  PROJECTS_DIR: path.join(CLAUDE_DIR, 'projects'),
  HISTORY_FILE: path.join(CLAUDE_DIR, 'history.jsonl'),
  STATS_CACHE_FILE: path.join(CLAUDE_DIR, 'stats-cache.json'),

  // How long a parsed payload is reused before a re-parse (ms). The core
  // registry applies this as the provider's response cache.
  STATS_TTL_MS: Number(process.env.CLAUDE_STATS_TTL_MS) || 30_000,
};
