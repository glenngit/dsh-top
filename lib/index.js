// dsh-top — host half (persistent profile bundle).
//
// Registers one exact HTTP route on the dsh web server:
//
//   GET /api/dsh-top-stats
//
// which returns host-wide CPU, memory, disk, network, and top processes as a
// compact JSON payload the browser widget renders. All reads are read-only.
//
// Multi-platform:
//   CPU and memory are computed with Node's built-in `os` module, so they work
//   identically on Linux, Windows and macOS with no subprocess. Disk, network
//   and process collection are best-effort per platform (see PLATFORMS) and
//   degrade to `null` rather than failing the whole request, so a partial
//   result still returns with the pieces that are available.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { cpus, totalmem, freemem } from "node:os";

const name = "dsh-top";
const inject = ["webServer"];

const ROUTE_PATH = "/api/dsh-top-stats";
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

const PLATFORM = process.platform; // "linux" | "win32" | "darwin" | ...

// Transient processes spawned by the collectors themselves (plus the shell
// they run under). They are dropped so the top-N list never shows the
// monitoring commands themselves.
const SELF = new Set([
  "ps", "awk", "head", "sort", "sh", "bash", "grep", "sed", "cut", "tr",
  "gawk", "mawk", "df", "wmic", "powershell", "pwsh", "Get-NetAdapterStatistics",
]);

function toNum(s) {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}
function clamp(n) { return Math.max(0, Math.min(100, n)); }
function round1(n) { return Math.round(n * 10) / 10; }
function pct(used, total) { return total > 0 ? round1(clamp((used / total) * 100)) : 0; }

// ---------------------------------------------------------------------------
// Cross-platform collectors (Node `os`, no subprocess, no /proc dependency).
// These are the backbone and work on Linux, Windows and macOS alike.
// ---------------------------------------------------------------------------

function readText(path) {
  // /proc pseudo-files are plain UTF-8 text read through Node's own fs — no
  // subprocess/no shell. Used only by the Linux network collector.
  return readFileSync(path, "utf8");
}

function sampleCpuMem() {
  const list = cpus();
  const totalCpu = list.reduce(
    (a, c) => a + c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq, 0);
  const idleCpu = list.reduce((a, c) => a + c.times.idle, 0);
  const memTotal = totalmem();
  const memFree = freemem();
  return { totalCpu, idleCpu, memTotal, memFree, cores: Math.max(1, list.length) };
}

// ---------------------------------------------------------------------------
// Best-effort per-platform collectors. Each returns a value or null when the
// platform/command is unavailable. A null simply leaves that section out of
// the payload — it never fails the request.
// ---------------------------------------------------------------------------

function runJson(cmd, args, options) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 20, ...options });
  } catch (err) {
    console.error(`[dsh-top] ${cmd} unavailable:`, String(err && err.message));
    return null;
  }
}

// --- Disk ---------------------------------------------------------------- //
function collectDisk() {
  if (PLATFORM === "linux" || PLATFORM === "darwin") {
    // POSIX df: 1 kB blocks. macOS df -P works too; we take the "/" mount.
    const out = runJson("df", ["-P", "/"]);
    if (out == null) return null;
    const line = out.split("\n")[1];
    const cols = line ? line.trim().split(/\s+/) : [];
    const totalKB = toNum(cols[1]);
    const usedKB = toNum(cols[2]);
    if (!totalKB) return null;
    return { usedKB, totalKB };
  }
  if (PLATFORM === "win32") {
    // Windows: report the drive containing the current working directory via
    // PowerShell's Get-PSDrive (no admin needed, read-only).
    const out = runJson("powershell", [
      "-NoProfile", "-NonInteractive", "-Command",
      "$d=Get-PSDrive -Name (Get-Location).Drive.Name; " +
      "[pscustomobject]@{Used=[long]$d.Used;Free=[long]$d.Free} | ConvertTo-Json -Compress",
    ]);
    if (!out) return null;
    let j; try { j = JSON.parse(out); } catch { return null; }
    const usedKB = (toNum(j.Used)) / 1024;
    const totalKB = (toNum(j.Used) + toNum(j.Free)) / 1024;
    if (!totalKB) return null;
    return { usedKB, totalKB };
  }
  return null;
}

// --- Network ------------------------------------------------------------- //
function collectNet() {
  if (PLATFORM === "linux") {
    // Cumulative bytes per interface from /proc/net/dev (non-loopback).
    let raw;
    try { raw = readText("/proc/net/dev"); } catch { return null; }
    let rx = 0, tx = 0;
    for (const line of raw.split("\n").slice(2)) {
      const m = line.trim().match(/^([^:]+):\s*(.*)$/);
      if (!m || m[1] === "lo") continue;
      const cols = m[2].split(/\s+/);
      rx += toNum(cols[0]);
      tx += toNum(cols[8]);
    }
    return { rx, tx };
  }
  if (PLATFORM === "darwin") {
    // netstat -ib gives cumulative in/out bytes per interface in the
    // Ibytes/Obytes columns; skip loopback.
    // Header (macOS): Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
    const out = runJson("netstat", ["-ibn"]);
    if (!out) return null;
    const rows = out.split("\n").map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 2);
    const headerIdx = rows.findIndex((c) => c[0] === "Name");
    if (headerIdx < 0) return null;
    const ix = rows[headerIdx].indexOf("Ibytes");
    const ox = rows[headerIdx].indexOf("Obytes");
    if (ix < 0 || ox < 0) return null;
    // A given interface appears on multiple rows (one per IP address); the
    // first row for each name carries the counters, subsequent repeats should
    // be summed only once. Track seen names.
    let rx = 0, tx = 0;
    const seen = new Set();
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const c = rows[i];
      if (c[0].startsWith("lo")) continue;
      if (seen.has(c[0])) continue;
      seen.add(c[0]);
      rx += toNum(c[ix]);
      tx += toNum(c[ox]);
    }
    return { rx, tx };
  }
  if (PLATFORM === "win32") {
    // Cumulative per-adapter bytes via Get-NetAdapterStatistics.
    const out = runJson("powershell", [
      "-NoProfile", "-NonInteractive", "-Command",
      "$s=Get-NetAdapterStatistics; [pscustomobject]@{Rx=($s | Measure-Object ReceivedBytes -Sum).Sum; " +
      "Tx=($s | Measure-Object SentBytes -Sum).Sum} | ConvertTo-Json -Compress",
    ]);
    if (!out) return null;
    let j; try { j = JSON.parse(out); } catch { return null; }
    return { rx: toNum(j.Rx), tx: toNum(j.Tx) };
  }
  return null;
}

// --- Top processes ------------------------------------------------------- //
function collectProcs() {
  const TOPN = 6;
  if (PLATFORM === "linux") {
    const out = runJson("ps", ["-eo", "pid,pcpu,pmem,rss,comm", "--sort=-pcpu", "--no-headers"]);
    if (!out) return null;
    const procs = [];
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
      if (!m) continue;
      const nm = m[5].trim();
      const base = nm.split("/").pop().split(" ")[0];
      if (!base || SELF.has(base)) continue;
      procs.push({ pid: Math.round(toNum(m[1])), name: nm, cpu: toNum(m[2]), mem: toNum(m[3]), rssKB: toNum(m[4]) });
      if (procs.length >= TOPN) break;
    }
    return procs.length ? procs : null;
  }
  if (PLATFORM === "darwin") {
    // macOS BSD ps: rss is in KB, %cpu/%mem already percentages.
    const out = runJson("ps", ["-Aceo", "pid,pcpu,pmem,rss,comm", "-r"]);
    if (!out) return null;
    const procs = [];
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
      if (!m) continue;
      const nm = m[5].trim();
      const base = nm.split("/").pop().split(" ")[0];
      if (!base || SELF.has(base)) continue;
      procs.push({ pid: Math.round(toNum(m[1])), name: nm, cpu: toNum(m[2]), mem: toNum(m[3]), rssKB: toNum(m[4]) });
      if (procs.length >= TOPN) break;
    }
    return procs.length ? procs : null;
  }
  if (PLATFORM === "win32") {
    // Windows: Get-Process, sorted by CPU, hand-rolled top-N.
    const out = runJson("powershell", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Get-Process | Sort-Object CPU -Descending | Select-Object -First " + (TOPN * 3) + " | " +
      "ForEach-Object { [pscustomobject]@{Id=$_.Id;Name=$_.ProcessName;Cpu=[math]::Round($_.CPU,1);" +
      "Mem=[math]::Round($_.WorkingSet64/1KB,1);Rss=[long]($_.WorkingSet64/1KB)} } | ConvertTo-Json -Compress",
    ]);
    if (!out) return null;
    let j; try { j = JSON.parse(out); } catch { return null; }
    const rows = Array.isArray(j) ? j : [j];
    const procs = [];
    for (const r of rows) {
      const nm = String(r.Name || "");
      if (!nm || SELF.has(nm)) continue;
      procs.push({ pid: Math.round(toNum(r.Id)), name: nm, cpu: toNum(r.Cpu), mem: toNum(r.Mem), rssKB: toNum(r.Rss) });
      if (procs.length >= TOPN) break;
    }
    return procs.length ? procs : null;
  }
  return null;
}

// ---------------------------------------------------------------------------

function sample() {
  const base = sampleCpuMem();
  let disk = null, net = null, procs = null;
  try { disk = collectDisk(); } catch (e) { console.error("[dsh-top] disk collector failed:", e); }
  try { net = collectNet(); } catch (e) { console.error("[dsh-top] net collector failed:", e); }
  try { procs = collectProcs(); } catch (e) { console.error("[dsh-top] procs collector failed:", e); }
  return { ...base, disk, net, procs };
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
              if (raw.net && prev.net) {
                rxRate = Math.max(0, (raw.net.rx - prev.net.rx) / dt);
                txRate = Math.max(0, (raw.net.tx - prev.net.tx) / dt);
              }
            }
          }
          prev = {
            at: now,
            totalCpu: raw.totalCpu,
            idleCpu: raw.idleCpu,
            net: raw.net ? { rx: raw.net.rx, tx: raw.net.tx } : null,
          };
          const memUsed = Math.max(0, raw.memTotal - raw.memFree);
          const payload = {
            ok: true,
            platform: PLATFORM,
            cores: raw.cores,
            cpu: round1(cpuPct),
            mem: { usedMB: memUsed / 1048576, totalMB: raw.memTotal / 1048576, pct: pct(memUsed, raw.memTotal) },
          };
          if (raw.disk) {
            payload.disk = {
              usedMB: raw.disk.usedKB / 1024,
              totalMB: raw.disk.totalKB / 1024,
              pct: pct(raw.disk.usedKB, raw.disk.totalKB),
            };
          } else {
            payload.disk = null;
          }
          if (raw.net) {
            payload.net = { rx: Math.round(rxRate), tx: Math.round(txRate) };
          } else {
            payload.net = null;
          }
          payload.procs = raw.procs
            ? raw.procs.map((p) => ({ pid: p.pid, name: p.name, cpu: round1(p.cpu), mem: round1(p.mem), rssKB: p.rssKB }))
            : null;
          sendJson(res, 200, payload);
        } catch (error) {
          // Never leak the underlying error string to the client — it may
          // contain an absolute path or tooling detail. Log server-side only.
          console.error("[dsh-top] stats sampling failed:", error);
          sendJson(res, 500, { ok: false, error: "stats unavailable" });
        }
      },
    }),
    "dsh-top: stats route",
  );
}

export { name, inject, apply };