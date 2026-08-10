import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";

// Claude-Code-style Agent tool: delegate scoped work to a child pi process.
// "fast" uses the 27B (cheap scouting/search); "main" uses the 122B.
// Only models already registered in models.json can be named — no surprise loads.

const MODELS = {
  fast: "qwen/qwen3.6-27b",
  main: "qwen3.5-122b-a10b",
} as const;

export default function (pi: ExtensionAPI) {
  if (process.env.PI_SUBAGENT === "1") return; // no nesting

  pi.registerTool({
    name: "task",
    label: "Subagent",
    description:
      "Delegate a self-contained task to a subagent (a child pi process with the same tools). " +
      "Use for research, broad searches, or grunt work whose details you don't need — only the conclusion. " +
      "tier 'fast' = small model, good for search/summarize; 'main' = full model, for hard reasoning. " +
      "The subagent has no access to this conversation: include ALL needed context in the prompt, " +
      "and tell it exactly what to return.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Complete, self-contained task description" }),
      tier: Type.Optional(Type.Union([Type.Literal("fast"), Type.Literal("main")], { description: "Model tier (default fast)" })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const model = MODELS[params.tier ?? "fast"];
      onUpdate?.({ content: [{ type: "text", text: `Subagent (${model}) working…` }], details: {} });
      const out = await new Promise<{ text: string; err: string | null }>((resolve) => {
        execFile(
          "pi",
          ["-p", "--no-session", "--provider", "lmstudio", "--model", model, params.prompt],
          {
            cwd: process.cwd(),
            timeout: 15 * 60 * 1000,
            maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env, PI_SUBAGENT: "1" },
            signal,
          },
          (error, stdout, stderr) => resolve({ text: stdout?.trim() || "", err: error ? (stderr?.trim() || error.message) : null }),
        );
      });
      if (out.err && !out.text) {
        return { content: [{ type: "text", text: `Subagent failed: ${out.err.slice(0, 500)}` }], isError: true, details: {} };
      }
      return { content: [{ type: "text", text: out.text || "(subagent returned no output)" }], details: {} };
    },
  });
}
