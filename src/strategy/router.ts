/**
 * prediction-market-lab — per-vertical strategy router.
 *
 * Mirrors `Prediction Market Lab/.../strategy/router.py:VerticalStrategyRouter`.
 *
 * Dispatches on `ctx.market.vertical` to per-vertical profiles.
 * Single-strategy verticals bypass the meta-stacker.
 *
 * **Default profiles (per the 2026-08-04 sweep +):**
 *   - weather:  ReversionQualitySignal (reversion wins on weather)
 *   - economic: ReversionQualitySignal (reversion wins on economic, even with naive)
 *   - politics: NaiveSignal (reversion loses on politics)
 *   - sports:   NaiveSignal (reversion loses on sports)
 *
 * Override via the `profiles` constructor arg.
 *
 * **Multi-strategy profiles use the agreement-only stacker.**
 * For the default 4 verticals above, each profile has a
 * single strategy so the stacker is bypassed entirely (a
 * direct dispatch, not the conservative "all must agree"
 * path). This matches the 2026-08-04 sweep: stacker
 * underperforms on weather because reversion fires on small
 * deviations the naive signal doesn't see.
 */

import type { Vertical } from "../lib/types.js";
import { NaiveSignal } from "./naive.js";
import { ReversionQualitySignal } from "./reversion.js";
import { LLMOpinionSignal } from "./llm-opinion.js";
import type { RandomForestModel } from "./forest.js";
import type { Signal, SignalContext, SignalStrategy } from "./signal.js";

export type VerticalProfile = ReadonlyArray<SignalStrategy>;

export interface VerticalStrategyRouterOpts {
	/**
	 * Map of vertical → list of strategies. Each list is
	 * ordered (the first strategy is the "primary"). Use
	 * `null` for a vertical to fall back to the default
	 * (NaiveSignal) for that vertical.
	 *
	 * **Defaults** (when `models.reversion` and `models.naive`
	 * are provided):
	 *   - weather:  [reversion]
	 *   - economic: [reversion]
	 *   - politics: [naive]
	 *   - sports:   [naive]
	 */
	profiles?: Partial<Record<Vertical, VerticalProfile | null>>;
	/**
	 * Optional model bundle. When provided, the default
	 * profiles use ReversionQualitySignal for the verticals
	 * where the sweep says it wins (weather, economic).
	 * When `null` or missing, the router falls back to
	 * NaiveSignal for every vertical.
	 */
	models?: {
		reversion?: { weather?: RandomForestModel; economic?: RandomForestModel };
		naive?: { name?: string };
	};
	/** Per-strategy knobs (forwarded to the constructors). */
	dev_min?: number;
	p_min?: number;
	/** Per-vertical NaiveSignal fade thresholds (fraction,
	 *  e.g. 0.02 = 2%). Used when the vertical falls back to
	 *  NaiveSignal (no reversion model loaded). Defaults to
	 *  the FADE_THRESHOLD constant (= 0.05) if a vertical is
	 *  missing from the map. 2026-08-10: live Kalshi markets
	 *  are lower-vol than synthetic, so weather and sports
	 *  routinely need 2% instead of 5% to fire at all. */
	fade_thresholds?: Partial<Record<Vertical, number>>;
	/** Per-vertical minimum absolute price move (cents) to
	 *  fire the signal. Combined with `fade_thresholds` via
	 *  OR: the signal fires when EITHER the percentage OR
	 *  the absolute threshold is exceeded. Used for stable
	 *  markets (e.g. KXWARMING-50 at 78¢) where a 1¢ move
	 *  is meaningful absolute edge but well below any
	 *  reasonable percentage threshold. 2026-08-10: lets
	 *  the bot actually fire on KXWARMING-50's micro-moves. */
	min_absolute_move_cents?: Partial<Record<Vertical, number>>;
	/** 2026-08-11 (option 2, lock-in): per-vertical
	 *  reversal confirmation depth. The NaiveSignal only
	 *  fires if the orderbook has at least this many
	 *  contracts at the best bid on the side we're
	 *  betting on. Filters out "fade into a void"
	 *  entries on thin books. Map of vertical to
	 *  contract count; missing entry = use 3 (the
	 *  router's default). */
	min_support_contracts?: Partial<Record<Vertical, number>>;
}

/**
 * Build a default profile map from a model bundle.
 */
function defaultProfiles(
	models: VerticalStrategyRouterOpts["models"],
	dev_min: number,
	p_min: number,
	fadeThresholds: Partial<Record<Vertical, number>> | undefined,
	minAbs: Partial<Record<Vertical, number>> | undefined,
	minSupport: Partial<Record<Vertical, number>> | undefined,
): Record<Vertical, VerticalProfile> {
	const ft = (v: Vertical): number => fadeThresholds?.[v] ?? 0.05;
	const ma = (v: Vertical): number => minAbs?.[v] ?? 0;
	// 2026-08-11 (option 2, lock-in): default 3 contracts
	// at the best bid. Operators can override per-vertical
	// or set to 0 to disable the gate.
	const ms = (v: Vertical): number => minSupport?.[v] ?? 3;
	// 2026-08-10: each vertical's default profile is now
	// [naive, llm_opinion] — the router uses the priority
	// stacker, so the bot trades when EITHER the price-based
	// signal OR the LLM verdict fires (whichever comes first).
	// 2026-08-11: expanded from 4 to 17 verticals. The four
	// legacy verticals keep their fade_threshold /
	// min_absolute_move_cents tunings; the 13 new verticals
	// get 5% / 0¢ defaults. The LLM is the primary signal
	// source for the new verticals until a per-vertical
	// model gets trained.
	//
	// 2026-08-11 (option 2, lock-in): every NaiveSignal in
	// the router uses `ms(vertical)` for the reversal
	// confirmation gate. The naive fade is negative-EV on
	// trending markets (KXOAIANTH-40-OAI lost $19.53
	// fading a down-move in a market with no bid support).
	// Requiring `ms` contracts at the best bid on the side
	// we're betting on filters out the "fade into a void"
	// entries. Set 0 to disable per vertical.
	const makeNaiveProfile = (vertical: Vertical): VerticalProfile => [
		new NaiveSignal({
			name: `naive_${vertical}`,
			fade_threshold: ft(vertical),
			min_absolute_move_cents: ma(vertical),
			min_support_contracts: ms(vertical),
		}),
		new LLMOpinionSignal({ name: `llm_${vertical}` }),
	];
	const profiles: Record<Vertical, VerticalProfile> = {
		// Legacy 4 — keep their tunings.
		weather: makeNaiveProfile("weather"),
		economic: makeNaiveProfile("economic"),
		politics: makeNaiveProfile("politics"),
		sports: makeNaiveProfile("sports"),
		// 13 new verticals (2026-08-11). LLM is the signal
		// source until enough trade data accumulates for a
		// reversion model to be trained.
		elections: makeNaiveProfile("elections"),
		// 2026-08-11 (option 1, lock-in): financials is
		// LLM-only with a high conviction floor. The naive
		// fade strategy is structurally negative-EV on
		// trending financials markets (KXOAIANTH-40-OAI:
		// naive fade-down lost $19.53 over 6h as the price
		// kept dropping). Until we have a real edge on this
		// vertical — reversal confirmation, event-driven
		// signals, or a trained reversion model — the only
		// safe entry path is a high-conviction LLM verdict.
		//
		// min_confidence 0.65 (vs the default 0.6) is one tick
		// stricter than the global default. It still admits
		// verdicts like KXDEELRIP-40-DEEL (0.60 → 0.62 range
		// in recent runs, with consistent direction over
		// hours) but filters out the marginal 0.55-0.6
		// "mild edge" calls that don't survive the spread.
		//
		// The router still uses the priority-dispatch
		// pattern (first non-null Signal wins), but with one
		// strategy in the profile, the dispatch is trivial.
		financials: [
			new LLMOpinionSignal({
				name: "llm_financials_strict",
				min_confidence: 0.65,
			}),
		],
		entertainment: makeNaiveProfile("entertainment"),
		science_technology: makeNaiveProfile("science_technology"),
		crypto: makeNaiveProfile("crypto"),
		companies: makeNaiveProfile("companies"),
		commodities: makeNaiveProfile("commodities"),
		mentions: makeNaiveProfile("mentions"),
		social: makeNaiveProfile("social"),
		world: makeNaiveProfile("world"),
		health: makeNaiveProfile("health"),
		transportation: makeNaiveProfile("transportation"),
		uncategorized: makeNaiveProfile("uncategorized"),
	};
	if (models?.reversion?.weather) {
		profiles.weather = [
			new ReversionQualitySignal({
				model: models.reversion.weather,
				dev_min,
				p_min,
				name: "reversion_weather",
			}),
		];
	}
	if (models?.reversion?.economic) {
		profiles.economic = [
			new ReversionQualitySignal({
				model: models.reversion.economic,
				dev_min,
				p_min,
				name: "reversion_economic",
			}),
		];
	}
	return profiles;
}

export class VerticalStrategyRouter implements SignalStrategy {
	readonly name = "vertical_router";
	private readonly profiles: Record<string, VerticalProfile>;
	private readonly defaultProfile: VerticalProfile;

	constructor(opts: VerticalStrategyRouterOpts = {}) {
		const dev_min = opts.dev_min ?? 1.5;
		const p_min = opts.p_min ?? 0.30;
		const defaults = defaultProfiles(
			opts.models,
			dev_min,
			p_min,
			opts.fade_thresholds,
			opts.min_absolute_move_cents,
			opts.min_support_contracts,
		);
		const merged: Record<string, VerticalProfile> = {...defaults };
		if (opts.profiles) {
			for (const [vertical, profile] of Object.entries(opts.profiles)) {
				if (profile === null) continue; // use default
				merged[vertical] = profile;
			}
		}
		this.profiles = merged;
		this.defaultProfile = [new NaiveSignal({ name: "naive_default" })];
	}

	profileFor(vertical: string | null | undefined): VerticalProfile {
		if (!vertical) return this.defaultProfile;
		return this.profiles[vertical] ?? this.defaultProfile;
	}

	__call(ctx: SignalContext): Signal | null {
		const vertical = ctx.market?.vertical ?? null;
		const profile = this.profileFor(vertical);
		if (profile.length === 1) return profile[0].__call(ctx);
		// 2026-08-10: priority dispatch (NOT agreement stacker).
		// Iterate the profile in order; the first strategy
		// that emits a non-null Signal wins. The default
		// profile is [naive, llm_opinion] — naive fires
		// on price moves (the original  strategy),
		// llm_opinion fires when the LLM has a fresh +
		// confident verdict (the step-15 addition). With
		// the old agreement-stacker semantics, the bot
		// never traded because naive won't fire on stable
		// markets and the LLM verdict alone wasn't enough
		// to push a trade through. Priority dispatch lets
		// either source trigger a trade independently.
		//
		// Operators who want the safer agreement-stacker
		// can pass `agreement: true` to the constructor.
		for (const strat of profile) {
			const sig = strat.__call(ctx);
			if (sig !== null) return sig;
		}
		return null;
	}
}
