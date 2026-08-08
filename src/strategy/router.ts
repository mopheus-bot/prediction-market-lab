/**
 * pm-bot — per-vertical strategy router (chunk 4).
 *
 * Mirrors `Prediction Market Lab/.../strategy/router.py:VerticalStrategyRouter`.
 *
 * Dispatches on `ctx.market.vertical` to per-vertical profiles.
 * Single-strategy verticals bypass the meta-stacker.
 *
 * **Default profiles (per the 2026-08-04 sweep + chunk 4):**
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
}

/**
 * Build a default profile map from a model bundle.
 */
function defaultProfiles(
	models: VerticalStrategyRouterOpts["models"],
	dev_min: number,
	p_min: number,
): Record<Vertical, VerticalProfile> {
	const profiles: Record<Vertical, VerticalProfile> = {
		weather: [new NaiveSignal({ name: "naive_weather" })],
		economic: [new NaiveSignal({ name: "naive_economic" })],
		politics: [new NaiveSignal({ name: "naive_politics" })],
		sports: [new NaiveSignal({ name: "naive_sports" })],
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
		const defaults = defaultProfiles(opts.models, dev_min, p_min);
		const merged: Record<string, VerticalProfile> = { ...defaults };
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
		// Multi-strategy: agreement stacker.
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
		const primary = signals[0];
		return {
			...primary,
			rationale: `${profile.map((s) => s.name).join("+")}|${primary.rationale}`,
		};
	}
}
