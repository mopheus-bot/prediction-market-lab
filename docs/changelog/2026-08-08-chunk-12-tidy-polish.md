# Chunk 12 — the app polish (2026-08-08)

**Scope:** make the operator surface feel like a the app-tier product
instead of a "good enough" internal tool. Five concrete changes:

1. **Skeleton loaders.** Replaced every "loading…" string in
   table tbodies (last-trades, vertical, signals, scans, cron-runs)
   with shimmer bars (`.skel-bar` with 3 widths: s/m/l). The
   shimmer animation respects `prefers-reduced-motion` (just
   uses a static color).

2. **Friendly empty states.** Every empty state now has a small
   icon + a 1-line hint explaining what populates it. Examples:
   - trades: 📊 "no trades yet — trades appear after the first
     signal-driven or manual fill"
   - signals: 📡 "signals fire when the WS sees an orderbook
     move that crosses the model threshold"
   - verticals: 📈 "one row per vertical (weather / politics /
     sports / economic)"

3. **Toast notifications.** Upgraded from a single text span
   to a colored icon (✓ for ok, ! for err) + body + × dismiss
   button. Errors linger 5s (was 3.5s); success auto-dismisses
   in 2.5s. The dismiss button is wired so the operator can
   clear a long error immediately.

4. **Mobile responsive.** Single breakpoint at 768px collapses
   the 4-col dashboard grid to single column, shrinks hero
   cards, makes the toast span full width. The brand bar
   wraps on small screens.

5. **Reduced motion.** The shimmer animation is disabled under
   `prefers-reduced-motion: reduce`. Other animations (live
   pulse, toast slide) are already gated.

**Files:**
- `public/index.html` — only file touched. 158 insertions,
  15 deletions.

**Verification:** dashboard validator passes; typecheck clean;
243/243 tests pass (no test changes — UI-only).
