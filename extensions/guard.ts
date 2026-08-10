import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Claude-Code-style blast-radius gate: reversible = free, destructive = confirm.
const RULES: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i, why: "recursive force delete" },
  { re: /\bgit\s+push\s+.*(--force|-f)\b/, why: "force push rewrites shared history" },
  { re: /\bgit\s+reset\s+--hard\b/, why: "discards uncommitted work" },
  { re: /\bgit\s+clean\s+-[a-z]*f/, why: "deletes untracked files" },
  { re: /\bkill(all)?\b.*-9|\bpkill\b/, why: "force-killing processes" },
  { re: /\bsudo\b/, why: "privilege escalation" },
  { re: /curl[^|]*\|\s*(ba|z)?sh|wget[^|]*\|\s*(ba|z)?sh/, why: "piping remote script to shell" },
  { re: /\bchmod\s+-R\s+777\b/, why: "world-writable permissions" },
  { re: /\b(mkfs|diskutil\s+erase|dd\s+.*of=\/dev)/i, why: "disk-level destruction" },
  { re: /\b(shutdown|reboot|halt)\b/, why: "system power control" },
  { re: /--no-verify\b/, why: "bypasses hooks — fix the failure instead" },
  { re: /rm\s+.*package-lock\.json|rm\s+.*\.lock\b/, why: "deleting lock files to silence errors" },
  { re: /\bmlx_vlm\.server|mlx-vlm.*serve|localhost:8080|127\.0\.0\.1:8080/, why: "second model server — can exhaust memory and crash this machine" },
  { re: /\blms\s+load\b/, why: "loading another model into memory" },
];

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash" && event.toolName !== "bash_background") return;
    const cmd: string = (event.input as any)?.command ?? "";
    for (const rule of RULES) {
      if (!rule.re.test(cmd)) continue;
      let ok = false;
      try {
        ok = await ctx.ui.confirm(`Guarded command (${rule.why})`, cmd.slice(0, 300));
      } catch {
        ok = false; // non-interactive mode: deny by default
      }
      if (!ok) {
        return {
          block: true,
          reason:
            `Blocked: ${rule.why}. Do not retry this command or work around the block with a variant. ` +
            `Explain to the user what you wanted to do and why, and let them decide.`,
        };
      }
      return; // user approved this one call — approval is not blanket
    }
  });
}
