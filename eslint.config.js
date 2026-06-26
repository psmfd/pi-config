// ESLint flat config — implements ADR-0021.
//
// Scope: agent/extensions/**/*.ts only. Type-aware rules ON via
// projectService (parses each per-extension tsconfig.json on demand).
//
// Deps are resolved through the repo-root `node_modules` symlink that
// scripts/lib/extension-deps.sh installs into $HOME/.cache/pi_config/.
// No package.json or lockfile is committed at the repo root.

import tseslint from "typescript-eslint";
import security from "eslint-plugin-security";

export default tseslint.config(
	{
		ignores: [
			// Generated runtime archives — never lint.
			"agent/extensions/compaction-optimizer/archive/**",
			// Cache symlink target — never lint upstream code.
			"node_modules/**",
		],
	},
	...tseslint.configs.recommendedTypeChecked,
	// eslint-plugin-security — the free defense-in-depth gate decided in ADR-0060
	// (#426). The shell surface is covered by shellcheck (validate.sh §9e); this
	// covers the extension TS that mirror-side CodeQL never scans. The recommended
	// set is all `warn`; the override block below tiers it for signal-over-noise.
	{ ...security.configs.recommended, files: ["agent/extensions/**/*.ts"] },
	{
		files: ["agent/extensions/**/*.ts"],
		rules: {
			// OFF — together these were 174 of 181 findings and are near-universal
			// false positives for a TypeScript agent: TS already type-checks
			// property access, and these extensions read/write computed paths by
			// design (that is their job, not a vulnerability).
			"security/detect-object-injection": "off",
			"security/detect-non-literal-fs-filename": "off",
			// ERROR — classic RCE / command-injection vectors that ~never false
			// positive. Zero findings today, so this is a clean PR-blocking gate
			// for future extension code (e.g. the subagent process-spawn surface).
			"security/detect-eval-with-expression": "error",
			"security/detect-child-process": "error",
			"security/detect-non-literal-require": "error",
			// Everything else stays at the recommended `warn` — notably
			// detect-unsafe-regex and detect-non-literal-regexp, which currently
			// surface 7 informative, non-blocking warnings on bounded/escaped
			// regexes (reviewed: no real ReDoS or injection).
		},
	},
	{
		// Apply type-aware rules only to extension TypeScript.
		files: ["agent/extensions/**/*.ts"],
		languageOptions: {
			parserOptions: {
				// projectService discovers the nearest tsconfig.json per file —
				// matches the per-extension tsconfig layout from ADR-0021 Axis A.
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			// ADR-0021 motivating rules (floating/misused promises in fs chains).
			"@typescript-eslint/no-floating-promises": "error",
			"@typescript-eslint/no-misused-promises": "error",
			"@typescript-eslint/await-thenable": "error",
			// Tighten unused vars; allow `_`-prefix for documented intentional unused.
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_",
				},
			],
			// Warn-only per ADR-0021: real bug surface is type-aware promise rules.
			"@typescript-eslint/no-explicit-any": "warn",
			// Import discipline.
			"@typescript-eslint/consistent-type-imports": [
				"error",
				{ prefer: "type-imports", fixStyle: "inline-type-imports" },
			],
			// Recommended-type-checked includes these by default; left explicit
			// because they're the most likely to surface real bugs in the
			// async/fs-mutating surface this ADR targets.
			"@typescript-eslint/require-await": "warn",
			// `no-unsafe-*` are very noisy against pi SDK types; warn-only.
			"@typescript-eslint/no-unsafe-assignment": "warn",
			"@typescript-eslint/no-unsafe-member-access": "warn",
			"@typescript-eslint/no-unsafe-call": "warn",
			"@typescript-eslint/no-unsafe-return": "warn",
			"@typescript-eslint/no-unsafe-argument": "warn",
		},
	},
	{
		// `node:test`'s top-level `test("name", async () => {})` returns a
		// Promise that the runner manages; awaiting it is not the pattern.
		// Disable the floating-promises rule for test files only.
		files: ["agent/extensions/**/*.test.ts"],
		rules: {
			"@typescript-eslint/no-floating-promises": "off",
		},
	},
);
