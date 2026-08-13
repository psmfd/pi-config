/**
 * Registration surface and the PI_HASHLINE_EDIT off-switch (patch #4).
 * Uses a minimal fake ExtensionAPI: registerTool collects tool names,
 * event subscription is a no-op.
 */

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import extension from "../index";

interface FakeTool {
	name: string;
}

function makeFakePi(): { pi: never; registered: string[] } {
	const registered: string[] = [];
	const pi = {
		registerTool(tool: FakeTool): void {
			registered.push(tool.name);
		},
		on(): void {
			/* events unused in this test */
		},
	};
	return { pi: pi as never, registered };
}

describe("hashline-edit registration", () => {
	afterEach(() => {
		delete process.env.PI_HASHLINE_EDIT;
	});

	it("registers read and edit overrides by default", () => {
		delete process.env.PI_HASHLINE_EDIT;
		const { pi, registered } = makeFakePi();
		extension(pi);
		assert.ok(registered.includes("read"), `registered: ${registered.join(", ")}`);
		assert.ok(registered.includes("edit"), `registered: ${registered.join(", ")}`);
	});

	it("PI_HASHLINE_EDIT=0 registers nothing", () => {
		process.env.PI_HASHLINE_EDIT = "0";
		const { pi, registered } = makeFakePi();
		extension(pi);
		assert.equal(registered.length, 0);
	});

	it("PI_HASHLINE_EDIT=false registers nothing", () => {
		process.env.PI_HASHLINE_EDIT = "false";
		const { pi, registered } = makeFakePi();
		extension(pi);
		assert.equal(registered.length, 0);
	});
});
