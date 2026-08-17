# dsh-top

A plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) **web GUI**: a system monitoring tool that shows live system stats in a floating, collapsible panel pinned to the **top-right corner**.

<p align="center">
  <img src="docs/screenshot.png" alt="dsh-top System Monitor panel" width="342" />
</p>

[![dsh.so security](https://www.dsh.so/badges/dsh-top.svg)](https://www.dsh.so/artifact/dsh-top/)

## Features

- **CPU** — live utilisation (computed from `os.cpus()` tick deltas) + core count
- **MEM** — used / total with percentage bar (from `os.totalmem()` / `os.freemem()`)
- **DISK** — used / total with percentage bar (platform-specific)
- **NETWORK** — download / upload throughput (platform-specific byte deltas)
- **Top 6 processes** — PID, name, CPU%, MEM% (platform-specific)
- Dark color-coded palette (cyan CPU, magenta RAM, yellow disk, blue/green network), monospace
- **Draggable** via the title bar, **collapsible** via the `–` / `+` button
- Transient monitor processes (`ps`, `awk`, `head`, …) are filtered out of the top-processes list

## How it works

| Part | File | What it does |
|---|---|---|
| Host half | `lib/index.js` | Registers `GET /api/dsh-top-stats`; CPU + memory use cross-platform Node `os` APIs; disk, network and processes use per-platform collectors that degrade to `null` when unavailable. |
| Browser half | `lib/client.js` | `dsh.client` web bundle; registers the panel into the frame-wide `shell.overlay` slot; polls every 2 s (pauses while collapsed). |
| Composition | `cordis.patch.yml` | The `dsh.bundle` patch layer that inserts the loader entry. |

## Platform support

DSH host code runs on Linux, but the DSH *server* can be run on any OS Node.js supports. `dsh-top` is multi-platform: it always reports at least CPU + memory (pure Node `os`, no subprocess), and fills in disk / network / processes where the platform allows. Missing sections are shown as **n/a** in the widget rather than failing the whole request.

| Platform | CPU | MEM | DISK | NETWORK | PROCESSES |
|---|---|:---:|:---:|:---:|:---:|
| Linux | ✅ | ✅ | `df` | `/proc/net/dev` | `ps` |
| macOS | ✅ | ✅ | `df` | `netstat -ib` | `ps` (BSD) |
| Windows | ✅ | ✅ | PowerShell `Get-PSDrive` | PowerShell `Get-NetAdapterStatistics` | PowerShell `Get-Process` |
| Other / unknown | ✅ | ✅ | n/a | n/a | n/a |

The CPU + memory meters work on every Node platform. Disk, network and process meters depend on the listed command/pseudo-file being present (e.g. slim/distroless containers may lack `df`/`ps`) — those sections then render as **n/a** while the rest keep working.

## Security

Because it is a *system monitor*, the host half reads host-wide CPU, memory, disk, network and process state. The cross-platform core (CPU + memory) uses Node's built-in `os` module — no subprocess and no OS-specific pseudo-files. Linux `/proc` reads go through Node's own `fs.readFileSync`. Only the platform collectors that need system tools invoke them — `ps`, `df`, and on Windows `powershell` — every time via `execFileSync` with a **static argv array** (never a shell string, no shell `-Command` interpolation of untrusted data), so there is **no shell-injection surface** and no attacker-controlled input. On Windows the PowerShell sub-command is a fixed script literal; none of its values come from the HTTP request. No data leaves the host, no credentials are read, and every read is **read-only**.

> `dsh.so`'s static scanner flags `node:child_process` as "critical". That is a heuristic signal on the mere presence of process access — not a vulnerability. Process access is intrinsic to a monitoring tool; review the (small) source yourself: the collectors are platform-whitelisted, argument-confined, and read-only, and any failure degrades to "n/a" rather than failing the request.

## Install

```sh
dsh plugin --profile web add dsh-top
```

Then restart the web app and refresh the page — the panel appears at the top-right.

## License

[MIT](LICENSE)
