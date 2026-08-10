import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, execFile } from "node:child_process";
import { openSync, readFileSync, existsSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";

interface BgProc {
  name: string;
  pid: number;
  command: string;
  log: string;
  startedAt: number;
  exitCode: number | null;
}

const procs = new Map<string, BgProc>();

function portOpen(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port, host: "127.0.0.1" });
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
}

function tailFile(path: string, lines: number): string {
  if (!existsSync(path)) return "(no log yet)";
  const text = readFileSync(path, "utf8");
  return text.split("\n").slice(-lines).join("\n");
}

function statusLine(): string {
  const running = [...procs.values()].filter((p) => p.exitCode === null);
  return running.length
    ? `bg: ${running.map((p) => `${p.name}(${p.pid})`).join(", ")}`
    : "";
}

export default function (pi: ExtensionAPI) {
  // --- LM Studio server auto-start ---
  pi.on("session_start", async (_event, ctx) => {
    if (await portOpen(1234)) return;
    const lms = `${homedir()}/.lmstudio/bin/lms`;
    if (!existsSync(lms)) return;
    ctx.ui.notify("LM Studio server not running — starting it…", "info");
    await new Promise<void>((resolve) => {
      execFile(lms, ["server", "start"], { timeout: 20000 }, () => resolve());
    });
    ctx.ui.notify(
      (await portOpen(1234))
        ? "LM Studio server up on :1234"
        : "Could not start LM Studio server — run: lms server start",
      (await portOpen(1234)) ? "info" : "error",
    );
  });

  // --- background process tools ---
  pi.registerTool({
    name: "bash_background",
    label: "Background bash",
    description:
      "Start a long-running command (dev server, watcher) detached in the background. " +
      "Returns the PID and log file. Use this instead of `bash` for anything that does not exit on its own. " +
      "Check on it with background_status; stop it with background_kill.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run" }),
      name: Type.String({ description: "Short unique name, e.g. 'dev-server'" }),
      cwd: Type.Optional(Type.String({ description: "Working directory (defaults to project cwd)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const existing = procs.get(params.name);
      if (existing && existing.exitCode === null) {
        return {
          content: [{ type: "text", text: `A process named '${params.name}' is already running (PID ${existing.pid}). Kill it first or pick another name.` }],
          isError: true, details: {},
        };
      }
      const log = `/tmp/pi-bg-${params.name}.log`;
      const fd = openSync(log, "w");
      const child = spawn("/bin/zsh", ["-lc", params.command], {
        cwd: params.cwd || process.cwd(),
        detached: true,
        stdio: ["ignore", fd, fd],
      });
      const rec: BgProc = {
        name: params.name, pid: child.pid!, command: params.command,
        log, startedAt: Date.now(), exitCode: null,
      };
      procs.set(params.name, rec);
      child.on("exit", (code) => {
        rec.exitCode = code ?? -1;
        try {
          ctx.ui.notify(`background '${rec.name}' exited (code ${rec.exitCode})`, code === 0 ? "info" : "error");
          ctx.ui.setStatus("bg", statusLine());
        } catch { /* ui may be gone at shutdown */ }
      });
      child.unref();
      ctx.ui.setStatus("bg", statusLine());
      // give fast-failing commands a moment so we can report immediately
      await new Promise((r) => setTimeout(r, 1500));
      const note = rec.exitCode !== null
        ? `WARNING: exited almost immediately with code ${rec.exitCode}. Log tail:\n${tailFile(log, 15)}`
        : `Running. Verify it works (e.g. curl the port), then continue.`;
      return {
        content: [{ type: "text", text: `Started '${params.name}' (PID ${rec.pid}), log: ${log}\n${note}` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "background_status",
    label: "Background status",
    description: "List background processes started this session, with recent log output.",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Only this process; omit for all" })),
      logLines: Type.Optional(Type.Number({ description: "Log lines to include (default 20)" })),
    }),
    async execute(_id, params) {
      const items = params.name
        ? [procs.get(params.name)].filter(Boolean) as BgProc[]
        : [...procs.values()];
      if (!items.length) {
        return { content: [{ type: "text", text: "No background processes this session." }], details: {} };
      }
      const n = params.logLines ?? 20;
      const text = items.map((p) =>
        `## ${p.name} — ${p.exitCode === null ? `RUNNING (PID ${p.pid})` : `EXITED code ${p.exitCode}`}\n` +
        `cmd: ${p.command}\nlog (${p.log}, last ${n} lines):\n${tailFile(p.log, n)}`,
      ).join("\n\n");
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  pi.registerTool({
    name: "background_kill",
    label: "Background kill",
    description: "Stop a background process started this session by name.",
    parameters: Type.Object({
      name: Type.String({ description: "Process name given at start" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const p = procs.get(params.name);
      if (!p) {
        return { content: [{ type: "text", text: `No process named '${params.name}'.` }], isError: true, details: {} };
      }
      if (p.exitCode !== null) {
        return { content: [{ type: "text", text: `'${p.name}' already exited (code ${p.exitCode}).` }], details: {} };
      }
      try { process.kill(-p.pid, "SIGTERM"); } catch { try { process.kill(p.pid, "SIGTERM"); } catch { /* gone */ } }
      ctx.ui.setStatus("bg", statusLine());
      return { content: [{ type: "text", text: `Sent SIGTERM to '${p.name}' (PID ${p.pid}).` }], details: {} };
    },
  });

  // /ps command for the human
  pi.registerCommand("ps", {
    description: "Show background processes",
    handler: async (_args, ctx) => {
      const items = [...procs.values()];
      ctx.ui.notify(
        items.length
          ? items.map((p) => `${p.name}: ${p.exitCode === null ? `running (${p.pid})` : `exited ${p.exitCode}`}`).join(" | ")
          : "No background processes",
        "info",
      );
    },
  });
}
