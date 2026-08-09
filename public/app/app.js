/* Trader — app shell JS
 * Shared utilities, API helpers, and renderers used across all sub-pages.
 * Extracted from the original single-page index.html (chunk 11 SaaS refactor).
 *
 * Each sub-page defines a window.appPageInit() function that calls
 * only the renderers it needs. The shell injects the top nav via
 * injectAppNav() and calls appPageInit() on DOMContentLoaded.
 */

// ─── Utilities ───
// Safe $() — returns a no-op Proxy for missing IDs so
// sub-pages without a given element don't crash on
// `el.textContent = ...` or `el.classList.add(...)`. Lets
// us share renderers (renderHero, renderPositions, etc.)
// across sub-pages that may not have every element.
const _noopFn = () => {};
const _noopEl = new Proxy(_noopFn, {
	get(_t, prop) {
		if (prop === "textContent" || prop === "innerHTML" || prop === "value"
			|| prop === "className" || prop === "id" || prop === "title"
			|| prop === "href" || prop === "src" || prop === "alt"
			|| prop === "placeholder" || prop === "type" || prop === "name"
			|| prop === "min" || prop === "max" || prop === "step"
			|| prop === "checked" || prop === "disabled" || prop === "hidden") return "";
		if (prop === "classList") return { add: _noopFn, remove: _noopFn, toggle: _noopFn, contains: () => false, replace: _noopFn };
		if (prop === "style") return new Proxy({}, { get: () => "", set: () => true });
		if (prop === "dataset") return {};
		if (prop === "children" || prop === "childNodes") return [];
		if (prop === "addEventListener" || prop === "removeEventListener"
			|| prop === "setAttribute" || prop === "removeAttribute"
			|| prop === "appendChild" || prop === "insertBefore" || prop === "removeChild"
			|| prop === "querySelector" || prop === "querySelectorAll"
			|| prop === "focus" || prop === "blur" || prop === "click"
			|| prop === "reset" || prop === "submit" || prop === "play"
			|| prop === "pause" || prop === "scrollIntoView") return _noopFn;
		return undefined;
	},
	set: () => true,
	apply: () => _noopEl,
});
const $ = (id) => document.getElementById(id) || _noopEl;
const fmtCents = (c) => {
	if (c === null || c === undefined) return "—";
	const sign = c < 0 ? "−" : c > 0 ? "+" : "";
	const abs = Math.abs(c);
	const dollars = (abs / 100).toFixed(2);
	return `${sign}$${dollars}`;
};
const fmtNum = (n) => (n === null || n === undefined ? "—" : n.toLocaleString());
const fmtTime = (ts) => {
	if (!ts) return "—";
	const d = new Date(ts);
	const now = new Date();
	const diffSec = (now - d) / 1000;
	if (diffSec < 60) return `${Math.floor(diffSec)}s ago`;
	if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
	if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
	return d.toISOString().slice(0, 10);
};
const fmtTimeFull = (ts) => {
	if (!ts) return "—";
	return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + "Z";
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ─── API fetchers ───
async function fetchJSON(path) {
	const r = await fetch(path, { credentials: "same-origin" });
	if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
	return r.json();
}

// ─── Renderers ───
// (setStatusPill removed in chunk 10 — replaced by the
// stage badge + stage panel, which derive from
// /api/pm/bot/stage.)

// Live indicator (chunk 9.8). Updated on every
// successful refresh. Dot pulses green when data
// is fresh (<60s). Turns amber when stale (60-300s).
// Red on error.
let _lastGoodRefreshMs = 0;
let _lastRefreshError = null;
function setLiveIndicator(state, text) {
	const dot = $("live-dot");
	if (dot) {
		dot.classList.remove("stale", "err");
		if (state === "stale") dot.classList.add("stale");
		else if (state === "err") dot.classList.add("err");
	}
	const el = $("live-text");
	if (el) el.textContent = text;
}

// ─── Stage (chunk 10) — the single badge that says what the bot is doing ───
// Driven by /api/pm/bot/stage. Updates the brand-bar badge,
// the large stage panel, and the action button.
let _lastStage = null;
async function fetchStage() {
	try {
		const data = await fetchJSON("/api/pm/bot/stage");
		_lastStage = data;
		renderStage(data);
		return data;
	} catch (e) {
		console.warn("stage fetch failed", e);
		return null;
	}
}
function renderStage(data) {
	// Brand-bar badge (small, compact).
	const badge = $("stage-badge");
	if (badge) badge.setAttribute("data-color", data.color);
	$("stage-label").textContent = data.label;

	// Big stage panel.
	const panel = $("stage-panel");
	if (panel) panel.setAttribute("data-color", data.color);
	$("stage-panel-label").textContent = data.label;
	$("stage-panel-desc").textContent = data.description;

	// Action button (start / restart / kill-switch / etc).
	const actionWrap = $("stage-panel-action");
	if (actionWrap) {
		if (data.action_label && data.action_path) {
			actionWrap.innerHTML = `<button class="btn" data-action="${esc(data.action_path)}">${esc(data.action_label)}</button>`;
		} else {
			actionWrap.innerHTML = "";
		}
	}
}

// ─── Schedule (chunk 10, renamed from Cadence in v2) — every auto-running service ───
// The API endpoint is still /api/pm/cadence (the backend term
// for the rhythm of services); the user-facing surface is
// "Schedule". Renamed in v2 of the SaaS UI for clarity.
async function fetchSchedule() {
	try {
		const data = await fetchJSON("/api/pm/cadence");
		renderSchedule(data);
		return data;
	} catch (e) {
		console.warn("schedule fetch failed", e);
		$("schedule-grid").innerHTML = `<div class="cadence-skeleton">Schedule unavailable — check API</div>`;
		return null;
	}
}
function renderSchedule(data) {
	const grid = $("schedule-grid");
	if (!grid || !data || !data.services) return;
	const summary = data.summary;
	$("schedule-summary").textContent =
		`${summary.n_ok} ok · ${summary.n_error} error${summary.n_error === 1 ? "" : "s"} · ${summary.n_starting} starting`;

	grid.innerHTML = data.services
		.map(
			(s) => `
		<div class="cadence-item" role="listitem" data-status="${esc(s.status)}" aria-label="${esc(s.name)}: ${esc(s.status)}, last run ${esc(s.last_ran_label)}">
			<div class="cadence-item-head">
				<div class="cadence-item-name">
					<span class="cadence-item-icon" aria-hidden="true">${esc(s.icon || "•")}</span>
					<span>${esc(s.name)}</span>
				</div>
				<span class="cadence-item-status" data-status="${esc(s.status)}">${esc(s.status)}</span>
			</div>
			<div class="cadence-item-time">
				<span>last: ${esc(s.last_ran_label)}</span>${s.next_in_ms !== null ? ` <span aria-hidden="true">·</span> <span>${esc(s.next_label)}</span>` : ""}
			</div>
			<div class="cadence-item-details" title="${esc(s.description)}">${esc(s.details)}</div>
		</div>`,
		)
		.join("");
}

// Stage action button handler (delegated).
document.addEventListener("click", (e) => {
	const btn = e.target.closest("[data-action]");
	if (!btn) return;
	const path = btn.getAttribute("data-action");
	if (path === "start" || path === "restart" || path === "stop") {
		postBotAction(path);
	} else if (path === "kill-switch?on=true" || path === "kill-switch?on=false") {
		const on = path.endsWith("true");
		postBotAction("kill-switch", { on });
	} else if (path === "trading-mode?mode=paper") {
		postBotAction("trading-mode", { trading_mode: "paper" });
	} else if (path === "trading-mode?mode=real") {
		postBotAction("trading-mode", { trading_mode: "real" });
	}
});

// Chunk 11b: blocklist (per-ticker kill switch).
// The dashboard reads the current disabled_tickers
// from /api/pm/bot/status; the user can add/remove
// via the input below the tags. We PATCH the bot
// config via /api/pm/bot/start (preserving other
// fields) and re-render.
async function updateBlocklist(action, ticker) {
	const t = (ticker ?? "").trim().toUpperCase();
	if (!t) return;
	const cur = window._lastBotStatus?.config?.disabled_tickers ?? [];
	let next;
	if (action === "add") {
		if (cur.includes(t)) return;
		next = [...cur, t];
	} else {
		next = cur.filter((x) => x !== t);
	}
	toast(`${action === "add" ? "blocklisting" : "unblocking"} ${t}…`);
	const r = await fetch("/api/pm/bot/start", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ disabled_tickers: next }),
	});
	if (r.ok) {
		setTimeout(() => { void refresh(); }, 600);
	} else {
		const data = await r.json().catch(() => ({}));
		toast(`blocklist update failed: ${data.message ?? r.statusText}`, false);
	}
}
document.addEventListener("click", (e) => {
	const rm = e.target.closest(".blocklist-remove");
	if (rm) {
		e.preventDefault();
		void updateBlocklist("remove", rm.dataset.ticker);
	}
});
document.addEventListener("click", (e) => {
	if (e.target.id === "blocklist-add-btn") {
		const input = $("blocklist-input");
		if (input?.value) {
			void updateBlocklist("add", input.value);
			input.value = "";
		}
	}
});
document.addEventListener("keydown", (e) => {
	if (e.target.id === "blocklist-input" && e.key === "Enter") {
		e.preventDefault();
		const input = e.target;
		if (input.value) {
			void updateBlocklist("add", input.value);
			input.value = "";
		}
	}
});

// Chunk 10.8: per-vertical cap overrides. Same
// shape as blocklist — add/remove tags that
// PATCH the bot config via /api/pm/bot/start.
async function updatePerVerticalCap(action, vertical, cents) {
	const v = (vertical ?? "").trim().toLowerCase();
	if (!v) return;
	const cur = { ...(window._lastBotStatus?.config?.per_vertical_max_notional_cents ?? {}) };
	let next;
	if (action === "add") {
		const c = Math.max(1, Math.floor(Number(cents)));
		if (!Number.isFinite(c) || c <= 0) {
			toast("cap must be a positive number of cents", false);
			return;
		}
		cur[v] = c;
		next = cur;
	} else {
		delete cur[v];
		next = cur;
	}
	toast(`${action === "add" ? `capping ${v} at ${(Number(cents) / 100).toFixed(2)}` : `removing ${v} cap`}…`);
	const r = await fetch("/api/pm/bot/start", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ per_vertical_max_notional_cents: next }),
	});
	if (r.ok) {
		setTimeout(() => { void refresh(); }, 600);
	} else {
		const data = await r.json().catch(() => ({}));
		toast(`cap update failed: ${data.message ?? r.statusText}`, false);
	}
}
document.addEventListener("click", (e) => {
	const rm = e.target.closest(".per-vertical-remove");
	if (rm) {
		e.preventDefault();
		void updatePerVerticalCap("remove", rm.dataset.vertical);
	}
});
document.addEventListener("click", (e) => {
	if (e.target.id === "per-vertical-add-btn") {
		const nameEl = $("per-vertical-input-name");
		const centsEl = $("per-vertical-input-cents");
		if (nameEl?.value && centsEl?.value) {
			void updatePerVerticalCap("add", nameEl.value, centsEl.value);
			nameEl.value = "";
			centsEl.value = "";
		} else {
			toast("vertical + cap both required", false);
		}
	}
});
document.addEventListener("keydown", (e) => {
	if (
		(e.target.id === "per-vertical-input-name" ||
			e.target.id === "per-vertical-input-cents") &&
		e.key === "Enter"
	) {
		e.preventDefault();
		const nameEl = $("per-vertical-input-name");
		const centsEl = $("per-vertical-input-cents");
		if (nameEl?.value && centsEl?.value) {
			void updatePerVerticalCap("add", nameEl.value, centsEl.value);
			nameEl.value = "";
			centsEl.value = "";
		}
	}
});

async function postBotAction(path, body) {
	const url = `/api/pm/bot/${path}`;
	toast(`bot ${path}…`);
	try {
		const r = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: body ? JSON.stringify(body) : undefined,
		});
		const data = await r.json().catch(() => ({}));
		if (r.ok && data.ok) {
			toast(`bot ${path} — ok`, true);
			setTimeout(() => { void fetchStage(); void fetchSchedule(); }, 600);
		} else {
			toast(`${path} failed: ${data.message ?? r.statusText}`, false);
		}
	} catch (e) {
		toast(`${path} failed: ${e.message}`, false);
	}
}

// Render the 4 hero stat cards (chunk 9.8):
// account balance, total PnL, 24h PnL, fees.
// Pulls from /api/pm/bot/status + /api/pm/summary.
function renderHero(status, summary) {
	// Account balance (live from Kalshi).
	const bal = window._lastBalance;
	if (bal && bal.ok) {
		$("hero-balance").textContent = `$${bal.balance_dollars}`;
		$("hero-balance-sub").textContent =
			`portfolio $${bal.portfolio_value_dollars} on Kalshi`;
	} else {
		$("hero-balance").textContent = "—";
		$("hero-balance-sub").textContent = "loading balance…";
	}
	// Total PnL = realized (closed trades) + unrealized (open).
	const realized = summary?.recap?.realized_cents ?? 0;
	const unrealized = status?.risk?.total_unrealized_pnl_cents ?? 0;
	const totalPnl = realized + unrealized;
	const totalEl = $("hero-pnl-total");
	totalEl.textContent = fmtCents(totalPnl);
	totalEl.classList.remove("pos", "neg");
	if (totalPnl > 0) totalEl.classList.add("pos");
	else if (totalPnl < 0) totalEl.classList.add("neg");
	// 24h PnL from summary recap.
	const pnl24 = summary?.recap?.last_24h_cents ?? 0;
	const pnl24El = $("hero-pnl-24h");
	pnl24El.textContent = fmtCents(pnl24);
	pnl24El.classList.remove("pos", "neg");
	if (pnl24 > 0) pnl24El.classList.add("pos");
	else if (pnl24 < 0) pnl24El.classList.add("neg");
	const nTrades24 = summary?.recap?.n_trades_24h ?? 0;
	$("hero-pnl-24h-sub").textContent = `${fmtNum(nTrades24)} trades`;
	// Total fees paid (cumulative).
	const feesCents = status?.counts?.total_fees_cents ?? 0;
	$("hero-fees").textContent = fmtCents(feesCents);
}

function renderPositions(positions) {
	const el = $("positions-list");
	if (!positions || positions.length === 0) {
		el.innerHTML = '<div class="empty">no open positions</div>';
		return;
	}
	el.innerHTML = positions.map((p) => {
		const sideCls = p.side === "yes" ? "yes" : "no";
		const pnl = p.unrealized_pnl_cents;
		const pnlCls = pnl > 0 ? "pos" : pnl < 0 ? "neg" : "zero";
		const pnlStr = pnl === null || pnl === undefined ? "—" : fmtCents(pnl);
		const markStr = p.mark_cents === null || p.mark_cents === undefined
			? ""
			: ` · mark ${esc(p.mark_cents)}c`;
		return `
			<div class="position-row">
				<div>
					<div><span class="position-ticker">${esc(p.ticker)}</span><span class="side-badge ${sideCls}">${esc(p.side.toUpperCase())}</span></div>
					<div class="position-meta">${esc(p.size)} contracts @ ${esc(p.entry_price)}c${markStr}</div>
				</div>
				<div class="position-side">
					<div class="pnl-pill ${pnlCls}">${pnlStr}</div>
					<button class="btn small danger position-close-btn" data-ticker="${esc(p.ticker)}" aria-label="Close ${esc(p.ticker)} position">Close</button>
				</div>
			</div>
		`;
	}).join("");

	// Wire close buttons.
	for (const btn of el.querySelectorAll(".position-close-btn")) {
		btn.addEventListener("click", () => {
			void closePosition(btn.dataset.ticker);
		});
	}
}

// Manual close of an open position. Works for paper
// + real positions; uses the current mark as the
// exit price.
async function closePosition(ticker) {
	if (!confirm(`Close ${ticker} at the current mark?`)) return;
	toast(`closing ${ticker}…`);
	const r = await fetch("/api/pm/bot/close-position", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ ticker, rationale: "ui_close" }),
	});
	if (r.ok) {
		const data = await r.json().catch(() => ({}));
		const pnl = data.pnl_cents ?? 0;
		const sign = pnl > 0 ? "+" : pnl < 0 ? "−" : "";
		toast(`closed ${ticker} · pnl ${sign}$${(Math.abs(pnl) / 100).toFixed(2)}`, true);
		setTimeout(() => { void refresh(); void refreshVerticals(); }, 600);
	} else {
		const data = await r.json().catch(() => ({}));
		toast(`close failed: ${data.message ?? r.statusText}`, false);
	}
}

// Manual cancel of an open real order (GTC
// orders that haven't filled yet). The cancel
// button on each trade row binds to this.
async function cancelOrder(orderId) {
	if (!confirm(`Cancel order ${orderId.slice(0, 8)}…?`)) return;
	toast(`cancelling ${orderId.slice(0, 8)}…`);
	const r = await fetch("/api/pm/bot/cancel-order", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ order_id: orderId }),
	});
	if (r.ok) {
		toast(`cancelled ${orderId.slice(0, 8)}…`, true);
		setTimeout(() => { void refresh(); }, 600);
	} else {
		const data = await r.json().catch(() => ({}));
		toast(`cancel failed: ${data.message ?? r.statusText}`, false);
	}
}

function renderVerticals(verticals) {
	const tbody = $("vertical-tbody");
	if (!verticals || Object.keys(verticals).length === 0) {
		tbody.innerHTML = '<tr><td colspan="5" class="empty"><div class="empty-icon">📈</div>no verticals yet<div class="empty-hint">one row per vertical (weather / economic / politics / sports)</div></td></tr>';
		return;
	}
	// Stable order: weather, economic, politics, sports.
	const order = ["weather", "economic", "politics", "sports"];
	const rows = order
		.filter((v) => verticals[v] !== undefined)
		.map((v) => [v, verticals[v]]);
	// Append any non-standard verticals (defensive — future-proof).
	for (const [v, d] of Object.entries(verticals)) {
		if (!order.includes(v)) rows.push([v, d]);
	}
	tbody.innerHTML = rows.map(([v, d]) => {
		const pnl24Cls = d.pnl_24h_cents > 0 ? "pos" : d.pnl_24h_cents < 0 ? "neg" : "muted";
		const pnlLifeCls = d.pnl_lifetime_cents > 0 ? "pos" : d.pnl_lifetime_cents < 0 ? "neg" : "muted";
		return `
			<tr>
				<td>${esc(v)}</td>
				<td class="num ${pnl24Cls}">${fmtCents(d.pnl_24h_cents)}</td>
				<td class="num ${pnlLifeCls}">${fmtCents(d.pnl_lifetime_cents)}</td>
				<td class="num">${fmtNum(d.n_trades_lifetime)}</td>
				<td class="num">${fmtNum(d.n_open ?? 0)}</td>
			</tr>
		`;
	}).join("");
}

function renderTrades(trades) {
	const tbody = $("trades-tbody");
	if (!trades || trades.length === 0) {
		tbody.innerHTML = '<tr><td colspan="7" class="empty">no trades yet</td></tr>';
		return;
	}
	tbody.innerHTML = trades.slice(0, 20).map((t) => {
		const pnl = t.pnl_cents;
		const pnlCls = pnl === null ? "muted" : pnl > 0 ? "pos" : pnl < 0 ? "neg" : "muted";
		const pnlStr = pnl === null || pnl === undefined ? "—" : fmtCents(pnl);
		const sideCls = t.side === "yes" ? "yes" : "no";
		return `
			<tr>
				<td class="muted">${esc(fmtTime(t.ts))}</td>
				<td class="ticker">${esc(t.ticker)}</td>
				<td><span class="side-badge ${sideCls}">${esc(t.side.toUpperCase())}</span></td>
				<td>${esc(t.action)}</td>
				<td class="num">${esc(t.price_cents)}c</td>
				<td class="num">${fmtNum(t.size)}</td>
				<td class="num ${pnlCls}">${pnlStr}</td>
			</tr>
		`;
	}).join("");
}

function renderSignals(signals) {
	const tbody = $("signals-tbody");
	if (!signals || signals.length === 0) {
		tbody.innerHTML = '<tr><td colspan="6" class="empty"><div class="empty-icon">📡</div>no signals yet<div class="empty-hint">signals fire when the WS sees an orderbook move that crosses the model threshold</div></td></tr>';
		return;
	}
	tbody.innerHTML = signals.slice(0, 20).map((s) => {
		const sideStr = s.side ? s.side.toUpperCase() : "—";
		const pStr = s.signal_p !== null ? s.signal_p.toFixed(2) : "—";
		return `
			<tr>
				<td class="muted">${esc(fmtTime(s.ts))}</td>
				<td class="ticker">${esc(s.ticker)}</td>
				<td>${esc(sideStr)}</td>
				<td class="num">${esc(pStr)}</td>
				<td>${esc(s.source)}</td>
				<td>${s.was_filled ? '<span class="pos">yes</span>' : '<span class="faint">no</span>'}</td>
			</tr>
		`;
	}).join("");
}

function renderRecap(recap) {
	const el = $("recap-body");
	if (!recap) {
		el.innerHTML = '<div class="empty">no recap yet — runs at 06:00 UTC</div>';
		return;
	}
	const t = recap.trades ?? {};
	const s = recap.signals ?? {};
	const pnlCls = (t.realized_pnl_cents ?? 0) > 0 ? "pos" : (t.realized_pnl_cents ?? 0) < 0 ? "neg" : "muted";
	el.innerHTML = `
		<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
			<div>
				<div class="stat-label">Date</div>
				<div class="stat-num" style="font-size: 18px;">${esc(recap.date ?? "—")}</div>
			</div>
			<div>
				<div class="stat-label">Realized PnL</div>
				<div class="stat-num ${pnlCls}" style="font-size: 22px;">${fmtCents(t.realized_pnl_cents ?? 0)}</div>
			</div>
		</div>
		<div style="margin-top: 16px; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; font-size: 12px;">
			<div><span class="muted">Trades:</span> ${fmtNum(t.n_total ?? 0)} <span class="faint">(${fmtNum(t.n_opens ?? 0)}o / ${fmtNum(t.n_closes ?? 0)}c)</span></div>
			<div><span class="muted">Signals:</span> ${fmtNum(s.n_total ?? 0)} <span class="faint">(${fmtNum(s.n_filled ?? 0)} filled)</span></div>
			<div><span class="muted">Open:</span> ${fmtNum(recap.open_positions ?? 0)}</div>
		</div>
	`;
}

// Render the Verticals panel (chunk 10.8c). One
// card per vertical with active toggle, model
// version, strategy + ELI5, 24h + all-time stats,
// and per-vertical cap. Toggles PATCH
// /api/pm/bot/start with the new disabled_verticals.
function renderVerticalsPanel(verticals) {
	const grid = $("verticals-grid");
	if (!grid) return;
	if (!verticals || verticals.length === 0) {
		grid.innerHTML = '<div class="empty"><div class="empty-icon">🎯</div>no verticals configured<div class="empty-hint">add tickers via /start to enable verticals</div></div>';
		return;
	}
	grid.innerHTML = verticals.map((v) => {
		const pnl24 = v.pnl_cents_24h;
		const pnlTot = v.pnl_cents_total;
		const pnl24Cls = pnl24 > 0 ? "pos" : pnl24 < 0 ? "neg" : "";
		const pnlTotCls = pnlTot > 0 ? "pos" : pnlTot < 0 ? "neg" : "";
		const capTxt = v.cap_cents != null
			? `$${(v.cap_cents / 100).toFixed(2)}`
			: "global";
		const tickersTxt = v.tickers.length === 0
			? "no tickers yet"
			: `${v.tickers.length} ticker${v.tickers.length === 1 ? "" : "s"}`;
		return `
			<div class="vertical-card ${v.active ? "" : "disabled"}" data-vertical="${esc(v.id)}">
				<div class="vertical-card-head">
					<span class="vertical-emoji">${esc(v.emoji)}</span>
					<span class="vertical-name">${esc(v.label)}</span>
					<span class="vertical-status">${v.active ? "live" : "off"}</span>
				</div>
				<div class="vertical-strategy">${esc(v.strategy_label)} · model ${esc(v.model_version)}</div>
				<div class="vertical-eli5">${esc(v.strategy_eli5)}</div>
				<div class="vertical-stats">
					<div class="vertical-stat">
						<span class="vertical-stat-label">24h trades</span>
						<span class="vertical-stat-val">${fmtNum(v.n_trades_24h)}</span>
					</div>
					<div class="vertical-stat">
						<span class="vertical-stat-label">24h PnL</span>
						<span class="vertical-stat-val ${pnl24Cls}">${fmtCents(pnl24)}</span>
					</div>
					<div class="vertical-stat">
						<span class="vertical-stat-label">all-time</span>
						<span class="vertical-stat-val ${pnlTotCls}">${fmtNum(v.n_trades_total)} · ${fmtCents(pnlTot)}</span>
					</div>
					<div class="vertical-stat">
						<span class="vertical-stat-label">cap/trade</span>
						<span class="vertical-stat-val">${esc(capTxt)}</span>
					</div>
					<div class="vertical-stat">
						<span class="vertical-stat-label">tickers</span>
						<span class="vertical-stat-val">${esc(tickersTxt)}</span>
					</div>
				</div>
				<div class="vertical-toggle">
					<span class="vertical-toggle-label">${v.active ? "trading enabled" : "all signals blocked"}</span>
					<div class="toggle-switch ${v.active ? "on" : ""}"
					     data-vertical="${esc(v.id)}"
					     role="switch"
					     aria-checked="${v.active}"
					     aria-label="Toggle ${esc(v.label)} vertical"
					     tabindex="0"></div>
				</div>
			</div>
		`;
	}).join("");

	// Wire toggle clicks.
	for (const sw of grid.querySelectorAll(".toggle-switch")) {
		sw.addEventListener("click", () => {
			void toggleVertical(sw.dataset.vertical);
		});
		sw.addEventListener("keydown", (e) => {
			if (e.key === " " || e.key === "Enter") {
				e.preventDefault();
				void toggleVertical(sw.dataset.vertical);
			}
		});
	}
}

// Toggle a vertical on/off via /api/pm/bot/start.
async function toggleVertical(vertical) {
	const cur = window._lastBotStatus?.config?.disabled_verticals ?? [];
	let next;
	if (cur.includes(vertical)) {
		// Re-enable.
		next = cur.filter((v) => v !== vertical);
		toast(`enabling ${vertical}…`);
	} else {
		// Disable.
		next = [...cur, vertical];
		toast(`blocking ${vertical}…`);
	}
	const r = await fetch("/api/pm/bot/start", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ disabled_verticals: next }),
	});
	if (r.ok) {
		setTimeout(() => { void refresh(); void refreshVerticals(); }, 600);
	} else {
		const data = await r.json().catch(() => ({}));
		toast(`vertical toggle failed: ${data.message ?? r.statusText}`, false);
	}
}

// Fetch + render the Verticals panel.
async function refreshVerticals() {
	try {
		const r = await fetch("/api/pm/verticals");
		if (!r.ok) return;
		const data = await r.json();
		renderVerticalsPanel(data.verticals ?? []);
	} catch (e) {
		console.warn("refreshVerticals failed", e);
	}
}

function renderCronRuns(runs) {
	const tbody = $("cron-tbody");
	if (!runs || runs.length === 0) {
		tbody.innerHTML = '<tr><td colspan="4" class="empty"><div class="empty-icon">⏱</div>no cron runs yet<div class="empty-hint">the scan cron fires every 15 min, the others run on the schedule in the Cadence panel</div></td></tr>';
		return;
	}
	tbody.innerHTML = runs.slice(0, 10).map((r) => {
		const statusCls = r.status === "success" ? "pos" : r.status === "error" ? "neg" : "muted";
		return `
			<tr>
				<td>${esc(r.cron_name)}</td>
				<td class="${statusCls}">${esc(r.status)}</td>
				<td class="muted">${esc(fmtTime(r.ts))}</td>
				<td class="num">${fmtNum(r.duration_ms ?? 0)}</td>
			</tr>
		`;
	}).join("");
}

// ─── Bot control → derive open positions from the trades table ───
async function fetchOpenPositions() {
	try {
		// Pull open positions from the bot's live
		// state (chunk 9.8: each position comes
		// with mark + unrealized_pnl_cents).
		// Cheaper than computing on the client,
		// and the mark data is the bot's own
		// (most recent WS frame, not the dashboard
		// pulling its own orderbook).
		const data = await fetchJSON("/api/pm/bot/status");
		return data?.risk?.open_positions ?? [];
	} catch (_e) {
		return [];
	}
}

// ─── Main refresh ───
async function refresh() {
	const t0 = Date.now();
	let okCount = 0;
	const tick = (n) => { okCount += n; };
	try {
		const [status, summary, scans, signals, trades, crons, botStatus, stage, cadence] = await Promise.all([
			fetchJSON("/api/pm/status").then((v) => { tick(1); return v; }).catch(() => null),
			fetchJSON("/api/pm/summary").then((v) => { tick(1); return v; }).catch(() => null),
			fetchJSON("/api/pm/scans").then((v) => { tick(1); return v; }).catch(() => null),
			fetchJSON("/api/pm/signals?limit=20").then((v) => { tick(1); return v; }).catch(() => ({ signals: [] })),
			fetchJSON("/api/pm/trades?limit=20").then((v) => { tick(1); return v; }).catch(() => ({ trades: [] })),
			fetchJSON("/api/pm/cron-runs?limit=10").then((v) => { tick(1); return v; }).catch(() => ({ runs: [] })),
			fetchJSON("/api/pm/bot/status").then((v) => { tick(1); return v; }).catch(() => null),
			fetchStage().then((v) => { tick(1); return v; }).catch(() => null),
			fetchSchedule().then((v) => { tick(1); return v; }).catch(() => null),
		]);

		// Chunk 9.8: hero stat cards.
		if (status || botStatus) {
			renderHero(botStatus, summary);
		}
		if (summary?.recap) renderRecap(summary.recap);
		if (signals?.signals) renderSignals(signals.signals);
		if (trades?.trades) {
			renderTrades(trades.trades);
			renderPositions(await fetchOpenPositions());
			// Chunk 9.6: last-5-trades panel +
			// the modal's trade list.
			renderLastTrades(trades.trades);
		} else {
			renderPositions([]);
			renderLastTrades([]);
		}
		if (crons?.runs) renderCronRuns(crons.runs);

		// Per-vertical: derive from summary.recap.verticals
		// (chunk 10.8: live aggregate now includes
		// per-vertical data so this section is no
		// longer stuck on "loading…").
		if (summary?.recap?.verticals) {
			renderVerticals(summary.recap.verticals);
		} else {
			renderVerticals({});
		}

		// Bot status pill (chunk 10: setStatusPill
		// removed — the stage badge in the brand bar
		// + the stage panel below are the single
		// source of truth. Keep the model-version
		// + trading controls render here.)
		if (botStatus) {
			$("model-version").textContent = `v${esc(botStatus.config?.model_version ?? "?")}`;
			// Chunk 9.6: trading mode + caps + kill
			// switch state.
			renderTradingControls(botStatus);
		}
		// Chunk 9.8: live indicator. OK if at
		// least 5 of 7 endpoints returned data.
		_lastLastRefreshMs = Date.now();
		_lastRefreshError = null;
		if (okCount >= 5) {
			const ageSec = Math.round((Date.now() - t0) / 1000);
			setLiveIndicator("live", `live · ${ageSec}s ago · ${okCount}/7 ok`);
		} else if (okCount > 0) {
			setLiveIndicator("stale", `partial · ${okCount}/7 ok · retrying…`);
		} else {
			setLiveIndicator("err", "refresh failed");
		}
	} catch (e) {
		console.error("refresh failed", e);
		_lastRefreshError = e instanceof Error ? e.message : String(e);
		// Chunk 10: setStatusPill was removed (the
		// live indicator + stage badge are the single
		// source of truth). Just update the live dot.
		setLiveIndicator("err", `err · ${_lastRefreshError.slice(0, 40)}`);
	}
}

// ─── CF Workers analytics (chunk 9.5) ───
// Pulls /api/pm/cf-analytics on a slower cadence
// (CF data is ~1m delayed; 90s is enough). On
// error, shows the message + link to the CF
// dashboard.
async function refreshCfAnalytics() {
	try {
		const r = await fetch("/api/pm/cf-analytics?hours=24", {
			credentials: "same-origin",
		});
		const data = await r.json();
		if (!data.ok) {
			renderCfAnalyticsError(data);
			return;
		}
		renderCfAnalytics(data);
	} catch (e) {
		renderCfAnalyticsError({
			error: "fetch_failed",
			detail: String(e).slice(0, 200),
			dashboard_url:
				"https://dash.cloudflare.com/8c995c329fee2ee6ab33d9d3d6a30e55" +
				"/workers/services/view/pm-bot/production/metrics",
		});
	}
}

function renderCfAnalytics(data) {
	$("cf-requests").textContent = fmtNum(data.totals.requests);
	$("cf-errors").textContent = fmtNum(data.totals.errors);
	const successEl = $("cf-success");
	successEl.textContent = `${data.totals.success_rate_pct.toFixed(2)}%`;
	successEl.classList.toggle("pos", data.totals.success_rate_pct >= 99);
	successEl.classList.toggle("neg", data.totals.success_rate_pct < 99);
	$("cf-subrequests").textContent = fmtNum(data.totals.subrequests);
	$("cf-dashboard-link").href = data.dashboard_url;

	// Render the bar chart.
	const chart = $("cf-chart");
	chart.innerHTML = "";
	if (!data.hourly || data.hourly.length === 0) {
		chart.innerHTML = '<div class="empty">no requests in the last 24h</div>';
	} else {
		const max = Math.max(1, ...data.hourly.map((b) => b.requests));
		for (const b of data.hourly) {
			const bar = document.createElement("div");
			bar.className = "cf-bar" + (b.errors > 0 ? " err" : "");
			const h = Math.max(1, Math.round((b.requests / max) * 72));
			bar.style.height = `${h}px`;
			const ts = b.datetime.replace("T", " ").replace("Z", "Z").slice(0, 16);
			bar.title = `${ts}Z · ${fmtNum(b.requests)} req, ${fmtNum(b.errors)} err`;
			chart.appendChild(bar);
		}
	}
	const since = (data.since || "").slice(0, 16).replace("T", " ");
	$("cf-foot").innerHTML =
		`<span>since ${esc(since)}Z</span>` +
		`<span>window: last 24h</span>` +
		`<span>updated ${new Date().toISOString().slice(11, 19)}Z</span>`;
}

function renderCfAnalyticsError(data) {
	$("cf-requests").textContent = "—";
	$("cf-errors").textContent = "—";
	$("cf-success").textContent = "—";
	$("cf-subrequests").textContent = "—";
	$("cf-dashboard-link").href =
		data.dashboard_url ||
		"https://dash.cloudflare.com/8c995c329fee2ee6ab33d9d3d6a30e55" +
			"/workers/services/view/pm-bot/production/metrics";
	$("cf-chart").innerHTML =
		`<div class="empty">` +
		`CF analytics unavailable: <code>${esc(data.error || "unknown")}</code>` +
		(data.detail ? ` — ${esc(data.detail)}` : "") +
		`<br><br><a href="${esc($("cf-dashboard-link").href)}" target="_blank" rel="noopener" style="color: var(--accent);">view at dash.cloudflare.com ↗</a>` +
		`</div>`;
	$("cf-foot").innerHTML = "";
}

// ─── Cost (chunk 9.7) ───
// Pulls /api/pm/cost on a 60s cadence. Shows
// the operator a single "how much is this
// costing me" number (24h + monthly estimate).
// Numbers are estimates, not invoiced.
async function refreshCost() {
	try {
		const r = await fetch("/api/pm/cost", { credentials: "same-origin" });
		const d = await r.json();
		if (!d.ok) {
			$("cost-total").textContent = "—";
			$("cost-cf").textContent = "—";
			$("cost-mmx").textContent = "—";
			$("cost-foot").innerHTML = `cost unavailable: <code>${esc(d.error || "unknown")}</code>${d.detail ? ` — ${esc(d.detail)}` : ""}`;
			return;
		}
		renderCost(d);
	} catch (e) {
		$("cost-total").textContent = "—";
		$("cost-cf").textContent = "—";
		$("cost-mmx").textContent = "—";
		$("cost-foot").textContent = `cost fetch failed: ${e.message}`;
	}
}

function renderCost(d) {
	const fmtUsd = (n) => {
		if (n === 0) return "$0.00";
		if (n < 0.01) return "<$0.01";
		return `$${n.toFixed(2)}`;
	};
	// Chunk 12 (2026-08-08): when a cost is $0, the
	// old display just showed "$0.00" which looks
	// broken. Add a context line below the dollar
	// amount so the operator sees what's actually
	// going on ("below free tier", "no LLM calls
	// yet", etc.).
	const freeContext = (kind) => {
		if (kind === "cf") {
			return "below 100K free requests/day";
		}
		if (kind === "d1") {
			return "below 100K free writes/day";
		}
		if (kind === "r2") {
			return "below 10GB free storage";
		}
		if (kind === "mmx") {
			return "no LLM calls yet (or stub mode)";
		}
		return "below free tier";
	};
	const totalEl = $("cost-total");
	totalEl.textContent = fmtUsd(d.total_estimated_cost_24h);
	totalEl.classList.toggle("free", d.total_estimated_cost_24h === 0);
	if (d.total_estimated_cost_24h === 0 && d.cf.estimated_cost_24h === 0) {
		$("cost-monthly").textContent =
			`≈ ${fmtUsd(d.monthly_estimate)}/mo · free tier`;
	} else {
		$("cost-monthly").textContent = `≈ ${fmtUsd(d.monthly_estimate)}/mo`;
	}

	const cfEl = $("cost-cf");
	cfEl.textContent = fmtUsd(d.cf.estimated_cost_24h);
	cfEl.classList.toggle("free", d.cf.estimated_cost_24h === 0);
	$("cost-cf-detail").textContent =
		d.cf.estimated_cost_24h === 0
			? `${fmtNum(d.cf.requests_24h)} requests · ${freeContext("cf")}`
			: `${fmtNum(d.cf.requests_24h)} requests · ${fmtNum(d.cf.errors_24h)} errors`;

	const mmxEl = $("cost-mmx");
	mmxEl.textContent = fmtUsd(d.mmx.estimated_cost_24h);
	mmxEl.classList.toggle("free", d.mmx.estimated_cost_24h === 0);
	$("cost-mmx-detail").textContent =
		d.mmx.estimated_cost_24h === 0 && d.mmx.calls_24h === 0
			? freeContext("mmx")
			: `${fmtNum(d.mmx.calls_24h)} calls · ${fmtNum(d.mmx.input_tokens_24h)} in / ${fmtNum(d.mmx.output_tokens_24h)} out tokens`;

	// Chunk 10.5: monthly limits card.
	renderMonthlyLimits(d.cf_monthly, d.dashboard_url);

	$("cost-cf-dashboard").href = d.dashboard_url;
	const notesHtml = (d.notes || []).map((n) => `<li>${esc(n)}</li>`).join("");
	$("cost-foot").innerHTML =
		`<strong>assumptions:</strong>` +
		(notesHtml ? `<ul>${notesHtml}</ul>` : " no notes") +
		`<div style="margin-top:6px; opacity:0.7;">estimates, not invoiced. confirm at the CF billing dashboard.</div>`;
}

// ─── Monthly limits (chunk 10.5) ───
// Single section: CF (Workers Paid plan). pm-bot
// is fully Cloudflare-native — no third-party
// infrastructure to track.
function renderMonthlyLimits(cf, dashboardUrl) {
	const container = $("monthly-limits");
	if (!container) return;

	// CF section
	const cfPctClass = (pct) =>
		pct >= 90 ? "bar-err" : pct >= 70 ? "bar-warn" : "bar-ok";

	const cfResetInfo = cf
		? `<div class="monthly-reset">resets in <strong>${esc(String(cf.days_until_reset))}</strong> day${cf.days_until_reset === 1 ? "" : "s"} · on <strong>${esc(cf.resets_on)}</strong> · day ${esc(String(cf.days_elapsed))}/30 of cycle</div>`
		: "";

	const cfBar = (label, current, limit, pct, suffix = "") => `
		<div class="monthly-bar">
			<div class="monthly-bar-head">
				<span class="monthly-bar-label">${esc(label)}</span>
				<span class="monthly-bar-pct ${pct >= 90 ? "pct-err" : pct >= 70 ? "pct-warn" : "pct-ok"}">${pct.toFixed(1)}%</span>
			</div>
			<div class="monthly-bar-track">
				<div class="monthly-bar-fill ${cfPctClass(pct)}" style="width: ${Math.min(100, pct).toFixed(1)}%;"></div>
			</div>
			<div class="monthly-bar-detail">${fmtNum(current)} / ${fmtNum(limit)}${esc(suffix)}</div>
		</div>`;

	const cfBars = cf
		? cfBar(
				"Workers requests",
				cf.requests.current,
				cf.requests.limit,
				cf.requests.pct,
				" (extrapolated from last 7d)",
			) +
			cfBar(
				"Workers CPU time",
				cf.cpu_ms.current,
				cf.cpu_ms.limit,
				cf.cpu_ms.pct,
				" ms",
			) +
			cfBar(
				"D1 writes (24h)",
				cf.d1_writes_24h.current,
				cf.d1_writes_24h.limit,
				cf.d1_writes_24h.pct,
			) +
			cfBar(
				"R2 storage",
				cf.r2_storage_gb.current,
				cf.r2_storage_gb.limit,
				cf.r2_storage_gb.pct,
				" GB",
			)
		: "<div class=\"muted\">CF billing date not configured.</div>";

	container.innerHTML = `
		<div class="monthly-section">
			<div class="monthly-section-head">
				<span class="monthly-section-title">Cloudflare Workers Paid</span>
				<a class="muted" href="${esc(dashboardUrl ?? "#")}" target="_blank" rel="noopener">open CF dashboard ↗</a>
			</div>
			${cfResetInfo}
			<div class="monthly-bars">${cfBars}</div>
		</div>`;
}

// ─── Skeleton + empty state helpers (chunk 12) ───
// Replace "loading…" text with shimmer bars that
// give a sense of "data is coming" without the
// visual monotony of a static "loading…" string.
function skelRow(cols, widths) {
	const cells = Array.from({ length: cols }, (_, i) => {
		const w = widths?.[i] ?? "m";
		return `<td><span class="skel-bar ${w}"></span></td>`;
	}).join("");
	return `<tr class="skel-row">${cells}</tr>`;
}
function skelTbody(tbodyId, cols, widths) {
	const tbody = $(tbodyId);
	if (!tbody) return;
	tbody.innerHTML =
		skelRow(cols, widths) + skelRow(cols, widths) + skelRow(cols, widths);
}
// Friendly empty state. The previous version just
// had "no trades yet" — chunk 12 adds a small icon
// + a hint explaining what the operator should do.
function emptyState(tbodyId, icon, message, hint) {
	const tbody = $(tbodyId);
	if (!tbody) return;
	tbody.innerHTML = `<tr><td colspan="${tbody.closest("table")?.querySelectorAll("thead th").length ?? 4}" class="empty">
		<div class="empty-icon">${esc(icon)}</div>
		<div>${esc(message)}</div>
		${hint ? `<div class="empty-hint">${esc(hint)}</div>` : ""}
	</td></tr>`;
}

// ─── Toast (chunk 12: icon + dismiss) ───
let toastTimer = null;
function toast(msg, ok = true) {
	const el = $("toast");
	el.classList.remove("ok", "err", "show");
	el.classList.add(ok ? "ok" : "err");
	// Chunk 12: wrap the message in icon + body +
	// dismiss button. The icon distinguishes ok vs
	// err at a glance.
	el.innerHTML = `
		<span class="toast-icon" aria-hidden="true">${ok ? "✓" : "!"}</span>
		<span class="toast-body">${esc(String(msg))}</span>
		<button class="toast-dismiss" aria-label="Dismiss">×</button>
	`;
	const dismiss = el.querySelector(".toast-dismiss");
	if (dismiss) {
		dismiss.addEventListener("click", () => {
			el.classList.remove("show");
		});
	}
	// Force reflow for animation restart.
	void el.offsetWidth;
	el.classList.add("show");
	if (toastTimer) clearTimeout(toastTimer);
	// Errors stay 5s (longer — the operator might
	// need to read the message); success auto-dismisses
	// in 2.5s.
	const ttl = ok ? 2500 : 5000;
	toastTimer = setTimeout(() => el.classList.remove("show"), ttl);
}

// ─── Trading mode + caps + kill switch (chunk 9.6) ───
// Set the trading mode via the API. The "real"
// mode opens a confirmation modal first.
async function setTradingMode(mode) {
	try {
		const r = await fetch("/api/pm/bot/trading-mode", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ trading_mode: mode }),
		});
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const body = await r.json();
		if (!body.ok) throw new Error(body.error ?? "unknown");
		toast(`trading mode → ${mode}`, true);
		await refresh();
		await refreshBalance();
	} catch (e) {
		toast(`trading mode failed: ${e.message}`, false);
	}
}

// Toggle the kill switch (one-click, no confirm).
async function setKillSwitch(on) {
	try {
		const r = await fetch("/api/pm/bot/kill-switch", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ on }),
		});
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const body = await r.json();
		if (!body.ok) throw new Error(body.error ?? "unknown");
		toast(`kill switch → ${on ? "ON" : "off"}`, on ? false : true);
		await refresh();
	} catch (e) {
		toast(`kill switch failed: ${e.message}`, false);
	}
}

// Fetch the live Kalshi account balance.
async function refreshBalance() {
	try {
		const r = await fetch("/api/pm/bot/balance", { credentials: "same-origin" });
		if (!r.ok) return;
		const d = await r.json();
		if (!d.ok) {
			$("caps-balance").textContent = "—";
			$("hero-balance").textContent = "—";
			$("hero-balance-sub").textContent = "loading balance…";
			window._lastBalance = null;
			return;
		}
		// Single source of truth: stash the response so
		// renderHero() can read it on the next refresh()
		// cycle, and update every balance-bearing element
		// here so the fix is immediate (no 30s wait for
		// the next refresh).
		window._lastBalance = d;
		$("caps-balance").textContent = `$${d.balance_dollars}`;
		$("modal-balance").textContent = `$${d.balance_dollars}`;
		$("hero-balance").textContent = `$${d.balance_dollars}`;
		$("hero-balance-sub").textContent =
			`portfolio $${d.portfolio_value_dollars} on Kalshi`;
	} catch (_e) {
		$("caps-balance").textContent = "—";
		$("hero-balance").textContent = "—";
		$("hero-balance-sub").textContent = "loading balance…";
	}
}

// Render the trading mode section from the
// current /api/pm/bot/status. Updates the
// active button + mode pill + caps panel +
// kill switch state.
function renderTradingControls(status) {
	if (!status?.config) return;
	const mode = status.config.trading_mode ?? "paper";
	const perTrade = (status.config.max_notional_cents_per_trade ?? 0) / 100;
	const dailyCap = (status.config.daily_notional_cents_cap ?? 0) / 100;
	const dailyUsed = (status.risk?.daily_notional_cents ?? 0) / 100;
	const killOn = !!status.config.kill_switch;
	const disabledTickers = status.config.disabled_tickers ?? [];
	const perVertical = status.config.per_vertical_max_notional_cents ?? {};

	// Active button highlight. (Chunk 10.8b: chunk 10.8
	// wrote "active primary" as a single space-separated
	// token which throws InvalidCharacterError. Use
	// classList.remove with each token separately.)
	for (const btn of document.querySelectorAll(".mode-btn")) {
		btn.classList.remove("active", "primary");
		if (btn.dataset.mode === mode) {
			btn.classList.add("active");
			if (mode === "real") btn.classList.add("primary");
		}
	}
	// Mode pill.
	const pill = $("mode-pill");
	pill.classList.remove("paper", "real", "off");
	pill.classList.add(mode);
	pill.textContent = mode;

	// Caps panel.
	$("caps-per-trade").textContent = `$${perTrade.toFixed(2)}`;
	$("caps-daily").textContent = `$${dailyUsed.toFixed(2)} / $${dailyCap.toFixed(2)}`;
	const bar = $("caps-bar");
	const pct = dailyCap > 0 ? Math.min(100, (dailyUsed / dailyCap) * 100) : 0;
	bar.style.width = `${pct}%`;
	bar.classList.remove("warn", "over");
	if (pct >= 100) bar.classList.add("over");
	else if (pct >= 80) bar.classList.add("warn");

	// Per-vertical caps (chunk 11b). Display as
	// removable tags so the operator can drop
	// overrides from the UI. Empty state shows a
	// muted "using global cap" hint.
	const perVerticalEl = $("per-vertical-caps");
	if (perVerticalEl) {
		const entries = Object.entries(perVertical);
		if (entries.length === 0) {
			perVerticalEl.innerHTML =
				'<div class="muted" style="font-size:11px;">no per-vertical overrides (using global cap)</div>';
		} else {
			perVerticalEl.innerHTML = entries
				.map(
					([v, c]) =>
						`<span class="vertical-cap-tag" data-vertical="${esc(v)}">${esc(v)}: $${(c / 100).toFixed(2)}<button class="per-vertical-remove" data-vertical="${esc(v)}" aria-label="Remove ${esc(v)} cap">×</button></span>`,
				)
				.join(" ");
		}
	}

	// Blocklist (chunk 11b). Display the disabled
	// tickers as tags + an input to add more.
	const blocklistEl = $("blocklist");
	if (blocklistEl) {
		const tagHtml = disabledTickers
			.map(
				(t) =>
					`<span class="blocklist-tag">${esc(t)}<button class="blocklist-remove" data-ticker="${esc(t)}" aria-label="Remove ${esc(t)}">×</button></span>`,
			)
			.join("");
		blocklistEl.innerHTML = tagHtml;
	}

	// Kill switch state.
	const killEl = $("kill-state");
	killEl.classList.toggle("on", killOn);
	killEl.textContent = killOn ? "ON" : "off";

	// Modal (mirror the live values for the
	// confirmation dialog).
	$("modal-per-trade").textContent = `$${perTrade.toFixed(2)}`;
	$("modal-daily-cap").textContent = `$${dailyCap.toFixed(2)}`;
	$("modal-today").textContent = `$${dailyUsed.toFixed(2)} / $${dailyCap.toFixed(2)}`;
	$("modal-kill").textContent = killOn ? "ON" : "off";
}

// Render the "last 5 trades" panel + the
// modal's trade list. Same data both places.
function renderLastTrades(trades) {
	const tbodies = [
		$("last-trades-tbody"),
		$("modal-trades-tbody"),
	];
	const last = (trades || []).slice(0, 5);
	if (last.length === 0) {
		for (const tb of tbodies) {
			tb.innerHTML = '<tr><td colspan="7" class="empty"><div class="empty-icon">📊</div>no trades yet<div class="empty-hint">trades appear after the first signal-driven or manual fill</div></td></tr>';
		}
		return;
	}
	const rows = last.map((t) => {
		const mode = t.trading_mode ?? "paper";
		const pnl = t.pnl_cents;
		const pnlTxt = pnl === null || pnl === undefined
			? "—"
			: `${pnl < 0 ? "−" : pnl > 0 ? "+" : ""}$${(Math.abs(pnl) / 100).toFixed(2)}`;
		const pnlClass = pnl > 0 ? "pos" : pnl < 0 ? "neg" : "";
		// Show a Cancel button for open real
		// orders (action="open" + pnl=null + real_order_id).
		const cancelBtn = (mode === "real" && t.action === "open" && t.pnl_cents == null && t.real_order_id)
			? `<button class="btn small danger trade-cancel-btn" data-order-id="${esc(t.real_order_id)}" aria-label="Cancel order ${esc(t.real_order_id.slice(0, 8))}">×</button>`
			: "";
		return `<tr>
			<td>${esc(fmtTime(t.ts))}</td>
			<td><code>${esc(t.ticker)}</code></td>
			<td>${esc(t.side)}</td>
			<td><span class="trade-mode-tag ${esc(mode)}">${esc(mode)}</span></td>
			<td class="num">${(t.price_cents ?? 0)}c</td>
			<td class="num">${fmtNum(t.size)}</td>
			<td class="num ${pnlClass}">${esc(pnlTxt)}</td>
			<td>${cancelBtn}</td>
		</tr>`;
	}).join("");
	// Full table (last-trades-tbl) needs colspan=7;
	// modal tbl is colspan=4 (no When/Size/Price
	// columns in the modal — just Ticker/Side/Mode/PnL).
	$("last-trades-tbody").innerHTML = rows;
	// Wire the per-row cancel buttons (only
	// present on open real orders).
	for (const btn of $("last-trades-tbody").querySelectorAll(".trade-cancel-btn")) {
		btn.addEventListener("click", () => {
			void cancelOrder(btn.dataset.orderId);
		});
	}
	const modalRows = last.map((t) => {
		const mode = t.trading_mode ?? "paper";
		const pnl = t.pnl_cents;
		const pnlTxt = pnl === null || pnl === undefined
			? "—"
			: `${pnl < 0 ? "−" : pnl > 0 ? "+" : ""}$${(Math.abs(pnl) / 100).toFixed(2)}`;
		const pnlClass = pnl > 0 ? "pos" : pnl < 0 ? "neg" : "";
		return `<tr>
			<td><code>${esc(t.ticker)}</code></td>
			<td>${esc(t.side)}</td>
			<td><span class="trade-mode-tag ${esc(mode)}">${esc(mode)}</span></td>
			<td class="num ${pnlClass}">${esc(pnlTxt)}</td>
		</tr>`;
	}).join("");
	$("modal-trades-tbody").innerHTML = modalRows;
}

// Wire the mode buttons.
$("btn-pause").addEventListener("click", () => setTradingMode("off"));
$("btn-paper").addEventListener("click", () => setTradingMode("paper"));
$("btn-live").addEventListener("click", () => {
	$("modal-live-back").classList.add("show");
	$("modal-live-input").value = "";
	$("modal-live-confirm").disabled = true;
	$("modal-live-input").classList.remove("good", "bad");
	// Focus after a tick so the modal is
	// already visible.
	setTimeout(() => $("modal-live-input").focus(), 50);
});
$("btn-killswitch").addEventListener("click", () => {
	const cur = $("kill-state").textContent.trim().toUpperCase() === "ON";
	setKillSwitch(!cur);
});

// Modal: cancel + live-input typing + confirm.
$("modal-live-cancel").addEventListener("click", () => {
	$("modal-live-back").classList.remove("show");
});
$("modal-live-input").addEventListener("input", (e) => {
	const v = e.target.value;
	const ok = v === "LIVE";
	e.target.classList.toggle("good", ok);
	e.target.classList.toggle("bad", v.length > 0 && !ok);
	$("modal-live-confirm").disabled = !ok;
});
$("modal-live-confirm").addEventListener("click", () => {
	$("modal-live-back").classList.remove("show");
	setTradingMode("real");
});
// ESC closes the modal.
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && $("modal-live-back").classList.contains("show")) {
		$("modal-live-back").classList.remove("show");
	}
});
// Click outside the modal closes it.
$("modal-live-back").addEventListener("click", (e) => {
	if (e.target === $("modal-live-back")) {
		$("modal-live-back").classList.remove("show");
	}
});

// ─── Bot controls ───
async function botCall(action) {
	const endpoints = {
		start: "/api/pm/bot/start",
		stop: "/api/pm/bot/stop",
		restart: "/api/pm/bot/restart",
	};
	try {
		const r = await fetch(endpoints[action], {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: action === "start" ? JSON.stringify({}) : "{}",
		});
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const body = await r.json();
		if (body.ok) {
			toast(`${action} ok`, true);
		} else {
			toast(`${action} failed: ${body.error ?? "?"}`, false);
		}
		await refresh();
	} catch (e) {
		toast(`${action} failed: ${e.message}`, false);
	}
}

$("btn-start").addEventListener("click", () => botCall("start"));
$("btn-stop").addEventListener("click", () => {
	if (confirm("Stop the live bot? Open positions will be held but no new signals will fire.")) {
		botCall("stop");
	}
});
$("btn-restart").addEventListener("click", () => {
	if (confirm("Restart the live bot? This re-establishes the WebSocket.")) {
		botCall("restart");
	}
});

// ─── Initial load + auto-refresh ───
// Chunk 9.8: auto-start. On first dashboard
// load, if the bot isn't running, hit
// /api/pm/bot/auto-start. Idempotent — does
// nothing if already running. The user
// never has to push Start manually.
async function autoStartOnLoad() {
	try {
		const r = await fetch("/api/pm/bot/auto-start", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		const body = await r.json().catch(() => null);
		if (body && body.started) {
			toast("bot auto-started — WS connecting…", true);
		} else if (body && body.already_running) {
			// no-op; just normal refresh
		}
	} catch (_e) {
		// Silent — refresh will still work,
		// the bot just won't be auto-started.
	}
}
autoStartOnLoad();
refresh();
refreshBalance();
refreshVerticals();
// CF analytics: 90s cadence. The CF GraphQL
// data is ~1m delayed; faster polling is
// wasteful + burns CF API quota.
refreshCfAnalytics();
// Cost: 60s. Combines CF + D1 + MMX; 24h
// data is delayed ~1m anyway.
refreshCost();
// ─── App shell — nav injection + page init contract ───
// Each sub-page defines `window.appPageInit()` to set up its own
// refresh cycle + event listeners. The shell injects the top nav,
// then calls appPageInit on DOMContentLoaded.
//
// Why a contract instead of auto-running refresh():
// the original single-page dashboard does refresh() every 5s which
// fetches 9 endpoints and re-renders every section. On a focused
// sub-page (e.g. /app/trades) we don't need the stage panel or CF
// analytics, so each page can pick exactly the cadence it needs.

const NAV_LINKS = [
	{ page: "dashboard", href: "/app/", label: "Dashboard" },
	{ page: "bot", href: "/app/bot", label: "Bot" },
	{ page: "positions", href: "/app/positions", label: "Positions" },
	{ page: "trades", href: "/app/trades", label: "Trades" },
	{ page: "models", href: "/app/models", label: "Models" },
	{ page: "schedule", href: "/app/schedule", label: "Schedule" },
	{ page: "dev", href: "/app/dev", label: "Dev" },
];

const BRAND_MONO_SVG = `
	<svg class="app-nav-brand-mono" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-label="Trader" role="img">
		<defs>
			<linearGradient id="bb-bars-nav" x1="0" y1="0" x2="0" y2="1">
				<stop offset="0%" stop-color="#60a5fa" />
				<stop offset="100%" stop-color="#3b82f6" />
			</linearGradient>
		</defs>
		<rect width="64" height="64" rx="14" fill="#0a0e1a" />
		<rect x="14" y="38" width="8" height="14" rx="2" fill="url(#bb-bars-nav)" opacity="0.5" />
		<rect x="28" y="30" width="8" height="22" rx="2" fill="url(#bb-bars-nav)" opacity="0.75" />
		<rect x="42" y="22" width="8" height="30" rx="2" fill="url(#bb-bars-nav)" />
		<circle cx="46" cy="18" r="2.6" fill="#10b981" />
		<line x1="14" y1="55" x2="50" y2="55" stroke="#d4af37" stroke-width="0.8" opacity="0.5" />
	</svg>
`;

// CF Access team host. Discovered from the login redirect
// Location: header. The team host is part of the CF account
// setup and rarely changes; if the dashboard breaks on logout,
// update this constant to the new team host (find it by
// visiting /app/ in an incognito window and copying the
// `wandering-river-XXX.cloudflareaccess.com` substring from
// the redirect URL). Auth lives in CF Access; the dashboard
// JS can't read the HttpOnly CF_AppSession cookie to discover
// it dynamically, so we hardcode.
const CF_ACCESS_TEAM_HOST = "wandering-river-109b.cloudflareaccess.com";

// Post-logout landing page. Always the production public
// marketing site () — NOT the current host, so local
// dev / previews / preview deploys still log the user out into
// the real marketing landing instead of a dead localhost or
// staging URL. The marketing site has the public-facing copy
// + a sign-in button to come back in.
const POST_LOGOUT_URL = "/";

function signoutUrl() {
	// The CF Access logout endpoint clears the CF_AppSession
	// cookie and 302-redirects to `redirect_url`. Note: this
	// only works when the user is actually auth'd (the endpoint
	// 404s without a session cookie) — that's the desired
	// behavior, the dashboard pages all sit behind CF Access.
	const u = new URL(`https://${CF_ACCESS_TEAM_HOST}/cdn-cgi/access/logout`);
	u.searchParams.set("redirect_url", POST_LOGOUT_URL);
	return u.toString();
}

function injectAppNav() {
	const nav = document.createElement("nav");
	nav.className = "app-nav";
	nav.setAttribute("aria-label", "App navigation");
	nav.innerHTML = `
		<a href="/app/" class="app-nav-brand">
			${BRAND_MONO_SVG}
			<span class="app-nav-brand-text">
				<span class="app-nav-brand-name">Trader</span>
				<span class="app-nav-brand-sub">Prediction Market Lab</span>
			</span>
		</a>
		<ul class="app-nav-links" role="menubar">
			${NAV_LINKS.map((l) => `
				<li role="none"><a class="app-nav-link" role="menuitem" data-page="${l.page}" href="${l.href}">${l.label}</a></li>
			`).join("")}
		</ul>
		<div class="app-nav-right">
			<span class="stage-badge" id="stage-badge" data-color="warn" role="status" aria-label="Bot stage">
				<span class="stage-dot" id="stage-dot"></span>
				<span class="stage-label" id="stage-label">connecting…</span>
			</span>
			<a href="${signoutUrl()}" class="app-nav-signout" id="app-nav-signout" rel="nofollow" aria-label="Sign out of Trader">
				<svg class="app-nav-signout-icon" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
					<path fill="currentColor" d="M3 3.5A1.5 1.5 0 0 1 4.5 2h5A1.5 1.5 0 0 1 11 3.5v1a.5.5 0 0 1-1 0v-1A.5.5 0 0 0 9.5 3h-5A.5.5 0 0 0 4 3.5v9a.5.5 0 0 0 .5.5h5a.5.5 0 0 0 .5-.5v-1a.5.5 0 0 1 1 0v1A1.5 1.5 0 0 1 9.5 14h-5A1.5 1.5 0 0 1 3 12.5v-9Zm8.854 4.354a.5.5 0 0 0-.708-.708L9.793 8.5H6a.5.5 0 0 0 0 1h3.793l-1.353 1.354a.5.5 0 0 0 .708.708l2.5-2.5Z"/>
				</svg>
				<span class="app-nav-signout-label">Sign out</span>
			</a>
		</div>
	`;

	// Mark the active link from the URL path. Handle both
	// `/app/bot` and `/app/bot.html` (local file:// or static
	// server) by stripping the extension. `index` resolves to
	// "dashboard" since the dashboard lives at /app/index.html.
	const raw = window.location.pathname.replace(/\/$/, "").replace(/\.html$/, "");
	const segs = raw.split("/").filter(Boolean);
	let page = "dashboard";
	if (segs.length === 0 || (segs.length === 1 && segs[0] === "app")) {
		page = "dashboard";
	} else if (segs[segs.length - 1] === "app" || segs[segs.length - 1] === "index") {
		page = "dashboard";
	} else {
		page = segs[segs.length - 1];
	}
	const activeLink = nav.querySelector(`[data-page="${page}"]`);
	if (activeLink) activeLink.classList.add("active");

	// Inject at the top of body (before anything else so it sits
	// sticky on scroll).
	document.body.insertBefore(nav, document.body.firstChild);
}

// Default appPageInit: full refresh cycle (5s fast, 30s slow) +
// balance + verticals + cost. Sub-pages can override.
const FAST_REFRESH_MS = 5000;
const SLOW_REFRESH_MS = 30000;
const CF_REFRESH_MS = 90000;
const BALANCE_REFRESH_MS = 30000;
const COST_REFRESH_MS = 60000;
let _appTimers = [];

function startTimers(spec) {
	// spec: [{ fn, ms }, ...]
	stopTimers();
	for (const { fn, ms } of spec) {
		// initial fire
		try { fn(); } catch (_e) { /* swallow — render is best-effort */ }
		_appTimers.push(setInterval(fn, ms));
	}
}

function stopTimers() {
	for (const t of _appTimers) clearInterval(t);
	_appTimers = [];
}

window.appPageInit = window.appPageInit || function defaultAppPageInit() {
	// Default = the original single-page refresh cycle. Sub-pages
	// can override by setting `window.appPageInit = function() {...}`
	// before this file loads.
	startTimers([
		{ fn: refresh, ms: FAST_REFRESH_MS },
		{ fn: refresh, ms: SLOW_REFRESH_MS },
		{ fn: refreshBalance, ms: BALANCE_REFRESH_MS },
		{ fn: refreshVerticals, ms: 30_000 },
		{ fn: refreshCfAnalytics, ms: CF_REFRESH_MS },
		{ fn: refreshCost, ms: COST_REFRESH_MS },
	]);
};

document.addEventListener("visibilitychange", () => {
	if (document.hidden) {
		stopTimers();
	} else if (typeof window.appPageOnVisible === "function") {
		window.appPageOnVisible();
	}
});

document.addEventListener("DOMContentLoaded", () => {
	injectAppNav();
	if (typeof window.appPageInit === "function") {
		window.appPageInit();
	}
});
