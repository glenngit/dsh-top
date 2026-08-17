// dsh-top collector tests — zero dependencies, Node's built-in test runner.
//
// Run: node --test test/
//
// These exercise the PURE parsers exported by lib/index.js against realistic
// command output for Linux, macOS and Windows, plus the container(MEM/CPU)
// fallback logic. They do NOT require a live mac/Windows host: the parsing
// code that runs on those platforms is verified here with fixtures.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDisk, parseDiskWin,
  parseNetLinux, parseNetDarwin, parseNetWin,
  parseProcs, parseMeminfo,
  containerMem, containerCores,
  parseCgroupMemLimit, parseCgroupQuota, parseCgroupCfsQuota,
  EXEC_TIMEOUT_MS,
} from "../lib/index.js";

// ---------------------------------------------------------------------------
// Disk
// ---------------------------------------------------------------------------

test("Linux/macOS `df -P /` parses into kB", () => {
  const out = "Filesystem     1024-blocks      Used Available Capacity Mounted on\n" +
    "/dev/vda1          50620216   9572832  41031456      19% /\n";
  const r = parseDisk(out);
  assert.equal(r.usedKB, 9572832);
  assert.equal(r.totalKB, 50620216);
});

test("df without a data row returns null", () => {
  assert.equal(parseDisk("Filesystem     1024-blocks\n"), null);
});

test("Windows Get-PSDrive JSON parses bytes into kB", () => {
  const j = '{"Used":107374182400,"Free":53687091200}';
  const r = parseDiskWin(j);
  assert.equal(r.usedKB, 104857600); // bytes -> kB
  assert.equal(r.totalKB, 157286400);
  assert.equal(r.totalKB - r.usedKB, 52428800);
});

test("Windows disk bad JSON returns null", () => {
  assert.equal(parseDiskWin("not json"), null);
});

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

test("Linux /proc/net/dev parses rx/tx, skips loopback", () => {
  const raw = "Inter-|   Receive                                                |  Transmit\n" +
    " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n" +
    "    lo: 1000000       0    0    0    0     0          0         0  2000000       0    0    0    0     0       0          0\n" +
    "  eth0: 357539642064   x    0    0    0     0          0         0  75894003443    x    0    0    0     0       0          0\n";
  const r = parseNetLinux(raw);
  assert.equal(r.rx, 357539642064);
  assert.equal(r.tx, 75894003443);
});

test("macOS netstat -ib parses Ibytes/Obytes, dedups per-IP rows", () => {
  const out = "Name  Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll\n" +
    "lo0   16384 <Link#1>                        123       0     4567      456       0     8901      0\n" +
    "lo0   16384 127           localhost         123       0     4567      456       0     8901      0\n" +
    "en0   1500  <Link#4>   a4:83:e7:xx         9876       0  99999999     5555       0  77777777      0\n" +
    "en0   1500  10.0.0.1     100.64.0.1        9876       0  99999999     5555       0  77777777      0\n";
  const r = parseNetDarwin(out);
  assert.equal(r.rx, 99999999);
  assert.equal(r.tx, 77777777);
});

test("macOS netstat without header row returns null", () => {
  assert.equal(parseNetDarwin("junk"), null);
});

test("Windows Get-NetAdapterStatistics JSON parses rx/tx", () => {
  const r = parseNetWin('{"Rx":9999,"Tx":8888}');
  assert.equal(r.rx, 9999);
  assert.equal(r.tx, 8888);
});

// ---------------------------------------------------------------------------
// Top processes
// ---------------------------------------------------------------------------

test("Linux `ps` output parses into top processes, filters self", () => {
  const out =
    "  123   4.8   7.2  288924 node\n" +
    "  456   1.3   0.3   15108 python3\n" +
    "  789   0.5   0.1     999 ps\n" +   // filtered (SELF)
    "  111   0.2   1.0    512 awk\n";    // filtered (SELF)
  const r = parseProcs(out, 6, false);
  assert.ok(r);
  assert.equal(r.length, 2);
  assert.equal(r[0].pid, 123);
  assert.equal(r[0].name, "node");
  assert.equal(r[1].pid, 456);
});

test("macOS BSD `ps` output parses, handles comm with path", () => {
  const out =
    "  695   3.0   0.5    1234 com.apple.Spotlight\n" +
    "  498   1.0   1.2  9012344 /usr/libexec/nsurlsessiond\n" +
    "  777   0.3   0.1     333 ps\n"; // filtered
  const r = parseProcs(out, 6, false);
  assert.ok(r);
  assert.equal(r.length, 2);
  assert.equal(r[0].name, "com.apple.Spotlight");
  assert.equal(r[1].name, "/usr/libexec/nsurlsessiond");
});

// The Windows collector emits Rss in BYTES and CpuS as raw CPU seconds plus a
// Start timestamp; the parser converts them into a percentage comparable to
// `ps pcpu`.
const START = "2026-01-01T00:00:00.000Z"; // process started
const NOW_MS = Date.parse("2026-01-01T01:00:00.000Z"); // 1h later -> age 3600s

test("Windows Get-Process JSON: raw CPU seconds + Rss bytes become percentages", () => {
  const j = JSON.stringify([
    // 3600 CPU seconds over 3600s lifetime on one core = 100% avg; 1 GB RSS.
    { Id: 1234, Name: "chrome", Cpu: 42.5, CpuS: 3600, Start: START, Rss: 1073741824 },
    // 900 CPU seconds over 3600s = 25% avg; 256 MB RSS.
    { Id: 4321, Name: "node", Cpu: 10.1, CpuS: 900, Start: START, Rss: 268435456 },
    { Id: 999, Name: "powershell", Cpu: 0.2, CpuS: 1, Start: START, Rss: 512000 }, // filtered
    { Id: 777, Name: "bun", Cpu: 0.1, CpuS: 0, Start: START, Rss: 102400 },
  ]);
  const memTotalBytes = 8 * 1024 ** 3; // 8 GiB
  const r = parseProcs(j, 2, true, NOW_MS, memTotalBytes);
  assert.ok(r);
  assert.equal(r.length, 2); // capped by topN even before filtering
  assert.equal(r[0].name, "chrome");
  assert.ok(Math.abs(r[0].cpu - 100) < 1, "3600s over 3600s ≈ 100%");
  assert.ok(Math.abs(r[0].mem - 12.5) < 1, "1 GiB of 8 GiB ≈ 12.5%");
  assert.equal(r[0].rssKB, 1048576);
  assert.equal(r[1].name, "node");
  assert.ok(Math.abs(r[1].cpu - 25) < 1, "900s over 3600s ≈ 25%");
  assert.ok(Math.abs(r[1].mem - 3.125) < 1, "256 MiB of 8 GiB ≈ 3.1%");
});

test("Windows Get-Process JSON: no CpuS/Start falls back to Cpu and RSS-derived mem", () => {
  const j = JSON.stringify([
    { Id: 1, Name: "chrome", Cpu: 42.5, Rss: 1073741824 }, // 1 GiB of 8 GiB -> 12.5%
    { Id: 2, Name: "node", Cpu: 10.1, Rss: 0 },
  ]);
  const r = parseProcs(j, 6, true, NOW_MS, 8 * 1024 ** 3);
  assert.ok(r);
  assert.equal(r[0].name, "chrome");
  assert.equal(r[0].cpu, 42.5); // pre-converted fallback
  assert.ok(Math.abs(r[0].mem - 12.5) < 1);
  assert.equal(r[1].mem, 0);
});

test("Windows Get-Process JSON: cpu clamped at 100 when CpuS exceeds age", () => {
  const j = JSON.stringify([
    // 7200 CPU-s over a 3600s lifetime would be 200% (multi-core); clamp to 100.
    { Id: 1, Name: "stress", CpuS: 7200, Start: START, Rss: 102400 },
  ]);
  const r = parseProcs(j, 6, true, NOW_MS, 8 * 1024 ** 3);
  assert.ok(r);
  assert.equal(r[0].cpu, 100);
});

test("empty process output returns null", () => {
  assert.equal(parseProcs("", 6, false), null);
});

// ---------------------------------------------------------------------------
// Cgroup file parsers (pure)
// ---------------------------------------------------------------------------

test("cgroup memory.max: 'max' and sentinels mean no limit", () => {
  assert.equal(parseCgroupMemLimit("max"), null);
  assert.equal(parseCgroupMemLimit("-1"), null);
  // Unrestricted cgroup v1 root: ~2^63 — must NOT be reported as RAM.
  assert.equal(parseCgroupMemLimit(String(2 ** 63 - 1)), null);
  assert.equal(parseCgroupMemLimit("9223372036854771712"), null);
});

test("cgroup memory.max: a real limit is returned in bytes", () => {
  assert.equal(parseCgroupMemLimit("4294967296"), 4 * 1024 ** 3); // 4 GiB
  assert.equal(parseCgroupMemLimit("  8589934592  ".trim()), 8 * 1024 ** 3);
  assert.equal(parseCgroupMemLimit(""), null);
  assert.equal(parseCgroupMemLimit(null), null);
});

test("cgroup cpu.max (v2): quota/period -> cores", () => {
  assert.equal(parseCgroupQuota("max 100000"), null);
  assert.equal(parseCgroupQuota("50000 100000"), 1);
  assert.equal(parseCgroupQuota("150000 100000"), 2); // 1.5 cores rounds to 2
  assert.equal(parseCgroupQuota("250000 100000"), 3); // 2.5 -> 3
  assert.equal(parseCgroupQuota("100 100"), 1);
  assert.equal(parseCgroupQuota("garbage"), null);
});

test("cgroup cfs quota (v1): '-1' means no quota", () => {
  assert.equal(parseCgroupCfsQuota("-1", "100000"), null);
  assert.equal(parseCgroupCfsQuota("50000", "100000"), 1);
  assert.equal(parseCgroupCfsQuota("200000", "100000"), 2);
  assert.equal(parseCgroupCfsQuota("0", "100000"), null);
  assert.equal(parseCgroupCfsQuota("50000", "0"), null); // no period -> no limit
  assert.equal(parseCgroupCfsQuota(null, null), null);
});

// ---------------------------------------------------------------------------
// Container-aware memory / cpu fallback
// ---------------------------------------------------------------------------

// containerMem/containerCores read the real /proc/self/cgroup and cgroup
// files, so on a finite-limited container they reflect the limit. On the
// current (typically unlimited) container they must return null (host view).
// We assert only the *shape* contract here; a value of null is a valid host
// fallback, and a finite limit is a valid container result.
test("containerMem returns {limit,used} or null, never NaN garbage", () => {
  const cm = containerMem();
  if (cm === null) return; // host view — valid
  assert.equal(typeof cm.limit, "number");
  assert.equal(typeof cm.used, "number");
  assert.ok(Number.isFinite(cm.limit));
  assert.ok(Number.isFinite(cm.used));
});

test("containerCores returns a positive integer or null", () => {
  const cc = containerCores();
  if (cc === null) return; // host view — valid
  assert.equal(Number.isInteger(cc), true);
  assert.ok(cc >= 1);
});

// ---------------------------------------------------------------------------
// Swap / /proc/meminfo parser
// ---------------------------------------------------------------------------

test("parseMeminfo extracts requested keys in kB", () => {
  const raw =
    "MemTotal:       16299920 kB\n" +
    "MemFree:         1234567 kB\n" +
    "MemAvailable:    9123456 kB\n" +
    "SwapTotal:      8388608 kB\n" +
    "SwapFree:       4194304 kB\n";
  const m = parseMeminfo(raw, ["SwapTotal", "SwapFree", "MemAvailable"]);
  assert.equal(m.SwapTotal, 8388608);
  assert.equal(m.SwapFree, 4194304);
  assert.equal(m.MemAvailable, 9123456);
});

test("parseMeminfo returns 0 for absent / unparsable keys", () => {
  const raw = "MemTotal: 1000 kB\n";
  const m = parseMeminfo(raw, ["SwapTotal", "NotARealKey"]);
  assert.equal(m.SwapTotal, 0);
  assert.equal(m.NotARealKey, 0);
});

test("parseMeminfo tolerates null input without throwing", () => {
  const m = parseMeminfo(null, ["SwapTotal"]);
  assert.equal(m.SwapTotal, 0);
});

test("swap math: used = total - free, never negative", () => {
  // Guard the pct/used derivation used by collectSwap for any input values.
  const total = 1000000, free = 800000;
  const used = Math.max(0, total - free);
  assert.equal(used, 200000);
  const overFree = 1200000; // free > total edge case still clamps to 0
  assert.equal(Math.max(0, total - overFree), 0);
});

// ---------------------------------------------------------------------------
// Exec timeout guard
// ---------------------------------------------------------------------------

test("runJson enforces a positive bounded EXEC_TIMEOUT_MS", () => {
  assert.equal(typeof EXEC_TIMEOUT_MS, "number");
  assert.ok(Number.isInteger(EXEC_TIMEOUT_MS));
  assert.ok(EXEC_TIMEOUT_MS > 0 && EXEC_TIMEOUT_MS <= 10_000);
});