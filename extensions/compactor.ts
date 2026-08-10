import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync, mkdirSync } from "node:fs";

// Micro-compaction, the supported way: cap huge tool results at creation time
// (full output goes to a spill file the agent can grep), surface context usage,
// and compact proactively before overflow forces it mid-task.

const CAP_CHARS = 30_000;      // ~7.5k tokens per tool result max
const COMPACT_AT = 0.8;        // proactive compaction threshold
const SPILL_DIR = "/tmp/pi-spill";

let spillCount = 0;
let compacting = false;

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    try { mkdirSync(SPILL_DIR, { recursive: true }); } catch { /* exists */ }
  });

  pi.on("tool_result", async (event) => {
    const content = (event as any).result?.content;
    if (!Array.isArray(content)) return;
    let changed = false;
    for (const block of content) {
      if (block?.type !== "text" || typeof block.text !== "string") continue;
      if (block.text.length <= CAP_CHARS) continue;
      const file = `${SPILL_DIR}/${Date.now()}-${++spillCount}.txt`;
      try { writeFileSync(file, block.text); } catch { continue; }
      block.text =
        block.text.slice(0, CAP_CHARS) +
        `\n\n[output capped at ${CAP_CHARS} of ${block.text.length} chars. ` +
        `Full output saved to ${file} — grep/read that file for the rest. ` +
        `Restate any facts you need from this output in your reply; it may be compacted away later.]`;
      changed = true;
    }
    if (changed) return { result: (event as any).result };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const usage = ctx.getContextUsage();
    if (!usage?.tokens || !ctx.model?.contextWindow) return;
    const frac = usage.tokens / ctx.model.contextWindow;
    ctx.ui.setStatus("ctx", `ctx ${(frac * 100).toFixed(0)}%`);
    if (frac >= COMPACT_AT && !compacting && ctx.isIdle()) {
      compacting = true;
      ctx.ui.notify(`Context at ${(frac * 100).toFixed(0)}% — compacting proactively…`, "info");
      ctx.compact({
        onComplete: () => { compacting = false; ctx.ui.notify("Compaction done.", "info"); },
        onError: () => { compacting = false; },
      });
    }
  });
}
