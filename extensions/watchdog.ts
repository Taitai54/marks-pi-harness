import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Advisor watchdog (inspired by oh-my-pi): after each agent run, a smaller model
// reviews what just happened and may leave a severity-tagged advisory. The note
// is injected at the start of the next turn — guidance to weigh, not obey.

const WATCHDOG_MODEL = "qwen/qwen3.6-27b";
const LM_URL = "http://localhost:1234/v1/chat/completions";
const MAX_TRANSCRIPT_CHARS = 8000;
const COOLDOWN_TURNS = 3;

let pendingAdvisory: string | null = null;
let turnsSinceAdvisory = COOLDOWN_TURNS;
let checking = false;

const SYSTEM = `You are a silent QA watchdog reviewing a coding agent's latest actions.
Look ONLY for: destructive or risky commands, claims not backed by verification,
repeated failing approaches, drift from the user's request, or forgotten steps.
Respond with EXACTLY one JSON object, nothing else:
{"severity":"none"|"nit"|"concern"|"blocker","guidance":"<one sentence, empty if none>"}
Almost always the answer is severity "none". Only speak up for real issues.`;

function renderDelta(messages: any[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const role = m.role ?? "?";
    if (typeof m.content === "string") parts.push(`${role}: ${m.content}`);
    else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === "text") parts.push(`${role}: ${b.text}`);
        else if (b.type === "toolCall" || b.type === "tool_use") parts.push(`${role} tool ${b.name ?? b.toolName}: ${JSON.stringify(b.input ?? b.arguments ?? {}).slice(0, 400)}`);
        else if (b.type === "toolResult" || b.type === "tool_result") parts.push(`tool result: ${JSON.stringify(b.content ?? "").slice(0, 400)}`);
      }
    }
  }
  const text = parts.join("\n");
  return text.length > MAX_TRANSCRIPT_CHARS ? text.slice(-MAX_TRANSCRIPT_CHARS) : text;
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_SUBAGENT === "1") return; // don't watchdog subagents

  pi.on("agent_end", async (event, ctx) => {
    turnsSinceAdvisory++;
    if (checking || turnsSinceAdvisory < COOLDOWN_TURNS) return;
    const delta = renderDelta((event as any).messages ?? []);
    if (delta.length < 200) return; // nothing substantive to review
    checking = true;
    // fire and forget — never block the agent
    (async () => {
      try {
        const res = await fetch(LM_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: WATCHDOG_MODEL,
            messages: [
              { role: "system", content: SYSTEM },
              { role: "user", content: `Latest agent activity:\n\n${delta}` },
            ],
            max_tokens: 200,
            temperature: 0,
          }),
          signal: AbortSignal.timeout(90_000),
        });
        if (!res.ok) return;
        const data = await res.json();
        const raw: string = data?.choices?.[0]?.message?.content ?? "";
        const jsonMatch = /\{[\s\S]*\}/.exec(raw);
        if (!jsonMatch) return;
        const verdict = JSON.parse(jsonMatch[0]);
        if (verdict.severity && verdict.severity !== "none" && verdict.guidance) {
          pendingAdvisory = `<advisory severity="${verdict.severity}" from="watchdog">${String(verdict.guidance).slice(0, 300)} (Weigh this — do not blindly obey.)</advisory>`;
          turnsSinceAdvisory = 0;
          try { ctx.ui.setStatus("wd", `watchdog: ${verdict.severity}`); } catch { /* ui gone */ }
        } else {
          try { ctx.ui.setStatus("wd", ""); } catch { /* ui gone */ }
        }
      } catch { /* watchdog must never break the session */ }
      finally { checking = false; }
    })();
  });

  pi.on("before_agent_start", async () => {
    if (!pendingAdvisory) return;
    const content = pendingAdvisory;
    pendingAdvisory = null;
    return { message: { customType: "watchdog-advisory", content, display: true } };
  });
}
