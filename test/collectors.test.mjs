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
  parseProcs, containerMem, containerCores,
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

test("Windows Get-Process JSON parses, filters powershell, caps at topN", () => {
  const j = JSON.stringify([
    { Id: 1234, Name: "chrome", Cpu: 42.5, Mem: 123456.7, Rss: 123456 },
    { Id: 4321, Name: "node", Cpu: 10.1, Mem: 98765.4, Rss: 98765 },
    { Id: 999, Name: "powershell", Cpu: 0.2, Mem: 500, Rss: 500 }, // filtered
    { Id: 777, Name: "bun", Cpu: 0.1, Mem: 100, Rss: 100 },
  ]);
  const r = parseProcs(j, 2, true);
  assert.ok(r);
  assert.equal(r.length, 2); // capped by topN even before filtering
  assert.equal(r[0].name, "chrome");
  assert.equal(r[1].name, "node");
});

test("empty process output returns null", () => {
  assert.equal(parseProcs("", 6, false), null);
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