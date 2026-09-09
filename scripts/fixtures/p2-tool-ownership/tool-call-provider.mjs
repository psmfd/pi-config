// Deterministic in-process provider for real installed-pi tool-call probes.
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";

export default function p2ToolCallProvider(pi) {
  const tool = process.env.P2_TOOL_CALL;
  const rawArguments = process.env.P2_TOOL_ARGUMENTS;
  if (!tool || !rawArguments) {
    throw new Error("P2_TOOL_CALL and P2_TOOL_ARGUMENTS are required");
  }
  // The fixture emits a real tool call; keep it a probe of the three standard
  // mutation tools with a bounded argument payload, never a general executor.
  if (!["write", "edit", "bash"].includes(tool)) {
    throw new Error(`unsupported P2 tool call: ${tool}`);
  }
  if (rawArguments.length > 4096) {
    throw new Error("P2_TOOL_ARGUMENTS exceeds 4 KiB");
  }

  const arguments_ = JSON.parse(rawArguments);
  const faux = fauxProvider({
    provider: "p2-faux",
    models: [
      {
        id: "p2-tool-call",
        name: "P2 deterministic tool-call fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 16_384,
        maxTokens: 1_024,
      },
    ],
  });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall(tool, arguments_, { id: "p2-call" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("P2 tool-call probe complete."),
  ]);
  pi.registerProvider(faux.provider);
}
