import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";

// Budget awareness + mechanical stall detection (BATS arXiv 2511.17006 + the
// ARIS stall ladder). Small models burn twenty calls circling one dead lead
// because they have no sense of spend; a visible countdown plus an explicit
// dig-vs-pivot rule turns that judgment into arithmetic. Stall detection is
// mechanical (repeated similar tool calls), not a quality judgment — it
// redirects, it never acquits.

const SOFT_TOOL_BUDGET = 60;      // per session; a nudge, not a hard stop
const RECENT_WINDOW = 10;
const REPEAT_THRESHOLD = 3;

let toolCalls = 0;
let recent: string[] = [];        // hashes of recent (tool, args-prefix)
let stallNudged = false;

function callSig(name: string, args: unknown): string {
  const a = JSON.stringify(args ?? {}).slice(0, 80);
  return createHash("sha256").update(`${name}:${a}`).digest("hex").slice(0, 12);
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => { toolCalls = 0; recent = []; stallNudged = false; });

  pi.on("tool_call", async (event) => {
    toolCalls++;
    const name = (event as any).toolName ?? (event as any).name ?? "?";
    recent.push(callSig(name, (event as any).arguments ?? (event as any).input));
    if (recent.length > RECENT_WINDOW) recent.shift();
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const usage = (ctx as any).getContextUsage?.();
    const win = (ctx as any).model?.contextWindow;
    const ctxPct = usage?.tokens && win ? Math.round((usage.tokens / win) * 100) : null;

    const counts = new Map<string, number>();
    for (const sig of recent) counts.set(sig, (counts.get(sig) ?? 0) + 1);
    const maxRepeat = Math.max(0, ...counts.values());
    const stalled = maxRepeat >= REPEAT_THRESHOLD;

    const parts = [`tool calls: ${toolCalls}${toolCalls > SOFT_TOOL_BUDGET ? ` (over the ~${SOFT_TOOL_BUDGET} soft budget — commit to the best answer you have)` : ""}`];
    if (ctxPct !== null) parts.push(`context: ${ctxPct}%`);
    let rule = "Budget rule: ample budget -> dig deeper on the current promising lead; low budget or high context -> pivot to an unexplored path or commit to the best supported answer.";
    if (stalled && !stallNudged) {
      stallNudged = true;
      rule += " STALL DETECTED: you have made 3+ near-identical tool calls. Repeating them again will not produce a different result. Pivot STRUCTURE, not parameters: change the source, the method, or the question — or report what is blocking you.";
    } else if (!stalled) {
      stallNudged = false;
    }
    return {
      message: {
        customType: "budget",
        content: `<budget>${parts.join(" | ")}. ${rule}</budget>`,
        display: false,
      },
    };
  });
}
