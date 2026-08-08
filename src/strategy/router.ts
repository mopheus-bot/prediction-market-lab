/**
 * pm-bot — per-vertical strategy router.
 *
 * Mirrors `Prediction Market Lab/.../strategy/router.py:VerticalStrategyRouter`
 * (subset, sufficient for chunk 3).
 *
 * The router reads `ctx.market.vertical` and dispatches to the right
 * strategy. Single-strategy verticals bypass the meta-stacker.
 *
 * Default profiles (per docs/strategy.md §4.5 + the 2026-08-04 sweep):
 *   weather:  reversion-only (chunk 4 — falls back to naive for now)
 *   economic: reversion-only (chunk 4 — falls back to naive for now)
 *   politics: naive
 *   sports:   naive
 *
 * In chunk 3, the same naive strategy is plugged in for all verticals
 * because the ONNX models are not yet available. Chunk 4 swaps in the
 * per-vertical reversion model where the 2026-08-04 sweep showed it
 * wins; the router API stays the same.
 */

import type { Vertical } from "../lib/types.js";
import { NaiveSignal } from "./naive.js";
import type { Signal, SignalContext, SignalStrategy } from "./signal.js";

export type VerticalProfile = ReadonlyArray<SignalStrategy>;

const DEFAULT_PROFILES: Record<Vertical, VerticalProfile> = {
	weather: [new NaiveSignal({ name: "naive_weather" })],
	economic: [new NaiveSignal({ name: "naive_economic" })],
	politics: [new NaiveSignal({ name: "naive_politics" })],
	sports: [new NaiveSignal({ name: "naive_sports" })],
};

const DEFAULT_FALLBACK: VerticalProfile = [new NaiveSignal({ name: "naive_default" })];

export class VerticalStrategyRouter implements SignalStrategy {
	readonly name = "vertical_router";
	private readonly profiles: Record<string, VerticalProfile>;
	private readonly defaultProfile: VerticalProfile;

	constructor(
		opts: {
			profiles?: Record<string, VerticalProfile>;
			defaultProfile?: VerticalProfile;
		} = {},
	) {
		this.profiles = { ...(opts.profiles ?? DEFAULT_PROFILES) };
		this.defaultProfile = opts.defaultProfile ?? DEFAULT_FALLBACK;
	}

	profileFor(vertical: string | null | undefined): VerticalProfile {
		if (!vertical) return this.defaultProfile;
		return this.profiles[vertical] ?? this.defaultProfile;
	}

	__call(ctx: SignalContext): Signal | null {
		const vertical = ctx.market?.vertical ?? null;
		const profile = this.profileFor(vertical);
		// Single-strategy profile: direct dispatch, no stacker overhead.
		if (profile.length === 1) return profile[0].__call(ctx);
		// Multi-strategy: agreement-stacker (conservative). All firing
		// strategies must agree on `side` or we skip the trade.
		const signals: Signal[] = [];
		for (const strat of profile) {
			const sig = strat.__call(ctx);
			if (sig !== null) signals.push(sig);
		}
		if (signals.length === 0) return null;
		const firstSide = signals[0].side;
		for (const sig of signals.slice(1)) {
			if (sig.side !== firstSide) return null; // disagreement
		}
		// All agree — return the primary's signal with the stacker name
		// prepended for provenance.
		const primary = signals[0];
		return {
			...primary,
			rationale: `${profile.map((s) => s.name).join("+")}|${primary.rationale}`,
		};
	}
}
