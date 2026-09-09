import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

// usage: rpc-lifecycle.mjs [--scenario lifecycle|late] <pi> <extension>...
const argv = process.argv.slice(2);
let scenario = "lifecycle";
if (argv[0] === "--scenario") {
  scenario = argv[1];
  argv.splice(0, 2);
}
const [piBin, ...extensions] = argv;
if (!piBin || extensions.length === 0 || !["lifecycle", "late"].includes(scenario)) {
  throw new Error(
    "usage: rpc-lifecycle.mjs [--scenario lifecycle|late] <pi> <extension>...",
  );
}

const child = spawn(
  piBin,
  ["--mode", "rpc", "--no-session", ...extensions.flatMap((e) => ["-e", e])],
  { stdio: ["pipe", "pipe", "pipe"], env: process.env },
);
let nextId = 1;
const pending = new Map();
let stderr = "";
child.stderr.setEncoding("utf8");
child.stdin.on("error", (error) => {
  rejectAll(new Error(`pi RPC stdin: ${error.message}: ${stderr}`));
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    rejectAll(new Error(`invalid RPC JSON: ${error.message}: ${line}`));
    return;
  }
  if (message.type !== "response" || message.id === undefined) return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  clearTimeout(waiter.timer);
  if (message.success) waiter.resolve(message);
  else waiter.reject(new Error(`${message.command}: ${message.error ?? "failed"}`));
}

const decoder = new StringDecoder("utf8");
let stdoutBuffer = "";
child.stdout.on("data", (chunk) => {
  stdoutBuffer += decoder.write(chunk);
  for (;;) {
    const newline = stdoutBuffer.indexOf("\n");
    if (newline < 0) break;
    let line = stdoutBuffer.slice(0, newline);
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length > 0) handleLine(line);
  }
});
child.stdout.on("end", () => {
  stdoutBuffer += decoder.end();
  if (stdoutBuffer.endsWith("\r")) stdoutBuffer = stdoutBuffer.slice(0, -1);
  if (stdoutBuffer.length > 0) handleLine(stdoutBuffer);
});

function rejectAll(error) {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  pending.clear();
}

function request(command) {
  const id = `p2-${nextId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`RPC timeout: ${command.type}`));
    }, 15_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
  });
}

child.on("exit", (code, signal) => {
  rejectAll(new Error(`pi RPC exited code=${code} signal=${signal}: ${stderr}`));
});

const scenarios = {
  // Reload, session replacement, and active-tool changes.
  lifecycle: [
    { type: "prompt", message: "/p2-snapshot startup" },
    { type: "prompt", message: "/p2-reload" },
    { type: "prompt", message: "/p2-snapshot reload" },
    { type: "new_session" },
    { type: "prompt", message: "/p2-snapshot new-session" },
    { type: "prompt", message: "/p2-set-active read,edit,bash" },
    { type: "prompt", message: "/p2-snapshot write-inactive" },
    { type: "prompt", message: "/p2-set-active write,edit,bash" },
    { type: "prompt", message: "/p2-snapshot active-restored" },
  ],
  // Post-load same-name registration from a command handler, one tool at a
  // time, with a snapshot after each attempt.
  late: [
    { type: "prompt", message: "/p2-snapshot late-startup" },
    { type: "prompt", message: "/p2-late-register write" },
    { type: "prompt", message: "/p2-snapshot late-write" },
    { type: "prompt", message: "/p2-late-register edit" },
    { type: "prompt", message: "/p2-snapshot late-edit" },
    { type: "prompt", message: "/p2-late-register bash" },
    { type: "prompt", message: "/p2-snapshot late-bash" },
  ],
};

try {
  await request({ type: "get_state" });
  for (const command of scenarios[scenario]) {
    await request(command);
  }
} finally {
  if (!child.stdin.destroyed) child.stdin.end();
  // "exit" has already fired when the child died early; waiting for it again
  // would never settle and would hide the rejection carrying pi's stderr.
  if (child.exitCode === null && child.signalCode === null) {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await new Promise((resolve) => child.once("exit", resolve));
    clearTimeout(timer);
  }
}
