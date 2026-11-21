/**
 * prediction-market-lab — shared test helper for D1 migrations.
 *
 * The vitest-pool-workers `applyD1Migrations` helper expects an
 * array of `{name, queries: string[]}`. Each migration file is
 * one entry. The wrangler statement-breakpoint marker
 * (`--> statement-breakpoint`) separates statements inside a file.
 *
 * Why this helper: each integration test that touches D1 needs to
 * apply the schema before running. We import the migration files
 * as raw strings via Vite's `?raw` import and split them here.
 *
 * Filter logic: we drop empty chunks AND comment-only chunks. The
 * migration files have a docstring header that lands in the first
 * split chunk; without filtering, `applyD1Migrations` fails with
 * "SQL code did not contain a statement".
 */

import migration0001 from "../../migrations/0001_initial_schema.sql?raw";
import migration0002 from "../../migrations/0002_real_trading_columns.sql?raw";
import migration0003 from "../../migrations/0003_bot_config.sql?raw";
import migration0004 from "../../migrations/0004_lead_suggestions.sql?raw";

const splitMigration = (sql: string): string[] =>
	sql
		.split(/-->\s*statement-breakpoint/)
		.map((s) => s.trim())
		.filter((s) => {
			if (s.length === 0) return false;
			// Comment-only if every non-empty line starts with `--`.
			const lines = s.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
			return !(lines.length > 0 && lines.every((l) => l.startsWith("--")));
		});

/** All migrations, in apply order. Tests can use the full list or
 * filter to a subset (e.g. model-registry tests don't need 0002). */
export const ALL_MIGRATIONS = [
	{ name: "0001_initial_schema.sql", queries: splitMigration(migration0001) },
	{ name: "0002_real_trading_columns.sql", queries: splitMigration(migration0002) },
	{ name: "0003_bot_config.sql", queries: splitMigration(migration0003) },
	{ name: "0004_lead_suggestions.sql", queries: splitMigration(migration0004) },
];
