# dsh-top

A plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) **web GUI**: a system monitoring tool that shows live system stats in a floating, collapsible panel pinned to the **top-right corner**.

<p align="center">
  <img src="docs/screenshot.png" alt="dsh-top System Monitor panel" width="342" />
</p>

[![dsh.so security](https://www.dsh.so/badges/dsh-top.svg)](https://www.dsh.so/artifact/dsh-top/)

## Features

- **CPU** — live utilisation (computed from `/proc/stat` deltas) + core count
- **MEM** — used / total with percentage bar
- **DISK** — used / total with percentage bar
- **NETWORK** — download / upload throughput (computed from `/proc/net/dev` byte deltas)
- **Top 6 processes** — PID, name, CPU%, MEM%
- Dark color-coded palette (cyan CPU, magenta RAM, yellow disk, blue/green network), monospace
- **Draggable** via the title bar, **collapsible** via the `–` / `+` button
- Transient monitor processes (`ps`, `awk`, `head`, …) are filtered out of the top-processes list

## How it works

| Part | File | What it does |
|---|---|---|
| Host half | `lib/index.js` | Registers `GET /api/dsh-top-stats`; reads CPU, memory, disk, network and top processes with read-only `/proc` + `ps` + `df` reads. |
| Browser half | `lib/client.js` | `dsh.client` web bundle; registers the panel into the frame-wide `shell.overlay` slot; polls every 2 s. |
| Composition | `cordis.patch.yml` | The `dsh.bundle` patch layer that inserts the loader entry. |

## Security

Because it is a *system monitor*, the host half reads host-wide process, CPU, memory and disk state. To do that it invokes the fixed read-only binaries `cat`, `ps` and `df` via `execFileSync` with a **static argv array** (never a shell string), so there is **no shell-injection surface** and no attacker-controlled input. No data leaves the host, no credentials are read, and every read is **read-only**.

> `dsh.so`'s static scanner flags the `node:child_process` import as "critical". That is a heuristic signal on the mere presence of process access — not a vulnerability. Process access is intrinsic to a monitoring tool; review the (small) source yourself: the commands are hard-coded, read-only, and argument-confined.

## Install

```sh
dsh plugin --profile web add dsh-top
```

Then restart the web app and refresh the page — the panel appears at the top-right.

## License

[MIT](LICENSE)
