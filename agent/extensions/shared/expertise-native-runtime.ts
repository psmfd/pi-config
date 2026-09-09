/**
 * Private A2/P4 sqlite-vec native preflight (ADR-0156).
 *
 * This module registers no tool and accepts no model-, project-, manifest-, or
 * environment-selected path. The production entry derives the passwd home and
 * validates the installed tree against the single code-owned policy: the
 * installed selector, manifest, and artifact must match the digests that policy
 * pins. Tests use the explicitly named test seams below; production callers
 * must use loadExpertiseNativeRuntime().
 *
 * Every refusal throws NativePreflightError with a stable P4_* code. Codes that
 * end in _STATE or name a runtime probe (P4_RUNTIME_*) classify failures of the
 * production host, not of the installed tree.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface NativeDatabase {
  loadExtension(path: string): void;
  query(sql: string): { get(...parameters: unknown[]): unknown };
}

export interface NativeRuntimeFacts {
  platform: string;
  arch: string;
  bun: string;
  glibc: string | null;
  sqlite: string;
  piExecutablePath: string;
  piExecutableSha256: string;
}

export interface NativePolicy {
  generation: string;
  manifestSha256: string;
  selectorSha256: string;
  platform: { os: string; arch: string };
  compatibility: { pi: string; bun: string; sqlite: string };
  piExecutableRelativePath: string;
  piExecutableSha256: string;
  glibc: string;
  artifact: { path: string; sha256: string; size: number; version: string };
  elf: {
    osAbi: number;
    abiVersion: number;
    machine: number;
    programHeaderCount: number;
    needed: readonly string[];
    soname: string | null;
    versionNeeds: Readonly<Record<string, readonly string[]>>;
  };
}

export class NativePreflightError extends Error {
  readonly code: string;
  /** Optional operator-facing detail; never a file's contents, only a basename or count. */
  readonly detail: string | null;
  constructor(code: string, detail: string | null = null) {
    super(detail === null ? code : `${code}: ${detail}`);
    this.name = "NativePreflightError";
    this.code = code;
    this.detail = detail;
  }
}

const fail = (code: string, detail?: string): never => { throw new NativePreflightError(code, detail ?? null); };
const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const modeOf = (metadata: Stats): number => metadata.mode & 0o7777;

/**
 * The only approved P4 policy. The installed selector and manifest must hash to
 * the digests pinned here; a second generation needs its own policy and the
 * generation-identity work tracked in #1102 and #1105 before it can be selected.
 */
export const PRODUCTION_NATIVE_POLICY: NativePolicy = Object.freeze({
  generation: "v1-linux-arm64-sqlite-vec-v0.1.9-0b84cbd06418",
  manifestSha256: "d55c4704f873bd1e386cb37dbb34cdab1f910e178528b10538ec9fcdd6dadbb2",
  selectorSha256: "f2de195583b7d7038c721978a3916881ecf989ad759d7810475fb6198bc2a4c6",
  platform: Object.freeze({ os: "linux", arch: "arm64" }),
  compatibility: Object.freeze({ pi: "v0.84.2-psmfd.1", bun: "1.3.10", sqlite: "3.51.2" }),
  piExecutableRelativePath: ".cache/pi_config/pi-v0.84.2-psmfd.1/pi/pi",
  piExecutableSha256: "f7fe24a7b54249bd25c94e4f00635325606c823a2cfe6ae6798e653c33fcf55a",
  glibc: "2.41",
  artifact: Object.freeze({
    path: "native/sqlite-vec/vec0.so",
    sha256: "0b84cbd06418ca3040827deddd650539be05be0f657952426b926c8606217437",
    size: 156520,
    version: "v0.1.9",
  }),
  elf: Object.freeze({
    osAbi: 0,
    abiVersion: 0,
    machine: 183,
    programHeaderCount: 7,
    needed: Object.freeze(["ld-linux-aarch64.so.1", "libc.so.6"]),
    soname: null,
    versionNeeds: Object.freeze({
      "ld-linux-aarch64.so.1": Object.freeze(["GLIBC_2.17"]),
      "libc.so.6": Object.freeze(["GLIBC_2.17"]),
    }),
  }),
});

const exactKeys = (value: unknown, expected: readonly string[], code: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(code);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(code);
  return record;
};

const parseJson = (bytes: Buffer, code: string): unknown => {
  if (bytes.includes(0)) fail(code);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    return fail(code);
  }
};

const inspectDirectory = (path: string, uid: number, exactMode: number | null, label: string): Stats => {
  let metadata: Stats;
  try { metadata = lstatSync(path); } catch { return fail(`${label}_MISSING`); }
  if (metadata.isSymbolicLink()) fail(`${label}_SYMLINK`);
  if (!metadata.isDirectory()) fail(`${label}_TYPE`);
  if (metadata.uid !== uid) fail("P4_PATH_OWNER");
  if (exactMode === null) {
    if ((modeOf(metadata) & 0o022) !== 0) fail("P4_PATH_WRITABLE");
  } else if (modeOf(metadata) !== exactMode) fail(`${label}_MODE`);
  return metadata;
};

const inspectFile = (path: string, uid: number, mode: number, label: string): Stats => {
  let metadata: Stats;
  try { metadata = lstatSync(path); } catch { return fail(`${label}_MISSING`); }
  if (metadata.isSymbolicLink()) fail(`${label}_SYMLINK`);
  if (!metadata.isFile()) fail(`${label}_TYPE`);
  if (metadata.uid !== uid) fail("P4_PATH_OWNER");
  if (modeOf(metadata) !== mode) fail(`${label}_MODE`);
  if (metadata.nlink !== 1) fail(`${label}_LINKS`);
  return metadata;
};

const assertContained = (candidate: string, parent: string, code: string): void => {
  const rel = relative(parent, candidate);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail(code);
};

const inspectTrustedAncestor = (path: string, uid: number): void => {
  let metadata: Stats;
  try { metadata = lstatSync(path); } catch { return fail("P4_ANCESTOR_MISSING"); }
  if (metadata.isSymbolicLink()) fail("P4_ANCESTOR_SYMLINK");
  if (!metadata.isDirectory()) fail("P4_ANCESTOR_TYPE");
  if (metadata.uid !== 0 && metadata.uid !== uid) fail("P4_PATH_OWNER");
  if ((modeOf(metadata) & 0o022) !== 0) fail("P4_PATH_WRITABLE");
};

const validatePathChain = (runtimeRoot: string, trustedHome: string, uid: number): void => {
  if (!isAbsolute(runtimeRoot) || !isAbsolute(trustedHome)) fail("P4_ROOT_ABSOLUTE");
  const home = resolve(trustedHome);
  const root = resolve(runtimeRoot);
  assertContained(root, home, "P4_ROOT_CONTAINMENT");
  let ancestor: string = sep;
  inspectTrustedAncestor(ancestor, uid);
  const homeParts = home.split(sep).filter(Boolean);
  for (let index = 0; index < homeParts.length - 1; index += 1) {
    ancestor = join(ancestor, homeParts[index]);
    inspectTrustedAncestor(ancestor, uid);
  }
  inspectDirectory(home, uid, null, "P4_HOME");
  let current = home;
  for (const component of relative(home, root).split(sep)) {
    current = join(current, component);
    inspectDirectory(current, uid, current === root ? 0o700 : null, current === root ? "P4_ROOT" : "P4_PATH");
  }
  let canonical: string;
  try { canonical = realpathSync(root); } catch { return fail("P4_ROOT_CANONICAL"); }
  if (canonical !== root) fail("P4_ROOT_CANONICAL");
};

/**
 * Open a regular file with O_NOFOLLOW, verify owner/mode/link count/size on
 * the descriptor, and read it from that descriptor. The same shape the artifact
 * read uses, so the selector and manifest cannot be swapped for a symlink
 * between their lstat and their read.
 */
const readVerifiedFile = (path: string, uid: number, mode: number, maximum: number, label: string): Buffer => {
  if (typeof constants.O_NOFOLLOW !== "number") fail("P4_NOFOLLOW_UNAVAILABLE");
  let descriptor: number;
  try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { return fail(`${label}_OPEN`); }
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) fail(`${label}_TYPE`);
    if (opened.uid !== uid) fail("P4_PATH_OWNER");
    if (modeOf(opened) !== mode) fail(`${label}_MODE`);
    if (opened.nlink !== 1) fail(`${label}_LINKS`);
    if (opened.size === 0 || opened.size > maximum) fail(`${label}_SIZE`);
    const bytes = readFileSync(descriptor);
    if (bytes.length !== opened.size) fail(`${label}_SIZE`);
    return bytes;
  } finally { closeSync(descriptor); }
};

const sortedNames = (path: string): string[] => readdirSync(path).sort();
const equalStrings = (actual: readonly string[], expected: readonly string[]): boolean =>
  actual.length === expected.length && actual.every((value, index) => value === expected[index]);

/** Closed-inventory check that names the offending basenames in the refusal detail. */
const assertInventory = (path: string, expected: readonly string[], code: string): void => {
  const actual = sortedNames(path);
  const wanted = [...expected].sort();
  if (equalStrings(actual, wanted)) return;
  const unexpected = actual.filter((name) => !wanted.includes(name)).map((name) => `unexpected ${JSON.stringify(name)}`);
  const missing = wanted.filter((name) => !actual.includes(name)).map((name) => `missing ${JSON.stringify(name)}`);
  fail(code, [...unexpected, ...missing].join(", "));
};

interface LoadSegment { offset: number; vaddr: number; filesz: number; }
interface DynamicProfile { needed: string[]; soname: string | null; versionNeeds: Record<string, string[]>; }

const safeNumber = (value: bigint, code: string): number => {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail(code);
  return Number(value);
};
const range = (offset: number, length: number, limit: number, code: string): void => {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > limit || length > limit - offset) fail(code);
};
const cString = (bytes: Buffer, offset: number, limit: number, code: string): string => {
  range(offset, 1, limit, code);
  const end = bytes.indexOf(0, offset);
  if (end < 0 || end >= limit) fail(code);
  return bytes.toString("utf8", offset, end);
};

/** Bounded static parser for the exact approved ELF64 little-endian profile. */
export const parseApprovedNativeElf = (bytes: Buffer, policy: NativePolicy["elf"]): DynamicProfile => {
  if (bytes.length < 64) fail("P4_ELF_TRUNCATED");
  if (!bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) fail("P4_ELF_MAGIC");
  if (bytes[4] !== 2) fail("P4_ELF_CLASS");
  if (bytes[5] !== 1) fail("P4_ELF_ENDIAN");
  if (bytes[6] !== 1) fail("P4_ELF_IDENT_VERSION");
  if (bytes[7] !== policy.osAbi) fail("P4_ELF_OSABI");
  if (bytes[8] !== policy.abiVersion) fail("P4_ELF_ABI_VERSION");
  if (bytes.readUInt16LE(16) !== 3) fail("P4_ELF_TYPE");
  if (bytes.readUInt16LE(18) !== policy.machine) fail("P4_ELF_MACHINE");
  if (bytes.readUInt32LE(20) !== 1) fail("P4_ELF_VERSION");
  if (bytes.readUInt16LE(52) !== 64) fail("P4_ELF_HEADER_SIZE");
  if (bytes.readUInt16LE(54) !== 56) fail("P4_ELF_PROGRAM_HEADER_SIZE");
  const count = bytes.readUInt16LE(56);
  if (count !== policy.programHeaderCount) fail("P4_ELF_PROGRAM_HEADER_COUNT");
  const table = safeNumber(bytes.readBigUInt64LE(32), "P4_ELF_BOUNDS");
  range(table, count * 56, bytes.length, "P4_ELF_BOUNDS");

  const loads: LoadSegment[] = [];
  let dynamic: { offset: number; vaddr: number; size: number } | null = null;
  let executableLoad = false;
  let gnuStackCount = 0;
  for (let index = 0; index < count; index += 1) {
    const at = table + index * 56;
    const type = bytes.readUInt32LE(at);
    const flags = bytes.readUInt32LE(at + 4);
    const offset = safeNumber(bytes.readBigUInt64LE(at + 8), "P4_ELF_BOUNDS");
    const vaddr = safeNumber(bytes.readBigUInt64LE(at + 16), "P4_ELF_BOUNDS");
    const fileSize = safeNumber(bytes.readBigUInt64LE(at + 32), "P4_ELF_BOUNDS");
    const memorySize = safeNumber(bytes.readBigUInt64LE(at + 40), "P4_ELF_BOUNDS");
    const alignment = safeNumber(bytes.readBigUInt64LE(at + 48), "P4_ELF_ALIGNMENT");
    range(offset, fileSize, bytes.length, "P4_ELF_SEGMENT_BOUNDS");
    if (fileSize > memorySize) fail("P4_ELF_SEGMENT_SIZE");
    // BigInt: p_align is a 64-bit field and JS bitwise operators truncate to 32 bits.
    if (alignment > 1 && ((BigInt(alignment) & (BigInt(alignment) - 1n)) !== 0n || offset % alignment !== vaddr % alignment)) fail("P4_ELF_ALIGNMENT");
    if (type === 1) {
      if ((flags & 3) === 3) fail("P4_ELF_WX");
      if ((flags & 1) !== 0) executableLoad = true;
      loads.push({ offset, vaddr, filesz: fileSize });
    } else if (type === 2) {
      if (dynamic !== null) fail("P4_ELF_DYNAMIC_COUNT");
      dynamic = { offset, vaddr, size: fileSize };
    } else if (type === 3 || type === 5) fail("P4_ELF_FORBIDDEN_SEGMENT");
    else if (type === 0x6474e551) {
      gnuStackCount += 1;
      if ((flags & 1) !== 0) fail("P4_ELF_EXEC_STACK");
    }
  }
  if (loads.length === 0 || !executableLoad) fail("P4_ELF_LOAD_SEGMENT");
  if (gnuStackCount !== 1) fail("P4_ELF_GNU_STACK");
  if (dynamic === null) fail("P4_ELF_DYNAMIC_COUNT");
  const dynamicSegment = dynamic as { offset: number; vaddr: number; size: number };
  if (dynamicSegment.size === 0 || dynamicSegment.size % 16 !== 0) fail("P4_ELF_DYNAMIC_BOUNDS");

  const mapVirtualSpan = (address: number, length: number, code: string): { offset: number; limit: number } => {
    const matches = loads.filter((load) => address >= load.vaddr && length <= load.filesz && address - load.vaddr <= load.filesz - length);
    if (matches.length !== 1) fail(code);
    const mapped = matches[0].offset + (address - matches[0].vaddr);
    range(mapped, length, bytes.length, code);
    return { offset: mapped, limit: matches[0].offset + matches[0].filesz };
  };
  const mapVirtual = (address: number, length: number, code: string): number => mapVirtualSpan(address, length, code).offset;
  const dynamicMappings = loads.filter((load) =>
    dynamicSegment.offset >= load.offset &&
    dynamicSegment.size <= load.filesz &&
    dynamicSegment.offset - load.offset <= load.filesz - dynamicSegment.size &&
    dynamicSegment.vaddr >= load.vaddr &&
    dynamicSegment.vaddr - load.vaddr === dynamicSegment.offset - load.offset,
  );
  if (dynamicMappings.length !== 1) fail("P4_ELF_DYNAMIC_MAPPING");

  const neededOffsets: number[] = [];
  const singletons = new Map<number, number>();
  let terminated = false;
  const singletonTags = new Set([5, 10, 14, 15, 22, 29, 0x6ffffffe, 0x6fffffff]);
  for (let at = dynamicSegment.offset; at < dynamicSegment.offset + dynamicSegment.size; at += 16) {
    const tag = safeNumber(bytes.readBigUInt64LE(at), "P4_ELF_DYNAMIC_TAG");
    const value = safeNumber(bytes.readBigUInt64LE(at + 8), "P4_ELF_DYNAMIC_TAG");
    if (tag === 0) { terminated = true; break; }
    if (tag === 1) neededOffsets.push(value);
    if (singletonTags.has(tag)) {
      if (singletons.has(tag)) fail("P4_ELF_DYNAMIC_DUPLICATE");
      singletons.set(tag, value);
    }
  }
  if (!terminated) fail("P4_ELF_DYNAMIC_TERMINATOR");
  if (singletons.has(15) || singletons.has(29) || singletons.has(22)) fail("P4_ELF_DYNAMIC_FORBIDDEN");
  const maybeStringAddress = singletons.get(5);
  const maybeStringSize = singletons.get(10);
  if (maybeStringAddress === undefined || maybeStringSize === undefined || maybeStringSize === 0) fail("P4_ELF_STRING_TABLE");
  const stringAddress = maybeStringAddress as number;
  const stringSize = maybeStringSize as number;
  const stringTable = mapVirtual(stringAddress, stringSize, "P4_ELF_STRING_TABLE");
  const readDynamicString = (offset: number): string => {
    if (offset < 0 || offset >= stringSize) fail("P4_ELF_STRING_OFFSET");
    return cString(bytes, stringTable + offset, stringTable + stringSize, "P4_ELF_STRING_VALUE");
  };

  const needed = neededOffsets.map(readDynamicString).sort();
  if (!equalStrings(needed, [...policy.needed].sort())) fail("P4_ELF_NEEDED");
  const soname = singletons.has(14) ? readDynamicString(singletons.get(14)!) : null;
  if (soname !== policy.soname) fail("P4_ELF_SONAME");

  const versionNeeds: Record<string, string[]> = {};
  const maybeNeedAddress = singletons.get(0x6ffffffe);
  const maybeNeedCount = singletons.get(0x6fffffff);
  if (maybeNeedAddress === undefined || maybeNeedCount === undefined || maybeNeedCount < 1 || maybeNeedCount > 64) fail("P4_ELF_VERSION_NEEDS");
  const needAddress = maybeNeedAddress as number;
  const needCount = maybeNeedCount as number;
  const needMapping = mapVirtualSpan(needAddress, 16, "P4_ELF_VERSION_NEEDS");
  let needOffset = needMapping.offset;
  const claimed: Array<{ start: number; end: number }> = [];
  const claimVersionRecord = (start: number): void => {
    const end = start + 16;
    if (claimed.some((item) => start < item.end && item.start < end)) fail("P4_ELF_VERSION_OVERLAP");
    claimed.push({ start, end });
  };
  for (let index = 0; index < needCount; index += 1) {
    range(needOffset, 16, needMapping.limit, "P4_ELF_VERSION_NEEDS");
    claimVersionRecord(needOffset);
    if (bytes.readUInt16LE(needOffset) !== 1) fail("P4_ELF_VERSION_NEEDS");
    const auxCount = bytes.readUInt16LE(needOffset + 2);
    if (auxCount < 1 || auxCount > 64) fail("P4_ELF_VERSION_NEEDS");
    const library = readDynamicString(bytes.readUInt32LE(needOffset + 4));
    const auxDelta = bytes.readUInt32LE(needOffset + 8);
    if (auxDelta < 16 || auxDelta % 4 !== 0) fail("P4_ELF_VERSION_ALIGNMENT");
    let auxOffset = needOffset + auxDelta;
    const versions: string[] = [];
    for (let auxIndex = 0; auxIndex < auxCount; auxIndex += 1) {
      range(auxOffset, 16, needMapping.limit, "P4_ELF_VERSION_NEEDS");
      claimVersionRecord(auxOffset);
      versions.push(readDynamicString(bytes.readUInt32LE(auxOffset + 8)));
      const next = bytes.readUInt32LE(auxOffset + 12);
      if (auxIndex + 1 < auxCount) {
        if (next < 16 || next % 4 !== 0) fail("P4_ELF_VERSION_ALIGNMENT");
        auxOffset += next;
      } else if (next !== 0) fail("P4_ELF_VERSION_TERMINATION");
    }
    if (versionNeeds[library] !== undefined) fail("P4_ELF_VERSION_NEEDS");
    versionNeeds[library] = versions.sort();
    const next = bytes.readUInt32LE(needOffset + 12);
    if (index + 1 < needCount) {
      if (next < 16 || next % 4 !== 0) fail("P4_ELF_VERSION_ALIGNMENT");
      needOffset += next;
    } else if (next !== 0) fail("P4_ELF_VERSION_TERMINATION");
  }
  const normalizedActual = Object.fromEntries(Object.entries(versionNeeds).sort(([a], [b]) => a.localeCompare(b)));
  const normalizedExpected = Object.fromEntries(Object.entries(policy.versionNeeds).sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => [key, [...values].sort()]));
  if (JSON.stringify(normalizedActual) !== JSON.stringify(normalizedExpected)) fail("P4_ELF_VERSION_POLICY");
  return { needed, soname, versionNeeds: normalizedActual };
};

const assertRuntime = (runtime: NativeRuntimeFacts, policy: NativePolicy): void => {
  if (runtime.platform !== policy.platform.os) fail("P4_RUNTIME_PLATFORM");
  if (runtime.arch !== policy.platform.arch) fail("P4_RUNTIME_ARCH");
  if (runtime.bun !== policy.compatibility.bun) fail("P4_RUNTIME_BUN");
  if (runtime.glibc === null) fail("P4_RUNTIME_LIBC_UNAVAILABLE");
  if (runtime.glibc !== policy.glibc) fail("P4_RUNTIME_LIBC");
  if (runtime.piExecutableSha256 !== policy.piExecutableSha256) fail("P4_RUNTIME_PI_DIGEST");
  if (runtime.sqlite !== policy.compatibility.sqlite) fail("P4_RUNTIME_SQLITE");
};

/**
 * Prove SQL load_extension() is denied. SQLite's authorizer refusal is the only
 * accepted outcome. P4_SQL_LOADER_STATE: the statement threw anything else,
 * which with real SQLite is what an enabled loader produces for the fixed
 * nonexistent path (a dlopen failure). P4_SQL_LOADER_ENABLED: the statement
 * returned a row, which only a loader that reached the path can do.
 */
const assertSqlLoaderDenied = (database: NativeDatabase): void => {
  try {
    database.query("select load_extension('/p4-must-remain-unauthorized') AS loaded").get();
  } catch (error) {
    if (error instanceof Error && error.message.includes("not authorized")) return;
    fail("P4_SQL_LOADER_STATE");
  }
  fail("P4_SQL_LOADER_ENABLED");
};

/** Test seam: runs the one fixed, denied statement above; carries no loader capability. */
export const testExpertiseSqlLoaderDenied = (database: NativeDatabase): void => assertSqlLoaderDenied(database);

const objectString = (value: unknown, key: string, code: string): string => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(code);
  const field = (value as Record<string, unknown>)[key];
  if (typeof field !== "string") fail(code);
  return field as string;
};

export interface PreflightTestOptions {
  runtimeRoot: string;
  trustedHome: string;
  expectedUid: number;
  policy: NativePolicy;
  /** Evaluated after the tree checks so an expensive probe never runs for a bad tree. */
  runtime: () => NativeRuntimeFacts;
  beforeFinalPathCheck?: () => void;
}

interface VerifiedNativeArtifact {
  artifactPath: string;
  generation: string;
  version: string;
}

const preflightInstalledRuntime = (options: PreflightTestOptions): VerifiedNativeArtifact => {
  const { expectedUid: uid, policy } = options;
  const home = resolve(options.trustedHome);
  const root = resolve(options.runtimeRoot);
  validatePathChain(options.runtimeRoot, options.trustedHome, uid);

  assertInventory(root, ["current-generation", "generations", "install.lock"], "P4_ROOT_INVENTORY");
  inspectFile(join(root, "install.lock"), uid, 0o600, "P4_INSTALL_LOCK");
  inspectDirectory(join(root, "generations"), uid, 0o700, "P4_GENERATIONS");
  const selectorPath = join(root, "current-generation");
  inspectFile(selectorPath, uid, 0o600, "P4_SELECTOR");
  const selectorBytes = readVerifiedFile(selectorPath, uid, 0o600, 4096, "P4_SELECTOR");
  if (sha256(selectorBytes) !== policy.selectorSha256) fail("P4_SELECTOR_DIGEST");
  const selector = exactKeys(parseJson(selectorBytes, "P4_SELECTOR_JSON"), ["generation", "manifestSha256", "schemaVersion"], "P4_SELECTOR_SCHEMA");
  if (selector.schemaVersion !== 1 || selector.generation !== policy.generation || selector.manifestSha256 !== policy.manifestSha256) fail("P4_SELECTOR_POLICY");

  const generations = join(root, "generations");
  // Exactly one generation: the installer does not prune superseded ones yet (#1105).
  assertInventory(generations, [policy.generation], "P4_GENERATIONS_INVENTORY");
  const generationRoot = join(generations, policy.generation);
  inspectDirectory(generationRoot, uid, 0o700, "P4_GENERATION");
  const nativeRoot = join(generationRoot, "native");
  const sqliteVecRoot = join(nativeRoot, "sqlite-vec");
  inspectDirectory(nativeRoot, uid, 0o700, "P4_GENERATION_PATH");
  inspectDirectory(sqliteVecRoot, uid, 0o700, "P4_GENERATION_PATH");
  assertInventory(generationRoot, ["manifest.json", "native"], "P4_GENERATION_INVENTORY");
  assertInventory(nativeRoot, ["sqlite-vec"], "P4_GENERATION_INVENTORY");
  assertInventory(sqliteVecRoot, ["vec0.so"], "P4_GENERATION_INVENTORY");

  const manifestPath = join(generationRoot, "manifest.json");
  inspectFile(manifestPath, uid, 0o600, "P4_MANIFEST");
  const manifestBytes = readVerifiedFile(manifestPath, uid, 0o600, 64 * 1024, "P4_MANIFEST");
  if (sha256(manifestBytes) !== policy.manifestSha256) fail("P4_MANIFEST_DIGEST");
  const manifest = exactKeys(parseJson(manifestBytes, "P4_MANIFEST_JSON"), ["compatibility", "files", "generation", "platform", "schemaVersion", "source"], "P4_MANIFEST_SCHEMA");
  const manifestPlatform = exactKeys(manifest.platform, ["arch", "os"], "P4_MANIFEST_PLATFORM");
  const compatibility = exactKeys(manifest.compatibility, ["bun", "pi", "sqlite"], "P4_MANIFEST_COMPATIBILITY");
  if (manifest.schemaVersion !== 1 || manifest.generation !== policy.generation || manifestPlatform.os !== policy.platform.os || manifestPlatform.arch !== policy.platform.arch) fail("P4_MANIFEST_POLICY");
  if (compatibility.pi !== policy.compatibility.pi || compatibility.bun !== policy.compatibility.bun || compatibility.sqlite !== policy.compatibility.sqlite) fail("P4_MANIFEST_COMPATIBILITY");
  if (!Array.isArray(manifest.files) || manifest.files.length !== 1) fail("P4_MANIFEST_FILES");
  const manifestFiles = manifest.files as unknown[];
  const artifactEntry = exactKeys(manifestFiles[0], ["archivePath", "mode", "path", "role", "sha256", "size", "version"], "P4_MANIFEST_FILES");
  if (artifactEntry.path !== policy.artifact.path || artifactEntry.sha256 !== policy.artifact.sha256 || artifactEntry.size !== policy.artifact.size || artifactEntry.mode !== "0600" || artifactEntry.role !== "native-library" || artifactEntry.version !== policy.artifact.version) fail("P4_MANIFEST_ARTIFACT");

  const artifactPath = join(generationRoot, policy.artifact.path);
  assertContained(artifactPath, generationRoot, "P4_ARTIFACT_CONTAINMENT");
  const before = inspectFile(artifactPath, uid, 0o600, "P4_ARTIFACT");
  if (before.size !== policy.artifact.size) fail("P4_ARTIFACT_SIZE");
  if (realpathSync(artifactPath) !== artifactPath) fail("P4_ARTIFACT_CANONICAL");

  if (typeof constants.O_NOFOLLOW !== "number") fail("P4_NOFOLLOW_UNAVAILABLE");
  let descriptor: number;
  try { descriptor = openSync(artifactPath, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { return fail("P4_ARTIFACT_OPEN"); }
  let artifactBytes: Buffer;
  let opened: Stats;
  try {
    opened = fstatSync(descriptor);
    if (!opened.isFile()) fail("P4_ARTIFACT_TYPE");
    if (opened.uid !== uid) fail("P4_PATH_OWNER");
    if (modeOf(opened) !== 0o600) fail("P4_ARTIFACT_MODE");
    if (opened.nlink !== 1) fail("P4_ARTIFACT_LINKS");
    if (opened.size !== policy.artifact.size) fail("P4_ARTIFACT_SIZE");
    artifactBytes = readFileSync(descriptor);
    const afterRead = fstatSync(descriptor);
    if (afterRead.dev !== opened.dev || afterRead.ino !== opened.ino || afterRead.size !== opened.size || afterRead.ctimeMs !== opened.ctimeMs) fail("P4_ARTIFACT_CHANGED");
  } finally { closeSync(descriptor); }
  if (artifactBytes.length !== policy.artifact.size) fail("P4_ARTIFACT_SIZE");
  if (sha256(artifactBytes) !== policy.artifact.sha256) fail("P4_ARTIFACT_DIGEST");
  parseApprovedNativeElf(artifactBytes, policy.elf);

  // Runtime facts last: in production this hashes the pi executable, so it
  // runs only once the installed tree has already passed every cheap check.
  const runtime = options.runtime();
  assertRuntime(runtime, policy);
  if (runtime.piExecutablePath !== join(home, policy.piExecutableRelativePath)) fail("P4_RUNTIME_PI_PATH");

  options.beforeFinalPathCheck?.();
  const finalPath = inspectFile(artifactPath, uid, 0o600, "P4_ARTIFACT");
  if (finalPath.dev !== opened.dev || finalPath.ino !== opened.ino || finalPath.size !== opened.size || finalPath.ctimeMs !== opened.ctimeMs) fail("P4_ARTIFACT_FINAL_RECHECK");
  if (realpathSync(artifactPath) !== artifactPath) fail("P4_ARTIFACT_CANONICAL");
  return { artifactPath, generation: policy.generation, version: policy.artifact.version };
};

/** Test-only validator: exposes no selected path, database, or loader capability. */
export const testExpertiseNativePreflight = (options: PreflightTestOptions): { generation: string; version: string } => {
  const verified = preflightInstalledRuntime(options);
  return { generation: verified.generation, version: verified.version };
};

const passwdHome = (uid: number): string => {
  const passwd = readFileSync("/etc/passwd", "utf8");
  const matches = passwd.split("\n").filter((line) => {
    const fields = line.split(":");
    return fields.length === 7 && /^[0-9]+$/.test(fields[2]) && Number(fields[2]) === uid;
  });
  if (matches.length !== 1) fail("P4_PASSWD_HOME");
  const home = matches[0].split(":")[5];
  if (!isAbsolute(home) || home.includes("\0")) fail("P4_PASSWD_HOME");
  return resolve(home);
};

const effectiveUid = (): number => {
  const uid = process.geteuid?.();
  if (uid === undefined) fail("P4_EFFECTIVE_UID");
  return uid as number;
};

const queryVersion = (database: NativeDatabase, sql: string, code: string): string => {
  let row: unknown;
  try { row = database.query(sql).get(); } catch { return fail(code); }
  return objectString(row, "version", code);
};

/**
 * Live host facts for the production entry. Every probe failure is coded so a
 * caller can classify it: the pi path is fixed relative to the passwd home and
 * ignores XDG_CACHE_HOME by design (environment-selected paths are refused).
 */
const productionRuntimeFacts = (trustedHome: string, database: NativeDatabase): NativeRuntimeFacts => {
  let executable: string;
  try { executable = realpathSync(process.execPath); } catch { return fail("P4_RUNTIME_PI_CANONICAL"); }
  const expectedExecutable = join(trustedHome, PRODUCTION_NATIVE_POLICY.piExecutableRelativePath);
  if (executable !== expectedExecutable) fail("P4_RUNTIME_PI_PATH");
  let glibcValue: string | null = null;
  try {
    const reportApi = process.report;
    const report = reportApi === undefined ? null : (reportApi.getReport() as { header?: { glibcVersionRuntime?: unknown } });
    glibcValue = report !== null && typeof report === "object" && typeof report.header?.glibcVersionRuntime === "string"
      ? report.header.glibcVersionRuntime
      : null;
  } catch { return fail("P4_RUNTIME_REPORT"); }
  let executableBytes: Buffer;
  try { executableBytes = readFileSync(executable); } catch { return fail("P4_RUNTIME_PI_READ"); }
  return {
    platform: process.platform,
    arch: process.arch,
    bun: process.versions.bun ?? "",
    glibc: glibcValue,
    sqlite: queryVersion(database, "select sqlite_version() AS version", "P4_RUNTIME_SQLITE"),
    piExecutablePath: executable,
    piExecutableSha256: sha256(executableBytes),
  };
};

const attemptedLoads = new WeakSet<NativeDatabase>();

/** Private production initializer: validates completely, then invokes Bun once. */
export const loadExpertiseNativeRuntime = (database: NativeDatabase): { generation: string; version: string } => {
  if (attemptedLoads.has(database)) fail("P4_ALREADY_INITIALIZED");
  const uid = effectiveUid();
  const trustedHome = passwdHome(uid);
  const runtimeRoot = join(trustedHome, ".local/share/agent-expertise/runtime");
  const verified = preflightInstalledRuntime({
    runtimeRoot,
    trustedHome,
    expectedUid: uid,
    policy: PRODUCTION_NATIVE_POLICY,
    runtime: () => productionRuntimeFacts(trustedHome, database),
  });
  assertSqlLoaderDenied(database);
  attemptedLoads.add(database);
  try { database.loadExtension(verified.artifactPath); }
  catch { return fail("P4_LOAD_FAILED"); }
  const version = queryVersion(database, "select vec_version() AS version", "P4_VEC_VERSION");
  if (version !== verified.version) fail("P4_VEC_VERSION");
  assertSqlLoaderDenied(database);
  return { generation: verified.generation, version: verified.version };
};
