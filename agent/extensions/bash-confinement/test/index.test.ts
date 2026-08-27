/**
 * bash-confinement — wiring tests for the Phase 2a policy extension (#1046,
 * ADR-0146). Hermetic: HOME is a temp dir (so settings.json / the grants file
 * resolve under our control), PI_CONFINE_LAUNCHER points at a fake launcher
 * script whose --probe exit code + stdout we script, and the PI_* env the
 * extension writes is saved/restored around each test.
 *
 * These prove the POLICY decisions (arm/refuse/inert, grant computation)
 * without a Landlock kernel — the real enforcement lives in
 * scripts/test-landlock-canary.sh.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import bashConfinement from "../index.ts";

const ENV_MODE = "PI_BASH_CONFINE";
const ENV_GRANTS_RW = "PI_CONFINE_GRANTS_RW";
const ENV_LAUNCHER = "PI_CONFINE_LAUNCHER";
const TOUCHED = [ENV_MODE, ENV_GRANTS_RW, ENV_LAUNCHER, "HOME"] as const;

interface Handler {
  (event: unknown, ctx: unknown): Promise<void> | void;
}

interface Notice {
  text: string;
  level: string;
}

function loadExtension(): {
  fire: (hasUI?: boolean) => Promise<Notice[]>;
  shutdown: () => Promise<void>;
} {
  const handlers: Record<string, Handler> = {};
  const pi = {
    registerFlag() {},
    registerCommand() {},
    on(event: string, handler: Handler) {
      handlers[event] = handler;
    },
  };
  bashConfinement(pi as never);
  const startHandler = handlers["session_start"];
  if (!startHandler) throw new Error("session_start handler was not registered");
  return {
    fire: async (hasUI = true) => {
      const notices: Notice[] = [];
      const ctx = {
        hasUI,
        ui: { notify: (text: string, level: string) => notices.push({ text, level }) },
      };
      await startHandler(undefined, ctx);
      return notices;
    },
    shutdown: async () => {
      const shutdownHandler = handlers["session_shutdown"];
      if (!shutdownHandler) throw new Error("session_shutdown handler was not registered");
      await shutdownHandler(undefined, {});
    },
  };
}

const saved: Record<string, string | undefined> = {};
let tmpHome: string;

function writeSettings(obj: unknown): void {
  mkdirSync(join(tmpHome, ".pi", "agent"), { recursive: true });
  writeFileSync(join(tmpHome, ".pi", "agent", "settings.json"), JSON.stringify(obj));
}

/** Fake launcher: exits `probeExit` on --probe, echoing `probeOut`. */
function writeFakeLauncher(probeExit: number, probeOut: string): string {
  const p = join(tmpHome, "fake-landlock-run");
  writeFileSync(p, `#!/bin/sh\nif [ "$1" = "--probe" ]; then echo '${probeOut}'; exit ${probeExit}; fi\nexit 0\n`);
  chmodSync(p, 0o755);
  return p;
}

beforeEach(() => {
  for (const k of TOUCHED) saved[k] = process.env[k];
  for (const k of TOUCHED) delete process.env[k];
  tmpHome = mkdtempSync(join(tmpdir(), "bash-confinement-home-"));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmpHome, { recursive: true, force: true });
});

const isLinux = process.platform === "linux";

test("off mode is fully inert: no env, no notice", async () => {
  writeSettings({ extensionSettings: { bashConfinement: { mode: "off" } } });
  const notices = await loadExtension().fire();
  assert.equal(process.env[ENV_MODE], undefined);
  assert.equal(notices.length, 0);
});

test("enabled:false is treated as off", async () => {
  writeSettings({ extensionSettings: { bashConfinement: { enabled: false } } });
  await loadExtension().fire();
  assert.equal(process.env[ENV_MODE], undefined);
});

test("non-Linux (or no launcher) never arms enforce", async () => {
  // On macOS the platform gate returns before probing; on Linux a missing
  // launcher probes unusable, so auto does not arm either way.
  writeSettings({ extensionSettings: { bashConfinement: { mode: "auto" } } });
  process.env[ENV_LAUNCHER] = join(tmpHome, "does-not-exist");
  await loadExtension().fire();
  assert.equal(process.env[ENV_MODE], undefined);
});

test("auto + probe full arms enforce and computes grants (Linux only)", async () => {
  if (!isLinux) {
    // Platform gate short-circuits before the probe on non-Linux; assert that.
    writeSettings({ extensionSettings: { bashConfinement: { mode: "auto" } } });
    process.env[ENV_LAUNCHER] = writeFakeLauncher(0, "landlock: fully enforced");
    const notices = await loadExtension().fire();
    assert.equal(process.env[ENV_MODE], undefined);
    assert.match(notices[0]?.text ?? "", /inert on this host/);
    return;
  }
  writeSettings({ extensionSettings: { bashConfinement: { mode: "auto" } } });
  process.env[ENV_LAUNCHER] = writeFakeLauncher(0, "landlock: fully enforced");
  const notices = await loadExtension().fire();
  assert.equal(process.env[ENV_MODE], "enforce");
  // default grants: ~/.cache/pi_config and ~/.npm
  const grants = process.env[ENV_GRANTS_RW] ?? "";
  assert.match(grants, /\.cache\/pi_config/);
  assert.match(grants, /\.npm/);
  assert.match(notices[0]?.text ?? "", /armed/);
});

test("auto + probe unusable emits advisory warning, does not arm (Linux)", async () => {
  if (!isLinux) return;
  writeSettings({ extensionSettings: { bashConfinement: { mode: "auto" } } });
  process.env[ENV_LAUNCHER] = writeFakeLauncher(125, "");
  const notices = await loadExtension().fire();
  assert.equal(process.env[ENV_MODE], undefined);
  assert.equal(notices[0]?.level, "warning");
  assert.match(notices[0]?.text ?? "", /NOT confined/);
});

test("enforce + partial or unusable probe publishes strict refusal (Linux)", async () => {
  if (!isLinux) return;
  writeSettings({ extensionSettings: { bashConfinement: { mode: "enforce" } } });

  for (const [probeExit, probeOutput] of [
    [0, "landlock: partially enforced"],
    [125, ""],
  ] as const) {
    process.env[ENV_LAUNCHER] = writeFakeLauncher(probeExit, probeOutput);
    const notices = await loadExtension().fire();
    assert.equal(process.env[ENV_MODE], "refuse");
    assert.equal(process.env[ENV_GRANTS_RW], undefined);
    assert.equal(notices[0]?.level, "warning");
    assert.match(notices[0]?.text ?? "", /refusing bash calls/);
    assert.match(notices[0]?.text ?? "", /Requires shellPath.*pi-bash-sandbox/);
  }
});

test("replacement into off or unusable mode revokes stale policy and grants", async () => {
  process.env[ENV_MODE] = "enforce";
  process.env[ENV_GRANTS_RW] = "/stale/grant";
  writeSettings({ extensionSettings: { bashConfinement: { mode: "off" } } });
  await loadExtension().fire();
  assert.equal(process.env[ENV_MODE], undefined);
  assert.equal(process.env[ENV_GRANTS_RW], undefined);

  if (!isLinux) return;
  writeSettings({ extensionSettings: { bashConfinement: { mode: "auto" } } });
  const grantsPath = join(tmpHome, ".config", "pi", "bash-confinement-grants.conf");
  mkdirSync(join(tmpHome, ".config", "pi"), { recursive: true });
  writeFileSync(grantsPath, "/grant-a\n");
  process.env[ENV_LAUNCHER] = writeFakeLauncher(0, "landlock: fully enforced");
  const extension = loadExtension();
  await extension.fire();
  assert.equal(process.env[ENV_MODE], "enforce");
  assert.match(process.env[ENV_GRANTS_RW] ?? "", /\/grant-a/);

  writeFileSync(grantsPath, "/grant-b\n");
  await extension.fire();
  assert.doesNotMatch(process.env[ENV_GRANTS_RW] ?? "", /\/grant-a/);
  assert.match(process.env[ENV_GRANTS_RW] ?? "", /\/grant-b/);

  process.env[ENV_LAUNCHER] = writeFakeLauncher(125, "");
  const replacementNotices = await extension.fire();
  assert.equal(process.env[ENV_MODE], undefined);
  assert.equal(process.env[ENV_GRANTS_RW], undefined);
  assert.equal(replacementNotices[0]?.level, "warning");
  assert.match(replacementNotices[0]?.text ?? "", /NOT confined/);
});

test("session shutdown revokes armed policy and grants", async () => {
  if (!isLinux) return;
  writeSettings({ extensionSettings: { bashConfinement: { mode: "auto" } } });
  process.env[ENV_LAUNCHER] = writeFakeLauncher(0, "landlock: fully enforced");
  const extension = loadExtension();
  await extension.fire();
  assert.equal(process.env[ENV_MODE], "enforce");
  assert.ok(process.env[ENV_GRANTS_RW]);

  await extension.shutdown();
  assert.equal(process.env[ENV_MODE], undefined);
  assert.equal(process.env[ENV_GRANTS_RW], undefined);
});

test("per-host grants file is appended to computed grants (Linux)", async () => {
  if (!isLinux) return;
  writeSettings({ extensionSettings: { bashConfinement: { mode: "auto" } } });
  mkdirSync(join(tmpHome, ".config", "pi"), { recursive: true });
  writeFileSync(
    join(tmpHome, ".config", "pi", "bash-confinement-grants.conf"),
    "# a comment\n/opt/toolchain\n\n/srv/data\n",
  );
  process.env[ENV_LAUNCHER] = writeFakeLauncher(0, "landlock: fully enforced");
  await loadExtension().fire();
  const grants = (process.env[ENV_GRANTS_RW] ?? "").split(":");
  assert.ok(grants.includes("/opt/toolchain"));
  assert.ok(grants.includes("/srv/data"));
});

test("missing settings.json defaults to auto (no throw)", async () => {
  // No settings written; readMode() falls back to "auto". With no launcher it
  // simply does not arm — the point is it must not throw.
  process.env[ENV_LAUNCHER] = join(tmpHome, "nope");
  const notices = await loadExtension().fire();
  assert.ok(Array.isArray(notices));
});
