import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdirSync, appendFileSync } from "node:fs";

// Persistent research fact store. A small local model with no prompt caching
// loses page 1 by the time it reads page 6, so it re-fetches and re-reads.
// This is the fix: an append-only SQLite store with provenance, three-tier
// confidence, and entity aliasing at write time ("Anthropic" = "Anthropic PBC"
// forever). Lives per-project in handoff/research/ next to the handoff notes:
// markdown stays the human artifact, this is the machine one.
//
// Tools: facts_add (after reading a page), facts_recall (BEFORE searching or
// fetching — you may already know it), facts_seen (before any fetch).

const DIR = "handoff/research";

let db: any = null;
let fts = false;

async function getDb() {
  if (db) return db;
  const { DatabaseSync } = await import("node:sqlite");
  mkdirSync(DIR, { recursive: true });
  db = new DatabaseSync(`${DIR}/facts.db`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id INTEGER PRIMARY KEY,
      claim TEXT NOT NULL,
      norm_claim TEXT NOT NULL,
      entities TEXT NOT NULL,
      confidence TEXT NOT NULL,
      source_url TEXT NOT NULL,
      source_quote TEXT,
      fetched_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS entities (key TEXT PRIMARY KEY, canonical TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS aliases (alias TEXT PRIMARY KEY, key TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS fetched (url TEXT PRIMARY KEY, fetched_at TEXT NOT NULL, fact_count INTEGER DEFAULT 0);
  `);
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(claim, entities, content=facts, content_rowid=id)`);
    fts = true;
  } catch { fts = false; }
  return db;
}

// ---- entity aliasing (the thing knowledge-graph tools skip) ----------------

function normEntity(name: string): string {
  return name.toLowerCase()
    .replace(/\b(inc|ltd|llc|plc|pbc|gmbh|corp|co|company)\.?$/g, "")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

function dice(a: string, b: string): number {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return (2 * hit) / (A.size + B.size);
}

function acronymOf(name: string): string {
  return name.split(/\s+/).filter((w) => w.length > 2).map((w) => w[0]).join("");
}

// normalize -> exact alias -> fuzzy/acronym -> new canonical. Runs at WRITE
// time so recall stays a plain lookup.
function resolveEntity(d: any, raw: string): string {
  const norm = normEntity(raw);
  if (!norm) return raw.trim();
  const hit = d.prepare(`SELECT key FROM aliases WHERE alias = ?`).get(norm);
  if (hit) return hit.key;
  const all = d.prepare(`SELECT key, canonical FROM entities`).all();
  for (const e of all) {
    if (dice(norm, e.key) >= 0.84 || (norm.length >= 2 && norm === acronymOf(e.canonical).toLowerCase())) {
      d.prepare(`INSERT OR IGNORE INTO aliases (alias, key) VALUES (?, ?)`).run(norm, e.key);
      return e.key;
    }
  }
  d.prepare(`INSERT OR IGNORE INTO entities (key, canonical) VALUES (?, ?)`).run(norm, raw.trim());
  d.prepare(`INSERT OR IGNORE INTO aliases (alias, key) VALUES (?, ?)`).run(norm, norm);
  return norm;
}

function normClaim(claim: string): string {
  return claim.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "facts_add",
    label: "Store facts",
    description:
      "Store facts learned from a fetched page into the persistent research store. Call after reading any page during " +
      "research. Each fact: one SELF-CONTAINED sentence (no pronouns), the entities it mentions, confidence " +
      "(EXTRACTED = the page states it outright; INFERRED = you concluded it; AMBIGUOUS = unclear), and a short " +
      "verbatim quote. Facts persist across sessions and are recalled with facts_recall.",
    parameters: Type.Object({
      source_url: Type.String({ description: "URL the facts came from" }),
      facts: Type.Array(Type.Object({
        claim: Type.String({ description: "One self-contained sentence" }),
        entities: Type.Array(Type.String(), { description: "Entities the claim is about" }),
        confidence: Type.String({ description: "EXTRACTED | INFERRED | AMBIGUOUS" }),
        quote: Type.Optional(Type.String({ description: "Verbatim supporting span, <=200 chars" })),
      })),
    }),
    async execute(_id, params) {
      const d = await getDb();
      const now = new Date().toISOString();
      let added = 0, corroborated = 0;
      const conflicts: string[] = [];
      for (const f of params.facts ?? []) {
        const conf = /^(EXTRACTED|INFERRED|AMBIGUOUS)$/i.test(f.confidence) ? f.confidence.toUpperCase() : "AMBIGUOUS";
        const keys = (f.entities ?? []).map((e: string) => resolveEntity(d, e)).sort();
        const nc = normClaim(f.claim);
        const dup = d.prepare(`SELECT id, source_url FROM facts WHERE norm_claim = ? AND entities = ?`).get(nc, JSON.stringify(keys));
        if (dup) {
          if (dup.source_url !== params.source_url) corroborated++; // second independent source — keep it
          else continue; // same claim, same source — pure dup
        }
        // light contradiction check: same entities, same non-numeric skeleton, different number
        const skeleton = nc.replace(/\d[\d.,]*/g, "#");
        if (/\d/.test(nc)) {
          const rows = d.prepare(`SELECT claim, source_url FROM facts WHERE entities = ?`).all(JSON.stringify(keys));
          for (const r of rows) {
            const rn = normClaim(r.claim);
            if (rn !== nc && /\d/.test(rn) && rn.replace(/\d[\d.,]*/g, "#") === skeleton) {
              conflicts.push(`"${f.claim}" vs earlier "${r.claim}" (${r.source_url})`);
            }
          }
        }
        const res = d.prepare(
          `INSERT INTO facts (claim, norm_claim, entities, confidence, source_url, source_quote, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(f.claim, nc, JSON.stringify(keys), conf, params.source_url, (f.quote ?? "").slice(0, 200), now);
        if (fts) d.prepare(`INSERT INTO facts_fts (rowid, claim, entities) VALUES (?, ?, ?)`).run(res.lastInsertRowid, f.claim, keys.join(" "));
        try {
          appendFileSync(`${DIR}/facts.jsonl`, JSON.stringify({ claim: f.claim, entities: keys, confidence: conf, source_url: params.source_url, quote: f.quote ?? "", fetched_at: now }) + "\n");
        } catch { /* jsonl mirror is best-effort */ }
        added++;
      }
      d.prepare(`INSERT INTO fetched (url, fetched_at, fact_count) VALUES (?, ?, ?) ON CONFLICT(url) DO UPDATE SET fetched_at = ?, fact_count = fact_count + ?`)
        .run(params.source_url, now, added, now, added);
      let msg = `Stored ${added} fact(s)${corroborated ? `, ${corroborated} corroborated by a second source` : ""}.`;
      if (conflicts.length) msg += `\nPOSSIBLE CONTRADICTION${conflicts.length > 1 ? "S" : ""} — resolve before answering:\n- ${conflicts.slice(0, 5).join("\n- ")}`;
      return { content: [{ type: "text", text: msg }], details: {} };
    },
  });

  pi.registerTool({
    name: "facts_recall",
    label: "Recall facts",
    description:
      "Recall stored facts BEFORE searching or fetching — you may already have the answer from an earlier page or " +
      "session. Returns one line per fact with confidence, source, and date. EXTRACTED facts first.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Keywords to match against claims" })),
      entity: Type.Optional(Type.String({ description: "Filter to facts about this entity" })),
      budget: Type.Optional(Type.Number({ description: "Max facts returned (default 20)" })),
    }),
    async execute(_id, params) {
      const d = await getDb();
      const budget = params.budget ?? 20;
      let rows: any[] = [];
      const entKey = params.entity ? resolveEntity(d, params.entity) : null;
      if (params.query && fts) {
        try {
          const ftsQuery = params.query.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean).join(" OR ");
          rows = d.prepare(
            `SELECT f.* FROM facts_fts t JOIN facts f ON f.id = t.rowid WHERE facts_fts MATCH ? ORDER BY CASE f.confidence WHEN 'EXTRACTED' THEN 0 WHEN 'INFERRED' THEN 1 ELSE 2 END, f.fetched_at DESC LIMIT ?`
          ).all(ftsQuery, budget * 2);
        } catch { rows = []; }
      }
      if (!rows.length && params.query) {
        const like = `%${params.query.split(/\s+/)[0]}%`;
        rows = d.prepare(`SELECT * FROM facts WHERE claim LIKE ? OR entities LIKE ? ORDER BY CASE confidence WHEN 'EXTRACTED' THEN 0 WHEN 'INFERRED' THEN 1 ELSE 2 END, fetched_at DESC LIMIT ?`).all(like, like, budget * 2);
      }
      if (!params.query) {
        rows = d.prepare(`SELECT * FROM facts ORDER BY CASE confidence WHEN 'EXTRACTED' THEN 0 WHEN 'INFERRED' THEN 1 ELSE 2 END, fetched_at DESC LIMIT ?`).all(budget * 2);
      }
      if (entKey) rows = rows.filter((r) => JSON.parse(r.entities).includes(entKey));
      if (!rows.length) {
        return { content: [{ type: "text", text: "No stored facts match. This is a real gap — search/fetch to fill it, then facts_add what you learn." }], details: {} };
      }
      const total = rows.length;
      rows = rows.slice(0, budget);
      const lines = rows.map((r) => {
        let host = r.source_url;
        try { host = new URL(r.source_url).hostname.replace(/^www\./, ""); } catch { /* keep */ }
        return `[${r.confidence}] ${r.claim} (${host}, ${r.fetched_at.slice(0, 10)})`;
      });
      const note = total > budget ? `\n\n[${total - budget} more facts matched — narrow the query or raise budget]` : "";
      return { content: [{ type: "text", text: lines.join("\n") + note }], details: {} };
    },
  });

  pi.registerTool({
    name: "facts_seen",
    label: "Check fetched",
    description: "Check whether a URL was already fetched and mined for facts this project. Call before web_fetch during research to avoid re-reading pages.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to check" }),
    }),
    async execute(_id, params) {
      const d = await getDb();
      const row = d.prepare(`SELECT fetched_at, fact_count FROM fetched WHERE url = ?`).get(params.url);
      if (!row) return { content: [{ type: "text", text: "Not fetched before." }], details: {} };
      return {
        content: [{ type: "text", text: `Already fetched ${row.fetched_at.slice(0, 16)} — ${row.fact_count} fact(s) stored. Use facts_recall instead of re-fetching.` }],
        details: {},
      };
    },
  });
}
