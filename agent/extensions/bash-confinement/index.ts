// PI-EXTENSION-CAPABILITY: no-registerTool
/**
 * bash-confinement — Phase 2a bash-tool write-confinement policy (ADR-0146,
 * #1046). The POLICY half; the mechanism is the vendored `landlock-run`
 * launcher behind the composed `pi-bash-sandbox` shellPath wrapper.
 *
 * At session start this extension probes the launcher, resolves the rollout
 * mode, and — when confinement is warranted on this host — exports the env
 * contract the wrapper reads (PI_BASH_CONFINE=enforce, plus the extension-
 * computed rw grants). The worktree extension publishes PI_SESSION_WORKTREE /
 * PI_CONFINE_SESSION on the first worktree activation; this extension never
 * owns the worktree path.
 *
 * Rollout mode (extensionSettings.bashConfinement.mode, default "auto"):
 *   - auto     : enforce when the probe reports fully usable; loud-advisory
 *                (a session-start warning, no enforcement) otherwise.
 *   - enforce  : force enforce; refuse to arm (loud) if the probe is unusable.
 *   - advisory : never enforce; emit the standing advisory warning.
 *   - off      : fully inert.
 * Linux-only: on macOS/Windows the extension emits a one-time inert notice
 * (confinement on those hosts is the Seatbelt leg, #707) and exports nothing.
 *
 * Trust: the mode is read from the USER settings layer only — a project layer
 * cannot weaken confinement (the same trust boundary token-meter and the
 * guard trio use). The operator escape hatch (SKIP_BASH_CONFINEMENT=1) lives
 * in the wrapper and is read from its own process env, never a repo file
 * (ADR-0146 D6).
 *
 * Observational only: exports env and notifies; never mutates a tool call,
 * never registers a tool. PI-EXTENSION-CAPABILITY: no-registerTool.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

const ENV_MODE = "PI_BASH_CONFINE";
const ENV_GRANTS_RW = "PI_CONFINE_GRANTS_RW";

type Mode = "auto" | "enforce" | "advisory" | "off";
type Probe = "full" | "partial" | "unusable";

/** Read the USER-layer mode only (project layer cannot weaken confinement). */
async function readMode(): Promise<Mode> {
  try {
    const p = join(homedir(), ".pi", "agent", "settings.json");
    const j = JSON.parse(await fs.readFile(p, "utf8")) as {
      extensionSettings?: { bashConfinement?: { mode?: unknown; enabled?: unknown } };
    };
    const s = j?.extensionSettings?.bashConfinement;
    if (s?.enabled === false) return "off";
    const m = s?.mode;
    if (m === "auto" || m === "enforce" || m === "advisory" || m === "off") return m;
    return "auto";
  } catch {
    return "auto";
  }
}

/** Read the per-host extra rw grants file (real home; deliberately outside
 * every grant so a confined child cannot widen its own grants). */
async function readExtraGrants(): Promise<string[]> {
  try {
    const p = join(homedir(), ".config", "pi", "bash-confinement-grants.conf");
    const text = await fs.readFile(p, "utf8");
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
  } catch {
    return [];
  }
}

/** Locate the vendored launcher. */
function launcherPath(): string {
  return process.env.PI_CONFINE_LAUNCHER?.trim() || join(homedir(), ".local", "bin", "landlock-run");
}

/** Probe the launcher's tri-state (the authority, not the kernel version). */
async function probe(): Promise<Probe> {
  try {
    const { stdout } = await execFileAsync(launcherPath(), ["--probe"], { timeout: 5000 });
    return /fully enforced/i.test(stdout) ? "full" : "partial";
  } catch {
    // Non-zero exit (125 = unsupported) or launcher missing.
    return "unusable";
  }
}

/** Default extension-computed rw grants beyond the worktree: the executed-
 * cache dirs ordinary dev work writes (named TOCTOU residual, ADR-0146 D4). */
function defaultGrants(): string[] {
  const home = homedir();
  return [join(home, ".cache", "pi_config"), join(home, ".npm")];
}

export default function bashConfinement(pi: ExtensionAPI): void {
  let notified = false;

  const resetPolicyEnv = (): void => {
    delete process.env[ENV_MODE];
    delete process.env[ENV_GRANTS_RW];
  };

  const noticeOnce = (ctx: ExtensionContext, text: string, level: "info" | "warning"): void => {
    if (notified || !ctx.hasUI) return;
    notified = true;
    ctx.ui.notify(`bash-confinement: ${text}`, level);
  };

  pi.on("session_start", async (_event, ctx) => {
    notified = false;
    // Session replacement reuses this process. Revoke the prior policy before
    // any async resolution or early return can expose stale grants.
    resetPolicyEnv();
    const mode: Mode = await readMode();
    if (mode === "off") return;

    if (process.platform !== "linux") {
      noticeOnce(
        ctx,
        "Linux-only (Landlock); bash-tool write confinement is inert on this host — macOS confinement is the Seatbelt leg (#707).",
        "info",
      );
      return;
    }

    const p = await probe();
    // Arming ALWAYS requires a usable probe — a kernel that cannot enforce
    // must never be reported as confined (ADR-0146 D5: enforce refuses loudly
    // rather than silently running unconfined). Mode selects intent; the
    // probe is the gate.
    const armed = (mode === "enforce" || mode === "auto") && p === "full";

    if (!armed) {
      if (mode === "enforce") {
        // Strict mode remains fail-closed when enforcement cannot be verified.
        // The wrapper recognizes this explicit state and refuses with exit 125.
        process.env[ENV_MODE] = "refuse";
        noticeOnce(
          ctx,
          `mode=enforce but the launcher probes ${p} — refusing bash calls until the probe reports full. Requires shellPath → pi-bash-sandbox to take effect. Run setup.sh or check the kernel Landlock LSM.`,
          "warning",
        );
      } else {
        noticeOnce(
          ctx,
          `advisory (launcher probes ${p}); bash writes are NOT confined. Set mode=enforce once the probe reports full.`,
          "warning",
        );
      }
      return;
    }

    // Arm: export the env contract the wrapper reads. The worktree extension
    // exports PI_SESSION_WORKTREE / PI_CONFINE_SESSION at first activation.
    process.env[ENV_MODE] = "enforce";
    const grants = [...defaultGrants(), ...(await readExtraGrants())];
    process.env[ENV_GRANTS_RW] = grants.join(":");

    // Effective only if the operator wired shellPath at this wrapper —
    // detectable but not from inside a pi extension; surface the reminder.
    noticeOnce(
      ctx,
      "write confinement armed (Landlock, enforce). Bash writes are limited to the session worktree, scratch, and granted paths. Requires shellPath → pi-bash-sandbox to take effect.",
      "info",
    );
  });

  pi.on("session_shutdown", () => {
    resetPolicyEnv();
  });
}
