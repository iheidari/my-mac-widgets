'use strict';

// Linear API key discovery, mirroring planLimits.js: an explicit env var wins,
// otherwise the macOS Keychain. There is deliberately no file fallback — unlike
// Claude Code, Linear writes no credential to disk for us to read, so a file
// would be one we invented and one more copy of a full-permission secret.
//
// If nothing is found the provider makes NO network call and reports
// available: false. Never fetch without a discovered credential.

const { execFileSync } = require('child_process');

// The Keychain item scripts/install.sh creates. `security` matches on service
// name, so this string is the contract between the installer and this module.
const KEYCHAIN_SERVICE = 'linear-stats';

function fromEnv() {
  const raw = process.env.LINEAR_API_KEY;
  if (!raw) return null;
  const key = String(raw).trim();
  return key ? { key, source: 'env' } : null;
}

function fromKeychain() {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // `security -w` echoes a trailing newline; a key with surrounding whitespace
    // would 401 in a way that looks like a revoked token rather than a typo.
    const key = String(out).trim();
    return key ? { key, source: 'keychain' } : null;
  } catch (_) {
    // Item absent, or the user denied access at the Keychain prompt. Both mean
    // "no credential" — the caller must not fall through to an unauthenticated
    // request.
    return null;
  }
}

function findApiKey() {
  return fromEnv() || fromKeychain();
}

module.exports = { findApiKey, KEYCHAIN_SERVICE };
