// Deliberate competing registration used to prove P2 collision behavior.
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";

const factories = {
  write: createWriteToolDefinition,
  edit: createEditToolDefinition,
  bash: createBashToolDefinition,
};

export default function p2CollisionFixture(pi) {
  const name = process.env.P2_COLLISION_TOOL;
  const factory = factories[name];
  if (!factory) throw new Error(`unsupported P2 collision tool: ${name}`);
  pi.registerTool(factory(process.cwd()));
}
