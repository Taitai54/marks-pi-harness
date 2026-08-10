---
name: deep-research
description: Structured multi-round web research for questions that need many searches and pages. Use for "research X", "find the best Y", "compare Z options", "what happened with W" — anything needing more than two fetches. Keeps context small via rounds, a rewritten report, and the facts store.
---

# Deep research (rounds + facts store)

Raw back-and-forth history poisons small models: by page 6 you have lost page 1,
and your own earlier speculation starts reading like established fact. This skill
replaces accumulation with ROUNDS. Scratch thinking is discarded every round; the
only things that survive are the REPORT (rewritten each round), the FACTS STORE
(facts_add/facts_recall), and the LEDGER of what failed.

## Before round 1 — plan first (this turn decides the whole trajectory)

1. `facts_recall` with the core question keywords. You may already know part of the answer from an earlier session.
2. Check the question for keyword traps BEFORE searching:
   - Specific number in the topic ("42 year old") -> strip it unless removing it changes the meaning ("GPT-4" keep).
   - Tutorial phrasing ("how to use X") -> real discussions say "my X setup", "X in production". Reframe.
   - Generic single noun ("marketing") -> too broad; ask the user for a facet instead of running a doomed sweep.
   - A person's name that collides ("Kevin Rose") -> anchor EVERY query with a disambiguating entity ("kevin rose digg founder").
3. Write the plan as your first Report (see format below): what must be verified, which
   sub-questions, which sources. 2-5 DIFFERENT-intent queries, passed as an ARRAY to one
   web_search call. Never put temporal words ("recent", "2026", "latest") or meta words
   ("news", "updates") in a query — use the `days` parameter for recency.

## Each round: Think -> Report -> Action

- **Think**: reason freely about what the last observation means. This is scratch — it
  will NOT be carried forward, so never cite your own Think text as evidence later.
- **Report**: rewrite it FROM SCRATCH, high density. Not an append. Format:

  ```
  QUESTION: <the user's question>
  VERIFIED (from fetched content, with source): ...
  UNVERIFIED LEADS (from snippets only): ...
  OPEN GAPS: what the answer still needs
  FAILED: approaches/sources tried that produced nothing (never retry these)
  NEXT: the single best next action and why
  ```

- **Action**: exactly one batched web_search OR 1-3 web_fetch calls. ALWAYS pass `goal`
  to web_fetch during research. Before any fetch, `facts_seen(url)`. After any page that
  taught you something, `facts_add` with EXTRACTED/INFERRED confidence and a verbatim quote.

## Search discipline

- Necessity check before every search, one line in Think: "do I already know this
  (facts_recall), and can search even help?" Skip searches that fail it.
- A failed source is NOT evidence of absence, but a clean search that finds nothing IS
  worth recording: add a fact "No source found stating X (searched YYYY-MM-DD)" as
  INFERRED. Negative evidence prevents both re-searching and overclaiming.
- One same-intent retry max. The FAILED list in the Report is binding.

## Restart protocol (context hygiene)

When context passes ~60% (see the <budget> line), or the harness compacts:
restart from ONLY (the question + the latest Report). Everything else is
reconstructable: facts are in the store, failures are in the Report. When writing
the first post-restart Report, treat the previous Report as the explicit baseline —
state what progress was made since it and which gaps remain from it, so nothing
silently drops.

## Before answering — verification pass

Run this checklist against your draft answer. Fix what fails, then answer:

1. Every claim in the answer traces to a VERIFIED fact (fetched content), not a snippet or your own Think text.
2. No wrong-entity mixups (right company/person/product — check aliases).
3. Dates: nothing presented as current that came from an unwindowed/undated source.
4. The user's ACTUAL constraint is addressed (e.g. "arrives in under a week" — not just "here are sellers").
5. Single-source claims are labeled as such; contradictions surfaced by facts_add are resolved or disclosed.
6. If the honest answer is "nothing solid found", SAY THAT — name the closest weak signal and what was searched. Never pad.

## Output

Answer from the final Report + facts_recall. Cite sources inline (domain is enough).
State verified facts plainly; label leads as leads. Keep the FAILED list available if
the user asks what was tried.
