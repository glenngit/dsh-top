# dsh-sysmon

A plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) **web GUI**: a system monitoring tool that shows live system stats in a floating panel pinned to the **top-right corner**.

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
| Host half | `lib/index.js` | Registers `GET /api/sysmon-stats`; reads CPU, memory, disk, network and top processes with read-only `/proc` + `ps` + `df` reads. |
| Browser half | `lib/client.js` | `dsh.client` web bundle; registers the panel into the frame-wide `shell.overlay` slot; polls every 2 s. |
| Composition | `cordis.patch.yml` | The `dsh.bundle` patch layer that inserts the loader entry. |

All system reads are **read-only**.

## Install

```sh
# place this package somewhere, then link it into your web profile:
dsh plugin --profile web add .
# or wire it manually into the profile's bundles + link dependency
```

Then restart the web app and refresh the page — the panel appears at the top-right.

## License

MIT
