---
name: prime
description: Cold-start on the CURRENT project — read the latest handoff and project context, then brief the user on exactly where things stand. Use when the user says prime, catch up, where were we, get up to speed, or starts a fresh session on ongoing work.
---

# Prime — resume a project cold

Follow exactly, in order:

## 1. Gather context (read, do not guess)

```bash
ls handoff/ 2>/dev/null | tail -3        # newest handoffs
```

- Read `handoff/LATEST.md` if it exists (this is the main source of truth).
- Read the project's `AGENTS.md` or `CLAUDE.md` if present (project conventions).
- If a git repo: `git status --short && git log --oneline -5` (what changed since the handoff).
- If no handoff/ folder exists: say so, then briefly survey the project (`ls`, README, package.json) instead.

## 2. Brief the user (short, then stop)

Reply with exactly this structure, max ~12 lines total:

- **Where we left off**: 2-3 sentences from the handoff's State section.
- **Decided**: the settled decisions (do not reopen these).
- **Next up**: the handoff's first 2-3 next steps, verbatim.
- **Watch out**: any landmines.
- End with: "Ready to continue — say the word or point me elsewhere."

## 3. Rules

- Do NOT start working until the user confirms the direction.
- Do NOT re-derive or second-guess settled decisions from the handoff.
- If git shows changes NEWER than the handoff, flag them: the handoff may be stale.
