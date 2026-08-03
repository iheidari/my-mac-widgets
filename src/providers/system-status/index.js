'use strict';

// System Status — uptime, memory, disk and connectivity for the system-status
// widget. Served at GET /stats/system-status.

const { memoizeAsync } = require('../../core/cache');
const { readUptime, readMemory, readDisk } = require('./system');
const { ConnectivityMonitor } = require('./connectivity');

// One monitor per process, shared by every reader. It starts on the first
// collect() and parks itself once nothing has read it for a couple of minutes,
// so quitting Übersicht stops the network polling too.
const monitor = new ConnectivityMonitor();

const MACHINE_TTL_MS = 5_000;

// vm_stat forks a subprocess, so the machine readings get a short cache of
// their own. The sole widget polls every 10s, so this window rarely serves it a
// hit — it is there so that a *second* reader (the CLI, another widget) is free
// rather than another fork. Uptime is left out: it is arithmetic on a cached
// boot time.
const readMachine = memoizeAsync(async () => ({ memory: readMemory(), disk: readDisk() }), {
  ttlMs: MACHINE_TTL_MS,
});

module.exports = {
  id: 'system-status',
  title: 'System Status',

  // This payload mixes cadences, so it opts out of the host's whole-payload
  // memo (in-flight de-duplication still applies) and caches its own sources.
  // Freezing everything for a TTL would hold a connectivity change off the
  // widget for that long, and monitor.read() is also the liveness signal that
  // keeps the prober awake — routed through a cache whose job is to *avoid*
  // calling collect(), it would eventually park the prober mid-use.
  ttlMs: 0,

  async collect() {
    const now = Date.now();
    return {
      uptime: readUptime(now),
      ...(await readMachine()),
      internet: monitor.read(),
      generatedAt: new Date(now).toISOString(),
    };
  },

  print(data) {
    const row = (r) => `${r?.usedPercent == null ? '—' : `${r.usedPercent}%`}  ${r?.text || ''}`;
    const net = data.internet.online == null ? 'checking…' : data.internet.online ? 'online' : 'offline';
    console.log('\n  System Status');
    console.log('  ' + '─'.repeat(34));
    console.log(`  uptime    ${data.uptime?.text || '—'}`);
    console.log(`  memory    ${row(data.memory)}`);
    console.log(`  disk      ${row(data.disk)}`);
    console.log(`  internet  ${net}\n`);
  },
};
