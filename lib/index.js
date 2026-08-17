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
  // subprocess/no shell. Used only by the Linux collectors.
  return readFileSync(path, "utf8");
}

// --- Container-aware reporting (Linux cgroups) --------------------------- //
// Inside a container, os.totalmem()/os.cpus() report the HOST's figures, not
// the container's cgroup limit. When a cgroup memory or cpu limit is set, we
// report the container's true limit; otherwise we fall back to the host view.
// Limits may live at any ancestor of our cgroup path, so we walk upward from
// our own leaf toward the root and take the first real value we find.

const CGROUP2 = "/sys/fs/cgroup";

// Our own cgroup path from /proc/self/cgroup, e.g. "/user.slice/.../scope".
function myCgroupPath() {
  try {
    const m = readText("/proc/self/cgroup").split("\n")[0].match(/^[^:]*:[^:]*:(.+)$/);
    return m ? m[1] : null;
  } catch { return null; }
}

// Raw contents of <cgroup>/<dir>/<name> for the nearest ancestor (leaf first).
// Returns trimmed string, or null when no ancestor exposes the file.
function cgroupRead(name) {
  const base = myCgroupPath();
  if (!base) return null;
  const segs = String(base).split("/").filter(Boolean);
  for (let depth = 0; depth <= segs.length; depth++) {
    const dir = "/" + segs.slice(0, segs.length - depth).join("/");
    try { return readText(CGROUP2 + dir + "/" + name).trim(); } catch { /* try parent */ }
  }
  return null;
}

// Container memory limit, if the cgroup sets one. Returns {limit, used} in
// bytes, else null (host view applies).
function containerMem() {
  // cgroup v2
  const max = cgroupRead("memory.max");
  if (max && max !== "max") {
    const limit = toNum(max);
    if (limit > 0) {
      const cur = cgroupRead("memory.current");
      return { limit, used: toNum(cur) };
    }
  }
  // cgroup v1
  const limitFile = CGROUP2 + "/memory/memory.limit_in_bytes";
  let limitV1 = null, usedV1 = 0;
  try {
    const v = readText(limitFile).trim();
    if (v !== "max" && toNum(v) > 0) limitV1 = toNum(v);
  } catch { /* no v1 controller */ }
  if (limitV1) {
    try { usedV1 = toNum(readText(limitFile.replace(/limit_in_bytes$/, "usage_in_bytes"))); } catch {}
    return { limit: limitV1, used: usedV1 };
  }
  return null;
}

// Container core quota, if the cgroup restricts it. Returns integer cores,
// else null (os.cpus().length applies).
function containerCores() {
  // cgroup v2: cpu.max = "QUOTA PERIOD"
  const cpuMax = cgroupRead("cpu.max");
  if (cpuMax && cpuMax !== "max") {
    const [quota, period] = cpuMax.split(/\s+/).map(toNum);
    if (quota > 0 && period > 0) return Math.max(1, Math.round(quota / period));
  }
  // cgroup v1: cpu/cpu.cfs_quota_us "/" cpu/cpu.cfs_period_us
  let quota = null, period = 0;
  try { const q = readText(CGROUP2 + "/cpu/cpu.cfs_quota_us").trim(); if (q !== "-1") quota = toNum(q); } catch {}
  if (quota != null && quota > 0) {
    try { period = toNum(readText(CGROUP2 + "/cpu/cpu.cfs_period_us")); } catch {}
    if (period > 0) return Math.max(1, Math.round(quota / period));
  }
  return null;
}

function sampleCpuMem() {
  const list = cpus();
  const totalCpu = list.reduce(
    (a, c) => a + c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq, 0);
  const idleCpu = list.reduce((a, c) => a + c.times.idle, 0);

  // Container-aware memory: use the cgroup limit when one is set.
  let memTotal = totalmem(), memFree = freemem();
  if (PLATFORM === "linux") {
    const cm = containerMem();
    if (cm && cm.limit) {
      memTotal = cm.limit;
      memFree = Math.max(0, cm.limit - cm.used);
    }
  }

  // Container-aware core count.
  let cores = Math.max(1, list.length);
  if (PLATFORM === "linux") {
    const cc = containerCores();
    if (cc) cores = cc;
  }

  return { totalCpu, idleCpu, memTotal, memFree, cores };
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

// --- Pure parsers (unit-testable without a live OS) ---------------------- //
// Each takes raw command/stdout text and returns the parsed result or null.
// Keeping these pure means the macOS/Windows branches can be exercised with
// realistic fixtures even on a Linux-only dev box.

function parseDisk(out) {
  if (!out) return null;
  const line = out.split("\n")[1];
  const cols = line ? line.trim().split(/\s+/) : [];
  const totalKB = toNum(cols[1]);
  const usedKB = toNum(cols[2]);
  if (!totalKB) return null;
  return { usedKB, totalKB };
}

function parseDiskWin(jsonStr) {
  if (!jsonStr) return null;
  let j; try { j = JSON.parse(jsonStr); } catch { return null; }
  const usedKB = toNum(j.Used) / 1024;
  const totalKB = (toNum(j.Used) + toNum(j.Free)) / 1024;
  if (!totalKB) return null;
  return { usedKB, totalKB };
}

function parseNetLinux(raw) {
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

function parseNetDarwin(out) {
  if (!out) return null;
  // Header: Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
  const rows = out.split("\n").map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 2);
  const headerIdx = rows.findIndex((c) => c[0] === "Name");
  if (headerIdx < 0) return null;
  const ix = rows[headerIdx].indexOf("Ibytes");
  const ox = rows[headerIdx].indexOf("Obytes");
  if (ix < 0 || ox < 0) return null;
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

function parseNetWin(jsonStr) {
  if (!jsonStr) return null;
  let j; try { j = JSON.parse(jsonStr); } catch { return null; }
  return { rx: toNum(j.Rx), tx: toNum(j.Tx) };
}

function parseProcs(out, topN, isWinJson) {
  if (!out) return null;
  const procs = [];
  if (isWinJson) {
    let j; try { j = JSON.parse(out); } catch { return null; }
    const rows = Array.isArray(j) ? j : [j];
    for (const r of rows) {
      const nm = String(r.Name || "");
      if (!nm || SELF.has(nm)) continue;
      procs.push({ pid: Math.round(toNum(r.Id)), name: nm, cpu: toNum(r.Cpu), mem: toNum(r.Mem), rssKB: toNum(r.Rss) });
      if (procs.length >= topN) break;
    }
  } else {
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
      if (!m) continue;
      const nm = m[5].trim();
      const base = nm.split("/").pop().split(" ")[0];
      if (!base || SELF.has(base)) continue;
      procs.push({ pid: Math.round(toNum(m[1])), name: nm, cpu: toNum(m[2]), mem: toNum(m[3]), rssKB: toNum(m[4]) });
      if (procs.length >= topN) break;
    }
  }
  return procs.length ? procs : null;
}

// --- Disk ---------------------------------------------------------------- //
function collectDisk() {
  if (PLATFORM === "linux" || PLATFORM === "darwin") {
    return parseDisk(runJson("df", ["-P", "/"]));
  }
  if (PLATFORM === "win32") {
    const out = runJson("powershell", [
      "-NoProfile", "-NonInteractive", "-Command",
      "$d=Get-PSDrive -Name (Get-Location).Drive.Name; " +
      "[pscustomobject]@{Used=[long]$d.Used;Free=[long]$d.Free} | ConvertTo-Json -Compress",
    ]);
    return parseDiskWin(out);
  }
  return null;
}

// --- Network ------------------------------------------------------------- //
function collectNet() {
  if (PLATFORM === "linux") {
    try { return parseNetLinux(readText("/proc/net/dev")); }
    catch { return null; }
  }
  if (PLATFORM === "darwin") {
    return parseNetDarwin(runJson("netstat", ["-ibn"]));
  }
  if (PLATFORM === "win32") {
    const out = runJson("powershell", [
      "-NoProfile", "-NonInteractive", "-Command",
      "$s=Get-NetAdapterStatistics; [pscustomobject]@{Rx=($s | Measure-Object ReceivedBytes -Sum).Sum; " +
      "Tx=($s | Measure-Object SentBytes -Sum).Sum} | ConvertTo-Json -Compress",
    ]);
    return parseNetWin(out);
  }
  return null;
}

// --- Top processes ------------------------------------------------------- //
function collectProcs() {
  const TOPN = 6;
  if (PLATFORM === "linux") {
    return parseProcs(runJson("ps", ["-eo", "pid,pcpu,pmem,rss,comm", "--sort=-pcpu", "--no-headers"]), TOPN, false);
  }
  if (PLATFORM === "darwin") {
    return parseProcs(runJson("ps", ["-Aceo", "pid,pcpu,pmem,rss,comm", "-r"]), TOPN, false);
  }
  if (PLATFORM === "win32") {
    const out = runJson("powershell", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Get-Process | Sort-Object CPU -Descending | Select-Object -First " + (TOPN * 3) + " | " +
      "ForEach-Object { [pscustomobject]@{Id=$_.Id;Name=$_.ProcessName;Cpu=[math]::Round($_.CPU,1);" +
      "Mem=[math]::Round($_.WorkingSet64/1KB,1);Rss=[long]($_.WorkingSet64/1KB)} } | ConvertTo-Json -Compress",
    ]);
    return parseProcs(out, TOPN, true);
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

export { name, inject, apply, parseDisk, parseDiskWin, parseNetLinux, parseNetDarwin, parseNetWin, parseProcs, containerMem, containerCores };