'use strict';

// Codex exposes the same plan windows shown by its /usage command through the
// ChatGPT backend used by the official CLI. The endpoint is not public API, so
// keep the wire shape isolated here and only expose normalized bars.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { createAdaptiveCache } = require('../../core/adaptiveCache');

const API_HOST = 'chatgpt.com';
const USAGE_PATH = '/backend-api/wham/usage';
const SUCCESS_TTL_MS = Math.max(180_000, Number(process.env.CODEX_LIMITS_TTL_MS) || 180_000);
const MAX_RESPONSE_BYTES = 1024 * 1024;

function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function authFile() {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
}

function extractCredential(raw) {
  let json;
  try {
    json = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (_) {
    return null;
  }
  const tokens = json && json.tokens;
  if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token) return null;
  if (typeof tokens.account_id !== 'string' || !tokens.account_id) return null;
  return { accessToken: tokens.access_token, accountId: tokens.account_id, source: 'file' };
}

function findCredential() {
  try {
    return extractCredential(fs.readFileSync(authFile(), 'utf8'));
  } catch (_) {
    return null;
  }
}

function parseReset(value, now = Date.now()) {
  if (value == null) return { resetAt: null, resetInSeconds: null };
  if (typeof value === 'string' && !value.trim()) return { resetAt: null, resetInSeconds: null };
  const n = finiteNumber(value);
  let ms;
  if (n != null) ms = n > 1e12 ? n : n > 1e9 ? n * 1000 : now + n * 1000;
  else {
    ms = new Date(value).getTime();
    if (!Number.isFinite(ms)) return { resetAt: null, resetInSeconds: null };
  }
  return {
    resetAt: new Date(ms).toISOString(),
    resetInSeconds: Math.max(0, Math.round((ms - now) / 1000)),
  };
}

function durationLabel(seconds, fallback) {
  if (seconds === 5 * 3600) return '5-hour limit';
  if (seconds === 7 * 86400) return 'Weekly limit';
  if (seconds && seconds % 86400 === 0) return `${seconds / 86400}-day limit`;
  if (seconds && seconds % 3600 === 0) return `${seconds / 3600}-hour limit`;
  return fallback;
}

function windowBar(id, fallbackLabel, window) {
  if (!window || typeof window !== 'object') return null;
  const used = finiteNumber(window.used_percent);
  const usedPercent = used != null ? Math.max(0, Math.min(100, Math.round(used))) : null;
  const windowSeconds = finiteNumber(window.limit_window_seconds);
  const resetValue = window.reset_at == null || (typeof window.reset_at === 'string' && !window.reset_at.trim())
    ? window.reset_after_seconds
    : window.reset_at;
  const reset = parseReset(resetValue);
  if (usedPercent == null && reset.resetAt == null) return null;
  return {
    id,
    label: durationLabel(windowSeconds, fallbackLabel),
    usedPercent,
    windowSeconds,
    ...reset,
  };
}

function usageToBars(json) {
  const limits = json && (json.rate_limit || json.rate_limits);
  if (!limits || typeof limits !== 'object') return [];
  return [
    windowBar('primary', 'Primary limit', limits.primary_window || limits.primary),
    windowBar('secondary', 'Secondary limit', limits.secondary_window || limits.secondary),
  ].filter(Boolean);
}

function requestTimeoutMs() {
  const configured = finiteNumber(process.env.CODEX_LIMITS_TIMEOUT_MS);
  return configured && configured > 0 ? Math.min(configured, 3000) : 3000;
}

function fetchUsage(credential, timeoutMs = requestTimeoutMs()) {
  return new Promise((resolve) => {
    let settled = false;
    let size = 0;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const req = https.request({
      host: API_HOST,
      path: USAGE_PATH,
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${credential.accessToken}`,
        'chatgpt-account-id': credential.accountId,
        'user-agent': 'codex-cli',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          res.destroy();
          finish({ error: 'usage response too large' });
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => finish({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    const timer = setTimeout(() => {
      req.destroy();
      finish({ error: 'usage request timed out' });
    }, timeoutMs);
    req.on('error', (err) => finish({ error: String(err && err.message) }));
    req.end();
  });
}

async function runFetch(findCred = findCredential, request = fetchUsage) {
  const deadlineAt = Date.now() + requestTimeoutMs();
  const requestBeforeDeadline = (credential) => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return Promise.resolve({ error: 'usage request timed out' });
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish({ error: 'usage request timed out' }), remaining);
      Promise.resolve(request(credential, remaining)).then(finish, (err) => {
        finish({ error: String((err && err.message) || err) });
      });
    });
  };
  let credential = findCred();
  if (!credential) return { available: false, error: 'no Codex credential found', bars: [] };
  let response = await requestBeforeDeadline(credential);
  if (response.status === 401 || response.status === 403) {
    const fresh = findCred();
    const changed = fresh && (
      fresh.accessToken !== credential.accessToken || fresh.accountId !== credential.accountId
    );
    if (changed) {
      credential = fresh;
      response = await requestBeforeDeadline(credential);
    }
  }
  const fail = (error, status = null) => ({ available: false, error, status, bars: [], source: credential.source });
  if (response.error) return fail(response.error);
  if (response.status === 401 || response.status === 403) return fail(`token rejected (${response.status})`, response.status);
  if (response.status === 429) return fail('rate limited (429)', response.status);
  let json;
  try {
    json = JSON.parse(response.body);
  } catch (_) {
    return fail(`usage endpoint returned non-JSON (status ${response.status})`, response.status);
  }
  const bars = usageToBars(json);
  return {
    available: bars.length > 0,
    error: bars.length ? null : 'usage endpoint returned no windows',
    status: response.status,
    bars,
    plan: json.plan_type || null,
    source: credential.source,
    updatedAt: new Date().toISOString(),
  };
}

const STALE_MAX_MS = 2 * 60 * 60 * 1000;

function ttlFor(value) {
  if (value && (value.available || value.status === 429)) {
    return SUCCESS_TTL_MS;
  }
  return Math.max(0, Number(process.env.CODEX_LIMITS_ERROR_TTL_MS) || 20_000);
}

function mergeStale(value, lastGood, now) {
  if (now - lastGood.at >= STALE_MAX_MS) return value;
  return {
    ...value,
    bars: lastGood.value.bars,
    plan: lastGood.value.plan,
    stale: true,
    staleSince: lastGood.value.updatedAt || new Date(lastGood.at).toISOString(),
  };
}

const limitsCache = createAdaptiveCache({
  load: runFetch,
  ttlFor,
  isGood: (value) => Boolean(value && value.available && value.bars && value.bars.length),
  mergeStale,
  errorValue: (err) => ({ available: false, error: String((err && err.message) || err), bars: [] }),
});

const getCodexLimitsCached = limitsCache.get;

function _resetCache() {
  limitsCache.reset();
}

function _expireCache() {
  limitsCache.expire();
}

module.exports = {
  getCodexLimitsCached,
  runFetch,
  fetchUsage,
  findCredential,
  extractCredential,
  usageToBars,
  parseReset,
  ttlFor,
  finiteNumber,
  requestTimeoutMs,
  _resetCache,
  _expireCache,
};
