'use strict';

// Machine readings for the system-status provider: uptime, memory, disk.
//
// Every function that interprets a number is pure and takes its input as an
// argument, so the tests can drive them from fixture strings instead of the
// developer's actual machine. Only the thin `read*` wrappers touch the OS.

const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const GIB = 1024 ** 3;
const GB = 1000 ** 3;

// The Data volume, not `/`. On APFS `/` is the sealed read-only system
// snapshot, which reports ~15% full forever; everything a user actually fills
// up lives on /System/Volumes/Data (93% here). Reading `/` is the classic way
// to ship a disk gauge that never moves.
const DEFAULT_VOLUME = '/System/Volumes/Data';

// ------------------------------------------------------------------- uptime

// `sysctl -n kern.boottime` prints: { sec = 1785611624, usec = 206644 } Sat ...
function parseBootTime(text) {
  const m = /sec\s*=\s*(\d+)/.exec(String(text || ''));
  if (!m) return null;
  const ms = Number(m[1]) * 1000;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

// "12m" / "3h 12m" / "1d 11h" — one step of precision below the leading unit,
// which is as much as anyone reads off a desktop widget.
function formatUptime(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.floor(seconds);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function uptimeFrom(bootMs, nowMs) {
  if (bootMs == null) return { bootAt: null, seconds: null, text: null };
  const seconds = Math.max(0, Math.round((nowMs - bootMs) / 1000));
  return { bootAt: new Date(bootMs).toISOString(), seconds, text: formatUptime(seconds) };
}

// ------------------------------------------------------------------- memory

// Activity Monitor's "Memory Used" = App Memory + Wired + Compressed, where
// App Memory is anonymous pages less the purgeable ones.
//
// The tempting shortcut — total minus (free + speculative) — is what `top`
// prints as "PhysMem used", and it is a different number: it counts the whole
// file-backed page cache as used. On this machine that is 71% against Activity
// Monitor's 40%, with the OS reporting 89% free. Since the widget colours the
// bar amber past 75% and red past 90%, the shortcut would leave it permanently
// alarming about memory macOS considers available. Cached files are reported
// separately, the way Activity Monitor reports them.
function parseVmStat(text, totalBytes) {
  const src = String(text || '');
  const pageSize = Number((/page size of (\d+) bytes/.exec(src) || [])[1]);
  const pages = (label) => {
    const m = new RegExp(`${label}:\\s+(\\d+)`).exec(src);
    return m ? Number(m[1]) : null;
  };

  const anonymous = pages('Anonymous pages');
  const purgeable = pages('Pages purgeable');
  const wired = pages('Pages wired down');
  const compressed = pages('Pages occupied by compressor');
  const free = pages('Pages free');
  const speculative = pages('Pages speculative');
  const counts = [anonymous, purgeable, wired, compressed, free, speculative];
  if (!Number.isFinite(pageSize) || counts.some((v) => v == null)) return null;
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;

  const usedBytes = Math.min(totalBytes, Math.max(0, anonymous - purgeable + wired + compressed) * pageSize);
  const unusedBytes = (free + speculative) * pageSize;
  return {
    totalBytes,
    usedBytes,
    // The reclaimable part of freeBytes — file cache the kernel hands back on
    // demand. Reported on its own the way Activity Monitor reports it, but it
    // is a *breakdown* of freeBytes, not a third bucket: usedBytes + freeBytes
    // is the total, and cachedBytes is already inside the second term.
    cachedBytes: Math.max(0, totalBytes - usedBytes - unusedBytes),
    freeBytes: totalBytes - usedBytes,
    usedPercent: round1((usedBytes / totalBytes) * 100),
    text: `${gib(usedBytes)} of ${gib(totalBytes)} used`,
  };
}

// --------------------------------------------------------------------- disk

// Matches what `df` and Finder report: capacity is measured against what this
// user can actually claim, so the blocks reserved for root are excluded from
// the denominator rather than counted as free space.
function diskFromStatfs(stat, volume) {
  if (!stat || !Number.isFinite(stat.bsize) || !Number.isFinite(stat.blocks)) return null;
  const totalBytes = stat.blocks * stat.bsize;
  const availBytes = Math.max(0, stat.bavail * stat.bsize);
  const usedBytes = Math.max(0, (stat.blocks - stat.bfree) * stat.bsize);
  const denominator = usedBytes + availBytes;
  if (denominator <= 0) return null;
  return {
    volume,
    totalBytes,
    usedBytes,
    freeBytes: availBytes,
    // usedPercent's denominator, exposed so the payload reconciles: usedBytes
    // over totalBytes is *not* usedPercent — the gap is the root reservation.
    capacityBytes: denominator,
    usedPercent: round1((usedBytes / denominator) * 100),
    text: `${gb(availBytes)} free of ${gb(totalBytes)}`,
  };
}

// ----------------------------------------------------------------- helpers

function round1(n) {
  return Math.round(n * 10) / 10;
}

// One rounding rule, two unit systems: memory follows Activity Monitor (binary
// units, labelled the way Apple labels them — "64 GB" for 64 GiB of RAM) and
// storage follows Finder (decimal, so 995G here matches its "995 GB").
function size(bytes, base) {
  const v = bytes / base;
  if (v >= 1000) return `${Number((v / 1000).toFixed(1))}T`;
  return `${v >= 100 ? Math.round(v) : Number(v.toFixed(1))}G`;
}

const gib = (bytes) => size(bytes, GIB);
const gb = (bytes) => size(bytes, GB);

// ------------------------------------------------------------------ readers

// Each reader answers null on any failure — a provider that throws becomes a
// 500 and takes the other three readings off the widget with it.

// Boot time cannot change while this process lives, so the sysctl runs once
// rather than forking on every widget poll; only `nowMs` moves. Only a
// *successful* parse is cached — caching a null would freeze uptime at "—" for
// the life of the helper, and re-forking is the cheaper way to be wrong.
let bootMs = null;
function readUptime(nowMs = Date.now()) {
  try {
    if (bootMs == null) {
      bootMs = parseBootTime(execFileSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8' }));
    }
    return uptimeFrom(bootMs, nowMs);
  } catch (_) {
    return uptimeFrom(null);
  }
}

function readMemory() {
  try {
    // os.totalmem() is hw.memsize read in-process — same bytes, no fork.
    return parseVmStat(execFileSync('vm_stat', { encoding: 'utf8' }), os.totalmem());
  } catch (_) {
    return null;
  }
}

function readDisk(volume = process.env.SYSTEM_STATUS_DISK_VOLUME || DEFAULT_VOLUME) {
  try {
    return diskFromStatfs(fs.statfsSync(volume), volume);
  } catch (_) {
    return null;
  }
}

module.exports = {
  parseBootTime,
  formatUptime,
  uptimeFrom,
  parseVmStat,
  diskFromStatfs,
  readUptime,
  readMemory,
  readDisk,
  DEFAULT_VOLUME,
};
