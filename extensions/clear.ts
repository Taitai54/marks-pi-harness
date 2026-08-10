/**
 * /clear — alias for /new: start a fresh session without exiting pi.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function clear(pi: ExtensionAPI) {
  pi.registerCommand("clear", {
    description: "Start a fresh session (alias for /new)",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const { cancelled } = await ctx.newSession();
      if (!cancelled) ctx.ui.notify("Fresh session started.", "info");
    },
  });
}
