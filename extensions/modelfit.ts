import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Per-model harness fitting (prime-agent lesson: capability-gate the prompt,
// and preemptively name the mistakes each model class actually makes).
// Injects ONE short appended note when the session's model changes class.
// Small local models get a tight leash; big models get autonomy.
// The 2026-08-04 O'Reilly session showed mistral-small emitting raw
// [TOOL_CALLS] tokens as text and claiming it has no tools — the small-model
// note names those exact failure modes.

type Klass = "small" | "mid" | "large";

function classify(id: string | undefined, contextWindow: number | undefined): Klass {
  const m = (id ?? "").toLowerCase();
  if (/(^|[^0-9])(3b|4b|7b|8b|9b|12b|14b|24b|27b|30b|32b)([^0-9]|$)|small|mini|nano|tiny/.test(m)) return "small";
  if (/(70b|72b|122b|120b|235b|480b)|large|opus/.test(m)) return "large";
  if (contextWindow && contextWindow < 64_000) return "small";
  return "mid";
}

const NOTES: Record<Klass, string> = {
  small: `<harness-note>
You are running as a small local model. Follow these rules exactly:
- You DO have working tools: read, write, edit, bash, web_search, web_fetch, todo_write, task, bash_background. Never claim you lack access to the system or the internet.
- Invoke tools ONLY through real tool calls. Never print tool-call syntax (like "[TOOL_CALLS]" or a JSON blob) as plain text — that executes nothing.
- Do not invent tools or functions that are not in your tool list (no call_skill(), no run_subagent()).
- Take ONE small step per turn: one tool call, look at the result, then decide the next step.
- Keep bash output small: pipe through head, tail, or grep. Never cat a whole large file.
- Do the work yourself; use the task subagent only if the user asks for it.
- Web: search with short keyword queries (never "in stock" / "under a week" phrases); if a fetch errors, switch source — never refetch the same URL bigger. Only facts you saw in fetched page content count as verified.
- When the task is done, stop calling tools and state the final answer briefly.
</harness-note>`,
  mid: `<harness-note>
Model class: mid-size local. Work in small verified steps, keep tool output lean (head/tail/grep), and delegate only self-contained research to the task tool (tier "fast"). Stop and state the final answer when done.
</harness-note>`,
  large: "",
};

export default function (pi: ExtensionAPI) {
  let lastKlass: Klass | null = null;

  pi.on("before_agent_start", async (_event, ctx) => {
    const model = (ctx as any).model;
    const klass = classify(model?.id, model?.contextWindow);
    if (klass === lastKlass) return;
    lastKlass = klass;
    try { ctx.ui.setStatus("fit", klass === "large" ? "" : `fit:${klass}`); } catch { /* ui */ }
    const note = NOTES[klass];
    if (!note) return;
    return { message: { customType: "modelfit", content: note, display: false } };
  });
}
