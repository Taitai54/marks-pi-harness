import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash } from "node:crypto";

// Goal mode + verification gates, ported from prime-agent's autonomous mode:
// - /goal <text>   set a persistent objective, re-injected every turn
// - /gate <cmd>    add a shell command that must pass before the goal can close
// - goal_complete  tool the model calls when it believes it is done; gates run,
//                  failures feed back, and a gate is NOT rerun until the
//                  workspace actually changed (objective anti-spin check).

const GATE_TIMEOUT_MS = 5 * 60 * 1000;
const GATE_OUTPUT_CAP = 4000;

let goal: string | null = null;
let gates: string[] = [];
let lastFailedHash: string | null = null;

async function run(pi: ExtensionAPI, cmd: string, timeout: number): Promise<{ code: number; out: string }> {
  try {
    const r: any = await (pi as any).exec("/bin/zsh", ["-lc", cmd], { timeout });
    const code = r?.exitCode ?? r?.code ?? 0;
    const out = [r?.stdout ?? "", r?.stderr ?? ""].filter(Boolean).join("\n");
    return { code, out };
  } catch (e: any) {
    return { code: 1, out: String(e?.message ?? e) };
  }
}

async function workspaceHash(pi: ExtensionAPI): Promise<string | null> {
  const head = await run(pi, "git rev-parse HEAD 2>/dev/null", 10_000);
  if (head.code !== 0) return null; // not a git repo — skip unchanged-check
  const status = await run(pi, "git status --porcelain && git diff", 20_000);
  return createHash("sha256").update(head.out + status.out).digest("hex");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("goal", {
    description: "Set/show/clear the persistent goal (usage: /goal <text> | /goal clear)",
    handler: async (args, ctx) => {
      const text = (args ?? "").trim();
      if (text === "clear") { goal = null; lastFailedHash = null; ctx.ui.setStatus("goal", ""); ctx.ui.notify("Goal cleared.", "info"); return; }
      if (!text) { ctx.ui.notify(goal ? `Goal: ${goal}` : "No goal set. /goal <text>", "info"); return; }
      goal = text;
      lastFailedHash = null;
      ctx.ui.setStatus("goal", "goal set");
      ctx.ui.notify(`Goal set. It will be re-injected every turn until goal_complete passes${gates.length ? ` (${gates.length} gate(s))` : ""}.`, "info");
    },
  });

  pi.registerCommand("gate", {
    description: "Add a verification gate command (usage: /gate <cmd> | /gate clear | /gate list)",
    handler: async (args, ctx) => {
      const text = (args ?? "").trim();
      if (text === "clear") { gates = []; lastFailedHash = null; ctx.ui.notify("Gates cleared.", "info"); return; }
      if (!text || text === "list") { ctx.ui.notify(gates.length ? gates.map((g, i) => `${i + 1}. ${g}`).join(" | ") : "No gates. /gate <cmd>", "info"); return; }
      gates.push(text);
      ctx.ui.notify(`Gate added (${gates.length} total): ${text}`, "info");
    },
  });

  pi.registerTool({
    name: "goal_complete",
    label: "Goal complete",
    description:
      "Call this ONLY when you believe the current goal is fully achieved. " +
      "Verification gates run automatically; if one fails you get the output back — fix the cause and try again. " +
      "Include one sentence of evidence for why the goal is done.",
    parameters: Type.Object({
      evidence: Type.String({ description: "One sentence: what you verified" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!goal) {
        return { content: [{ type: "text", text: "No goal is set — nothing to complete." }], details: {} };
      }
      if (gates.length) {
        const hash = await workspaceHash(pi);
        if (hash && lastFailedHash && hash === lastFailedHash) {
          return {
            content: [{ type: "text", text: "Gates NOT rerun: the workspace is unchanged since the last failed gate. Edit source files or tests to address the failure before attempting to finish again." }],
            isError: true, details: {},
          };
        }
        for (const g of gates) {
          const r = await run(pi, g, GATE_TIMEOUT_MS);
          if (r.code !== 0) {
            lastFailedHash = hash;
            const out = r.out.length > GATE_OUTPUT_CAP ? r.out.slice(-GATE_OUTPUT_CAP) : r.out;
            return {
              content: [{ type: "text", text: `GATE FAILED (exit ${r.code}): ${g}\n\n${out}\n\nThe goal is not complete. Fix the failure, then call goal_complete again.` }],
              isError: true, details: {},
            };
          }
        }
        lastFailedHash = null;
      }
      const done = goal;
      goal = null;
      ctx.ui.setStatus("goal", "");
      ctx.ui.notify(`Goal complete${gates.length ? " (all gates passed)" : ""}: ${done}`, "info");
      return { content: [{ type: "text", text: `Goal closed${gates.length ? " — all gates passed" : ""}. Evidence: ${params.evidence}` }], details: {} };
    },
  });

  pi.on("before_agent_start", async () => {
    if (!goal) return;
    const gateLine = gates.length
      ? ` Before it can close, these commands must pass: ${gates.join(" ; ")}.`
      : "";
    return {
      message: {
        customType: "goal-reminder",
        content: `<goal>Active goal: ${goal}.${gateLine} Keep working toward it; call goal_complete with evidence when done. A passed gate only proves what the gate checks — do not game it.</goal>`,
        display: false,
      },
    };
  });

  pi.on("session_start", async () => { goal = null; gates = []; lastFailedHash = null; });
}
