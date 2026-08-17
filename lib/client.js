// dsh-top — browser half (persistent profile bundle).
//
// A floating panel pinned to the top-right of the dsh web GUI,
// registered into the frame-wide `shell.overlay` slot. It polls the host
// route `/api/dsh-top-stats` every 2 seconds and renders CPU / RAM / DISK /
// NETWORK plus the top 6 processes. Draggable via its title bar, collapsible.
window.__ModuleLoader__.load({
	id: "dsh-top",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let jsxRuntime = require("react/jsx-runtime");
		const { useState, useEffect, useRef } = react;
		const { jsx, jsxs, Fragment } = jsxRuntime;

		const POLL_MS = 2000;
		const STATS_PATH = "/api/dsh-top-stats";

		function clampNum(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
		function pctText(n) { return String(Math.round(clampNum(n, 0, 100) * 10) / 10) + "%"; }
		function fmtRate(b) {
			if (b < 1024) return Math.round(b) + " B/s";
			if (b < 1048576) return (b / 1024).toFixed(1) + " K/s";
			if (b < 1073741824) return (b / 1048576).toFixed(1) + " M/s";
			return (b / 1073741824).toFixed(2) + " G/s";
		}
		function fmtSize(mb) {
			if (mb >= 1024) return (mb / 1024).toFixed(1) + "G";
			if (mb >= 1) return mb.toFixed(0) + "M";
			return (mb * 1024).toFixed(0) + "K";
		}

		const css = [
			".sysmon{position:fixed;top:12px;right:12px;z-index:2147483000;width:330px;max-width:calc(100vw - 24px);",
			"background:#12151c;border:1px solid #2a3340;border-radius:8px;box-shadow:0 10px 32px rgba(0,0,0,0.5);",
			"color:#d8dee9;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace;",
			"font-size:12px;line-height:1.45;pointer-events:auto;user-select:none;overflow:hidden;box-sizing:border-box}",
			".sysmon *,.sysmon *::before,.sysmon *::after{box-sizing:border-box}",
			".sysmon__head{display:flex;align-items:center;justify-content:space-between;padding:7px 10px;",
			"background:linear-gradient(180deg,#1b212b,#171b23);border-bottom:1px solid #2a3340;cursor:grab;touch-action:none}",
			".sysmon__head:active{cursor:grabbing}",
			".sysmon__title{font-weight:700;letter-spacing:2px;color:#4fd6c0;font-size:11px}",
			".sysmon__toggle{background:transparent;border:1px solid #2a3340;color:#9aa4b2;border-radius:4px;",
			"width:18px;height:18px;line-height:1;cursor:pointer;font-size:12px;padding:0;text-align:center}",
			".sysmon__toggle:hover{background:#232a36;color:#fff}",
			".sysmon__body{padding:8px 10px 10px}",
			".sysmon__meter{margin-bottom:7px}",
			".sysmon__row{display:flex;align-items:center;gap:8px}",
			".sysmon__label{width:36px;flex:none;font-weight:700;color:#8a93a4;letter-spacing:0.5px}",
			".sysmon__bar{flex:1;height:10px;background:#1e242e;border-radius:3px;overflow:hidden}",
			".sysmon__bar--net{height:6px}",
			".sysmon__fill{height:100%;border-radius:3px;transition:width .35s ease}",
			".sysmon__pct{width:46px;flex:none;text-align:right;font-weight:700;font-variant-numeric:tabular-nums}",
			".sysmon__sub{padding-left:44px;color:#6b7484;font-size:10px;margin-top:2px}",
			".sysmon__net{display:flex;gap:10px;margin:4px 0 8px;padding-left:44px}",
			".sysmon__net-item{flex:1;min-width:0}",
			".sysmon__net-head{display:flex;justify-content:space-between;font-size:10px;margin-bottom:3px}",
			".sysmon__procs{border-top:1px solid #232a34;padding-top:6px}",
			".sysmon__procs-head,.sysmon__proc{display:grid;grid-template-columns:40px 1fr 58px 54px;gap:6px;align-items:center}",
			".sysmon__procs-head{color:#6b7484;font-size:10px;letter-spacing:0.5px;text-transform:uppercase;padding:1px 0 3px}",
			".sysmon__proc{padding:3px 0;border-top:1px solid rgba(35,42,52,0.6)}",
			".sysmon__proc-pid{color:#6b7484;font-variant-numeric:tabular-nums}",
			".sysmon__proc-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#c8d0dc}",
			".sysmon__proc-cpu,.sysmon__proc-mem{text-align:right;font-variant-numeric:tabular-nums;border-radius:2px;padding:0 2px}",
			".sysmon__err{color:#e06c75;padding:4px 0;word-break:break-word}"
		].join("");

		function Meter(props) {
			const v = clampNum(props.value, 0, 100);
			return jsxs("div", {
				className: "sysmon__meter",
				children: [
					jsxs("div", {
						className: "sysmon__row",
						children: [
							jsx("span", { className: "sysmon__label", children: props.label }),
							jsx("div", {
								className: "sysmon__bar",
								children: jsx("div", {
									className: "sysmon__fill",
									style: { width: v + "%", background: props.color }
								})
							}),
							jsx("span", { className: "sysmon__pct", style: { color: props.color }, children: props.text })
						]
					}),
					props.sub ? jsx("div", { className: "sysmon__sub", children: props.sub }) : null
				]
			});
		}

		function NetItem(props) {
			const scale = 10 * 1024 * 1024;
			const w = clampNum((props.rate / scale) * 100, 0, 100);
			return jsxs("div", {
				className: "sysmon__net-item",
				children: [
					jsxs("div", {
						className: "sysmon__net-head",
						children: [
							jsx("span", { style: { color: props.color }, children: props.arrow }),
							jsx("span", { style: { color: props.color }, children: fmtRate(props.rate) })
						]
					}),
					jsx("div", {
						className: "sysmon__bar sysmon__bar--net",
						children: jsx("div", {
							className: "sysmon__fill",
							style: { width: w + "%", background: props.color }
						})
					})
				]
			});
		}

		function ProcRow(props) {
			const p = props.p;
			const cpu = clampNum(p.cpu, 0, 100);
			const mem = clampNum(p.mem, 0, 100);
			const cpuFill = "linear-gradient(90deg, rgba(60,198,192,0.16) " + cpu + "%, rgba(60,198,192,0) " + cpu + "%)";
			const memFill = "linear-gradient(90deg, rgba(198,120,221,0.18) " + mem + "%, rgba(198,120,221,0) " + mem + "%)";
			return jsxs("div", {
				className: "sysmon__proc",
				children: [
					jsx("span", { className: "sysmon__proc-pid", children: String(p.pid) }),
					jsx("span", { className: "sysmon__proc-name", title: p.name, children: p.name }),
					jsx("span", { className: "sysmon__proc-cpu", style: { color: "#3cc6c0", backgroundImage: cpuFill }, children: String(p.cpu) + "%" }),
					jsx("span", { className: "sysmon__proc-mem", style: { color: "#c678dd", backgroundImage: memFill }, children: String(p.mem) + "%" })
				]
			});
		}

		function Body(props) {
			const d = props.data;
			if (d.error) {
				return jsx("div", {
					className: "sysmon__body",
					children: jsx("div", { className: "sysmon__err", children: String(d.error) })
				});
			}
			return jsx("div", {
				className: "sysmon__body",
				children: jsxs(Fragment, {
					children: [
						jsx(Meter, { label: "CPU", value: d.cpu, text: pctText(d.cpu), color: "#3cc6c0", sub: (d.cores || 1) + " cores" }),
						jsx(Meter, { label: "MEM", value: d.mem.pct, text: pctText(d.mem.pct), color: "#c678dd", sub: fmtSize(d.mem.usedMB) + " / " + fmtSize(d.mem.totalMB) + " used" }),
						jsx(Meter, { label: "DISK", value: d.disk.pct, text: pctText(d.disk.pct), color: "#e5c07b", sub: fmtSize(d.disk.usedMB) + " / " + fmtSize(d.disk.totalMB) + " used" }),
						jsxs("div", {
							className: "sysmon__net",
							children: [
								jsx(NetItem, { arrow: "\u2193", rate: d.net.rx, color: "#61afef" }),
								jsx(NetItem, { arrow: "\u2191", rate: d.net.tx, color: "#98c379" })
							]
						}),
						jsxs("div", {
							className: "sysmon__procs",
							children: [
								jsxs("div", {
									className: "sysmon__procs-head",
									children: [
										jsx("span", { children: "PID" }),
										jsx("span", { children: "NAME" }),
										jsx("span", { style: { textAlign: "right" }, children: "CPU%" }),
										jsx("span", { style: { textAlign: "right" }, children: "MEM%" })
									]
								}),
								...(d.procs || []).map((p) => jsx(ProcRow, { key: String(p.pid), p: p }))
							]
						})
					]
				})
			});
		}

		function Monitor() {
			const [data, setData] = useState(null);
			const [open, setOpen] = useState(true);
			const [off, setOff] = useState({ dx: 0, dy: 0 });
			const dragRef = useRef(null);

			useEffect(() => {
				const style = document.createElement("style");
				style.setAttribute("data-plugin", "dsh-top");
				style.textContent = css;
				document.head.appendChild(style);

				let alive = true;
				const tick = () => {
					fetch(STATS_PATH, { cache: "no-store" })
						.then((r) => r.json())
						.then((body) => { if (alive) setData(body); })
						.catch((e) => { if (alive) setData({ error: String((e && e.message) || e) }); });
				};
				tick();
				const timer = setInterval(tick, POLL_MS);
				return () => {
					alive = false;
					clearInterval(timer);
					document.head.removeChild(style);
				};
			}, []);

			const onDown = (e) => {
				if (e.button !== 0) return;
				try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
				dragRef.current = { sx: e.clientX, sy: e.clientY, bx: off.dx, by: off.dy };
			};
			const onMove = (e) => {
				const d = dragRef.current;
				if (!d) return;
				setOff({
					dx: clampNum(d.bx + (e.clientX - d.sx), -900, 0),
					dy: clampNum(d.by + (e.clientY - d.sy), 0, 900)
				});
			};
			const onUp = () => { dragRef.current = null; };

			return jsx("div", {
				className: "sysmon",
				style: { transform: "translate(" + off.dx + "px," + off.dy + "px)" },
				children: jsxs(Fragment, {
					children: [
						jsxs("div", {
							className: "sysmon__head",
							onPointerDown: onDown,
							onPointerMove: onMove,
							onPointerUp: onUp,
							onPointerCancel: onUp,
							children: [
								jsx("span", { className: "sysmon__title", children: "SYSTEM" }),
								jsx("button", {
									className: "sysmon__toggle",
									onClick: () => setOpen(!open),
									onPointerDown: (e) => e.stopPropagation(),
									title: open ? "Collapse" : "Expand",
									children: open ? "\u2013" : "+"
								})
							]
						}),
						open
							? (data
								? jsx(Body, { data: data })
								: jsx("div", { className: "sysmon__body sysmon__err", children: "loading\u2026" }))
							: null
					]
				})
			});
		}

		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "dsh-top",
				order: 50,
				label: "System Monitor"
			}, Monitor));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
