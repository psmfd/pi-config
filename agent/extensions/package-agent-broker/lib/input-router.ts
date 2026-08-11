/**
 * input-router.ts — exact raw-input command routing (#916).
 *
 * The broker registers NO model-callable tool and NO `registerCommand`
 * handler. It classifies exact raw input from `pi.on("input")`:
 *
 *   /package-agent list
 *   /package-agent inspect <qualified-id>
 *   /package-agent status [qualified-id]
 *   /package-agent review <qualified-id> [--alias <alias>]
 *   /package-agent reject <qualified-id>
 *   /package-agent revoke-draft <qualified-id>
 *   /package-agent approve <qualified-id> [--alias <alias>]   (#928)
 *   /package-agent grants                                     (#928)
 *   /package-agent revoke <qualified-id>                      (#929)
 *   /package-agent dispatch <qualified-id> -- <task text>     (#930)
 *
 * Routing contract:
 *   - input whose first non-space token is exactly `/package-agent` is OURS:
 *     it is always handled (never passed to the model, skills, templates, or
 *     other extensions), and malformed variants are handled + rejected;
 *   - anything else (including confusable lookalikes that are NOT the exact
 *     ASCII token) is not ours and continues down the normal pipeline —
 *     there is no other authorization path for it to reach;
 *   - the router only PARSES; interactivity/mode gating happens in index.ts
 *     against ctx.mode / event.source / event.streamingBehavior.
 */

import {
  ALIAS_RE,
  QUALIFIED_ID_RE,
  isPrintableAscii,
} from "../../shared/package-agent-review-contract.ts";

export const COMMAND_PREFIX = "/package-agent";

export type RoutedCommand =
  | { kind: "list" }
  | { kind: "status"; qualifiedId: string | null }
  | { kind: "inspect"; qualifiedId: string }
  | { kind: "review"; qualifiedId: string; alias: string | null }
  | { kind: "reject"; qualifiedId: string }
  | { kind: "revoke-draft"; qualifiedId: string }
  | { kind: "approve"; qualifiedId: string; alias: string | null }
  | { kind: "grants" }
  | { kind: "revoke"; qualifiedId: string }
  | { kind: "dispatch"; qualifiedId: string; task: string };

export type RouteResult =
  | { ours: false }
  | { ours: true; ok: true; command: RoutedCommand }
  | { ours: true; ok: false; reason: string };

/**
 * Read-only commands never record review evidence, create authority, or
 * change an alias. `approve` (#928) is affirmative for the same reason
 * `review` is — it is the only path that creates an active grant.
 */
export function isAffirmative(command: RoutedCommand): boolean {
  return command.kind === "review" || command.kind === "approve";
}

const MAX_INPUT_LENGTH = 1024;

export function routeInput(text: string): RouteResult {
  // Ownership test: the first whitespace-delimited token must be the exact
  // ASCII prefix. Leading spaces/tabs are tolerated for ownership (so a
  // padded variant cannot slip past the broker to be expanded elsewhere),
  // but any non-canonical form is then handled + rejected below.
  const oursMatch = /^[ \t]*(\/package-agent)(?=$|[\s])/.exec(text);
  if (!oursMatch) return { ours: false };

  const reject = (reason: string): RouteResult => ({ ours: true, ok: false, reason });

  if (text.length > MAX_INPUT_LENGTH) return reject("input too long");
  if (!isPrintableAscii(text.replace(/[\t\n]/g, " "))) {
    return reject("non-ASCII or control characters in command");
  }
  // Canonical form: no leading whitespace, single spaces between tokens.
  if (!text.startsWith(COMMAND_PREFIX)) return reject("leading whitespace not accepted");
  const rest = text.slice(COMMAND_PREFIX.length);
  if (rest !== "" && !rest.startsWith(" ")) return reject("malformed command");
  const tokens = rest === "" ? [] : rest.slice(1).split(" ");
  if (tokens.some((t) => t.length === 0)) return reject("repeated or trailing spaces");

  const sub = tokens[0];
  const args = tokens.slice(1);

  const requireQid = (value: string | undefined): string | RouteResult => {
    if (value === undefined) return reject("missing qualified id");
    if (!QUALIFIED_ID_RE.test(value)) return reject("invalid qualified id");
    return value;
  };

  switch (sub) {
    case undefined:
      return reject("missing subcommand");
    case "list": {
      if (args.length !== 0) return reject("list takes no arguments");
      return { ours: true, ok: true, command: { kind: "list" } };
    }
    case "status": {
      if (args.length === 0) {
        return { ours: true, ok: true, command: { kind: "status", qualifiedId: null } };
      }
      if (args.length !== 1) return reject("status takes at most one argument");
      const qid = requireQid(args[0]);
      if (typeof qid !== "string") return qid;
      return { ours: true, ok: true, command: { kind: "status", qualifiedId: qid } };
    }
    case "inspect":
    case "reject":
    case "revoke-draft":
    case "revoke": {
      if (args.length !== 1) return reject(`${sub} takes exactly one argument`);
      const qid = requireQid(args[0]);
      if (typeof qid !== "string") return qid;
      return { ours: true, ok: true, command: { kind: sub, qualifiedId: qid } };
    }
    case "grants": {
      if (args.length !== 0) return reject("grants takes no arguments");
      return { ours: true, ok: true, command: { kind: "grants" } };
    }
    case "dispatch": {
      // Form: dispatch <qualified-id> -- <task text...>. The task is free
      // text (single spaces significant), delimited by the literal `--`
      // token so the strict single-space tokenizer above never applies to
      // it. It is WORK INPUT, never authorization input (ADR-0131 D7); the
      // dispatcher enforces its own byte bound.
      if (args.length < 3) return reject("dispatch takes <qualified-id> -- <task>");
      const qid = requireQid(args[0]);
      if (typeof qid !== "string") return qid;
      if (args[1] !== "--") return reject("dispatch takes <qualified-id> -- <task>");
      const task = args.slice(2).join(" ");
      if (task.length === 0) return reject("empty task");
      return { ours: true, ok: true, command: { kind: "dispatch", qualifiedId: qid, task } };
    }
    case "review":
    case "approve": {
      if (args.length !== 1 && args.length !== 3) {
        return reject(`${sub} takes <qualified-id> [--alias <alias>]`);
      }
      const qid = requireQid(args[0]);
      if (typeof qid !== "string") return qid;
      let alias: string | null = null;
      if (args.length === 3) {
        if (args[1] !== "--alias") return reject(`unknown ${sub} option`);
        if (!ALIAS_RE.test(args[2])) return reject("invalid alias");
        alias = args[2];
      }
      return { ours: true, ok: true, command: { kind: sub, qualifiedId: qid, alias } };
    }
    default:
      return reject("unknown subcommand");
  }
}
