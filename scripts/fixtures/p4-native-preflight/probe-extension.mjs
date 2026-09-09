// A2/P4 installed-pi probe. Test-only scenario controls never enter production.
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";

import {
  PRODUCTION_NATIVE_POLICY,
  loadExpertiseNativeRuntime,
  testExpertiseNativePreflight,
  testExpertiseSqlLoaderDenied,
} from "../../../agent/extensions/shared/expertise-native-runtime.ts";

const hash = (value) => createHash("sha256").update(value).digest("hex");

// Every ELF mutation below targets a byte offset measured from the pinned
// vec0.so (readelf -l / -V). expectWord() asserts the field still holds the
// measured value before it is overwritten, so a re-vendored artifact fails the
// fixture with a re-measure message instead of silently mutating a different
// field and hitting a different guard.
function expectWord(bytes, offset, width, expected, what) {
  const actual = width === 8 ? bytes.readBigUInt64LE(offset) : width === 2 ? bytes.readUInt16LE(offset) : bytes.readUInt32LE(offset);
  if (BigInt(actual) !== BigInt(expected)) {
    throw new Error(`fixture offset ${offset} (${what}) holds 0x${BigInt(actual).toString(16)}, expected 0x${BigInt(expected).toString(16)}; re-measure after re-vendoring the artifact`);
  }
}
const PT_GNU_STACK = 0x6474e551;
const PT_GNU_RELRO = 0x6474e552;
const DYNAMIC_VADDR = 0x31dd0n; // phdr[2] (PT_DYNAMIC) p_vaddr at file offset 192
const VN0_CNT = 0x1cf2; // verneed[0].vn_cnt (measured 1)
const VN0_NEXT = 0x1cfc; // verneed[0].vn_next (measured 32)
const VNA0_NEXT = 0x1d0c; // vernaux[0].vna_next (measured 0)
const VN1_NEXT = 0x1d1c; // verneed[1].vn_next (measured 0, chain end)
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
};
const canonicalBytes = (value) => `${JSON.stringify(canonical(value))}\n`;

function paths(root) {
  const generation = PRODUCTION_NATIVE_POLICY.generation;
  const generationRoot = join(root, "generations", generation);
  return {
    selector: join(root, "current-generation"),
    manifest: join(generationRoot, "manifest.json"),
    artifact: join(generationRoot, PRODUCTION_NATIVE_POLICY.artifact.path),
  };
}

function refreshPolicy(root, policy, refreshArtifact = false) {
  const target = paths(root);
  const manifestSha256 = hash(readFileSync(target.manifest));
  const selector = {
    generation: policy.generation,
    manifestSha256,
    schemaVersion: 1,
  };
  writeFileSync(target.selector, canonicalBytes(selector), { mode: 0o600 });
  chmodSync(target.selector, 0o600);
  const next = {
    ...policy,
    manifestSha256,
    selectorSha256: hash(readFileSync(target.selector)),
  };
  if (refreshArtifact) {
    const artifact = readFileSync(target.artifact);
    next.artifact = { ...policy.artifact, sha256: hash(artifact), size: artifact.length };
  }
  return next;
}

function rewriteManifest(root, mutate) {
  const target = paths(root);
  const manifest = JSON.parse(readFileSync(target.manifest, "utf8"));
  mutate(manifest);
  writeFileSync(target.manifest, canonicalBytes(manifest), { mode: 0o600 });
  chmodSync(target.manifest, 0o600);
}

function mutateArtifactAndManifest(root, mutateBytes) {
  const target = paths(root);
  const changed = mutateBytes(Buffer.from(readFileSync(target.artifact)));
  writeFileSync(target.artifact, changed, { mode: 0o600 });
  chmodSync(target.artifact, 0o600);
  rewriteManifest(root, (manifest) => {
    manifest.files[0].sha256 = hash(changed);
    manifest.files[0].size = changed.length;
  });
}

function fakeDatabase(calls, pathsSeen, options = {}) {
  let beforeSqliteDone = false;
  return {
    query(sql) {
      return {
        get() {
          if (sql === "select sqlite_version() AS version") {
            if (!beforeSqliteDone && options.beforeSqlite) options.beforeSqlite();
            beforeSqliteDone = true;
            return { version: options.sqliteVersion ?? "3.51.2" };
          }
          if (sql.includes("load_extension(")) {
            // A loader that reached the path returns a row; a loader that is
            // enabled but cannot open the fixed nonexistent path throws the
            // dlopen failure real SQLite reports. Only the authorizer refusal
            // is the accepted state.
            if (options.sqlLoaderReturnsRow) return { loaded: 1 };
            if (options.sqlLoaderThrowsDlopen) throw new Error("/p4-must-remain-unauthorized.so: cannot open shared object file: No such file or directory");
            throw new Error("not authorized");
          }
          if (sql === "select vec_version() AS version") return { version: "v0.1.9" };
          throw new Error(`unexpected SQL in P4 fixture: ${sql}`);
        },
      };
    },
    loadExtension(path) {
      calls.count += 1;
      pathsSeen.push(path);
      if (options.loaderThrows) throw new Error("fixture loader failure");
    },
  };
}

// Runtime facts for the seam legs. Platform, arch, glibc, and the pi executable
// identity are synthetic so the legs run on every CI lane. The Bun version is
// always live, and the SQLite version is live on Linux (Bun embeds SQLite there;
// macOS Bun links the system library), so a pi bump that changes either goes
// red on every lane instead of only on the ARM64 production legs.
function liveSqliteVersion() {
  if (process.platform !== "linux") return "3.51.2";
  const probe = new Database(":memory:");
  try { return probe.query("select sqlite_version() AS version").get().version; }
  finally { probe.close(); }
}
function testRuntimeFacts() {
  return {
    platform: "linux",
    arch: "arm64",
    bun: process.versions.bun ?? "",
    glibc: "2.41",
    sqlite: liveSqliteVersion(),
    piExecutablePath: join(process.env.P4_TRUSTED_HOME, PRODUCTION_NATIVE_POLICY.piExecutableRelativePath),
    piExecutableSha256: PRODUCTION_NATIVE_POLICY.piExecutableSha256,
  };
}

function prepareScenario(baseRoot, scenarioRoot, scenario) {
  cpSync(baseRoot, scenarioRoot, { recursive: true, force: false, errorOnExist: true });
  chmodSync(scenarioRoot, 0o700);
  let policy = structuredClone(PRODUCTION_NATIVE_POLICY);
  let expectedUid = process.geteuid();
  const runtime = testRuntimeFacts();
  const target = paths(scenarioRoot);
  const generationRoot = dirname(dirname(dirname(target.artifact)));
  for (const directory of [
    join(scenarioRoot, "generations"),
    generationRoot,
    join(generationRoot, "native"),
    join(generationRoot, "native", "sqlite-vec"),
  ]) chmodSync(directory, 0o700);

  switch (scenario) {
    case "valid_spy":
    case "loader_failure":
    case "final_recheck":
    case "sql_loader_enabled":
    case "sql_loader_state":
    case "writable_ancestor":
      break;
    case "wrong_mode":
      chmodSync(target.artifact, 0o644);
      break;
    case "wrong_type":
      rmSync(target.artifact);
      mkdirSync(target.artifact, { mode: 0o700 });
      break;
    case "symlink_artifact": {
      const moved = `${scenarioRoot}.artifact`;
      renameSync(target.artifact, moved);
      symlinkSync(moved, target.artifact);
      break;
    }
    case "hard_link":
      linkSync(target.artifact, `${scenarioRoot}.hardlink`);
      break;
    case "digest_mismatch": {
      const bytes = Buffer.from(readFileSync(target.artifact));
      bytes[bytes.length - 1] ^= 1;
      writeFileSync(target.artifact, bytes, { mode: 0o600 });
      break;
    }
    case "wrong_class":
      mutateArtifactAndManifest(scenarioRoot, (bytes) => { bytes[4] = 1; return bytes; });
      policy = refreshPolicy(scenarioRoot, policy, true);
      break;
    case "wrong_endian":
      mutateArtifactAndManifest(scenarioRoot, (bytes) => { bytes[5] = 2; return bytes; });
      policy = refreshPolicy(scenarioRoot, policy, true);
      break;
    case "wrong_osabi":
      mutateArtifactAndManifest(scenarioRoot, (bytes) => { bytes[7] = 3; return bytes; });
      policy = refreshPolicy(scenarioRoot, policy, true);
      break;
    case "wrong_abi_version":
      mutateArtifactAndManifest(scenarioRoot, (bytes) => { bytes[8] = 1; return bytes; });
      policy = refreshPolicy(scenarioRoot, policy, true);
      break;
    case "wrong_machine":
      mutateArtifactAndManifest(scenarioRoot, (bytes) => {
        bytes.writeUInt16LE(62, 18);
        return bytes;
      });
      policy = refreshPolicy(scenarioRoot, policy, true);
      break;
    case "truncated_elf":
      mutateArtifactAndManifest(scenarioRoot, (bytes) => bytes.subarray(0, 40));
      policy = refreshPolicy(scenarioRoot, policy, true);
      break;
    case "unexpected_dependency":
      mutateArtifactAndManifest(scenarioRoot, (bytes) => {
        const needle = Buffer.from("libc.so.6\0");
        const offset = bytes.indexOf(needle);
        if (offset < 0) throw new Error("fixture cannot locate libc dependency string");
        Buffer.from("libx.so.6\0").copy(bytes, offset);
        return bytes;
      });
      policy = refreshPolicy(scenarioRoot, policy, true);
      break;
    case "wrong_symbol_version":
      mutateArtifactAndManifest(scenarioRoot, (bytes) => {
        const needle = Buffer.from("GLIBC_2.17\0");
        const offset = bytes.indexOf(needle);
        if (offset < 0) throw new Error("fixture cannot locate GLIBC version string");
        Buffer.from("GLIBC_9.99\0").copy(bytes, offset);
        return bytes;
      });
      policy = refreshPolicy(scenarioRoot, policy, true);
      break;
    case "dynamic_outside_load":
      mutateArtifactAndManifest(scenarioRoot, (bytes) => {
        expectWord(bytes, 192, 8, DYNAMIC_VADDR, "PT_DYNAMIC p_vaddr");
        bytes.writeBigUInt64LE(0x400000n, 192);
        return bytes;
      });
      policy = refreshPolicy(scenarioRoot, policy, true);
      break;
    case "missing_gnu_stack":
      mutateArtifactAndManifest(scenarioRoot, (bytes) => {
        expectWord(bytes, 344, 4, PT_GNU_STACK, "phdr[5] p_type PT_GNU_STACK");
        bytes.writeUInt32LE(4, 344); // PT_NOTE
        return bytes;
      });
      policy = refreshPolicy(scenarioRoot, policy, true);
      break;
    case "duplicate_gnu_stack":
      mutateArtifactAndManifest(scenarioRoot, (bytes) => {
        expectWord(bytes, 400, 4, PT_GNU_RELRO, "phdr[6] p_type PT_GNU_RELRO");
        bytes.writeUInt32LE(PT_GNU_STACK, 400);
        return bytes;
      });
      policy = refreshPolicy(scenarioRoot, policy, true);
      break;
    case "executable_gnu_stack":
      mutateArtifactAndManifest(scenarioRoot, (bytes) => {
        expectWord(bytes, 348, 4, 6, "phdr[5] p_flags RW");
        bytes.writeUInt32LE(7, 348); // RWX
        return bytes;
      });
      policy = refreshPolicy(scenarioRoot, policy, true);
      break;
    case "version_need_overlap":
      mutateArtifactAndManifest(scenarioRoot, (bytes) => {
        expectWord(bytes, VN0_NEXT, 4, 32, "verneed[0].vn_next");
        bytes.writeUInt32LE(16, VN0_NEXT); // lands on vernaux[0]
        return bytes;
      });
      policy = refreshPolicy(scenarioRoot, policy, true);
      break;
    case "version_need_misaligned":
      mutateArtifactAndManifest(scenarioRoot, (bytes) => {
        expectWord(bytes, VN0_NEXT, 4, 32, "verneed[0].vn_next");
        bytes.writeUInt32LE(18, VN0_NEXT);
        return bytes;
      });
      policy = refreshPolicy(scenarioRoot, policy, true);
      break;
    case "version_aux_misaligned":
      mutateArtifactAndManifest(scenarioRoot, (bytes) => {
        expectWord(bytes, VN0_CNT, 2, 1, "verneed[0].vn_cnt");
        expectWord(bytes, VNA0_NEXT, 4, 0, "vernaux[0].vna_next");
        bytes.writeUInt16LE(2, VN0_CNT);
        bytes.writeUInt32LE(18, VNA0_NEXT);
        return bytes;
      });
      policy = refreshPolicy(scenarioRoot, policy, true);
      break;
    case "version_need_unterminated":
      mutateArtifactAndManifest(scenarioRoot, (bytes) => {
        expectWord(bytes, VN1_NEXT, 4, 0, "verneed[1].vn_next");
        bytes.writeUInt32LE(4, VN1_NEXT);
        return bytes;
      });
      policy = refreshPolicy(scenarioRoot, policy, true);
      break;
    case "version_aux_unterminated":
      mutateArtifactAndManifest(scenarioRoot, (bytes) => {
        expectWord(bytes, VNA0_NEXT, 4, 0, "vernaux[0].vna_next");
        bytes.writeUInt32LE(4, VNA0_NEXT);
        return bytes;
      });
      policy = refreshPolicy(scenarioRoot, policy, true);
      break;
    case "wrong_manifest_compatibility":
      rewriteManifest(scenarioRoot, (manifest) => { manifest.compatibility.bun = "9.9.9"; });
      policy = refreshPolicy(scenarioRoot, policy, false);
      break;
    case "wrong_runtime_bun":
      runtime.bun = "9.9.9";
      break;
    case "wrong_runtime_arch":
      runtime.arch = "x64";
      break;
    case "wrong_runtime_glibc":
      runtime.glibc = "2.40";
      break;
    case "wrong_runtime_pi_digest":
      runtime.piExecutableSha256 = "0".repeat(64);
      break;
    case "wrong_runtime_sqlite":
      runtime.sqlite = "3.50.0";
      break;
    case "wrong_owner_ancestor":
      // An unprivileged harness cannot chown, so this only proves the ancestor
      // walk refuses a foreign-owned directory (the real home). Runtime-tree
      // owner checks need a second uid (#1108).
      expectedUid += 1;
      break;
    case "extra_inventory":
      writeFileSync(join(dirname(target.artifact), "unexpected"), "x", { mode: 0o600 });
      break;
    case "symlink_root": {
      const moved = `${scenarioRoot}.real`;
      renameSync(scenarioRoot, moved);
      symlinkSync(moved, scenarioRoot);
      break;
    }
    default:
      throw new Error(`unknown P4 scenario: ${scenario}`);
  }
  return { policy, runtime, expectedUid };
}

async function runScenario(scenario) {
  const calls = { count: 0 };
  const pathsSeen = [];
  if (scenario.startsWith("production_")) {
    // Production legs drive loadExpertiseNativeRuntime() against the real
    // passwd-home installation with a real bun:sqlite connection. The wrapper
    // only counts loader calls and, for the two SQL-loader legs, replaces the
    // fixed denied statement's outcome with the state under test.
    const real = new Database(":memory:");
    const database = {
      query(sql) {
        if (sql.includes("load_extension(")) {
          if (scenario === "production_sql_loader_enabled") return { get: () => ({ loaded: 1 }) };
          if (scenario === "production_sql_loader_state") {
            return { get: () => { throw new Error("/p4-must-remain-unauthorized.so: cannot open shared object file: No such file or directory"); } };
          }
        }
        return real.query(sql);
      },
      loadExtension(path) {
        calls.count += 1;
        pathsSeen.push(path);
        if (scenario === "production_loader_failure_retry") throw new Error("fixture loader failure");
        real.loadExtension(path);
      },
    };
    try {
      if (scenario === "production_sql_loader_enabled" || scenario === "production_sql_loader_state") {
        const expected = scenario === "production_sql_loader_enabled" ? "P4_SQL_LOADER_ENABLED" : "P4_SQL_LOADER_STATE";
        let code = "accepted";
        try { loadExpertiseNativeRuntime(database); }
        catch (error) { code = error?.code ?? "UNCLASSIFIED"; }
        return { ok: code === expected, code, calls: calls.count, paths: pathsSeen };
      }
      if (scenario === "production_loader_failure_retry") {
        let firstCode = "accepted";
        let secondCode = "accepted";
        try { loadExpertiseNativeRuntime(database); }
        catch (error) { firstCode = error?.code ?? "UNCLASSIFIED"; }
        try { loadExpertiseNativeRuntime(database); }
        catch (error) { secondCode = error?.code ?? "UNCLASSIFIED"; }
        if (firstCode !== "P4_LOAD_FAILED" || secondCode !== "P4_ALREADY_INITIALIZED" || calls.count !== 1) {
          return { ok: false, code: "P4_FAILURE_RETRY_PROBE", calls: calls.count, paths: pathsSeen };
        }
        return { ok: true, code: "ok", calls: calls.count, paths: pathsSeen };
      }
      const result = loadExpertiseNativeRuntime(database);
      let secondCode = "accepted";
      try { loadExpertiseNativeRuntime(database); }
      catch (error) { secondCode = error?.code ?? "UNCLASSIFIED"; }
      if (secondCode !== "P4_ALREADY_INITIALIZED" || calls.count !== 1) {
        return { ok: false, code: "P4_CARDINALITY_PROBE", calls: calls.count, paths: pathsSeen };
      }
      return { ok: true, code: "ok", calls: calls.count, paths: pathsSeen, result };
    } catch (error) {
      return { ok: false, code: error?.code ?? "UNCLASSIFIED", calls: calls.count, paths: pathsSeen };
    } finally {
      real.close();
    }
  }

  const baseRoot = process.env.P4_BASE_ROOT;
  const scratch = process.env.P4_SCENARIO_ROOT;
  const trustedHome = process.env.P4_TRUSTED_HOME;
  if (!baseRoot || !scratch || !trustedHome) throw new Error("P4 fixture paths are required");
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(dirname(scratch), { recursive: true, mode: 0o700 });
  const prepared = prepareScenario(baseRoot, scratch, scenario);
  const scenarioArtifact = paths(scratch).artifact;
  const database = fakeDatabase(calls, pathsSeen, {
    loaderThrows: scenario === "loader_failure",
    sqlLoaderReturnsRow: scenario === "sql_loader_enabled",
    sqlLoaderThrowsDlopen: scenario === "sql_loader_state",
  });
  const beforeFinalPathCheck = scenario === "final_recheck"
    ? () => {
        const replacement = `${scenarioArtifact}.replacement`;
        copyFileSync(scenarioArtifact, replacement);
        chmodSync(replacement, 0o600);
        renameSync(replacement, scenarioArtifact);
      }
    : undefined;
  if (scenario === "writable_ancestor") chmodSync(dirname(trustedHome), 0o770);
  try {
    const verified = testExpertiseNativePreflight({
      runtimeRoot: scratch,
      trustedHome: realpathSync(trustedHome),
      expectedUid: prepared.expectedUid,
      policy: prepared.policy,
      runtime: () => prepared.runtime,
      beforeFinalPathCheck,
    });
    if (Object.keys(verified).sort().join(",") !== "generation,version") {
      throw Object.assign(new Error("P4_TEST_SEAM_SHAPE"), { code: "P4_TEST_SEAM_SHAPE" });
    }
    // The seam carries no loader. The SQL-denial probe is the module's own
    // (exported test seam); the single loadExtension() call below is the
    // fixture's, standing in for the production initializer's one call, so
    // `calls` on this path measures the fixture, not the module.
    testExpertiseSqlLoaderDenied(database);
    try { database.loadExtension(scenarioArtifact); }
    catch { throw Object.assign(new Error("P4_LOAD_FAILED"), { code: "P4_LOAD_FAILED" }); }
    const version = database.query("select vec_version() AS version").get()?.version;
    if (version !== verified.version) throw Object.assign(new Error("P4_VEC_VERSION"), { code: "P4_VEC_VERSION" });
    testExpertiseSqlLoaderDenied(database);
    const result = { generation: verified.generation, version: verified.version };
    return { ok: true, code: "ok", calls: calls.count, paths: pathsSeen, result };
  } catch (error) {
    return { ok: false, code: error?.code ?? "UNCLASSIFIED", calls: calls.count, paths: pathsSeen };
  } finally {
    if (scenario === "hard_link") rmSync(`${scratch}.hardlink`, { force: true });
    if (scenario === "symlink_artifact") rmSync(`${scratch}.artifact`, { force: true });
    if (scenario === "symlink_root") rmSync(`${scratch}.real`, { recursive: true, force: true });
    if (scenario === "writable_ancestor") chmodSync(dirname(trustedHome), 0o700);
  }
}

export default function p4NativePreflightProbe(pi) {
  pi.registerCommand("p4-probe", {
    description: "Run one deterministic P4 native-preflight scenario",
    handler: async (args) => {
      const output = process.env.P4_PROBE_OUT;
      if (!output) throw new Error("P4_PROBE_OUT is required");
      const result = await runScenario(args.trim());
      writeFileSync(output, `${JSON.stringify(result)}\n`, { mode: 0o600 });
    },
  });
}
