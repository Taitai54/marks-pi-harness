import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

// Web tools v2. Search: Brave API if a key exists in ~/.env, otherwise
// DuckDuckGo Lite (far more stable markup than html.duckduckgo.com).
// Fetch: r.jina.ai reader (clean markdown, keyless) with a local
// HTML-strip fallback. netguard.ts blocks both tools when offline.

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 20_000;

let envCache: Record<string, string> | null = null;
function homeEnv(key: string): string | undefined {
  if (!envCache) {
    envCache = {};
    try {
      for (const line of readFileSync(`${homedir()}/.env`, "utf8").split("\n")) {
        const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*"?([^"#]*)"?\s*$/.exec(line);
        if (m) envCache[m[1]] = m[2].trim();
      }
    } catch { /* no ~/.env */ }
  }
  return process.env[key] || envCache[key] || undefined;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<(nav|footer|header|aside)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function braveSearch(query: string, max: number, key: string): Promise<string[] | null> {
  const res = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(max, 20)}`,
    { headers: { "X-Subscription-Token": key, Accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  if (!res.ok) return null;
  const data = await res.json();
  const results = data?.web?.results;
  if (!Array.isArray(results) || !results.length) return null;
  return results.slice(0, max).map((r: any, i: number) =>
    `${i + 1}. ${r.title}\n   ${r.url}\n   ${(r.description ?? "").replace(/<[^>]+>/g, "")}`);
}

// DDG serves per-endpoint captcha challenges unpredictably, so both endpoints
// are tried; a challenge page simply yields zero matches and we move on.
async function ddgSearch(endpoint: "html" | "lite", query: string, max: number): Promise<string[] | null> {
  const url = endpoint === "html"
    ? "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query)
    : "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(query);
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) return null;
  const html = await res.text();
  const re = endpoint === "html"
    ? /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g
    : /<a[^>]+href="([^"]+)"[^>]*class="result-link"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result-snippet"[^>]*>([\s\S]*?)<\/td>)?/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < max) {
    let link = m[1];
    const uddg = /uddg=([^&]+)/.exec(link);
    if (uddg) link = decodeURIComponent(uddg[1]);
    if (link.startsWith("//")) link = "https:" + link;
    out.push(`${out.length + 1}. ${stripHtml(m[2])}\n   ${link}\n   ${stripHtml(m[3] || "")}`);
  }
  return out.length ? out : null;
}

// Last resort: OpenRouter web-plugin model. Costs a fraction of a cent per
// call but never gets captcha-walled. Returns a sourced answer, not a SERP.
async function openrouterSearch(query: string, key: string): Promise<string | null> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini:online",
      messages: [{
        role: "user",
        content: `Web search: ${query}\nReturn the top results as a numbered list — title, URL, one-line snippet each. No commentary.`,
      }],
      max_tokens: 700,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  return typeof text === "string" && text.trim() ? `[via openrouter :online]\n${text.trim()}` : null;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web search",
    description:
      "Search the web. Returns numbered titles, URLs, and snippets. " +
      "Use for current information, docs, and error messages; follow up with web_fetch to read a result.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      maxResults: Type.Optional(Type.Number({ description: "Max results (default 8)" })),
    }),
    async execute(_id, params) {
      const max = params.maxResults ?? 8;
      const errors: string[] = [];
      const brave = homeEnv("BRAVE_API_KEY");
      if (brave) {
        try {
          const r = await braveSearch(params.query, max, brave);
          if (r) return { content: [{ type: "text", text: r.join("\n\n") }], details: {} };
          errors.push("brave: no results");
        } catch (e: any) { errors.push(`brave: ${e?.message ?? e}`); }
      }
      for (const endpoint of ["html", "lite"] as const) {
        try {
          const r = await ddgSearch(endpoint, params.query, max);
          if (r) return { content: [{ type: "text", text: r.join("\n\n") }], details: {} };
          errors.push(`ddg-${endpoint}: no results/challenge`);
        } catch (e: any) { errors.push(`ddg-${endpoint}: ${e?.message ?? e}`); }
      }
      const orKey = homeEnv("OPENROUTER_API_KEY");
      if (orKey) {
        try {
          const r = await openrouterSearch(params.query, orKey);
          if (r) return { content: [{ type: "text", text: r }], details: {} };
          errors.push("openrouter: no results");
        } catch (e: any) { errors.push(`openrouter: ${e?.message ?? e}`); }
      }
      return {
        content: [{ type: "text", text: `Search failed (${errors.join("; ")}). Try a simpler query, or fetch a likely URL directly with web_fetch.` }],
        isError: true, details: {},
      };
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web fetch",
    description:
      "Fetch a URL and return clean readable markdown/text. Use for docs, articles, GitHub pages — prefer this over `curl` for reading pages.",
    parameters: Type.Object({
      url: Type.String({ description: "Full URL including https://" }),
      maxChars: Type.Optional(Type.Number({ description: "Max characters returned (default 20000)" })),
    }),
    async execute(_id, params) {
      const max = params.maxChars ?? 20000;
      const clip = (text: string) =>
        text.length > max ? text.slice(0, max) + `\n\n[truncated at ${max} of ${text.length} chars — refetch with higher maxChars if needed]` : text;

      // 1) Jina reader: clean markdown, strips nav/junk (huge token savings)
      try {
        const headers: Record<string, string> = { "User-Agent": UA, "X-Return-Format": "markdown" };
        const jinaKey = homeEnv("JINA_API_KEY");
        if (jinaKey) headers.Authorization = `Bearer ${jinaKey}`;
        const res = await fetch(`https://r.jina.ai/${params.url}`, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (res.ok) {
          const text = (await res.text()).trim();
          if (text.length > 100) return { content: [{ type: "text", text: clip(text) }], details: {} };
        }
      } catch { /* fall through to direct fetch */ }

      // 2) Direct fetch + local strip
      try {
        const res = await fetch(params.url, {
          headers: { "User-Agent": UA, Accept: "text/html,application/json,text/plain,*/*" },
          redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) {
          return { content: [{ type: "text", text: `Fetch failed: HTTP ${res.status} ${res.statusText}` }], isError: true, details: {} };
        }
        const type = res.headers.get("content-type") || "";
        const body = await res.text();
        return { content: [{ type: "text", text: clip(type.includes("html") ? stripHtml(body) : body) }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Fetch failed: ${e?.message ?? e}` }], isError: true, details: {} };
      }
    },
  });
}
