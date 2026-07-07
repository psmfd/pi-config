/**
 * subagent/sanitize-env.ts — build the environment passed to spawned child
 * pi processes (pi_config issue #596, epic #595).
 *
 * WHY
 * ---
 * Historically the subagent extension called `spawn(...)` without an `env:`
 * option, so children inherited the parent pi process's full environment
 * verbatim. That's fine for most vars but makes it impossible to enforce the
 * ADR-0028 trust boundary for the expertise client: a subagent whose parent
 * session set `PI_EXPERTISE_ALLOW_LOCALDEV_WRITE=1` would silently inherit
 * write capability, breaking the "orchestrator-only creates" invariant that
 * epic #595 depends on.
 *
 * MODES
 * -----
 * Two modes, chosen by the caller — never inferred from the parent env.
 *
 *   1. `strict: false` (DEFAULT) — passthrough + explicit denies.
 *      Every parent env var is passed through EXCEPT those matching the
 *      always-deny list (see `ALWAYS_DENY_EXACT` / `ALWAYS_DENY_PATTERNS`).
 *      This is the safe rollout for #596: it strips
 *      `PI_EXPERTISE_ALLOW_LOCALDEV_WRITE` unconditionally without disturbing
 *      the 20 existing wrappers whose tools may legitimately depend on
 *      arbitrary parent env (model-provider keys, `GH_TOKEN`,
 *      `SSH_AUTH_SOCK`, cloud creds, etc.).
 *
 *   2. `strict: true` — allowlist-only.
 *      Only keys in `BASE_ALLOWLIST` (or an exact match in `extraAllow`, or
 *      a prefix match in `extraAllowPrefixes`) are passed through, AND the
 *      always-deny list still applies as a belt-and-suspenders check. This
 *      is the target posture for #606; it is implemented here but not
 *      enabled by any wrapper yet.
 *
 * WHAT IS NEVER PASSED (either mode)
 * ----------------------------------
 * - `PI_EXPERTISE_ALLOW_LOCALDEV_WRITE` — the ADR-0028 write gate. Stripping
 *   it enforces "orchestrator-only expertise_create" structurally, not just
 *   by convention.
 *
 * WHAT IS ONLY DENIED IN STRICT MODE
 * ----------------------------------
 * - Anything whose NAME matches `/(_|^)(TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY)$/i`
 *   unless the caller explicitly re-allows it via `extraAllow`. Under default
 *   mode these still pass through (model-provider keys, `GH_TOKEN`, etc. are
 *   load-bearing for existing wrappers); the pattern is only enforced when
 *   the wrapper opts into strict mode and has enumerated its real needs.
 */

/** Options controlling {@link buildSanitizedEnv}. */
export interface SanitizeEnvOptions {
	/**
	 * When true, only the base allowlist + `extraAllow` + `extraAllowPrefixes`
	 * keys are passed through. Defaults to false (passthrough with explicit
	 * denies) — see the file header for the rationale.
	 */
	readonly strict?: boolean;

	/** Extra exact key names to allow (strict mode only). */
	readonly extraAllow?: readonly string[];

	/** Extra key prefixes to allow (strict mode only), e.g. `"AWS_"`. */
	readonly extraAllowPrefixes?: readonly string[];
}

/**
 * Env keys that MUST NEVER reach a spawned child, regardless of mode. Kept
 * short and load-bearing — each entry needs a comment explaining why.
 */
const ALWAYS_DENY_EXACT: ReadonlySet<string> = new Set([
	// ADR-0028 write gate for expertise-client. Stripping enforces
	// "orchestrator-only expertise_create" structurally (epic #595).
	"PI_EXPERTISE_ALLOW_LOCALDEV_WRITE",
]);

/**
 * Env keys matching any of these patterns are denied in STRICT mode only.
 * (Under default mode they pass through — most are load-bearing for
 * existing wrappers, e.g. `GH_TOKEN`, `ANTHROPIC_API_KEY`.)
 */
const STRICT_DENY_PATTERNS: readonly RegExp[] = [
	// _TOKEN, _SECRET, _PASSWORD, _PASSWD, _APIKEY, _API_KEY suffixes.
	/(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY)$/i,
	// _PRIVATE_KEY suffix (SSH keys, provider service accounts, etc.).
	/_PRIVATE_KEY$/i,
];

/**
 * Minimum env every strict-mode child needs to start and run correctly. Keep
 * this list conservative — additions should be justified per-wrapper via
 * `extraAllow` / `extraAllowPrefixes` (issue #606), not bolted onto the base.
 */
const BASE_ALLOWLIST: ReadonlySet<string> = new Set([
	// POSIX baseline.
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"PWD",
	"TMPDIR",
	"TMP",
	"TEMP",
	// Locale.
	"LANG",
	"LANGUAGE",
	// Terminal.
	"TERM",
	"COLORTERM",
	"NO_COLOR",
	"FORCE_COLOR",
	// Timezone.
	"TZ",
	// Node/Bun runtime discovery (child pi may be a Node script).
	"NODE_PATH",
	"NODE_OPTIONS",
]);

/** Prefixes always allowed under strict mode (in addition to `BASE_ALLOWLIST`). */
const BASE_ALLOW_PREFIXES: readonly string[] = [
	"LC_", // Locale category vars (LC_ALL, LC_CTYPE, …).
	"XDG_", // XDG basedir spec.
];

/**
 * Build the environment dict to pass as `spawn(..., { env })` for a subagent
 * child pi process.
 *
 * The returned object is a fresh dict; the input is never mutated.
 */
export function buildSanitizedEnv(
	parent: NodeJS.ProcessEnv,
	opts: SanitizeEnvOptions = {},
): NodeJS.ProcessEnv {
	const strict = opts.strict === true;
	const extraAllow = new Set(opts.extraAllow ?? []);
	const extraAllowPrefixes = opts.extraAllowPrefixes ?? [];

	const out: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(parent)) {
		if (value === undefined) continue;
		if (ALWAYS_DENY_EXACT.has(key)) continue;

		if (strict) {
			if (STRICT_DENY_PATTERNS.some((re) => re.test(key))) {
				if (!extraAllow.has(key)) continue;
			}
			const allowedByBase =
				BASE_ALLOWLIST.has(key) ||
				BASE_ALLOW_PREFIXES.some((p) => key.startsWith(p));
			const allowedByExtra =
				extraAllow.has(key) ||
				extraAllowPrefixes.some((p) => key.startsWith(p));
			if (!allowedByBase && !allowedByExtra) continue;
		}

		out[key] = value;
	}
	return out;
}

/**
 * Test-only accessor for the always-deny list. Exported so unit tests can
 * assert stability of the load-bearing entries without duplicating the
 * literal set; not part of the runtime API contract.
 */
export const __testing = {
	ALWAYS_DENY_EXACT,
	STRICT_DENY_PATTERNS,
	BASE_ALLOWLIST,
	BASE_ALLOW_PREFIXES,
};
