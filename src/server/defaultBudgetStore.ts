import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * On-disk persistence for the "default budget" setting.
 *
 * Why this exists: when this MCP server runs behind a per-call-spawn gateway
 * (e.g. LiteLLM's MCP proxy spawns the upstream stdio process fresh on every
 * single tool call), any in-process default-budget value set via
 * `ynab_set_default_budget` is born and dies inside the same call — it never
 * survives to the next request. Persisting to a file inside the parent
 * container restores the setter/getter contract because the file outlives any
 * single stdio process.
 *
 * For direct-desktop usage (Claude Desktop spawning the binary once for the
 * whole session) this disk write is a harmless no-op — the in-memory value
 * still works as before, and the disk copy just stays in sync.
 *
 * Storage path: `${YNAB_MCPB_STATE_DIR ?? <os.tmpdir>/ynab-mcpb}/default-budget.json`
 *
 * Test isolation: gated on `NODE_ENV !== "test"` so existing test suites that
 * construct the server expecting no default are unaffected. Tests that want to
 * exercise persistence can set NODE_ENV to anything else and `YNAB_MCPB_STATE_DIR`
 * to a per-test tempdir.
 */

const UUID_REGEX =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isTestEnv(): boolean {
	return process.env["NODE_ENV"] === "test";
}

/**
 * Returns the path to the on-disk default-budget store file.
 */
export function getDefaultBudgetStorePath(): string {
	const dir = process.env["YNAB_MCPB_STATE_DIR"] || join(tmpdir(), "ynab-mcpb");
	return join(dir, "default-budget.json");
}

/**
 * Load the persisted default budget ID, if any. Returns undefined when the
 * file is missing, unreadable, malformed, contains a non-UUID value, or when
 * running under NODE_ENV=test. Never throws.
 */
export function loadDefaultBudget(): string | undefined {
	if (isTestEnv()) return undefined;
	const path = getDefaultBudgetStorePath();
	if (!existsSync(path)) return undefined;
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as { budget_id?: unknown };
		if (typeof parsed.budget_id !== "string") return undefined;
		const trimmed = parsed.budget_id.trim();
		if (!UUID_REGEX.test(trimmed)) return undefined;
		return trimmed;
	} catch {
		return undefined;
	}
}

/**
 * Persist the default budget ID atomically (write-temp + rename). No-op under
 * NODE_ENV=test. Throws on invalid UUID input; logs and swallows filesystem
 * errors so a transient disk problem does not break the in-memory setter.
 */
export function saveDefaultBudget(budgetId: string): void {
	if (isTestEnv()) return;
	const trimmed = budgetId.trim();
	if (!UUID_REGEX.test(trimmed)) {
		throw new Error(
			`saveDefaultBudget: invalid UUID format: ${JSON.stringify(budgetId)}`,
		);
	}
	const path = getDefaultBudgetStorePath();
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmpPath = `${path}.tmp`;
		writeFileSync(
			tmpPath,
			JSON.stringify({
				budget_id: trimmed,
				saved_at: new Date().toISOString(),
			}),
			{ mode: 0o600 },
		);
		renameSync(tmpPath, path);
	} catch (err) {
		console.error(
			`defaultBudgetStore: failed to persist default budget to ${path}:`,
			err,
		);
	}
}

/**
 * Remove the persisted default budget file, if any. No-op under NODE_ENV=test
 * or when the file does not exist. Swallows filesystem errors.
 */
export function clearDefaultBudgetStore(): void {
	if (isTestEnv()) return;
	const path = getDefaultBudgetStorePath();
	if (!existsSync(path)) return;
	try {
		unlinkSync(path);
	} catch {
		// Intentionally ignored: clearing is best-effort.
	}
}
