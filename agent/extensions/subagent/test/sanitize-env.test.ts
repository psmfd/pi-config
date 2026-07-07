import assert from "node:assert/strict";
import { test } from "node:test";

import { __testing, buildSanitizedEnv } from "../sanitize-env.ts";

// -----------------------------------------------------------------------------
// Load-bearing invariants (guard against accidental drift in the denylist).
// -----------------------------------------------------------------------------

test("ALWAYS_DENY_EXACT includes the ADR-0028 write gate", () => {
  assert.equal(__testing.ALWAYS_DENY_EXACT.has("PI_EXPERTISE_ALLOW_LOCALDEV_WRITE"), true);
});

test("BASE_ALLOWLIST is minimum-viable (POSIX + locale + terminal)", () => {
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "TERM", "TZ"]) {
    assert.equal(__testing.BASE_ALLOWLIST.has(key), true, `${key} missing from BASE_ALLOWLIST`);
  }
});

// -----------------------------------------------------------------------------
// Default mode: passthrough + explicit denies.
// -----------------------------------------------------------------------------

test("default mode: PI_EXPERTISE_ALLOW_LOCALDEV_WRITE is stripped even when set", () => {
  const out = buildSanitizedEnv({
    PATH: "/usr/bin",
    PI_EXPERTISE_ALLOW_LOCALDEV_WRITE: "1",
  });
  assert.equal(out.PATH, "/usr/bin");
  assert.equal(out.PI_EXPERTISE_ALLOW_LOCALDEV_WRITE, undefined);
});

test("default mode: unrelated vars pass through unchanged", () => {
  const parent = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/tester",
    ANTHROPIC_API_KEY: "sk-ant-xxx", // load-bearing for child pi model calls
    GH_TOKEN: "gho_xxx", // load-bearing for gh-cli-expert
    SSH_AUTH_SOCK: "/tmp/ssh-agent",
    PI_EXPERTISE_API_KEY: "test-key", // needed for search
    RANDOM_VAR: "value",
  };
  const out = buildSanitizedEnv(parent);
  for (const key of Object.keys(parent)) {
    assert.equal(out[key], parent[key as keyof typeof parent], `${key} not passed through`);
  }
});

test("default mode: undefined values are dropped (not serialized)", () => {
  const out = buildSanitizedEnv({ PATH: "/usr/bin", MISSING: undefined });
  assert.equal(Object.hasOwn(out, "MISSING"), false);
});

test("default mode: strict-mode secret patterns do NOT trigger deny", () => {
  // Load-bearing: in default mode ANTHROPIC_API_KEY and GH_TOKEN must reach
  // the child even though they match the STRICT_DENY_PATTERNS regex.
  const out = buildSanitizedEnv({
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "sk-ant",
    GH_TOKEN: "gho_x",
    MY_SECRET: "s",
    DB_PASSWORD: "p",
  });
  assert.equal(out.ANTHROPIC_API_KEY, "sk-ant");
  assert.equal(out.GH_TOKEN, "gho_x");
  assert.equal(out.MY_SECRET, "s");
  assert.equal(out.DB_PASSWORD, "p");
});

test("default mode: caller's parent env is not mutated", () => {
  const parent = { PATH: "/usr/bin", PI_EXPERTISE_ALLOW_LOCALDEV_WRITE: "1" };
  const before = { ...parent };
  buildSanitizedEnv(parent);
  assert.deepEqual(parent, before);
});

// -----------------------------------------------------------------------------
// Strict mode: allowlist-only + denylist patterns.
// -----------------------------------------------------------------------------

test("strict mode: base allowlist keys pass; unlisted keys dropped", () => {
  const out = buildSanitizedEnv(
    {
      PATH: "/usr/bin",
      HOME: "/home/x",
      LANG: "C.UTF-8",
      TERM: "xterm",
      RANDOM_VAR: "value",
      ARBITRARY: "y",
    },
    { strict: true },
  );
  assert.equal(out.PATH, "/usr/bin");
  assert.equal(out.HOME, "/home/x");
  assert.equal(out.LANG, "C.UTF-8");
  assert.equal(out.TERM, "xterm");
  assert.equal(out.RANDOM_VAR, undefined);
  assert.equal(out.ARBITRARY, undefined);
});

test("strict mode: LC_* and XDG_* prefixes pass by default", () => {
  const out = buildSanitizedEnv(
    {
      LC_ALL: "C",
      LC_CTYPE: "en_US.UTF-8",
      XDG_CONFIG_HOME: "/home/x/.config",
      XDG_RUNTIME_DIR: "/run/user/1000",
      NON_PREFIXED: "no",
    },
    { strict: true },
  );
  assert.equal(out.LC_ALL, "C");
  assert.equal(out.LC_CTYPE, "en_US.UTF-8");
  assert.equal(out.XDG_CONFIG_HOME, "/home/x/.config");
  assert.equal(out.XDG_RUNTIME_DIR, "/run/user/1000");
  assert.equal(out.NON_PREFIXED, undefined);
});

test("strict mode: secret-suffix keys are dropped by default", () => {
  const out = buildSanitizedEnv(
    {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk",
      GH_TOKEN: "gho",
      MY_SECRET: "s",
      DB_PASSWORD: "p",
      LEGACY_PASSWD: "l",
      SIGNING_PRIVATE_KEY: "pem",
      LOWER_case_token: "ok-token", // case-insensitive
    },
    { strict: true },
  );
  assert.equal(out.PATH, "/usr/bin");
  assert.equal(out.ANTHROPIC_API_KEY, undefined);
  assert.equal(out.GH_TOKEN, undefined);
  assert.equal(out.MY_SECRET, undefined);
  assert.equal(out.DB_PASSWORD, undefined);
  assert.equal(out.LEGACY_PASSWD, undefined);
  assert.equal(out.SIGNING_PRIVATE_KEY, undefined);
  assert.equal(out.LOWER_case_token, undefined);
});

test("strict mode: extraAllow re-enables specific secret-suffix keys", () => {
  const out = buildSanitizedEnv(
    {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk",
      GH_TOKEN: "gho",
      OTHER_SECRET: "s",
    },
    { strict: true, extraAllow: ["ANTHROPIC_API_KEY", "GH_TOKEN"] },
  );
  assert.equal(out.ANTHROPIC_API_KEY, "sk");
  assert.equal(out.GH_TOKEN, "gho");
  assert.equal(out.OTHER_SECRET, undefined);
});

test("strict mode: extraAllowPrefixes admits whole namespaces", () => {
  const out = buildSanitizedEnv(
    {
      PATH: "/usr/bin",
      AWS_REGION: "us-east-1",
      AWS_PROFILE: "dev",
      AZURE_TENANT_ID: "t",
      RANDOM: "no",
    },
    { strict: true, extraAllowPrefixes: ["AWS_", "AZURE_"] },
  );
  assert.equal(out.AWS_REGION, "us-east-1");
  assert.equal(out.AWS_PROFILE, "dev");
  assert.equal(out.AZURE_TENANT_ID, "t");
  assert.equal(out.RANDOM, undefined);
});

test("strict mode: ALWAYS_DENY beats every allowlist rule", () => {
  const out = buildSanitizedEnv(
    {
      PATH: "/usr/bin",
      PI_EXPERTISE_ALLOW_LOCALDEV_WRITE: "1",
    },
    {
      strict: true,
      extraAllow: ["PI_EXPERTISE_ALLOW_LOCALDEV_WRITE"], // hostile caller
      extraAllowPrefixes: ["PI_"], // hostile caller
    },
  );
  assert.equal(out.PATH, "/usr/bin");
  assert.equal(out.PI_EXPERTISE_ALLOW_LOCALDEV_WRITE, undefined);
});

test("strict mode: extraAllow re-enables a secret-suffix even against the pattern", () => {
  // extraAllow must beat STRICT_DENY_PATTERNS (that's the escape hatch for
  // per-wrapper allowlists in #606) but NEVER beats ALWAYS_DENY_EXACT.
  const out = buildSanitizedEnv(
    {
      PATH: "/usr/bin",
      COPILOT_API_KEY: "gh",
    },
    { strict: true, extraAllow: ["COPILOT_API_KEY"] },
  );
  assert.equal(out.COPILOT_API_KEY, "gh");
});

// -----------------------------------------------------------------------------
// Explicit-strict-false is identical to default.
// -----------------------------------------------------------------------------

test("strict:false is identical to default (passthrough with denies)", () => {
  const parent = {
    PATH: "/usr/bin",
    RANDOM: "y",
    PI_EXPERTISE_ALLOW_LOCALDEV_WRITE: "1",
  };
  const a = buildSanitizedEnv(parent);
  const b = buildSanitizedEnv(parent, { strict: false });
  assert.deepEqual(a, b);
});
