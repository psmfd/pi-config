/**
 * suspend-inclusive-clock.ts — verified expiry clock resolution (#929).
 *
 * Grant lifetime must advance while the host sleeps. This module deliberately
 * exposes no wall-clock or hrtime fallback as verified: callers receive a
 * fail-visible clock when the platform primitive cannot be resolved.
 */

import * as fs from "node:fs";

import type { MonotonicClock } from "./grant-registry.ts";

export type ClockSource = "linux-proc-uptime" | "darwin-mach-continuous-time" | "unverified";

export interface ResolvedClock extends MonotonicClock {
  readonly source: ClockSource;
  readonly diagnostic: string;
}

interface BunFfi {
  dlopen?: (path: string, symbols: Record<string, unknown>) => {
    symbols: Record<string, unknown>;
    close?: () => void;
  };
  FFI?: { ptr?: (value: ArrayBufferView) => unknown };
}

function unverified(diagnostic: string): ResolvedClock {
  return Object.freeze({
    nowMs: () => Number(process.hrtime.bigint() / 1_000_000n),
    suspendInclusive: false,
    source: "unverified" as const,
    diagnostic,
  });
}

/** Parse the first (uptime) field of Linux /proc/uptime into integer ms. */
export function parseProcUptimeMs(text: string): number | null {
  const first = /^([0-9]+(?:\.[0-9]+)?)(?:\s|$)/.exec(text)?.[1];
  if (!first) return null;
  const seconds = Number(first);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const ms = Math.floor(seconds * 1_000);
  return Number.isSafeInteger(ms) ? ms : null;
}

function linuxClock(readFile: (path: string, encoding: BufferEncoding) => string): ResolvedClock {
  const read = (): number => {
    const value = parseProcUptimeMs(readFile("/proc/uptime", "utf8"));
    if (value === null) throw new Error("/proc/uptime is invalid");
    return value;
  };
  try {
    read();
    return Object.freeze({
      nowMs: read,
      suspendInclusive: true,
      source: "linux-proc-uptime" as const,
      diagnostic: "verified Linux kernel uptime (/proc/uptime)",
    });
  } catch {
    return unverified("unable to read a valid /proc/uptime");
  }
}

/**
 * Resolve Darwin's mach_continuous_time through Bun's runtime FFI surface.
 * The import is intentionally runtime-reflective: Node/tsx runs unit tests
 * without Bun types or the bun:ffi module. `mach_timebase_info` converts the
 * continuous ticks to milliseconds; failure of either symbol is fail-closed.
 */
function darwinClock(bun: BunFfi | undefined): ResolvedClock {
  try {
    if (!bun?.dlopen || !bun.FFI?.ptr) return unverified("Bun FFI unavailable for mach_continuous_time");
    const lib = bun.dlopen("/usr/lib/libSystem.B.dylib", {
      mach_continuous_time: { args: [], returns: "u64" },
      mach_timebase_info: { args: ["ptr"], returns: "i32" },
    });
    const continuous = lib.symbols.mach_continuous_time as (() => bigint) | undefined;
    const timebase = lib.symbols.mach_timebase_info as ((pointer: unknown) => number) | undefined;
    if (!continuous || !timebase) return unverified("Darwin time symbols unavailable");
    const info = new Uint32Array(2);
    if (timebase(bun.FFI.ptr(info)) !== 0 || info[0] === 0 || info[1] === 0) {
      return unverified("mach_timebase_info refused");
    }
    const numerator = BigInt(info[0]);
    const denominator = BigInt(info[1]);
    const nowMs = (): number => {
      const ms = (continuous() * numerator) / (denominator * 1_000_000n);
      if (ms > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("continuous time exceeds safe range");
      return Number(ms);
    };
    nowMs();
    // Keep the library resident for the lifetime of this clock; closing it
    // would invalidate the symbol closures retained by nowMs.
    void lib;
    return Object.freeze({
      nowMs,
      suspendInclusive: true,
      source: "darwin-mach-continuous-time" as const,
      diagnostic: "verified Darwin mach_continuous_time",
    });
  } catch {
    return unverified("unable to resolve Darwin mach_continuous_time");
  }
}

export interface ClockResolverOptions {
  platform?: NodeJS.Platform;
  readFile?: (path: string, encoding: BufferEncoding) => string;
  bun?: BunFfi | undefined;
}

/** Resolve a verified source on supported production platforms, else fail visible. */
export function resolveSuspendInclusiveClock(options: ClockResolverOptions = {}): ResolvedClock {
  const platform = options.platform ?? process.platform;
  if (platform === "linux") return linuxClock(options.readFile ?? fs.readFileSync);
  if (platform === "darwin") {
    const bun = options.bun ?? (globalThis as unknown as { Bun?: BunFfi }).Bun;
    return darwinClock(bun);
  }
  return unverified(`no verified suspend-inclusive clock for ${platform}`);
}
