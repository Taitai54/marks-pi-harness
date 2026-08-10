import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connect } from "node:net";

// Network-aware guard. Born from 2026-08-04: `brew install exiftool` hung for
// 35m45s offline on a plane (pi's bash tool has no default timeout), and `npx`
// hung 4m49s the same day. Two jobs:
//   1. Every bash call gets a default timeout (the tool supports one in
//      seconds; the model just never sets it).
//   2. Network-touching commands and web tools fail INSTANTLY with clear
//      guidance when there is no connectivity.

const DEFAULT_TIMEOUT_S = 120;   // bash calls without an explicit timeout
const NETWORK_TIMEOUT_S = 90;    // network-heavy commands, even when online
const PROBE_TTL_MS = 20_000;     // reuse a connectivity verdict this long

const NETWORK_RE = new RegExp(
  [
    /\bbrew\s+(install|upgrade|update|tap|fetch)\b/,
    /\bnpm\s+(install|i|ci|update|add|audit)\b/,
    /\bnpx\s/, /\bbunx\s/,
    /\bpnpm\s+(install|add|i|update)\b/, /\byarn\s+(add|install|upgrade)\b/,
    /\bpip3?\s+(install|download)\b/, /\buv\s+(pip|add|sync|tool)\b/,
    /\bcargo\s+(install|add)\b/, /\bgem\s+install\b/, /\bgo\s+(get|install)\s/,
    /\bgit\s+(clone|fetch|pull|push|ls-remote)\b/,
    /\bcurl\s/, /\bwget\s/,
    /\bdocker\s+(pull|push|build)\b/,
    /\bapt(-get)?\s+(install|update)\b/,
  ].map((r) => r.source).join("|"),
);

let lastProbe = { at: 0, online: true };

function probe(timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: "1.1.1.1", port: 443 });
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
}

async function online(): Promise<boolean> {
  if (Date.now() - lastProbe.at < PROBE_TTL_MS) return lastProbe.online;
  const ok = await probe();
  lastProbe = { at: Date.now(), online: ok };
  return ok;
}

const OFFLINE_BASH_REASON =
  "OFFLINE: no network connectivity right now, so this install/fetch/clone would hang or fail. " +
  "Do NOT retry it, and do not try a different package manager — they are all offline too. " +
  "Solve the task with what is already on this machine: check for existing binaries (`which`, `ls /opt/homebrew/bin`), " +
  "use python3 stdlib or other installed tooling, or degrade gracefully. " +
  "If something genuinely must be installed, tell the user to run it once back online.";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!(await online())) ctx.ui.setStatus("net", "OFFLINE");
  });

  pi.on("tool_call", async (event, ctx) => {
    const name = event.toolName;

    if (name === "bash" || name === "bash_background") {
      const input = event.input as { command?: string; timeout?: number };

      // Observed live 2026-08-08: model ran `background_status --name x` as a
      // shell command (exit 127). Tools are not shell binaries — catch it.
      const toolAsCmd = /^\s*(background_status|background_kill|bash_background|todo_write|web_search|web_fetch|goal_complete|task)\b/.exec(input.command ?? "");
      if (toolAsCmd) {
        return {
          block: true,
          reason:
            `"${toolAsCmd[1]}" is one of YOUR TOOLS, not a shell command — running it in bash always fails. ` +
            `Invoke it as a tool call with its parameters instead.`,
        };
      }

      const isNet = NETWORK_RE.test(input.command ?? "");

      if (isNet && !(await online())) {
        ctx.ui.setStatus("net", "OFFLINE");
        return { block: true, reason: OFFLINE_BASH_REASON };
      }
      if (isNet) ctx.ui.setStatus("net", "");

      // input is mutable in tool_call hooks; timeout is in seconds
      if (name === "bash" && input.timeout === undefined) {
        input.timeout = isNet ? NETWORK_TIMEOUT_S : DEFAULT_TIMEOUT_S;
      }
      return;
    }

    if ((name === "web_search" || name === "web_fetch") && !(await online())) {
      ctx.ui.setStatus("net", "OFFLINE");
      return {
        block: true,
        reason:
          "OFFLINE: no network. Skip web research — answer from local files and your own knowledge, " +
          "and tell the user which claims you could not verify online.",
      };
    }
  });
}
