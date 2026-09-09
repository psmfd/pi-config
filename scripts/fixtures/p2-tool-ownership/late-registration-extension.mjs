// Post-load same-name registration used to prove P2 replacement semantics.
// Registers nothing at load; /p2-late-register <tool> registers the pinned
// factory definition from inside a command handler, after every load-time
// owner is installed.
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

export default function p2LateRegistrationFixture(pi) {
  pi.registerCommand("p2-late-register", {
    description: "Register a same-name tool after load (P2 replacement probe)",
    handler: async (args) => {
      const name = args.trim();
      const factory = factories[name];
      if (!factory) throw new Error(`unsupported P2 late registration: ${name}`);
      pi.registerTool(factory(process.cwd()));
    },
  });
}
