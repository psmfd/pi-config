import { test } from "node:test";
import assert from "node:assert/strict";
import {
	filterApplyForContext,
	hasActiveThinking,
	isPrivateOrLoopbackHost,
} from "../lib/guards.ts";

// --- isPrivateOrLoopbackHost -------------------------------------------------

test("guards: loopback and RFC 1918 hosts classify as private", () => {
	for (const url of [
		"http://localhost:8000/v1",
		"http://127.0.0.1:8000/v1",
		"http://127.255.0.1/v1",
		"http://[::1]:8000/v1",
		"http://10.0.0.5/v1",
		"http://172.16.0.1/v1",
		"http://172.31.255.254/v1",
		"http://192.168.1.10:11434/v1",
	]) {
		assert.equal(isPrivateOrLoopbackHost(url), true, url);
	}
});

test("guards: public/cloud hosts classify as NOT private", () => {
	for (const url of [
		"https://api.individual.githubcopilot.com",
		"https://api.anthropic.com",
		"https://chatgpt.com/backend-api/codex",
		"http://172.15.0.1/v1", // just outside 172.16/12
		"http://172.32.0.1/v1",
		"http://11.0.0.1/v1",
		"http://193.168.1.1/v1",
		"not a url",
		"",
	]) {
		assert.equal(isPrivateOrLoopbackHost(url), false, url);
	}
});

// --- hasActiveThinking -------------------------------------------------------

test("guards: thinking object with non-disabled type is active", () => {
	assert.equal(hasActiveThinking({ thinking: { type: "adaptive" } }), true);
	assert.equal(hasActiveThinking({ thinking: { type: "enabled", budget_tokens: 4096 } }), true);
});

test("guards: thinking object with no type key counts as active (fail toward suppression)", () => {
	assert.equal(hasActiveThinking({ thinking: {} }), true);
});

test("guards: disabled/absent/non-object thinking is NOT active", () => {
	assert.equal(hasActiveThinking({ thinking: { type: "disabled" } }), false);
	assert.equal(hasActiveThinking({ temperature: 0.5 }), false);
	// Completions-style "string-thinking" format must not false-positive.
	assert.equal(hasActiveThinking({ thinking: "auto" }), false);
	assert.equal(hasActiveThinking(undefined), false);
	assert.equal(hasActiveThinking("not-an-object"), false);
});

// --- filterApplyForContext ---------------------------------------------------

const FULL_APPLY = {
	chatTemplateKwargs: { enable_thinking: false },
	temperature: 0.6,
	topP: 0.95,
	maxTokensCap: 4096,
};

test("guards: local openai-completions model keeps the full apply block (live omlx rule shape)", () => {
	const { filtered, suppressed } = filterApplyForContext(FULL_APPLY, {
		api: "openai-completions",
		baseUrl: "http://localhost:8000/v1",
		payload: { messages: [] },
	});
	assert.deepEqual(filtered, FULL_APPLY);
	assert.deepEqual(suppressed, []);
});

test("guards: cloud openai-completions (github-copilot shape) suppresses chatTemplateKwargs only", () => {
	const { filtered, suppressed } = filterApplyForContext(FULL_APPLY, {
		api: "openai-completions",
		baseUrl: "https://api.individual.githubcopilot.com",
		payload: { messages: [] },
	});
	assert.equal(filtered.chatTemplateKwargs, undefined);
	assert.equal(filtered.temperature, 0.6);
	assert.equal(filtered.maxTokensCap, 4096);
	assert.deepEqual(suppressed, ["chatTemplateKwargs"]);
});

test("guards: non-completions api suppresses chatTemplateKwargs even on a private host", () => {
	const { filtered, suppressed } = filterApplyForContext(FULL_APPLY, {
		api: "openai-responses",
		baseUrl: "http://192.168.1.10/v1",
		payload: {},
	});
	assert.equal(filtered.chatTemplateKwargs, undefined);
	assert.deepEqual(suppressed, ["chatTemplateKwargs"]);
});

test("guards: active thinking suppresses temperature, topP, AND maxTokensCap", () => {
	const { filtered, suppressed } = filterApplyForContext(FULL_APPLY, {
		api: "anthropic-messages",
		baseUrl: "https://api.anthropic.com",
		payload: { thinking: { type: "adaptive" }, max_tokens: 32000 },
	});
	assert.equal(filtered.temperature, undefined);
	assert.equal(filtered.topP, undefined);
	assert.equal(filtered.maxTokensCap, undefined);
	assert.deepEqual(
		suppressed.sort(),
		["chatTemplateKwargs", "maxTokensCap", "temperature", "topP"].sort(),
	);
});

test("guards: disabled thinking does not suppress sampling fields", () => {
	const { filtered } = filterApplyForContext(
		{ temperature: 0.6, maxTokensCap: 4096 },
		{
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
			payload: { thinking: { type: "disabled" } },
		},
	);
	assert.equal(filtered.temperature, 0.6);
	assert.equal(filtered.maxTokensCap, 4096);
});

test("guards: unknown api / unparseable baseUrl fail toward suppression", () => {
	for (const ctx of [
		{ api: undefined, baseUrl: "http://localhost:8000/v1", payload: {} },
		{ api: "openai-completions", baseUrl: undefined, payload: {} },
		{ api: "openai-completions", baseUrl: "%%%", payload: {} },
	]) {
		const { filtered, suppressed } = filterApplyForContext(
			{ chatTemplateKwargs: { a: 1 } },
			ctx,
		);
		assert.equal(filtered.chatTemplateKwargs, undefined, JSON.stringify(ctx));
		assert.deepEqual(suppressed, ["chatTemplateKwargs"]);
	}
});

test("guards: input apply object is never mutated", () => {
	const apply = { ...FULL_APPLY };
	filterApplyForContext(apply, {
		api: "anthropic-messages",
		baseUrl: "https://api.anthropic.com",
		payload: { thinking: { type: "adaptive" } },
	});
	assert.deepEqual(apply, FULL_APPLY);
});
