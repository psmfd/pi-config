/**
 * shared/shell-lex.ts — lexer unit tests (ADR-0072).
 *
 * Exercises the parsing primitive in isolation: segmentation, quote joining,
 * pipe-sink vs logical-OR, redirection capture, stdin detection, env-assignment
 * stripping, `-c` detection, `$IFS` normalization, and the conservative
 * deglue-word-substitution transform.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lex,
  preprocessCommand,
  deglueWordSubstitutions,
  stripEnvAssignments,
  hasMinusC,
} from "../shell-lex.ts";

test("segments split on unquoted control operators", () => {
  const segs = lex("echo a; rm b");
  assert.equal(segs.length, 2);
  assert.deepEqual(segs[0].tokens, ["echo", "a"]);
  assert.deepEqual(segs[1].tokens, ["rm", "b"]);
});

test("quote-adjacent runs join into one word (Class A)", () => {
  assert.deepEqual(lex("r''m /x")[0].tokens, ["rm", "/x"]);
  assert.deepEqual(lex("'rm' /x")[0].tokens, ["rm", "/x"]);
  assert.deepEqual(lex('"rm" /x')[0].tokens, ["rm", "/x"]);
});

test("single pipe marks the downstream segment pipedInto", () => {
  const segs = lex("echo x | sh");
  assert.equal(segs.length, 2);
  assert.equal(segs[0].pipedInto, false);
  assert.equal(segs[1].pipedInto, true);
  assert.deepEqual(segs[1].tokens, ["sh"]);
});

test("logical OR (||) does NOT mark pipedInto", () => {
  const segs = lex("false || sh");
  assert.equal(segs.length, 2);
  assert.equal(segs[1].pipedInto, false);
  assert.deepEqual(segs[1].tokens, ["sh"]);
});

test("three-stage pipeline marks each downstream sink", () => {
  const segs = lex("echo b64 | base64 -d | sh");
  assert.equal(segs.length, 3);
  assert.equal(segs[0].pipedInto, false);
  assert.equal(segs[1].pipedInto, true);
  assert.equal(segs[2].pipedInto, true);
});

test("output redirection is captured with its target, not left as a token", () => {
  const segs = lex("echo x > /etc/passwd");
  assert.equal(segs.length, 1);
  assert.deepEqual(segs[0].tokens, ["echo", "x"]);
  assert.deepEqual(segs[0].redirects, [{ op: ">", target: "/etc/passwd" }]);
});

test("forced-clobber and append redirection operators are distinguished", () => {
  assert.deepEqual(lex("echo x >| /a")[0].redirects, [{ op: ">|", target: "/a" }]);
  assert.deepEqual(lex("echo x >> /a")[0].redirects, [{ op: ">>", target: "/a" }]);
  assert.deepEqual(lex("echo x>/a")[0].redirects, [{ op: ">", target: "/a" }]);
});

test("stdin redirection sets readsInput", () => {
  assert.equal(lex("bash < script.sh")[0].readsInput, true);
  assert.equal(lex("bash <<< 'payload'")[0].readsInput, true);
  assert.equal(lex("echo hi")[0].readsInput, false);
});

test("stripEnvAssignments drops leading NAME=value prefixes", () => {
  assert.deepEqual(stripEnvAssignments(["FOO=bar", "rm", "/x"]), ["rm", "/x"]);
  assert.deepEqual(stripEnvAssignments(["rm", "/x"]), ["rm", "/x"]);
});

test("hasMinusC detects -c and short-option clusters", () => {
  assert.equal(hasMinusC(["sh", "-c", "x"]), true);
  assert.equal(hasMinusC(["bash", "-ec", "x"]), true);
  assert.equal(hasMinusC(["bash", "script.sh"]), false);
});

test("preprocessCommand normalizes literal $IFS but not $IFSX", () => {
  assert.equal(preprocessCommand("rm$IFS/etc/passwd"), "rm /etc/passwd");
  assert.equal(preprocessCommand("rm${IFS}/etc/passwd"), "rm /etc/passwd");
  // A different variable named $IFSX must be left intact.
  assert.equal(preprocessCommand("echo $IFSX"), "echo $IFSX");
});

test("preprocessCommand collapses line continuations", () => {
  assert.equal(preprocessCommand("r\\\nm /x"), "rm /x");
});

test("deglueWordSubstitutions removes word-internal empty substitutions", () => {
  assert.equal(deglueWordSubstitutions("r$(true)m /x"), "rm /x");
  assert.equal(deglueWordSubstitutions("r`true`m /x"), "rm /x");
  assert.equal(deglueWordSubstitutions("foo$(date)bar"), "foobar");
});

test("deglueWordSubstitutions leaves space-separated value substitutions intact", () => {
  // Preceded by whitespace → not word-glued → not a path-rewriting false positive.
  assert.equal(deglueWordSubstitutions("rm $(echo /tmp)/x"), "rm $(echo /tmp)/x");
  assert.equal(deglueWordSubstitutions("echo $(rm /tmp/s)"), "echo $(rm /tmp/s)");
});
