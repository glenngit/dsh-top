// dsh-top — host half (persistent profile bundle).
//
// Registers one exact HTTP route on the dsh web server:
//
//   GET /api/dsh-top-stats
//
// which reads host-wide CPU, memory, disk, network, and the top processes
// with ordinary /proc + ps + df reads and returns a compact JSON payload the
// browser widget renders. All reads are read-only.

import { execFileSync } from "node:child_process";

const name = "dsh-top";
const inject = ["webServer"];

const ROUTE_PATH = "/api/dsh-top-stats";
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

// Transient processes spawned by this very monitor (plus the shell it runs
// under). They are dropped so the top-N list never shows "ps" or "awk".
const SELF = new Set([
  "ps", "awk", "head", "sort", "sh", "bash", "grep", "sed", "cut", "tr",
  "gawk", "mawk", "cat", "df",
]);

function toNum(s) {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}
function clamp(n) { return Math.max(0, Math.min(100, n)); }
function round1(n) { return Math.round(n * 10) / 10; }
function pct(used, total) { return total > 0 ? round1(clamp((used / total) * 100)) : 0; }

function readText(path) {
  return execFileSync("cat", [path], { encoding: "utf8", maxBuffer: 1 << 20 });
}

function sample() {
  // CPU counters from /proc/stat (first "cpu" aggregate line).
  const stat = readText("/proc/stat").split("\n").find((l) => l.startsWith("cpu "));
  const cpu = stat ? stat.trim().split(/\s+/).slice(1).map(toNum) : [];
  const totalCpu = cpu.reduce((a, b) => a + b, 0);
  const idleCpu = (cpu[3] || 0) + (cpu[4] || 0);

  // Memory from /proc/meminfo (kB).
  const meminfo = readText("/proc/meminfo");
  const pick = (k) => {
    const m = meminfo.match(new RegExp("^" + k + ":\\s*(\\d+)", "m"));
    return m ? toNum(m[1]) : 0;
  };
  const memTotal = pick("MemTotal");
  const memAvail = pick("MemAvailable");

  // Root filesystem usage (1 kB blocks per POSIX df).
  const df = execFileSync("df", ["-P", "/"], { encoding: "utf8", maxBuffer: 1 << 20 })
    .split("\n")[1];
  const dfCols = df ? df.trim().split(/\s+/) : [];
  const dfTotal = toNum(dfCols[1]);
  const dfUsed = toNum(dfCols[2]);

  // Cumulative network bytes (sum over non-loopback interfaces).
  const net = readText("/proc/net/dev").split("\n").slice(2);
  let netRx = 0, netTx = 0;
  for (const line of net) {
    const m = line.trim().match(/^([^:]+):\s*(.*)$/);
    if (!m || m[1] === "lo") continue;
    const cols = m[2].split(/\s+/);
    netRx += toNum(cols[0]);
    netTx += toNum(cols[8]);
  }

  // Top processes by CPU. Sample more than needed, drop self/transient names,
  // keep the top 6.
  const psOut = execFileSync("ps", ["-eo", "pid,pcpu,pmem,rss,comm", "--sort=-pcpu", "--no-headers"],
    { encoding: "utf8", maxBuffer: 1 << 20 });
  const procs = [];
  for (const line of psOut.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const nm = m[5].trim();
    const base = nm.split("/").pop().split(" ")[0];
    if (!base || SELF.has(base)) continue;
    procs.push({
      pid: Math.round(toNum(m[1])),
      name: nm,
      cpu: toNum(m[2]),
      mem: toNum(m[3]),
      rssKB: toNum(m[4]),
    });
    if (procs.length >= 6) break;
  }

  // Core count.
  const cores = (() => {
    try {
      const n = (readText("/proc/cpuinfo").match(/^processor\s*:/gm) || []).length;
      return Math.max(1, n);
    } catch { return 1; }
  })();

  return { totalCpu, idleCpu, memTotal, memAvail, dfTotal, dfUsed, netRx, netTx, cores, procs };
}

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function apply(ctx) {
  let prev = null;

  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: ROUTE_PATH,
      handler: async (req, res) => {
        try {
          const raw = sample();
          const now = Date.now();
          let cpuPct = 0, rxRate = 0, txRate = 0;
          if (prev) {
            const dt = (now - prev.at) / 1000;
            if (dt > 0) {
              const dTotal = raw.totalCpu - prev.totalCpu;
              const dIdle = raw.idleCpu - prev.idleCpu;
              if (dTotal > 0) cpuPct = clamp((1 - dIdle / dTotal) * 100);
              rxRate = Math.max(0, (raw.netRx - prev.netRx) / dt);
              txRate = Math.max(0, (raw.netTx - prev.netTx) / dt);
            }
          }
          prev = { at: now, totalCpu: raw.totalCpu, idleCpu: raw.idleCpu, netRx: raw.netRx, netTx: raw.netTx };
          const memUsed = Math.max(0, raw.memTotal - raw.memAvail);
          sendJson(res, 200, {
            ok: true,
            cores: raw.cores,
            cpu: round1(cpuPct),
            mem: { usedMB: memUsed / 1024, totalMB: raw.memTotal / 1024, pct: pct(memUsed, raw.memTotal) },
            disk: { usedMB: raw.dfUsed / 1024, totalMB: raw.dfTotal / 1024, pct: pct(raw.dfUsed, raw.dfTotal) },
            net: { rx: Math.round(rxRate), tx: Math.round(txRate) },
            procs: raw.procs.map((p) => ({ pid: p.pid, name: p.name, cpu: round1(p.cpu), mem: round1(p.mem), rssKB: p.rssKB })),
          });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String((error && error.message) || error) });
        }
      },
    }),
    "dsh-top: stats route",
  );
}

export { name, inject, apply };
