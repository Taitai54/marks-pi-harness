import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import { resolve } from "node:path";

// File-freshness guard: block edits to files that changed on disk since the
// agent last read them (external edit, linter, another process).

const lastRead = new Map<string, number>();

// noop-loop guard (borrowed from oh-my-pi): block the 3rd identical tool call in a row
let lastCallKey = "";
let repeatCount = 0;

// failed-edit guard (observed live 2026-08-08: repeated oldText mismatches on
// style.css minutes apart = model editing from a stale memory of the file).
// After ANY failed edit, further edits to that file are blocked until it is re-read.
const editFailed = new Set<string>();

function mtime(path: string): number | null {
  try { return statSync(path).mtimeMs; } catch { return null; }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => { lastRead.clear(); });

  pi.on("tool_result", async (event) => {
    const name = (event as any).toolName;
    const input = (event as any).input;
    const path = input?.path ?? input?.file_path ?? input?.filePath;
    if (!path) return;
    const abs = resolve(String(path));
    const isError = (event as any).result?.isError === true;
    if (name === "edit" && isError) {
      editFailed.add(abs);
      return;
    }
    if (name === "read") editFailed.delete(abs);
    // reading or writing establishes known state
    if (name === "read" || name === "write" || (name === "edit" && !isError)) {
      const m = mtime(abs);
      if (m !== null) lastRead.set(abs, m);
      if (name !== "read") editFailed.delete(abs);
    }
  });

  pi.on("tool_call", async (event) => {
    const key = event.toolName + JSON.stringify(event.input ?? {});
    if (key === lastCallKey) {
      if (++repeatCount >= 3) {
        repeatCount = 0;
        return {
          block: true,
          reason:
            "You have made this exact tool call 3 times in a row — repeating it will not change the outcome. " +
            "Step back: re-read the file or error, form a different hypothesis, and try a different approach.",
        };
      }
    } else {
      lastCallKey = key;
      repeatCount = 1;
    }
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const input = event.input as any;
    const raw = input?.path ?? input?.file_path ?? input?.filePath;
    if (!raw) return;
    const path = resolve(String(raw));
    if (event.toolName === "edit" && editFailed.has(path)) {
      return {
        block: true,
        reason:
          `Your previous edit to ${path} FAILED to match — your memory of this file is stale. ` +
          `Read the file (at least the region you are editing) first, then re-apply the edit ` +
          `using the exact current text. Do not guess at whitespace from memory.`,
      };
    }
    const known = lastRead.get(path);
    const current = mtime(path);
    if (known === undefined || current === null) return; // new file or never read — allow
    if (current > known) {
      return {
        block: true,
        reason:
          `${path} changed on disk after you last read it (external edit or another process). ` +
          `Read it again first, then re-apply your change against the current content.`,
      };
    }
  });
}
