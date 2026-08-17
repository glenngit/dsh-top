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
import { cpus, totalmem, freemem, loadavg, uptime } from "node:os";

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
// Limits may live at any ancestor of our cgroup path (a host-level cap above
// a Docker limit, for example), so we walk the ancestors leaf-first in BOTH
// cgroup v1 and v2 and take the tightest real limit we find. Kernel-default
// sentinels ("max", "-1", and ~2^63 for unrestricted v1 memory) are treated
// as "no limit" so an unrestricted host is never misreported.

const CGROUP2 = "/sys/fs/cgroup";

// Our own cgroup path from /proc/self/cgroup, e.g. "/user.slice/.../scope".
function myCgroupPath() {
  try {
    const m = readText("/proc/self/cgroup").split("\n")[0].match(/^[^:]*:[^:]*:(.+)$/);
    return m ? m[1] : null;
  } catch { return null; }
}

// Pure cgroup file parsers (unit-testable without a live kernel).
//
// A value is "no limit" when it is the literal "max", the cgroup-v1 CFS
// sentinel "-1", or a kernel-default sentinel. v1 memory.limit_in_bytes on an
// unrestricted root cgroup is roughly 2^63 bytes (~9.2 EiB), so any plausible
// physical memory sits far below it: we treat >= 2^60 (1 EiB) as "no limit"
// rather than reporting it as the machine's RAM.
const CGROUP_NO_LIMIT = 2 ** 60;

function parseCgroupMemLimit(text) {
  if (text == null) return null;
  const v = String(text).trim();
  if (v === "max" || v === "-1") return null;
  const n = toNum(v);
  return n > 0 && n < CGROUP_NO_LIMIT ? n : null;
}

function parseCgroupQuota(text) {
  // cgroup v2 "cpu.max": "QUOTA PERIOD" or "max PERIOD" -> cores or null.
  if (text == null) return null;
  const [q, p] = String(text).trim().split(/\s+/).map(toNum);
  if (q <= 0 || p <= 0 || q >= CGROUP_NO_LIMIT) return null;
  return Math.max(1, Math.round(q / p));
}

function parseCgroupCfsQuota(quotaText, periodText) {
  // cgroup v1 cpu.cfs_quota_us / cpu.cfs_period_us -> cores or null.
  // "-1" means no quota; a 0/missing period means no limit.
  if (quotaText == null || periodText == null) return null;
  const q = toNum(String(quotaText).trim());
  const p = toNum(String(periodText).trim());
  if (q <= 0 || p <= 0 || q >= CGROUP_NO_LIMIT) return null;
  return Math.max(1, Math.round(q / p));
}

// Our cgroup path's ancestor directories, leaf first, ending at "/".
// /user.slice/foo.scope -> ["/user.slice/foo.scope", "/user.slice", "/"]
function cgroupDirs() {
  const base = myCgroupPath();
  if (!base) return ["/"];
  const segs = String(base).split("/").filter(Boolean);
  const dirs = [];
  for (let depth = 0; depth <= segs.length; depth++) {
    dirs.push("/" + segs.slice(0, segs.length - depth).join("/"));
  }
  return dirs;
}

// Walk our ancestors (leaf first) reading <CGROUP2><dir>/<name>.
// `pick` receives each trimmed value and returns the first non-null result.
function cgroupWalk(name, pick) {
  for (const dir of cgroupDirs()) {
    let v = null;
    try { v = readText(CGROUP2 + dir + "/" + name).trim(); } catch { /* try parent */ }
    const r = pick(v);
    if (r !== null && r !== undefined) return r;
  }
  return null;
}

// Container memory limit, if the cgroup sets one. Returns {limit, used} in
// bytes, else null (host view applies). When several ancestors set a limit
// (e.g. a host-level cap above a Docker limit), the tightest applies.
function containerMem() {
  // cgroup v2: memory.max across our ancestors (tightest wins); usage from
  // our own leaf.
  let limit = null;
  for (const dir of cgroupDirs()) {
    let v = null;
    try { v = readText(CGROUP2 + dir + "/memory.max").trim(); } catch { continue; }
    const l = parseCgroupMemLimit(v);
    if (l != null && (limit == null || l < limit)) limit = l;
  }
  if (limit != null) {
    const used = cgroupWalk("memory.current", (v) => (v == null ? null : toNum(v)));
    return { limit, used: used == null ? 0 : used };
  }
  // cgroup v1: memory/memory.limit_in_bytes + usage_in_bytes at our cgroup
  let limitV1 = null, usedV1 = 0;
  for (const dir of cgroupDirs()) {
    const limitFile = CGROUP2 + dir + "/memory/memory.limit_in_bytes";
    const usageFile = CGROUP2 + dir + "/memory/memory.usage_in_bytes";
    let v = null, u = null;
    try { v = readText(limitFile).trim(); } catch { continue; }
    try { u = readText(usageFile).trim(); } catch { /* usage optional */ }
    const l = parseCgroupMemLimit(v);
    if (l != null && (limitV1 == null || l < limitV1)) {
      limitV1 = l;
      usedV1 = u == null ? 0 : toNum(u);
    }
  }
  if (limitV1 != null) return { limit: limitV1, used: usedV1 };
  return null;
}

// Container core quota, if the cgroup restricts it. Returns integer cores,
// else null (os.cpus().length applies). Tightest ancestor wins.
function containerCores() {
  let best = null;
  for (const dir of cgroupDirs()) {
    let v = null;
    try { v = readText(CGROUP2 + dir + "/cpu.max").trim(); } catch { continue; }
    const c = parseCgroupQuota(v);
    if (c != null && (best == null || c < best)) best = c;
  }
  if (best != null) return best;
  // cgroup v1: cpu/cpu.cfs_quota_us + cpu/cpu.cfs_period_us at our cgroup
  for (const dir of cgroupDirs()) {
    const quotaFile = CGROUP2 + dir + "/cpu/cpu.cfs_quota_us";
    const periodFile = CGROUP2 + dir + "/cpu/cpu.cfs_period_us";
    let q = null, p = null;
    try { q = readText(quotaFile).trim(); } catch { continue; }
    try { p = readText(periodFile).trim(); } catch { continue; }
    const c = parseCgroupCfsQuota(q, p);
    if (c != null && (best == null || c < best)) best = c;
  }
  return best;
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

// Bound every external collector: a wedged `ps`/`df`/`powershell` must time
// out and degrade to null instead of holding the request open.
const EXEC_TIMEOUT_MS = 5000;

function runJson(cmd, args, options) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      maxBuffer: 1 << 20,
      timeout: EXEC_TIMEOUT_MS,
      ...options,
    });
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

function parseProcs(out, topN, isWinJson, nowMs, memTotalBytes) {
  if (!out) return null;
  const procs = [];
  if (isWinJson) {
    let j; try { j = JSON.parse(out); } catch { return null; }
    const rows = Array.isArray(j) ? j : [j];
    for (const r of rows) {
      const nm = String(r.Name || "");
      if (!nm || SELF.has(nm)) continue;
      // The collector emits Rss in bytes.
      const rssKB = Math.round(toNum(r.Rss) / 1024);
      // Get-Process.CPU is cumulative CPU *seconds*, not a percentage — the
      // previous code sent it straight into the "CPU%" column. Convert to a
      // lifetime-average % (cpuS / process age), the same semantics Linux
      // `ps pcpu` reports. Fall back to the pre-converted Cpu value if no
      // raw seconds/age are available.
      let cpu = toNum(r.Cpu);
      const cpuS = r.CpuS != null ? toNum(r.CpuS) : null;
      if (cpuS != null && nowMs) {
        const startMs = Date.parse(String(r.Start || ""));
        const age = startMs > 0 ? (nowMs - startMs) / 1000 : 0;
        if (age > 0) cpu = clamp((cpuS / age) * 100);
      }
      // The legacy Mem field was WorkingSet/1KB (a KB value, not a percent);
      // derive a real percentage from the RSS instead.
      const mem = memTotalBytes > 0
        ? clamp((rssKB * 1024) / memTotalBytes * 100)
        : 0;
      procs.push({ pid: Math.round(toNum(r.Id)), name: nm, cpu, mem, rssKB });
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

// --- Swap (Linux only; via /proc/meminfo, no subprocess) ------------------ //
// Extract an arbitrary set of "Key: value" rows from /proc/meminfo-style text
// (values in kB). Returns a plain object of number values; keys that are absent
// or unparsable come back as 0. Pure and unit-testable.
function parseMeminfo(raw, keys) {
  const out = {};
  for (const key of keys) {
    let val = 0;
    if (raw) {
      const m = raw.match(new RegExp("^" + key + ":\\s*(\\d+)", "m"));
      if (m) val = toNum(m[1]);
    }
    out[key] = val;
  }
  return out;
}

function collectSwap() {
  if (PLATFORM !== "linux") return null;
  try {
    const { SwapTotal, SwapFree } = parseMeminfo(readText("/proc/meminfo"), ["SwapTotal", "SwapFree"]);
    if (!SwapTotal) return null; // swap disabled — not an error
    return { totalKB: SwapTotal, usedKB: Math.max(0, SwapTotal - SwapFree) };
  } catch {
    return null;
  }
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
    // Emit raw CPU seconds (CpuS) and RSS bytes (Rss) so the parser can
    // derive a percentage comparable to `ps pcpu`; keep Cpu/Mem as fallbacks.
    const out = runJson("powershell", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Get-Process | Sort-Object CPU -Descending | Select-Object -First " + (TOPN * 3) + " | " +
      "ForEach-Object { [pscustomobject]@{Id=$_.Id;Name=$_.ProcessName;" +
      "Cpu=[math]::Round($_.CPU,3);CpuS=[math]::Round($_.CPU,3);" +
      "Start=(if ($_.StartTime) { $_.StartTime.ToString(\"o\") } else { '' });" +
      "Mem=[math]::Round($_.WorkingSet64/1KB,1);Rss=[long]$_.WorkingSet64} } | ConvertTo-Json -Compress",
    ]);
    return parseProcs(out, TOPN, true, Date.now(), totalmem());
  }
  return null;
}

// ---------------------------------------------------------------------------

function sample() {
  const base = sampleCpuMem();
  let disk = null, net = null, procs = null, swap = null;
  try { disk = collectDisk(); } catch (e) { console.error("[dsh-top] disk collector failed:", e); }
  try { net = collectNet(); } catch (e) { console.error("[dsh-top] net collector failed:", e); }
  try { procs = collectProcs(); } catch (e) { console.error("[dsh-top] procs collector failed:", e); }
  try { swap = collectSwap(); } catch (e) { console.error("[dsh-top] swap collector failed:", e); }

  // Load average (1 / 5 / 15 min) and uptime come straight from the Node `os`
  // module — no subprocess, present on every platform.
  const la = loadavg();
  return {
    ...base,
    disk, net, procs, swap,
    load1: toNum(la[0]),
    load5: toNum(la[1]),
    load15: toNum(la[2]),
    uptimeSec: Math.max(0, uptime()),
  };
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
          if (raw.swap) {
            payload.swap = {
              usedMB: raw.swap.usedKB / 1024,
              totalMB: raw.swap.totalKB / 1024,
              pct: pct(raw.swap.usedKB, raw.swap.totalKB),
            };
          } else {
            payload.swap = null;
          }
          // Load average + uptime (from Node `os`, always present).
          payload.load = { "1": round1(raw.load1), "5": round1(raw.load5), "15": round1(raw.load15) };
          payload.uptimeSec = Math.round(raw.uptimeSec);
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

export {
  name, inject, apply,
  parseDisk, parseDiskWin, parseNetLinux, parseNetDarwin, parseNetWin, parseProcs,
  parseMeminfo,
  containerMem, containerCores,
  parseCgroupMemLimit, parseCgroupQuota, parseCgroupCfsQuota,
  EXEC_TIMEOUT_MS,
};
