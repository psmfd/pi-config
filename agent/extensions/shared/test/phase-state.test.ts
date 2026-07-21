import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
	__clearAll,
	armSelfCompact,
	clearSession,
	consumeSelfCompact,
	deferralCount,
	disarmSelfCompact,
	noteCompaction,
	noteDeferral,
	noteTurnEnd,
	publishTaskType,
	subagentEnded,
	subagentInFlight,
	subagentStarted,
	taskTypeChangedSinceCompaction,
	turnsSinceTaskTypeChange,
} from "../phase-state.ts";

beforeEach(() => __clearAll());

test("phase-state: unknown session yields no-signal defaults", () => {
	assert.equal(turnsSinceTaskTypeChange("s"), undefined);
	assert.equal(taskTypeChangedSinceCompaction("s"), false);
	assert.equal(subagentInFlight("s"), false);
	assert.equal(deferralCount("s"), 0);
	assert.equal(consumeSelfCompact("s"), false);
});

test("phase-state: task-type change stamps the current turn; republish does not reset", () => {
	noteTurnEnd("s", 3);
	publishTaskType("s", "code-edit");
	noteTurnEnd("s", 5);
	assert.equal(turnsSinceTaskTypeChange("s"), 2);
	publishTaskType("s", "code-edit"); // same label — no reset
	assert.equal(turnsSinceTaskTypeChange("s"), 2);
	publishTaskType("s", "code-review"); // real transition
	assert.equal(turnsSinceTaskTypeChange("s"), 0);
});

test("phase-state: turn counter is monotonic", () => {
	noteTurnEnd("s", 7);
	noteTurnEnd("s", 4); // regression ignored
	publishTaskType("s", "agentic-loop");
	assert.equal(turnsSinceTaskTypeChange("s"), 0);
	noteTurnEnd("s", 9);
	assert.equal(turnsSinceTaskTypeChange("s"), 2);
});

test("phase-state: taskTypeChangedSinceCompaction flips on compaction", () => {
	noteTurnEnd("s", 2);
	publishTaskType("s", "code-edit");
	assert.equal(taskTypeChangedSinceCompaction("s"), true);
	noteTurnEnd("s", 4);
	noteCompaction("s");
	assert.equal(taskTypeChangedSinceCompaction("s"), false);
	noteTurnEnd("s", 6);
	publishTaskType("s", "creative");
	assert.equal(taskTypeChangedSinceCompaction("s"), true);
});

test("phase-state: subagent in-flight tracking by tool-call id", () => {
	subagentStarted("s", "tc1");
	subagentStarted("s", "tc2");
	assert.equal(subagentInFlight("s"), true);
	subagentEnded("s", "tc1");
	assert.equal(subagentInFlight("s"), true);
	subagentEnded("s", "tc2");
	assert.equal(subagentInFlight("s"), false);
	subagentEnded("s", "tc-never-started"); // harmless
	assert.equal(subagentInFlight("s"), false);
});

test("phase-state: deferral counter resets on committed compaction", () => {
	assert.equal(noteDeferral("s"), 1);
	assert.equal(noteDeferral("s"), 2);
	assert.equal(deferralCount("s"), 2);
	noteCompaction("s");
	assert.equal(deferralCount("s"), 0);
});

test("phase-state: self-compact flag arms once and consumes once", () => {
	armSelfCompact("s");
	assert.equal(consumeSelfCompact("s"), true);
	assert.equal(consumeSelfCompact("s"), false, "flag must not double-consume");
	armSelfCompact("s");
	disarmSelfCompact("s");
	assert.equal(consumeSelfCompact("s"), false, "disarm clears without consuming");
});

test("phase-state: sessions are isolated and clearable", () => {
	noteTurnEnd("a", 5);
	publishTaskType("a", "code-edit");
	subagentStarted("b", "tc1");
	assert.equal(turnsSinceTaskTypeChange("b"), undefined);
	assert.equal(subagentInFlight("a"), false);
	clearSession("a");
	assert.equal(turnsSinceTaskTypeChange("a"), undefined);
	assert.equal(subagentInFlight("b"), true);
});
