/**
 * state-store.ts — operator-owned, fail-closed broker state (#916).
 *
 * State root: `${XDG_STATE_HOME:-~/.local/state}/pi/package-agent-broker/`
 * (absolute, operator-owned, outside projects and packages).
 *
 * Guarantees:
 *   - directories 0700, files 0600; ownership/type/no-follow verified on
 *     every load; symlinked, foreign-owned, or non-regular state is refused;
 *   - one authoritative state image (`state.json`): drafts, decisions,
 *     state generation, per-proposal draft revisions, closed-schema audit;
 *   - writes go through a sibling O_EXCL no-follow temp file, file fsync,
 *     atomic rename, and parent-directory fsync;
 *   - compare-and-swap on the state generation: a commit whose starting
 *     generation no longer matches the durable image is refused;
 *   - cross-process mutation lock (O_EXCL lock file) with bounded
 *     acquisition and conservative stale-lock REFUSAL (never auto-steal);
 *   - fail-closed recovery: unreadable or invalid state refuses mutations.
 *
 * Nothing in this file gives a draft authority. Rollback of this state is
 * harmless by design (ADR-0128): drafts are permanently non-authorizing.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

import {
  BOUNDS,
  STATE_SCHEMA_VERSION,
  initialBrokerState,
  type AuditEvent,
  type BrokerState,
} from "../../shared/package-agent-review-contract.ts";
import {
  GRANT_BOUNDS,
  GRANT_RECEIPT_KIND,
} from "../../shared/package-agent-grant-contract.ts";

export class StateError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | "state-integrity-refused"
      | "generation-conflict"
      | "lock-unavailable"
      | "bounds-exceeded",
  ) {
    super(message);
    this.name = "StateError";
  }
}

/** Test seam: fault-injection hooks around persistence boundaries. */
export interface StateStoreHooks {
  beforeTempWrite?: () => void;
  beforeRename?: () => void;
  afterRename?: () => void;
}

export interface StateStoreOptions {
  /** Override the state root (tests). Must be absolute. */
  rootOverride?: string;
  /** Lock acquisition attempts (default 5) and delay between them (ms). */
  lockAttempts?: number;
  lockDelayMs?: number;
  /** Age (ms) beyond which a lock is reported stale (still refused). */
  lockStaleMs?: number;
  hooks?: StateStoreHooks;
}

const DEFAULT_LOCK_ATTEMPTS = 5;
const DEFAULT_LOCK_DELAY_MS = 200;
const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000;

export function resolveStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_STATE_HOME;
  const base =
    xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".local", "state");
  const root = path.join(base, "pi", "package-agent-broker");
  if (!path.isAbsolute(root)) {
    throw new StateError("state root is not absolute", "state-integrity-refused");
  }
  return root;
}

function verifyOwnedDir(dir: string): void {
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) {
    throw new StateError("state path is not a real directory", "state-integrity-refused");
  }
  if (process.getuid && st.uid !== process.getuid()) {
    throw new StateError("state directory has unexpected ownership", "state-integrity-refused");
  }
  if ((st.mode & 0o077) !== 0) {
    throw new StateError("state directory permissions are too broad", "state-integrity-refused");
  }
}

function ensureStateRoot(root: string): void {
  // Create each missing component 0700; then verify the final directory.
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  // mkdirSync's mode does not apply to pre-existing dirs; verify, don't fix.
  verifyOwnedDir(root);
}

function sleep(ms: number): Promise<void> {
  // Async (setTimeout-based): pi's runtime is Bun-compiled, and blocking the
  // extension host's event loop on Atomics.wait has unverified semantics
  // there — so lock retries yield instead of blocking.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class StateStore {
  readonly root: string;
  private readonly opts: Required<Pick<StateStoreOptions, "lockAttempts" | "lockDelayMs" | "lockStaleMs">> & {
    hooks: StateStoreHooks;
  };

  constructor(options: StateStoreOptions = {}) {
    this.root = options.rootOverride ?? resolveStateRoot();
    if (!path.isAbsolute(this.root)) {
      throw new StateError("state root is not absolute", "state-integrity-refused");
    }
    this.opts = {
      lockAttempts: options.lockAttempts ?? DEFAULT_LOCK_ATTEMPTS,
      lockDelayMs: options.lockDelayMs ?? DEFAULT_LOCK_DELAY_MS,
      lockStaleMs: options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS,
      hooks: options.hooks ?? {},
    };
  }

  private get statePath(): string {
    return path.join(this.root, "state.json");
  }

  private get lockPath(): string {
    return path.join(this.root, "lock");
  }

  /**
   * Load the authoritative state image. Missing file yields the initial
   * state; any integrity violation is a fail-closed StateError.
   */
  load(): BrokerState {
    ensureStateRoot(this.root);
    let fd: number;
    try {
      fd = fs.openSync(this.statePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return initialBrokerState();
      if (code === "ELOOP") {
        throw new StateError("state file is a symlink", "state-integrity-refused");
      }
      throw new StateError("state file open refused", "state-integrity-refused");
    }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) {
        throw new StateError("state file is not regular", "state-integrity-refused");
      }
      if (process.getuid && st.uid !== process.getuid()) {
        throw new StateError("state file has unexpected ownership", "state-integrity-refused");
      }
      if ((st.mode & 0o077) !== 0) {
        throw new StateError("state file permissions are too broad", "state-integrity-refused");
      }
      if (st.size > BOUNDS.maxStateBytes) {
        throw new StateError("state file exceeds size bound", "bounds-exceeded");
      }
      const buf = Buffer.alloc(Number(st.size));
      let off = 0;
      while (off < buf.length) {
        const n = fs.readSync(fd, buf, off, buf.length - off, off);
        if (n <= 0) break;
        off += n;
      }
      if (off !== buf.length) {
        throw new StateError("state file changed during read", "state-integrity-refused");
      }
      return this.validateState(buf.toString("utf8"));
    } finally {
      fs.closeSync(fd);
    }
  }

  private validateState(text: string): BrokerState {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new StateError("state file is not valid JSON", "state-integrity-refused");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new StateError("state image is not an object", "state-integrity-refused");
    }
    const s = parsed as Partial<BrokerState>;
    if (s.schemaVersion !== STATE_SCHEMA_VERSION) {
      throw new StateError("unsupported state schema version", "state-integrity-refused");
    }
    if (!Number.isSafeInteger(s.generation) || (s.generation as number) < 0) {
      throw new StateError("state generation is invalid", "state-integrity-refused");
    }
    if (
      s.drafts === null || typeof s.drafts !== "object" || Array.isArray(s.drafts) ||
      s.draftRevisions === null || typeof s.draftRevisions !== "object" || Array.isArray(s.draftRevisions) ||
      !Array.isArray(s.audit) ||
      !Number.isSafeInteger(s.auditDropped)
    ) {
      throw new StateError("state image shape is invalid", "state-integrity-refused");
    }
    if (Object.keys(s.drafts as object).length > BOUNDS.maxDrafts) {
      throw new StateError("state draft count exceeds bound", "bounds-exceeded");
    }
    // `grantReceipts` was added by #928; images written before it are valid
    // and normalize to empty. Receipts are non-authorizing (the dispatch path
    // reads no file), so a missing map is a display gap, never a trust gap.
    if (s.grantReceipts === undefined) {
      s.grantReceipts = {};
    } else if (
      s.grantReceipts === null ||
      typeof s.grantReceipts !== "object" ||
      Array.isArray(s.grantReceipts)
    ) {
      throw new StateError("state grantReceipts shape is invalid", "state-integrity-refused");
    }
    if (Object.keys(s.grantReceipts).length > GRANT_BOUNDS.maxGrantReceipts) {
      throw new StateError("state receipt count exceeds bound", "bounds-exceeded");
    }
    // Structural check mirroring the draft contract check below: a receipt
    // that claims to be authorizing is refused outright. This is defence in
    // depth — nothing reads receipts for authorization — but a state image
    // asserting the opposite is evidence of tampering and must not load.
    for (const [qid, receipt] of Object.entries(s.grantReceipts as Record<string, unknown>)) {
      const r = receipt as { kind?: unknown; authorizing?: unknown; terminal?: unknown };
      if (r === null || typeof r !== "object" || r.kind !== GRANT_RECEIPT_KIND || r.authorizing !== false) {
        throw new StateError(
          `state receipt ${JSON.stringify(qid)} violates the non-authorizing contract`,
          "state-integrity-refused",
        );
      }
      // The #929 terminal stamp is evidence only, but a malformed one is the
      // same tampering signal as a flipped `authorizing` flag: refuse it.
      if (r.terminal !== undefined && r.terminal !== null) {
        const t = r.terminal as { state?: unknown; atMs?: unknown };
        if (
          typeof t !== "object" ||
          (t.state !== "revoked" && t.state !== "expired") ||
          !Number.isSafeInteger(t.atMs) ||
          (t.atMs as number) <= 0
        ) {
          throw new StateError(
            `state receipt ${JSON.stringify(qid)} terminal stamp is malformed`,
            "state-integrity-refused",
          );
        }
      }
    }

    // Deep draft validation is intentionally shallow here: drafts are
    // non-authorizing display data; #917 must never consume them. Structural
    // integrity (kind/activatable flags) is still enforced.
    for (const [qid, draft] of Object.entries(s.drafts as Record<string, unknown>)) {
      const d = draft as { kind?: unknown; activatable?: unknown; authorizationDigest?: unknown };
      if (
        d === null || typeof d !== "object" ||
        d.kind !== "package-agent-review-draft" ||
        d.activatable !== false ||
        d.authorizationDigest !== null
      ) {
        throw new StateError(
          `state draft ${JSON.stringify(qid)} violates the non-authorizing contract`,
          "state-integrity-refused",
        );
      }
    }
    return s as BrokerState;
  }

  /**
   * Acquire the cross-process mutation lock. Bounded attempts; a persistent
   * or stale lock is REFUSED with guidance, never stolen.
   */
  private async acquireLock(): Promise<void> {
    ensureStateRoot(this.root);
    for (let attempt = 0; attempt < this.opts.lockAttempts; attempt++) {
      try {
        const fd = fs.openSync(
          this.lockPath,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
          0o600,
        );
        try {
          fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new StateError("lock file creation refused", "lock-unavailable");
        }
        if (attempt < this.opts.lockAttempts - 1) await sleep(this.opts.lockDelayMs);
      }
    }
    let staleNote = "";
    try {
      const st = fs.lstatSync(this.lockPath);
      if (Date.now() - st.mtimeMs > this.opts.lockStaleMs) {
        staleNote = ` (lock appears stale; if no other pi process is running, remove ${this.lockPath} manually)`;
      }
    } catch {
      // lock vanished between attempts — still refuse; caller may retry.
    }
    throw new StateError(`mutation lock unavailable${staleNote}`, "lock-unavailable");
  }

  private releaseLock(): void {
    try {
      fs.unlinkSync(this.lockPath);
    } catch {
      // Already gone: nothing to release.
    }
  }

  /**
   * Run `mutate` under the cross-process lock with generation CAS.
   *
   * The callback receives the freshly reloaded authoritative state and the
   * caller's expected starting generation is compared against it; a mismatch
   * refuses the commit. The callback returns the next state (generation is
   * advanced here, not by the callback).
   */
  async commit(
    expectedGeneration: number,
    mutate: (current: BrokerState) => BrokerState,
  ): Promise<BrokerState> {
    await this.acquireLock();
    try {
      const current = this.load();
      if (current.generation !== expectedGeneration) {
        throw new StateError(
          `state generation moved (expected ${expectedGeneration}, found ${current.generation})`,
          "generation-conflict",
        );
      }
      const next = mutate(current);
      next.generation = current.generation + 1;
      this.persist(next);
      return next;
    } finally {
      this.releaseLock();
    }
  }

  /** Append an audit event and persist, without generation preconditions. */
  async appendAudit(event: AuditEvent): Promise<void> {
    await this.appendEvidence((current) => {
      pushAudit(current, event);
    });
  }

  /**
   * Apply a NON-AUTHORIZING evidence mutation under the store lock, without
   * generation preconditions — the same class of write as `appendAudit`,
   * generalized so #929 can stamp lifecycle audit events and receipt
   * terminal fields in one persisted image.
   *
   * The callback receives only the `EvidenceImage` projection, so touching
   * anything an operator decision depends on — drafts, draft revisions — is
   * a compile error, not a comment violation. Those fields go through
   * `commit` and its generation CAS, so a concurrent operator flow still
   * conflicts loudly instead of being silently overwritten.
   */
  async appendEvidence(mutate: (current: EvidenceImage) => void): Promise<void> {
    await this.acquireLock();
    try {
      const current = this.load();
      mutate(current);
      current.generation = current.generation + 1;
      this.persist(current);
    } finally {
      this.releaseLock();
    }
  }

  private persist(state: BrokerState): void {
    // Cheap structural pre-check before serializing: a state image can only
    // grow through bounded per-draft fields, so refuse an over-count image
    // before materializing a large JSON string.
    if (Object.keys(state.drafts).length > BOUNDS.maxDrafts) {
      throw new StateError("state draft count exceeds bound", "bounds-exceeded");
    }
    if (Object.keys(state.grantReceipts ?? {}).length > GRANT_BOUNDS.maxGrantReceipts) {
      throw new StateError("state receipt count exceeds bound", "bounds-exceeded");
    }
    const text = JSON.stringify(state);
    if (Buffer.byteLength(text, "utf8") > BOUNDS.maxStateBytes) {
      throw new StateError("state image exceeds size bound", "bounds-exceeded");
    }
    const tmpPath = path.join(
      this.root,
      `state.json.tmp.${process.pid}.${randomBytes(6).toString("hex")}`,
    );
    this.opts.hooks.beforeTempWrite?.();
    const fd = fs.openSync(
      tmpPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fs.writeSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      this.opts.hooks.beforeRename?.();
      fs.renameSync(tmpPath, this.statePath);
      this.opts.hooks.afterRename?.();
    } catch (err) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // best-effort temp cleanup
      }
      throw err;
    }
    const dirFd = fs.openSync(this.root, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  }
}

/**
 * The evidence-only writable projection of the state image: the audit trail
 * and the non-authorizing receipt map. `appendEvidence` exposes exactly this
 * to its callers, so the no-CAS path structurally cannot reach the
 * CAS-protected operator-decision fields (drafts, draft revisions).
 */
export type EvidenceImage = Pick<BrokerState, "audit" | "auditDropped" | "grantReceipts">;

/** Append an audit event to a state image, enforcing the retention cap. */
export function pushAudit(state: Pick<BrokerState, "audit" | "auditDropped">, event: AuditEvent): void {
  state.audit.push(event);
  while (state.audit.length > BOUNDS.maxAuditEvents) {
    state.audit.shift();
    state.auditDropped += 1;
  }
}
