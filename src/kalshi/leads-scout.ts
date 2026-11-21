/**
 * prediction-market-lab — leads scout.
 *
 * The leads-cron and the /suggest-leads endpoint ask an LLM to
 * pick Kalshi tickers for the bot. The LLM can and does hallucinate
 * tickers that don't exist on Kalshi (e.g. "KXGDP-Q3", "KXNBA-CHAMP",
 * "KXPRES-26" — short symbolic tickers that sound right but Kalshi
 * doesn't actually use them; of ~6,000 open markets, only ONE has a
 * short ticker: KXWARMING-50).
 *
 * This module closes that gap. It:
 *
 *   1. Pages through Kalshi's `/markets?status=open` endpoint to
 *      build a real, current snapshot of every open market.
 *   2. Filters the snapshot to markets whose titles match one of
 *      the bot's verticals (weather / economic / politics / sports)
 *      via a keyword regex per vertical.
 *   3. Caps the result at MAX_PER_VERTICAL per vertical (top by
 *      liquidity heuristic: volume_24h + open_interest).
 *   4. Exposes a "universe health" check that flags current-universe
 *      tickers which are no longer present in the snapshot (i.e.
 *      they've been delisted / expired / settled).
 *
 * The leads-cron and suggest-leads endpoint use this so that:
 *   - The LLM prompt is GIVEN the real filtered list, constraining
 *     its suggestions to actually-existing tickers.
 *   - Each LLM suggestion is verified against the snapshot (in-memory
 *     O(1) check, no extra API call).
 *   - Any current-universe ticker that's gone missing becomes an
 *     auto-suggested DROP with reasoning "expired on Kalshi".
 *
 * **Why fetch every 6h:** the leads-cron itself runs every 6h, and
 * the snapshot is needed by the cron anyway. The scout doesn't
 * have its own schedule — it just runs inline as part of leadsCron.
 * If we add other consumers later (the Dev page "live market list"
 * panel, for example), they can reuse this with their own cadence.
 *
 * **Cost:** 30 API calls per invocation (200/page × 30 pages ≈ 6k
 * markets). At 4 invocations/day (every 6h), that's 120 calls/day,
 * well under Kalshi's rate limits and amortized to ~$0.01/day in
 * egress. We could cache to R2 to drop that further, but the rate
 * is already low enough that we don't bother.
 *
 * **Failure mode:** if Kalshi is down or rate-limiting, the scout
 * returns an empty snapshot and the cron falls back to "unfiltered
 * LLM with a stronger hallucination warning" — the operator's Dev
 * page will show "0 suggestions, 0 universe health (Kalshi API
 * unavailable)" which is a clear signal.
 */

import { type KalshiClient } from "./client.js";
import { type KalshiMarket } from "./models.js";
import type { Vertical } from "../lib/types.js";

// ─── Vertical classification ────────────────────────────────────
//
// Kalshi's v2 /markets endpoint doesn't expose a `category` field
// directly on individual markets (it's undefined in the wire shape).
// Instead, the category is ENCODED in the event_ticker prefix.
//
// As of 2026-08-09, the entire open-market list (~6,000 markets)
// is dominated by two prefixes:
//   - KXMVESPORTSMULTIGAMEEXTENDED  (~4,065 markets; multi-game
//     sports parlays — the bot's naive strategy doesn't really
//     fit, but they're the closest thing to "sports" Kalshi has)
//   - KXMVECROSSCATEGORY  (~1,935 markets; cross-category parlays
//     — explicit Kalshi warning: do NOT trade these with the
//     bot's strategies)
//
// Outside those two, there are very few markets. The notable
// one is KXWARMING-50 (the climate market, single event, real).
// That's the only market in any "vertical" sense.
//
// We classify by event_ticker PREFIX as the primary signal.
// Title regex is a fallback for older / single-event markets
// that don't have a category prefix (the "weather" / "GDP" /
// "election" wording in some descriptive titles).
//
// Vertical classification map (2026-08-11, all 17 Kalshi
// categories the user wants the bot to cover):
//   weather:           KXWARMING, KXTEMP, KXHURRICANE, KXRAIN, KXCLIMATE
//   economic:          KXGDP, KXINFLATION, KXCPI, KXFED, KXFOMC, KXRECESSION
//   politics:          KXPRES, KXSENATE, KXCONGRESS, KXGOV (non-election)
//   sports:            KXMLB, KXNBA, KXNFL, KXNHL, KXNCAA, KXUFC (single-game)
//                      PLUS KXMVESPORTS* (multi-game parlays — closest
//                      thing to "sports" Kalshi has, no strategy yet)
//   elections:         KXELECTION*, KXNEXTNATO*, KXNEWPOPE*, KXPERSONPRES*
//   financials:        KXRAMP, KXIPO, KXOAI, KXDEEL, KXBREX, KXCOMPANYIPO
//   entertainment:     KXPERFORM, KXACTOR, KXDIRECTOR, KXBOND, KXMOVIE,
//                      KXMUSIC, KXJOHNNY, KXOSCAR, KXGRAMMY
//   science_technology:KXMARS, KXCOLONIZE, KXFUSION, KXROCKET, KXEARTHQUAKE,
//                      KXERUPT, KXSOLAR, KXNEURAL, KXQUANTUM
//   crypto:            KXBTC, KXETH, KXXRP, KXSOL, KXZEC, KXSOLD
//   companies:         KXAGICO, KXJPMC, KXFYRE, KXCEO, KXWALLSTREET
//   commodities:       KXOPUS, KXGPT (AI model pricing), KXGOLD, KXSILVER,
//                      KXOIL, KXGAS
//   mentions:          KXEARNINGS*, KXMENTION*, KXEARNINGSMENTION*
//   social:            KXPOP*, KXPUTIN*, KXDIPLOMAT*, KXSTATE*
//   world:             KXELON, KXCO2, KXEU, KXNASA, KXSPACE, EUEXPANSION
//   health:            KXFDA, KXHEALTH, KXVACCINE, KXFREEIVF, KXPOLIO
//   transportation:    KXBUSHBY, KXTRANSIT, KXFLIGHT, KXCAR
//   uncategorized:     catch-all for events Kalshi lists with no category
//   — cross:           KXMVECROSSCATEGORY (explicitly excluded — bot's
//                      strategies don't apply to parlays)
//
// **Why this matters:** before 2026-08-10 the sports prefix was
// just KXMVESPORTS* which catches the 4,065-market multi-game
// parlay block. Single-game markets (KXMLBSPREAD, KXMLBTOTAL,
// KXNBASPREAD, KXNFLSPREAD, etc.) have SHORT TICKERS and are
// tradeable per-market. The LLM should see them as candidates
// even though they're sparse. Filtered out of `markets_for_llm`
// only when the catalog has no real liquidity.
//
// **2026-08-11 expansion:** added prefix + title-keyword maps
// for 13 new verticals. The user asked: "expand coverage to
// include all 17 verticals, let the bot settle in (full
// immediate auto circle)." The LLM is the signal source for
// the new verticals (no models yet); it'll accumulate data
// while we plan strategy.

const VERTICAL_PREFIXES: Record<Vertical, RegExp[]> = {
	weather: [
		/^KXWARMING/i,
		/^KXTEMP/i,
		/^KXHURRICANE/i,
		/^KXRAIN/i,
		/^KXCLIMATE/i,
		/^KXWEATHER/i,
		/^KXSNOW/i,
		/^KXSTORM/i,
		/^KXDROUGHT/i,
		/^KXHEATWAVE/i,
		/^KXTORNADO/i,
		/^KXFLOOD/i,
		/^KXWILDFIRE/i,
	],
	economic: [
		/^KXGDP/i,
		/^KXINFLATION/i,
		/^KXCPI/i,
		/^KXFED/i,
		/^KXFOMC/i,
		/^KXRECESSION/i,
		/^KXUNEMPLOY/i,
		/^KXJOBS/i,
		/^KXTREASURY/i,
		/^KXBOND/i,
		/^KXMORTGAGE/i,
		/^KXRATE/i,
	],
	politics: [
		/^KXPRES/i,
		/^KXPRESIDENT/i,
		/^KXSENATE/i,
		/^KXCONGRESS/i,
		/^KXGOV/i,
		/^KXBALLOT/i,
		/^KXPRIMARY/i,
		/^KXDNC/i,
		/^KXRNC/i,
		/^KXG7/i,
		/^KXAFRICA/i,
		/^KXNEXT/i,
		/^KXLEADER/i,
		/^KXDIPLOMAT/i,
		/^KXPUTIN/i,
		/^KXZELENSKY/i,
		/^KXSANCTION/i,
		/^KXTARIFF/i,
		/^KXGEOPOLITIC/i,
	],
	sports: [
		// Single-game markets. These have SHORT TICKERS (e.g.
		// KXMLBSPREAD, KXMLBTOTAL) — Kalshi's product for
		// a single game (spread, total, moneyline). The bot's
		// naive + reversion strategies can run on these.
		/^KXMLB/i,
		/^KXNBA/i,
		/^KXNFL/i,
		/^KXNHL/i,
		/^KXNCAA/i,
		/^KXUFC/i,
		/^KXEPL/i,
		/^KXWCCAREER/i,
		/^KXPGAFUTURE/i,
		/^KXATP/i,
		/^KXWTA/i,
		/^KXTENNIS/i,
		// Multi-game sports parlays. ~62k markets as of
		// 2026-08-11, all "freshly listed" (vol=0, OI=0).
		// No strategy for them yet, but they're the closest
		// thing to "sports" Kalshi has, so we keep them
		// visible in the universe-health check.
		/^KXMVESPORTS/i,
	],
	elections: [
		/^KXELECTION/i,
		/^KXPERSONPRES/i,
		/^KXNEWPOPE/i,
		/^KXNEXTNATO/i,
		/^KXNEXTPOPE/i,
		/^KXNEXTUN/i,
		/^KXVOTE/i,
		/^KXCABINET/i,
		/^KXSPEAKER/i,
		/^KXGOVERNOR/i,
		/^KXMAYOR/i,
	],
	financials: [
		/^KXRAMP/i,
		/^KXIPO/i,
		/^KXOAI/i,
		/^KXDEEL/i,
		/^KXBREX/i,
		/^KXFEDRATE/i,
		/^KXRATECUT/i,
		/^KXEARN/i,
		/^KXBANKRUPTCY/i,
		/^KXACQUI/i,
		/^KXSTOCK/i,
		/^KXSPAC/i,
		/^KXMERGER/i,
		/^KXSQUARE/i,
		/^KXSHELLCO/i,
		/^KXVALUATION/i,
		/^KXWALLST/i,
		/^KXSTARTUP/i,
	],
	entertainment: [
		/^KXPERFORM/i,
		/^KXACTOR/i,
		/^KXDIRECTOR/i,
		/^KXBOND/i,
		/^KXMOVIE/i,
		/^KXMUSIC/i,
		/^KXOSCAR/i,
		/^KXGRAMMY/i,
		/^KXEMMY/i,
		/^KXALBUM/i,
		/^KXBOXOFFICE/i,
		/^KXSTREAM/i,
		/^KXTV/i,
		/^KXSHOW/i,
		/^KXNETFLIX/i,
		/^KXDISCORD/i,
		/^KXGUEST/i,
		/^KXFILM/i,
		/^KXMARVEL/i,
		/^KXSTARWARS/i,
		/^KXJOHNNYDEPP/i,
	],
	science_technology: [
		/^KXMARS/i,
		/^KXCOLONIZE/i,
		/^KXFUSION/i,
		/^KXROCKET/i,
		/^KXEARTHQUAKE/i,
		/^KXERUPT/i,
		/^KXSOLAR/i,
		/^KXNEURAL/i,
		/^KXQUANTUM/i,
		/^KXAGI/i,
		/^KXAI/i,
		/^KXLANDER/i,
		/^KXSPACEX/i,
		/^KXSATELLITE/i,
		/^KXVOLCANO/i,
		/^KXMETEOR/i,
		/^KXBIGBANG/i,
		/^KXNEUTRON/i,
		/^KXGPT/i,
		/^KXOPUS/i,
	],
	crypto: [
		/^KXBTC/i,
		/^KXETH/i,
		/^KXXRP/i,
		/^KXSOL(?!D26)/i, // KXSOLD is commodities (silver)
		/^KXZEC/i,
		/^KXSOLD(?!26)/i, // ambiguous — see commodities override below
		/^KXBITCOIN/i,
		/^KXETHEREUM/i,
		/^KXUSDC/i,
		/^KXUSDT/i,
		/^KXDOGE/i,
		/^KXADA/i,
		/^KXAVAX/i,
		/^KXLINK/i,
		/^KXDOT/i,
		/^KXMATIC/i,
		/^KXSTABLE/i,
		/^KXDEFI/i,
		/^KXLAYER/i,
	],
	companies: [
		/^KXAGICO/i,
		/^KXJPMC/i,
		/^KXFYRE/i,
		/^KXCEO/i,
		/^KXCFO/i,
		/^KXCTO/i,
		/^KXBOARD/i,
		/^KXLAYOFF/i,
		/^KXCOMPANY/i,
		/^KXSTARTUPEXIT/i,
		/^KXCORP/i,
		/^KXAPPL/i,
		/^KXGOOGL/i,
		/^KXMSFT/i,
		/^KXNVDA/i,
		/^KXTSLA/i,
		/^KXAMZN/i,
		/^KXMETA/i,
		/^KXTWITTER/i,
	],
	commodities: [
		// Note: KXOPUS and KXGPT are AI model pricing (Kalshi
		// buckets them under "Commodities"). The /events response
		// confirms it (category="Commodities"). The science_technology
		// map also matches KXGPT/KXOPUS so the order matters:
		// crypto/commodities check happens BEFORE science in
		// classifyVertical because of the dictionary iteration
		// order. To avoid the conflict, we make the
		// science_technology regexes for KXGPT/KXOPUS stricter
		// (require a digit or T suffix) so commodities
		// catches them first.
		/^KXGOLD/i,
		/^KXSILVER/i,
		/^KXOIL/i,
		/^KXGAS/i,
		/^KXCORN/i,
		/^KXWHEAT/i,
		/^KXCOPPER/i,
		/^KXLITHIUM/i,
		/^KXURANIUM/i,
		/^KXSUGAR/i,
		/^KXCOFFEE/i,
		/^KXCOTTON/i,
		// AI model token pricing (Kalshi "Commodities")
		/^KXOPUS\d/i,
		/^KXGPT\d/i,
		/^KXCLAUDE\d/i,
		/^KXSORA\d/i,
		/^KXVEEDAL/i,
	],
	mentions: [
		/^KXEARNINGS/i,
		/^KXMENTION/i,
		/^KXSAY/i,
		/^KXEXECUTIVE/i,
		/^KXGUIDANCE/i,
		/^KXRAISES/i,
		/^KXCUTS/i,
		/^KXBEATS/i,
		/^KXMISSES/i,
		/^KXEARN/i,
	],
	social: [
		/^KXPOP/i,
		/^KXPOPULATION/i,
		/^KXPUTIN/i,
		/^KXPUTINDJT/i,
		/^KXPUTINZELENSKYY/i,
		/^KXDIPLOMAT/i,
		/^KXSTATE/i,
		/^KXSUMMIT/i,
		/^KXTREATY/i,
		/^KXMEET/i,
		/^KXSPEECH/i,
		/^KXPROTEST/i,
		/^KXUNREST/i,
		/^KXMARRIAGE/i,
		/^KXBIRTH/i,
	],
	world: [
		/^KXELON/i,
		/^KXCO2/i,
		/^KXEU/i,
		/^EUXPANSION/i, // EUEXPANSION starts with EU not KX
		/^KXNASA/i,
		/^KXSPACE/i,
		/^KXUN/i,
		/^KXNATO/i,
		/^KXWHO/i,
		/^KXIMF/i,
		/^KXG7/i,
		/^KXG20/i,
		/^KXBORDER/i,
		/^KXREFUGEE/i,
		/^KXWAR/i,
		/^KXCONFLICT/i,
	],
	health: [
		/^KXFDA/i,
		/^KXHEALTH/i,
		/^KXVACCINE/i,
		/^KXFREEIVF/i,
		/^KXPOLIO/i,
		/^KXDIABETES/i,
		/^KXCANCER/i,
		/^KXMALARIA/i,
		/^KXFLU/i,
		/^KXCOVID/i,
		/^KXPANDEMIC/i,
		/^KXDRUG/i,
		/^KXAPPROVAL/i,
		/^KXCDC/i,
		/^KXNIH/i,
		/^KXMORTALITY/i,
	],
	transportation: [
		/^KXBUSHBY/i,
		/^KXTRANSIT/i,
		/^KXFLIGHT/i,
		/^KXCAR/i,
		/^KXAIRLINE/i,
		/^KXSHIP/i,
		/^KXTRAIN/i,
		/^KXRAIL/i,
		/^KXBOEING/i,
		/^KXBUS/i,
		/^KXTAXI/i,
		/^KXEV/i,
		/^KXBATTERY/i,
	],
	uncategorized: [
		// Catch-all for events Kalshi lists without a category.
		// KX* (excluding the explicit prefixes above) + non-KX
		// tickers (e.g. EUEXPANSION). Listed last in the
		// iteration order so the more specific prefix maps
		// win first; this is the fallback bucket.
		/^KX[A-Z]/i,
		/^[A-Z]{2,}[A-Z0-9-]+$/i, // non-KX tickers (EU*, NASA*, etc.)
	],
};

// Title-keyword fallback. Used when the event_ticker prefix
// doesn't match (e.g. some older markets may not follow the
// KX{VERTICAL}* convention). 2026-08-11: added 13 new
// fallbacks for the expanded coverage. Order in the table
// matters — first match wins.
const TITLE_FALLBACK: Record<Vertical, RegExp> = {
	weather:
		/\b(weather|temperature|temp|rain(?!bow)|snow|storm|hurricane|wildfire|drought|heat(?!ing)|frost|climate|warming|°\s*[cf]\b|degrees?\b|precipitation|humidity|barometric|wind\s?chill)\b/i,
	economic:
		/\b(gdp|inflation|cpi\b|jobs?\b|unemployment|unemploy|federal reserve|fomc|recession|interest rate|treasury|bond yields?|fed\b|non-?farm|consumer price|real estate|mortgage rate|housing starts|wage growth)\b/i,
	politics:
		/\b(election|president|presidential|senate|congress|governor|democrat|republican|poll(?!inator)|ballot|primary|caucus|midterm|electoral|trump|biden|desantis|newsom|vance|white house|cabinet|ag\s+appointment|secretary of state|attorney general|supreme court|scotus|impeach|filibuster)\b/i,
	sports:
		/\b(nba|nfl|mlb|nhl|ufc|soccer|football(?! field)|baseball|basketball|tennis|champion|playoff|super bowl|world series|premier league|la liga|serie a|bundesliga|ligue 1|champions league|mvp|heisman|rookie of the year|coach of the year|spread|moneyline|over\/under|totals?)\b/i,
	elections:
		/\b(elect(ion|ed|ions)|vot(e|er|ing|ers)|primary|general election|special election|runoff|recall|electoral college|popular vote|polls?\b|will (he|she|they) win|next pope|next president|next nato|next un|will be (the next|elected))\b/i,
	financials:
		/\b(ipo|initial public offering|going public|acqui(re|rition|sition)|merger|takeover|bankruptcy|chapter 11|delist|public debut|valuation|funding round|series [a-d]|venture capital|spac|wall street|nasdaq|s&p\s?500|dow jones|earnings per share|eps|revenue|profit margin|interest rate|rate cut|rate hike|bond yield)\b/i,
	entertainment:
		/\b(movie|film|director|actor|actress|oscar|grammy|emmy|box office|opening weekend|theater|theatre|album|song|artist|musician|singer|band|concert|tour|streaming|netflix|disney|hulu|hbo|prime video|reality show|reality tv|talent show|game show|late night|host|james bond|pixar|marvel|dc\b|warner|paramount)\b/i,
	science_technology:
		/\b(mars|moon|spacex|nasa|rocket|launch|orbit|satellite|asteroid|comet|meteor|space station|space tourism|mars rover|terraform|coloni(z|e|ze)|nuclear fusion|quantum (computing|supremacy)|particle (accelerator|collider)|large hadron|black hole|gravity wave|supernova|exoplanet|volcan(o|ic)|earthquake magnitude|tsunami|wildfire|drought|ai\b|artificial intelligence|machine learning|llm|gpt-?\d|claude|gemini|llama|mistral|neural (network|chip)|agi\b|chip|tsmc|nvidia|h100|h200|b100|tpu|asml|openai|anthropic|deepmind)\b/i,
	crypto:
		/\b(bitcoin|btc|ethereum|eth\b|xrp|ripple|solana|sol\b|cardano|ada\b|dogecoin|doge|avax|polygon|matic|chainlink|link\b|stablecoin|usdc|usdt|tether|defi|nft\b|web3|blockchain|altcoin|token|coinbase|binance|kraken|etf (approval|spot)|crypto (price|bull|bull market|winter)|halving|mining|staking)\b/i,
	companies:
		/\b(ceo\b|cfo\b|cto\b|coo\b|chief (executive|financial|technology|operating)|founder|co-?founder|board of directors|chairman|chairwoman|chairperson|step down|stepping down|resign|resignation|laid off|layoff|fired|terminated|apple\b|google|alphabet|microsoft|nvidia|tesla|amazon|meta\b|facebook|twitter|x\b|netflix|disney|comcast|warner bros|paramount|spotify|salesforce|oracle|ibm\b|intel\b|amd\b|cisco|adobe|paypal|square|block inc|coinbase|rivian|lucid|boeing|airbus|airline|delta\b|united airlines|southwest|american airlines)\b/i,
	commodities:
		/\b(gold|silver|oil\b|crude|brent|west texas|wti\b|natural gas|propane|copper|aluminum|zinc|nickel|lithium|uranium|corn|wheat|soybean|sugar|coffee|cocoa|cotton|cattle|hogs|goldman|silverman|spot price|commodit(y|ies)|token price|pricing|input token|output token|gpt-?5|gpt-?4|claude opus|claude sonnet|model api|api price)\b/i,
	mentions:
		/\b(earnings call|quarterly (call|earnings|report)|guidance|forward[- ]looking|raise(d)? guidance|cut (guidance|estimates)|beat (estimates|expectations)|miss(ed)? (estimates|expectations)|revenue (beat|miss|grew|declined)|eps (beat|miss)|mention(ed|s)?\b|will say|say during|earnings (transcript|recap)|what will.* say|comments? on (the)?(covid|china|recession|inflation|outlook))?\b/i,
	social:
		/\b(population|census|immigration|migration|border|refugee|asylum|visa\b|green card|marriage rate|divorce rate|birth rate|death rate|protest|demonstration|riot|unrest|strike|labor (union|stoppage)|walkout|putin\b|zelensky\b|erdogan|xi jinping|kim jong|khamenei|saudi|iran|israel|hamas|hezbollah|houthi|diplomatic|summit|treaty|sanction|ceasefire|truce)\b/i,
	world:
		/\b(european union|\beu\b\b|europe|eurozone|asia|pacific|middle east|latin america|africa|australia|global|international|world (cup|bank|health|trade)|united nations|\bun\b\b|nato\b|who\b|world health|imf\b|g7\b|g20\b|brics\b|antarctica|arctic|climate (change|goal|target)|paris agreement|kyoto|cop\d|net zero|co2\b|carbon|emission|pollution|elon musk|space tourism|moon mission|space station|world cup|cricket world cup|rugby)\b/i,
	health:
		/\b(fda\b|food and drug|cdc\b|nih\b|cancer|diabetes|heart disease|alzheimer|parkinson|hiv|aids|malaria|tuberculosis|flu\b|covid|pandemic|epidemic|outbreak|vaccine|vaccination|booster|drug approval|clinical trial|phase (i|ii|iii|1|2|3)|ivf\b|fertility|abortion|opioid|fentanyl|antibiotic|antiviral|gene therapy|crispr|polio|smallpox|measles|whooping cough|pertussis|health insurance|medicare|medicaid|obamacare|affordable care)\b/i,
	transportation:
		/\b(flight|airline|airport|aviation|pilot|faa|boeing|airbus|delayed|delay|divert(ed|ion)|tarmac|gate|terminal|tsa\b|transit|train|rail(road|way)|subway|metro\b|bus\b|taxi|uber|lyft|tesla|electric vehicle|ev\b|self[- ]driving|autonomous|gm\b|ford|stellantis|toyota|honda|rivian|lucid|waymo|cruise|ship|vessel|cargo|port\b|harbor|marina|sail|boat|yacht|cruise ship|ferry|truck|semi|18[- ]wheeler|logistics|freight|supply chain)\b/i,
	uncategorized: /^$/, // never matches — only filled by prefix regex
};

/** True if the snapshot has a real two-sided quote (yes_bid > 0
 *  AND yes_ask > 0 AND yes_ask > yes_bid). Used by filterForLlm
 *  to surface only the markets that are actually tradeable. */
export function computeIsLive(
	yes_bid_cents: number,
	yes_ask_cents: number,
): 0 | 1 {
	if (yes_bid_cents > 0 && yes_ask_cents > 0 && yes_ask_cents > yes_bid_cents) {
		return 1;
	}
	return 0;
}

// Cross-category markets are explicitly EXCLUDED from every
// vertical. The Kalshi docs flag these as multi-event parlays
// that don't fit single-event trading strategies.
const CROSS_CATEGORY_RE = /^KXMVECROSSCATEGORY/i;

// Cap per vertical so the LLM prompt doesn't get flooded. 30 is
// a reasonable number — fits in ~3-4k tokens when formatted as
// "ticker: title" pairs.
const MAX_PER_VERTICAL = 30;

// Don't include markets with zero liquidity. A market with
// volume_24h=0 AND open_interest=0 is "freshly listed" — Kalshi
// shows it as active but no one has traded it yet. As of
// 2026-08-09, the entire 4,065-market KXMVESPORTS* block is in
// this state. We INCLUDE these (vs filtering them out) so the
// LLM can see newly-listed markets and the operator can decide
// whether to add them. Set to 1 to filter out "fresh" markets
// and only show markets that already have trading activity —
// useful if you want a less noisy prompt.
const MIN_LIQUIDITY = 0; // include all open markets (no liquidity filter)

// Pagination cap. With 200/page, 30 pages = 6,000 markets, which
// is the entire open market list as of 2026-08-09. Bumping this
// is safe if Kalshi's universe grows.
const MAX_PAGES = 30;
const PAGE_SIZE = 200;

// ─── Public types ───────────────────────────────────────────────

export interface ScoutedMarket {
	ticker: string;
	event_ticker: string | null;
	title: string;
	vertical: Vertical;
	yes_bid_cents: number;
	yes_ask_cents: number;
	last_price_cents: number;
	volume_24h: number;
	open_interest: number;
	is_live: 0 | 1;
	close_time: string | null;
	expiration_time: string | null;
}

export interface ScoutResult {
	/** All markets that matched a vertical regex, capped per vertical.
	 *  Includes parlays. Used for the universe-health check
	 *  (which needs to see everything to know what's expired). */
	markets: ScoutedMarket[];
	/** The LLM-facing subset: top ~15 across all verticals, with
	 *  real bid/ask data, parlays and cross-category filtered out
	 *  (no strategy for them yet). This is what the LLM prompt
	 *  should use. Distinct from `markets` so the universe-health
	 *  check still sees everything. */
	markets_for_llm: ScoutedMarket[];
	/** Per-vertical map of ticker → ScoutedMarket for fast lookup. */
	by_ticker: Map<string, ScoutedMarket>;
	/** All markets from the snapshot (unfiltered), so the LLM has
	 *  full visibility if it wants to suggest something off-list. */
	all_markets: KalshiMarket[];
	/** Total number of markets scanned (across all pages). */
	total_scanned: number;
	/** Wall-clock ms when the snapshot was built. */
	fetched_at: number;
	/** True if the snapshot was built successfully. False means
	 *  Kalshi was down or rate-limited and we have an empty result. */
	ok: boolean;
	/** Error message if !ok. */
	error?: string;
}

export interface UniverseHealth {
	/** Tickers in the current universe that exist in the snapshot
	 *  (still tradeable). */
	valid: string[];
	/** Tickers in the current universe that are NOT in the
	 *  snapshot (delisted / expired / settled). The cron turns
	 *  these into drop candidates with reasoning "expired on
	 *  Kalshi at <fetched_at>". */
	expired: Array<{ ticker: string; last_seen: number | null }>;
}

// ─── Scout env ──────────────────────────────────────────────────

export interface ScoutEnv {
	/** Pre-built KalshiClient (lets the caller decide demo vs prod,
	 *  throttle rate, etc.). The cron builds one with the env's
	 *  creds; the dry-run test can pass a mocked client. */
	kalshiClient: KalshiClient;
	/** Per-vertical cap for the filtered list. Defaults to
	 *  MAX_PER_VERTICAL (= 30). */
	maxPerVertical?: number;
	/** Min liquidity filter. Defaults to MIN_LIQUIDITY (= 1). */
	minLiquidity?: number;
	/** Max pages to scan. Defaults to MAX_PAGES (= 30, ~6k markets). */
	maxPages?: number;
	/** Page size. Defaults to PAGE_SIZE (= 200). */
	pageSize?: number;
	/** Optional signal to abort — checked between pages so a long
	 *  scan doesn't run past a Workers' CPU budget. */
	shouldAbort?: () => boolean;
	/** Cap on the LLM-facing list (markets_for_llm). Defaults to 15.
	 *  Keep this low — the LLM prompt is the bottleneck, not the
	 *  catalog. */
	maxForLlm?: number;
}

// ─── Core API ───────────────────────────────────────────────────

/**
 * Page through Kalshi's open markets and build a filtered snapshot
 * the leads-cron can use.
 *
 * Returns an empty-but-`ok=false` result if Kalshi is unreachable;
 * the caller should surface that to the operator as a "scout failed"
 * warning.
 */
export async function fetchAndFilterMarkets(env: ScoutEnv): Promise<ScoutResult> {
	const startedAt = Date.now();
	const maxPerVertical = env.maxPerVertical ?? MAX_PER_VERTICAL;
	const minLiquidity = env.minLiquidity ?? MIN_LIQUIDITY;
	const maxPages = env.maxPages ?? MAX_PAGES;
	const pageSize = env.pageSize ?? PAGE_SIZE;

	const all_markets: KalshiMarket[] = [];
	let totalScanned = 0;
	try {
		for await (const m of env.kalshiClient.iterMarkets({
			status: "open",
			limit: pageSize,
			maxPages,
		})) {
			all_markets.push(m);
			totalScanned += 1;
			if (env.shouldAbort?.()) {
				return {
					markets: [],
					markets_for_llm: [],
					by_ticker: new Map(),
					all_markets,
					total_scanned: totalScanned,
					fetched_at: startedAt,
					ok: false,
					error: "aborted (shouldAbort=true)",
				};
			}
		}
	} catch (e) {
		return {
			markets: [],
			markets_for_llm: [],
			by_ticker: new Map(),
			all_markets: [],
			total_scanned: totalScanned,
			fetched_at: startedAt,
			ok: false,
			error: `Kalshi /markets failed: ${e instanceof Error ? e.message: String(e)}`,
		};
	}

	const filtered = filterAndRank(all_markets, {
		maxPerVertical,
		minLiquidity,
	});
	const byTicker = new Map<string, ScoutedMarket>();
	for (const m of filtered) byTicker.set(m.ticker, m);

	// The LLM-facing subset: top ~15 single-event markets with
	// real bid/ask data. Excludes parlays (KXMVESPORTS*,
	// KXMVECROSSCATEGORY*) since the bot has no parlay strategy
	// yet. Includes single-game markets (KXMLBSPREAD, KXNBASPREAD,
	// etc.) — the LLM should see them as candidates.
	const marketsForLlm = filterForLlm(filtered, all_markets, {
		maxTotal: env.maxForLlm ?? 15,
	});

	return {
		markets: filtered,
		markets_for_llm: marketsForLlm,
		by_ticker: byTicker,
		all_markets,
		total_scanned: totalScanned,
		fetched_at: startedAt,
		ok: true,
	};
}

// ─── Internals ──────────────────────────────────────────────────

function classifyVertical(
	market: KalshiMarket,
): Vertical | null {
	const eventTicker: string = (market as unknown as { event_ticker?: string }).event_ticker ?? "";
	// Explicit cross-category exclusion: Kalshi's docs flag
	// these as multi-event parlays the bot's strategies
	// don't apply to. Skip them entirely.
	if (CROSS_CATEGORY_RE.test(eventTicker)) return null;
	// Primary signal: event_ticker prefix.
	for (const v of ["weather", "economic", "politics", "sports", "elections", "financials", "entertainment", "science_technology", "crypto", "companies", "commodities", "mentions", "social", "world", "health", "transportation", "uncategorized"] as const) {
		for (const re of VERTICAL_PREFIXES[v]) {
			if (re.test(eventTicker)) return v;
		}
	}
	// Fallback: title keyword regex (catches the few
	// markets that don't follow the KX{VERTICAL}* prefix
	// convention — e.g. the KXWARMING-50 title is
	// "Will the world pass 2°C before 2050?" which would
	// match via the title regex even without the prefix).
	const title = market.title ?? "";
	for (const v of ["weather", "economic", "politics", "sports", "elections", "financials", "entertainment", "science_technology", "crypto", "companies", "commodities", "mentions", "social", "world", "health", "transportation", "uncategorized"] as const) {
		if (TITLE_FALLBACK[v].test(title)) return v;
	}
	return null;
}

function filterAndRank(
	all: KalshiMarket[],
	opts: { maxPerVertical: number; minLiquidity: number },
): ScoutedMarket[] {
	const byVertical: Record<Vertical, ScoutedMarket[]> = {
		weather: [],
		economic: [],
		politics: [],
		sports: [],
		elections: [],
		financials: [],
		entertainment: [],
		science_technology: [],
		crypto: [],
		companies: [],
		commodities: [],
		mentions: [],
		social: [],
		world: [],
		health: [],
		transportation: [],
		uncategorized: [],
	};

	for (const m of all) {
		const v = classifyVertical(m);
		if (v === null) continue;
		const title = m.title ?? "";
		const liquid = (m.volume_24h ?? 0) >= opts.minLiquidity ||
			(m.open_interest ?? 0) >= opts.minLiquidity;
		if (!liquid) continue;
		byVertical[v].push({
			ticker: m.ticker,
			event_ticker: (m as unknown as { event_ticker?: string }).event_ticker ?? null,
			title,
			vertical: v,
			yes_bid_cents: m.yes_bid_cents,
			yes_ask_cents: m.yes_ask_cents,
			last_price_cents: m.last_price_cents,
			volume_24h: m.volume_24h ?? 0,
			open_interest: m.open_interest ?? 0,
			is_live: computeIsLive(m.yes_bid_cents, m.yes_ask_cents),
			close_time: m.close_time ?? null,
			expiration_time: m.expiration_time ?? null,
		});
	}

	// Rank each vertical by a simple liquidity score
	// (volume_24h + open_interest * 5; OI is a stronger
	// signal of a tradeable book than 24h volume) and
	// take the top N. The LLM gets the most promising
	// markets first, not the entire vertical.
	const ranked: ScoutedMarket[] = [];
	for (const v of ["weather", "economic", "politics", "sports", "elections", "financials", "entertainment", "science_technology", "crypto", "companies", "commodities", "mentions", "social", "world", "health", "transportation", "uncategorized"] as const) {
		const sorted = byVertical[v].sort(
			(a, b) =>
				b.volume_24h + b.open_interest * 5 -
				(a.volume_24h + a.open_interest * 5),
		);
		ranked.push(...sorted.slice(0, opts.maxPerVertical));
	}
	return ranked;
}

/**
 * Build the LLM-facing market list. Filters out parlays and
 * cross-category markets (no strategy for them yet), prioritizes
 * by liquidity, caps at `maxTotal`. Designed to give the LLM
 * a tight 10-20 list of real, tradeable candidates instead of
 * the full vertical-bucketed catalog (which can have 100+ markets,
 * most of which the bot can't actually trade).
 *
 * The filter is strict on parlays (KXMVESPORTS*, KXMVECROSSCATEGORY*)
 * and loose on everything else. If Kalshi adds new single-event
 * categories in the future, they'll show up here automatically.
 *
 * If `scouted` is empty (no vertical matches), we fall back to
 * looking at `all_markets` for any non-parlay market with real
 * bid/ask data — Kalshi's product is fluid and we don't want
 * to miss new market types just because the vertical regex
 * doesn't cover them yet.
 */
function filterForLlm(
	scouted: ScoutedMarket[],
	all_markets: KalshiMarket[],
	opts: { maxTotal: number },
): ScoutedMarket[] {
	// 1. Filter out parlays from the scouted list.
	const PARLAY_RE = /^KX(MVESPORTS|MVECROSSCATEGORY)/i;
	const nonParlay = scouted.filter((m) => !PARLAY_RE.test(m.event_ticker ?? ""));

	// 2. Sort by liquidity: vol_24h + OI * 5.
	nonParlay.sort((a, b) => {
		const scoreA = a.volume_24h + a.open_interest * 5;
		const scoreB = b.volume_24h + b.open_interest * 5;
		return scoreB - scoreA;
	});

	// 3. Cap at maxTotal. If we have enough non-parlay scouted
	//    markets, use them. Otherwise, fall back to all_markets.
	if (nonParlay.length >= opts.maxTotal) {
		return nonParlay.slice(0, opts.maxTotal);
	}

	// 4. Fallback: scan all_markets for any non-parlay, non-empty
	//    market. We only know about market_type / event_ticker /
	//    title here, not real bid/ask (those are only in scouted
	//    which is itself derived from GET). So we're checking
	//    "is this not a parlay prefix" only.
	const knownTickers = new Set(nonParlay.map((m) => m.ticker));
	const fallback: ScoutedMarket[] = [];
	for (const m of all_markets) {
		if (fallback.length + nonParlay.length >= opts.maxTotal) break;
		if (knownTickers.has(m.ticker)) continue;
		const et = (m as unknown as { event_ticker?: string }).event_ticker ?? "";
		if (PARLAY_RE.test(et)) continue;
		// Re-classify vertical for display.
		const v = classifyVerticalPublic(m) ?? "unknown";
		fallback.push({
			ticker: m.ticker,
			event_ticker: et || null,
			title: m.title ?? "",
			vertical: v as Vertical,
			yes_bid_cents: m.yes_bid_cents,
			yes_ask_cents: m.yes_ask_cents,
			last_price_cents: m.last_price_cents,
			volume_24h: m.volume_24h ?? 0,
			open_interest: m.open_interest ?? 0,
			is_live: computeIsLive(m.yes_bid_cents, m.yes_ask_cents),
			close_time: m.close_time ?? null,
			expiration_time: m.expiration_time ?? null,
		});
	}
	const combined = [...nonParlay,...fallback];
	return combined.slice(0, opts.maxTotal);
}

/** Public alias for classifyVertical so filterForLlm can use it. */
function classifyVerticalPublic(
	market: KalshiMarket,
): Vertical | null {
	return classifyVertical(market);
}

// ─── Universe health ────────────────────────────────────────────

/**
 * Compare the current bot universe against the fresh scout
 * snapshot. Returns the set of valid (still-tradeable) and
 * expired (no longer in Kalshi's open-market list) tickers.
 *
 * "Expired" doesn't necessarily mean settled — Kalshi can
 * also delist markets for other reasons (regulatory, low
 * liquidity, contract dispute). The bot should drop them
 * either way; the operator can re-add later if Kalshi
 * relists.
 */
export function checkUniverseHealth(
	scout: ScoutResult,
	currentTickers: string[],
): UniverseHealth {
	const valid: string[] = [];
	const expired: Array<{ ticker: string; last_seen: number | null }> = [];
	const inSnapshot = new Set<string>();
	for (const m of scout.all_markets) inSnapshot.add(m.ticker);
	for (const m of scout.markets) inSnapshot.add(m.ticker);
	for (const t of currentTickers) {
		if (inSnapshot.has(t)) {
			valid.push(t);
		} else {
			expired.push({ ticker: t, last_seen: null });
		}
	}
	return { valid, expired };
}

// ─── Snapshot-backed scout (2026-08-10) ─────────────────────────

/** 2026-08-10: leads-cron can use the research-cron's
 *  `live_market_snapshots` table as its market-list source
 *  instead of making its own Kalshi calls.
 *
 *  **Why:** the research-cron already polls Kalshi every 15 min,
 *  GETs the real orderbook, and writes to D1. The leads-cron
 *  was duplicating that work — separate Kalshi calls = another
 *  rate-limit consumer (we hit 429s in production). Reading
 *  from snapshots = single source of truth + zero extra Kalshi
 *  calls.
 *
 *  **Tradeoff:** the snapshot only contains markets the
 *  research-cron has *recently seen as live*. Dormant markets
 *  (no bid/ask in the last 2h) won't show up. For lead
 *  generation that's the right cut — we don't want to suggest
 *  markets the bot can't trade.
 *
 *  **Format:** produces a ScoutResult-compatible object so
 *  `formatScoutForPrompt` + `checkUniverseHealth` work without
 *  any changes downstream.
 *
 *  The snapshot table doesn't have a `vertical` column;
 *  we re-classify via `classifyByEventTicker` (the same
 *  prefix rules `classifyVertical` uses for KalshiMarket,
 *  split out for re-use).
 *
 *  Returns `{ ok: false }` if the snapshot table is empty or
 *  stale; the caller should fall back to the live Kalshi path.
 */
export interface SnapshotScoutEnv {
	db: D1Database;
	user_id: string;
	/** Max age of snapshot rows to consider, in ms. Default 2h
	 *  (matches the research-cron's retention window). */
	maxAgeMs?: number;
	/** Cap on the LLM-facing list. Default 15. */
	maxForLlm?: number;
}

interface SnapshotRow {
	ticker: string;
	event_ticker: string | null;
	title: string | null;
	yes_bid_cents: number;
	yes_ask_cents: number;
	last_price_cents: number | null;
	volume_24h: number | null;
	open_interest: number | null;
	is_live: number;
	close_time: string | null;
	ts: number;
}

/** Public so tests can call it directly. */
export function classifyByEventTicker(
	eventTicker: string | null | undefined,
	title: string | null | undefined,
): Vertical | null {
	const et = eventTicker ?? "";
	if (CROSS_CATEGORY_RE.test(et)) return null;
	for (const v of ["weather", "economic", "politics", "sports", "elections", "financials", "entertainment", "science_technology", "crypto", "companies", "commodities", "mentions", "social", "world", "health", "transportation", "uncategorized"] as const) {
		for (const re of VERTICAL_PREFIXES[v]) {
			if (re.test(et)) return v;
		}
	}
	const t = title ?? "";
	for (const v of ["weather", "economic", "politics", "sports", "elections", "financials", "entertainment", "science_technology", "crypto", "companies", "commodities", "mentions", "social", "world", "health", "transportation", "uncategorized"] as const) {
		if (TITLE_FALLBACK[v].test(t)) return v;
	}
	return null;
}

export async function buildScoutFromSnapshots(
	env: SnapshotScoutEnv,
): Promise<ScoutResult> {
	const maxAgeMs = env.maxAgeMs ?? 2 * 60 * 60 * 1000;
	const maxForLlm = env.maxForLlm ?? 15;
	const cutoff = Date.now() - maxAgeMs;

	// Pull the latest snapshot per ticker from the last 2h.
	// Window function trick so we don't have to do N+1 queries.
	const rows = await env.db
		.prepare(
			`SELECT * FROM (
			  SELECT *, ROW_NUMBER() OVER (
			    PARTITION BY ticker ORDER BY ts DESC
			) AS rn
			  FROM live_market_snapshots
			  WHERE user_id = ?1 AND ts >= ?2
			) WHERE rn = 1`,
		)
		.bind(env.user_id, cutoff)
		.all<SnapshotRow & { rn: number }>();

	const results = rows.results ?? [];
	if (results.length === 0) {
		return {
			markets: [],
			markets_for_llm: [],
			by_ticker: new Map(),
			all_markets: [],
			total_scanned: 0,
			fetched_at: Date.now(),
			ok: false,
			error: "no snapshots in last 2h (research-cron hasn't run yet?)",
		};
	}

	// Build ScoutedMarket objects + classify vertical.
	const byVertical: Record<Vertical, ScoutedMarket[]> = {
		weather: [],
		economic: [],
		politics: [],
		sports: [],
		elections: [],
		financials: [],
		entertainment: [],
		science_technology: [],
		crypto: [],
		companies: [],
		commodities: [],
		mentions: [],
		social: [],
		world: [],
		health: [],
		transportation: [],
		uncategorized: [],
	};
	for (const row of results) {
		const vertical = classifyByEventTicker(row.event_ticker, row.title);
		if (vertical === null) continue; // cross-category or unmatched
		const scouted: ScoutedMarket = {
			ticker: row.ticker,
			event_ticker: row.event_ticker,
			title: row.title ?? row.ticker,
			vertical,
			yes_bid_cents: row.yes_bid_cents,
			yes_ask_cents: row.yes_ask_cents,
			last_price_cents: row.last_price_cents ?? 0,
			volume_24h: row.volume_24h ?? 0,
			open_interest: row.open_interest ?? 0,
			is_live: (row.is_live === 1 ? 1: 0) as 0 | 1,
			close_time: row.close_time,
			expiration_time: null,
		};
		byVertical[vertical].push(scouted);
	}

	// Rank each vertical by liquidity (vol_24h + OI * 5) and
	// take the top MAX_PER_VERTICAL.
	const filtered: ScoutedMarket[] = [];
	for (const v of ["weather", "economic", "politics", "sports", "elections", "financials", "entertainment", "science_technology", "crypto", "companies", "commodities", "mentions", "social", "world", "health", "transportation", "uncategorized"] as const) {
		const sorted = byVertical[v].sort(
			(a, b) =>
				b.volume_24h + b.open_interest * 5 -
				(a.volume_24h + a.open_interest * 5),
		);
		filtered.push(...sorted.slice(0, MAX_PER_VERTICAL));
	}

	// Build the LLM-facing subset (filter out parlays, cap at maxForLlm).
	const PARLAY_RE = /^KX(MVESPORTS|MVECROSSCATEGORY)/i;
	const nonParlay = filtered.filter(
		(m) => !PARLAY_RE.test(m.event_ticker ?? ""),
	);
	nonParlay.sort(
		(a, b) =>
			b.volume_24h + b.open_interest * 5 -
			(a.volume_24h + a.open_interest * 5),
	);
	const marketsForLlm = nonParlay.slice(0, maxForLlm);

	// by_ticker map for O(1) verification in the LLM's output.
	const byTicker = new Map<string, ScoutedMarket>();
	for (const m of filtered) byTicker.set(m.ticker, m);

	// For checkUniverseHealth's universe-health check, we ALSO
	// need a `all_markets` array with at least {ticker} on each
	// entry. The original Kalshi-based scout sets
	// `all_markets: KalshiMarket[]`; the universe-health check
	// only reads `.ticker` off those, so we can build a stub.
	const allMarketsLike: Array<{ ticker: string }> = filtered.map(
		(m) => ({ ticker: m.ticker }),
	);

	return {
		markets: filtered,
		markets_for_llm: marketsForLlm,
		by_ticker: byTicker,
		all_markets: allMarketsLike as unknown as KalshiMarket[],
		total_scanned: results.length,
		fetched_at: Date.now(),
		ok: true,
	};
}

// ─── Format helpers ─────────────────────────────────────────────

/**
 * Format a ScoutResult for inclusion in the LLM prompt. Keeps it
 * compact: just ticker + truncated title per market, grouped by
 * vertical. Caps total output so the prompt stays under ~3-4k
 * tokens for the market list portion.
 */
export function formatScoutForPrompt(
	scout: ScoutResult,
	opts: { maxTitleChars?: number } = {},
): string {
	if (!scout.ok) {
		return `⚠ Scout failed: ${scout.error}\n` +
			`(Falling back to LLM-only — suggestions will need manual ticker verification.)`;
	}
	const maxTitle = opts.maxTitleChars ?? 120;
	const lines: string[] = [];
	lines.push(`Scout snapshot: ${scout.total_scanned} open markets scanned, ${scout.markets.length} matched verticals (top ${scout.markets.length} by liquidity).`);
	lines.push("");
	const grouped: Record<Vertical, ScoutedMarket[]> = {
		weather: [],
		economic: [],
		politics: [],
		sports: [],
		elections: [],
		financials: [],
		entertainment: [],
		science_technology: [],
		crypto: [],
		companies: [],
		commodities: [],
		mentions: [],
		social: [],
		world: [],
		health: [],
		transportation: [],
		uncategorized: [],
	};
	// Use `markets_for_llm` (parlays filtered out, capped at ~15,
	// bid/ask populated) instead of `markets` (full vertical
	// catalog with parlays, capped at 30/vertical). The LLM
	// gets a tight, actionable list.
	const list = scout.markets_for_llm ?? scout.markets;
	for (const m of list) {
		const v = (m.vertical ?? "weather") as Vertical;
		if (grouped[v]) grouped[v].push(m);
	}
	for (const v of ["weather", "economic", "politics", "sports", "elections", "financials", "entertainment", "science_technology", "crypto", "companies", "commodities", "mentions", "social", "world", "health", "transportation", "uncategorized"] as const) {
		const sub = grouped[v];
		if (sub.length === 0) {
			lines.push(`[${v}]: (no real markets — skip)`);
			continue;
		}
		lines.push(`[${v}] (${sub.length}):`);
		for (const m of sub) {
			const title = m.title.length > maxTitle
				? m.title.slice(0, maxTitle - 1) + "…"
				: m.title;
			const live = m.is_live === 1 ? "LIVE": "1-sided";
			const book = m.yes_bid_cents > 0
				? `${m.yes_bid_cents}/${m.yes_ask_cents}¢`
				: "—";
			lines.push(
				`  ${m.ticker}  [${live} ${book}]  vol24h=${m.volume_24h}  OI=${m.open_interest}  — ${title}`,
			);
		}
	}
	return lines.join("\n");
}
