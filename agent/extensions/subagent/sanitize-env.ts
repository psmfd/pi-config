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
 *      is the target posture for #606; wrappers opt in via `env-strict:
 *      true` frontmatter (with `env-allow`/`env-allow-prefix` extensions),
 *      translated by buildChildEnv below. All 21 first-party wrappers are
 *      strict; credential-bearing ones carry justified env-allow entries.
 *
 * WHAT IS NEVER PASSED (either mode)
 * ----------------------------------
 * - `PI_EXPERTISE_ALLOW_LOCALDEV_WRITE` — the create opt-in gate.
 * - `EXPERTISE_API_TOKEN` — the upstream pre-provisioned bearer/JWT.
 * - `EXPERTISE_API_TOKEN_FILE` — a pointer to a mounted bearer/JWT.
 * - the caller's `EXPERTISE_API_SECRETS_FILE` path. Children receive a
 *   `/dev/null` sentinel instead so upstream extensions cannot fall back to
 *   the default token-bearing file. Canonical expertise is parent-fetched and
 *   injected; children do not need the bearer.
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
	// Create gate: stripping enforces orchestrator-only expertise_create.
	"PI_EXPERTISE_ALLOW_LOCALDEV_WRITE",
	// ADR-0103/ADR-0121 upstream bearer: canonical search stays parent-owned.
	"EXPERTISE_API_TOKEN",
	"EXPERTISE_API_TOKEN_FILE",
	// The caller-controlled value is replaced with a safe sentinel below.
	"EXPERTISE_API_SECRETS_FILE",
]);

const BLOCKED_EXPERTISE_SECRETS_FILE = "/dev/null";

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
	// ACCESS_KEY / ACCESS_KEY_ID / SECRET_ACCESS_KEY suffixes (#793): the
	// suffix-anchored pattern above misses AWS_SECRET_ACCESS_KEY (ends
	// _ACCESS_KEY, not _SECRET) — the standard AWS credential pair must not
	// ride into a strict child on an `AWS_` prefix allow.
	/(?:^|_)ACCESS_KEY(?:_ID)?$/i,
	// CREDENTIAL/CREDENTIALS suffix (e.g. GOOGLE_APPLICATION_CREDENTIALS —
	// a pointer to key material; strict children get it only via an exact
	// per-wrapper env-allow).
	/(?:^|_)CREDENTIALS?$/i,
];

/**
 * Minimum env every strict-mode child needs to start and run correctly. Keep
 * this list conservative — additions should be justified per-wrapper via
 * `extraAllow` / `extraAllowPrefixes` (issue #606), not bolted onto the base.
 * The one exception category is unconditional cross-cutting infrastructure
 * every child needs identically regardless of wrapper (runtime plumbing,
 * proxy egress, whole-tree accounting) — those belong here or in
 * `BASE_ALLOW_PREFIXES` with a justifying comment (ADR-0105).
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
	// Proxy plumbing (#606): the child's web_fetch and provider HTTP calls
	// honor the same egress path as the parent. pi's runtime is bun-compiled,
	// and bun's fetch respects these env vars natively (#827) — so the
	// pass-through here is all web_fetch needs to route a child through the
	// operator's proxy. Both cases pass; bun and most CLIs accept either.
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	// Cache-ratio measurement (ADR-0114, #760): the cache-meter twin of the
	// TOKEN_METER_ carve-out below. cache-meter's suite-wide prefix-churn gate
	// only sees subagent turns if child pi processes inherit the config var
	// that arms the recorder. CACHE_METER_CONFIG is a non-secret operator-set
	// measurement-config name (inert when unset), the same observational
	// category as the token-meter vars — unconditional cross-cutting infra, not
	// a per-wrapper credential. Exact key (cache-meter reads only this one).
	"CACHE_METER_CONFIG",
	// Spawn-time prefill measurement (ADR-0125, #891): prefill-meter's
	// per-segment prompt sizing only covers subagent children if they inherit
	// the config var that arms the recorder — the whole point is measuring the
	// CHILD's composed prompt (the #889/ADR-0124 delta). Non-secret operator-set
	// run label (inert when unset), same observational category and same
	// exact-key style as CACHE_METER_CONFIG above (prefill-meter reads only
	// this one). Unconditional cross-cutting infra, not a per-wrapper credential.
	"PREFILL_METER_CONFIG",
]);

/** Prefixes always allowed under strict mode (in addition to `BASE_ALLOWLIST`). */
const BASE_ALLOW_PREFIXES: readonly string[] = [
	"LC_", // Locale category vars (LC_ALL, LC_CTYPE, …).
	"XDG_", // XDG basedir spec.
	// pi's own configuration namespace (#606): the child IS a pi process —
	// PI_CODING_AGENT_DIR, PI_PACKAGE_DIR, PI_OFFLINE, etc. are runtime
	// plumbing it must inherit. Secret-shaped members of the namespace
	// (e.g. PI_EXPERTISE_API_KEY) are still stripped: STRICT_DENY_PATTERNS
	// runs first and is only rescuable by an exact per-wrapper `env-allow`
	// entry, and ALWAYS_DENY_EXACT (PI_EXPERTISE_ALLOW_LOCALDEV_WRITE)
	// beats every allow rule. PI_GUARD_PROFILE is set-or-delete via
	// applyGuardProfile regardless of what passes through here.
	"PI_",
	// Whole-tree token accounting (ADR-0105): token-meter's session rollup
	// (ADR-0073 decision 4) only includes subagent usage if every child
	// inherits TOKEN_METER_SESSION / TOKEN_METER_ENABLED /
	// TOKEN_METER_POLICY_TAG — non-secret observational values (session id,
	// boolean, short operator label). Unconditional infra applied identically
	// to every wrapper, so it lives on the base list like PI_/proxy rather
	// than as 21 per-wrapper env-allow entries a future wrapper would forget.
	// Secret-shaped members of the namespace (e.g. a hypothetical
	// TOKEN_METER_API_TOKEN) are still stripped: STRICT_DENY_PATTERNS runs
	// first. Inert for consumers without the standalone pi-token-meter
	// mirror — nothing sets the namespace there, so nothing passes.
	"TOKEN_METER_",
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
	// A missing override would make both our client and upstream's extension
	// discover ~/.config/expertise-api/secrets.env in the child. Pin a harmless
	// non-config file so the bearer remains parent-owned even in default mode.
	out.EXPERTISE_API_SECRETS_FILE = BLOCKED_EXPERTISE_SECRETS_FILE;
	return out;
}

/**
 * Guard-profile signal (pi_config #551, ADR-0091). Set-or-delete semantics:
 * PI_GUARD_PROFILE is never inherited from the parent env — it is deleted
 * unconditionally and re-set only when the wrapper's `guard-profile`
 * frontmatter carries a recognized value. A parent-session value therefore
 * cannot leak into an undeclared wrapper, and a typo'd frontmatter value
 * yields NO profile rather than a half-armed one (bash-destructive-guard
 * only recognizes "report-only" anyway). Mutates and returns `env`.
 */
export function applyGuardProfile(
	env: NodeJS.ProcessEnv,
	guardProfile: string | undefined,
): NodeJS.ProcessEnv {
	delete env.PI_GUARD_PROFILE;
	if (guardProfile === "report-only") env.PI_GUARD_PROFILE = "report-only";
	return env;
}

/**
 * Spawn-depth signal (pi_config #841, ADR-0118). The parent stamps every
 * child with its own depth + 1; the tool's execute() refuses to spawn once
 * the process's depth has reached the configured maximum (default 1). This
 * mechanically backs the orchestrator-protocol sub-agent obligation ("do
 * not spawn additional agents on your own initiative") that was previously
 * behavioral-only: without it a wrapper whose tool surface includes
 * `subagent` lets children fan out grandchildren invisibly — unbounded
 * depth, no orchestrator visibility, multiplying token spend.
 */
export const SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";

/**
 * Current spawn depth of this process: 0 at the orchestrator (var absent),
 * n for a child spawned by a depth-(n-1) process. Anything non-numeric,
 * negative, or fractional reads as 0 — the value is always re-stamped by
 * buildChildEnv below, so a mangled inherited value cannot compound.
 */
export function readSpawnDepth(env: NodeJS.ProcessEnv): number {
	const raw = env[SUBAGENT_DEPTH_ENV];
	if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) return 0;
	return Number.parseInt(raw.trim(), 10);
}

/**
 * LOCAL PATCH #11 (pi_config #606): single composing seam for the spawn
 * call site — translates a wrapper's AgentConfig env fields into
 * SanitizeEnvOptions and applies the guard-profile signal, so index.ts
 * passes `spawn(..., { env: buildChildEnv(process.env, agent) })` and the
 * whole translation stays unit-testable without a spawn harness (same
 * pattern applyGuardProfile established).
 *
 * LOCAL PATCH #15 (pi_config #841, ADR-0118): also stamps the child's
 * spawn depth. Set-or-increment semantics, same philosophy as
 * applyGuardProfile's set-or-delete: the child's value is always computed
 * from the parent's parsed depth, never inherited verbatim (the `PI_`
 * prefix passes strict mode, but the recompute here overwrites whatever
 * passed through).
 */
export function buildChildEnv(
	parent: NodeJS.ProcessEnv,
	agent: {
		guardProfile?: string;
		envStrict?: boolean;
		envAllow?: readonly string[];
		envAllowPrefixes?: readonly string[];
	},
): NodeJS.ProcessEnv {
	const env = buildSanitizedEnv(parent, {
		strict: agent.envStrict === true,
		extraAllow: agent.envAllow,
		extraAllowPrefixes: agent.envAllowPrefixes,
	});
	env[SUBAGENT_DEPTH_ENV] = String(readSpawnDepth(parent) + 1);
	return applyGuardProfile(env, agent.guardProfile);
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
	BLOCKED_EXPERTISE_SECRETS_FILE,
};
