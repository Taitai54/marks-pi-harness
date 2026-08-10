import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

// Web tools v3. Search: Brave API if a key exists in ~/.env, otherwise
// DuckDuckGo (html then lite), otherwise OpenRouter :online. Ad redirects are
// dropped, repeat URLs across searches are collapsed, every result block is
// labeled with the engine that answered.
// Fetch: r.jina.ai reader -> direct fetch + strip -> headless Chrome render.
// Every path runs a content-quality gate: empty or markup-dominated output is
// an ERROR, never a silent success (the 2026-08-10 DGX session burned 6 of 10
// fetches on junk that looked like success). Bot-walled retail domains skip
// straight to Chrome. JSON-LD/meta price data is surfaced even when the page
// body is unreadable. netguard.ts blocks all of this when offline.

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 20_000;
const PW_PATH = `${process.env.HOME}/.pi/agent/node_modules/playwright-core`;
const BROWSER_IDLE_KILL_MS = 120_000;

// Domains that bot-wall plain/reader fetches; jina and direct are a waste of a
// round trip here, so web_fetch goes straight to the Chrome rung.
const BOTWALL = /(^|\.)(amazon|bestbuy|bhphotovideo|walmart|costco|memoryexpress|canadacomputers|homedepot|target|adorama)\.(com|ca|co\.uk)$/i;

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

// Collapse whitespace HARD. Shopify/Magento themes strip to thousands of
// lines holding a single space; those defeat a plain \n{3,} collapse and eat
// the whole maxChars budget before any content appears.
function sanitizeWhitespace(text: string): string {
  return text
    .replace(/[ \t]+$/gm, "")
    .replace(/^[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripHtml(html: string): string {
  return sanitizeWhitespace(html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<(nav|footer|header|aside)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&quot;|&#x22;/g, '"')
    .replace(/[ \t]+/g, " "));
}

// Quality gate: output that is empty, tiny, or still markup is a failure the
// model must SEE as a failure. Raw-HTML passthrough happens when r.jina.ai
// degrades under rate limiting and echoes page source as "markdown".
function looksLikeMarkup(text: string): boolean {
  if (/^\s*(<!doctype|<html[\s>])/i.test(text.slice(0, 300))) return true;
  const tags = (text.match(/<[a-z!/][^>]*>/gi) || []).length;
  return tags > 40 && tags / Math.max(text.length / 100, 1) > 1; // >1 tag per 100 chars
}
function junkKind(text: string): string | null {
  const t = text.trim();
  if (!t) return "empty";
  if (t.length < 200) return "near-empty";
  if (looksLikeMarkup(t)) return "raw markup / JS bootstrap";
  return null;
}

// Retail pages carry price/stock in JSON-LD and meta tags even when the body
// is a JS-rendered wall. Surface that before anything else.
function extractStructured(html: string): string | null {
  const facts: string[] = [];
  const seen = new Set<string>();
  const add = (k: string, v: unknown) => {
    if (v === undefined || v === null || v === "") return;
    const line = `${k}: ${String(v).slice(0, 200)}`;
    if (!seen.has(line)) { seen.add(line); facts.push(line); }
  };
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const type = String(node["@type"] ?? "");
    if (/product/i.test(type)) { add("product", node.name); add("brand", node.brand?.name ?? node.brand); }
    if (/offer/i.test(type) || node.price !== undefined || node.lowPrice !== undefined) {
      add("price", node.price ?? node.lowPrice);
      add("currency", node.priceCurrency);
      add("availability", String(node.availability ?? "").replace(/^https?:\/\/schema\.org\//i, ""));
    }
    for (const v of Object.values(node)) if (v && typeof v === "object") walk(v);
  };
  const ldRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = ldRe.exec(html))) {
    try { walk(JSON.parse(m[1].trim())); } catch { /* malformed ld+json */ }
  }
  const metaRe = /<meta[^>]+(?:property|name|itemprop)=["']((?:og:|product:|twitter:)?(?:price[:_]?amount|price[:_]?currency|price|availability|title))["'][^>]+content=["']([^"']+)["']/gi;
  while ((m = metaRe.exec(html))) add(m[1].replace(/^(og|product|twitter):/, ""), m[2]);
  return facts.length ? `[structured data]\n${facts.join("\n")}` : null;
}

// ---- headless Chrome rung (same launch pattern as browser.ts) --------------

let pwBrowser: any = null;
let pwIdleTimer: ReturnType<typeof setTimeout> | null = null;
async function getPwBrowser() {
  if (pwBrowser?.isConnected()) return pwBrowser;
  const mod: any = await import(PW_PATH);
  const chromium = mod.chromium ?? mod.default?.chromium;
  pwBrowser = await chromium.launch({ channel: "chrome", headless: true });
  return pwBrowser;
}
function schedulePwIdleKill() {
  if (pwIdleTimer) clearTimeout(pwIdleTimer);
  pwIdleTimer = setTimeout(() => { pwBrowser?.close().catch(() => {}); pwBrowser = null; }, BROWSER_IDLE_KILL_MS);
}

async function browserFetch(url: string): Promise<{ text: string; structured: string | null }> {
  let context: any = null;
  try {
    const b = await getPwBrowser();
    context = await b.newContext({ userAgent: UA, viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(500);
    const text = sanitizeWhitespace(await page.evaluate(() => {
      const clone = document.body?.cloneNode(true) as HTMLElement | null;
      if (!clone) return "";
      clone.querySelectorAll("nav, header, footer, aside, script, style, noscript, [role=navigation], [aria-hidden=true]").forEach((n) => n.remove());
      document.body.appendChild(clone); // innerText needs layout; remove right after
      const t = clone.innerText;
      clone.remove();
      return t;
    }));
    const structured = extractStructured(await page.content());
    return { text, structured };
  } finally {
    try { await context?.close(); } catch { /* gone */ }
    schedulePwIdleKill();
  }
}

// ---- search engines --------------------------------------------------------

async function braveSearch(query: string, max: number, key: string): Promise<string[] | null> {
  const res = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(max, 20)}`,
    { headers: { "X-Subscription-Token": key, Accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  if (!res.ok) return null;
  const data = await res.json();
  const results = data?.web?.results;
  if (!Array.isArray(results) || !results.length) return null;
  return results.slice(0, max).map((r: any) =>
    `${r.title}\n${r.url}\n${(r.description ?? "").replace(/<[^>]+>/g, "")}`);
}

function isAdLink(link: string): boolean {
  return /duckduckgo\.com\/y\.js|bing\.com\/aclick|ad_provider=|doubleclick\.net/i.test(link);
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
    if (isAdLink(link)) continue; // tracker redirects poison context and can't be fetched
    out.push(`${stripHtml(m[2])}\n${link}\n${stripHtml(m[3] || "")}`);
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
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

export default function (pi: ExtensionAPI) {
  // Session memory: URLs already shown by web_search (dedup), and URLs whose
  // fetch produced junk (stop the raise-maxChars-and-retry loop).
  const seenUrls = new Set<string>();
  const fetchMemory = new Map<string, string>(); // url -> failure kind

  // Repeat results still show title+URL (the model may need them) but drop
  // their snippet and are flagged, so re-searches stop re-paying full price.
  function formatResults(raw: string[]): string {
    let repeats = 0;
    const lines = raw.map((r, i) => {
      const [title, url, snippet] = r.split("\n");
      const repeat = url && seenUrls.has(url);
      if (url) seenUrls.add(url);
      if (repeat) { repeats++; return `${i + 1}. (seen earlier) ${title}\n   ${url}`; }
      return `${i + 1}. ${title}\n   ${url}\n   ${snippet ?? ""}`.trimEnd();
    });
    const note = repeats
      ? `\n\n[${repeats} of ${raw.length} results were already returned this session — searching the same intent again mostly re-buys what you have. Fetch pages or change the query's intent.]`
      : "";
    return lines.join("\n\n") + note;
  }

  pi.registerTool({
    name: "web_search",
    label: "Web search",
    description:
      "Search the web. Returns numbered titles, URLs, and snippets. " +
      "Queries are keyword bags, not wishes: stock status, shipping speed, and prices live on product pages, not in " +
      "search indexes, so never put phrases like 'in stock' or 'under a week' in a query. " +
      "Follow up with web_fetch to read a result — snippets and titles are NOT verified facts.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query (keywords, not sentences)" }),
      maxResults: Type.Optional(Type.Number({ description: "Max results (default 8)" })),
    }),
    async execute(_id, params) {
      const max = params.maxResults ?? 8;
      const errors: string[] = [];
      const brave = homeEnv("BRAVE_API_KEY");
      if (brave) {
        try {
          const r = await braveSearch(params.query, max, brave);
          if (r) return { content: [{ type: "text", text: `[via brave]\n${formatResults(r)}` }], details: {} };
          errors.push("brave: no results");
        } catch (e: any) { errors.push(`brave: ${e?.message ?? e}`); }
      }
      for (const endpoint of ["html", "lite"] as const) {
        try {
          const r = await ddgSearch(endpoint, params.query, max);
          if (r) return { content: [{ type: "text", text: `[via ddg-${endpoint}]\n${formatResults(r)}` }], details: {} };
          errors.push(`ddg-${endpoint}: no results/challenge`);
        } catch (e: any) { errors.push(`ddg-${endpoint}: ${e?.message ?? e}`); }
      }
      const orKey = homeEnv("OPENROUTER_API_KEY");
      if (orKey) {
        try {
          const r = await openrouterSearch(params.query, orKey);
          if (r) return { content: [{ type: "text", text: `[via openrouter :online]\n${r}` }], details: {} };
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
      "Fetch a URL and return clean readable text. Use for docs, articles, product pages — prefer this over `curl`. " +
      "JS-heavy retail sites are rendered in a headless browser automatically; [structured data] blocks at the top " +
      "carry machine-read price/stock facts. If a fetch errors, do NOT retry it with a larger maxChars — " +
      "the tool already escalated through every method it has; pick a different source.",
    parameters: Type.Object({
      url: Type.String({ description: "Full URL including https://" }),
      maxChars: Type.Optional(Type.Number({ description: "Max characters returned (default 20000)" })),
    }),
    async execute(_id, params) {
      const max = params.maxChars ?? 20000;
      const clip = (text: string) =>
        text.length > max
          ? text.slice(0, max) + `\n\n[truncated at ${max} of ${text.length} chars. If the fact you need isn't above, prefer a more specific page over refetching this one bigger.]`
          : text;
      const ok = (via: string, text: string, structured: string | null) => ({
        content: [{ type: "text" as const, text: `[via ${via}]\n${structured ? structured + "\n\n" : ""}${clip(text)}` }],
        details: {},
      });
      const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true, details: {} });

      // Failure memory: a URL that already produced junk this session gets no
      // plain retry — bigger maxChars cannot fix an unreadable page.
      const remembered = fetchMemory.get(params.url);
      if (remembered === "browser-junk") {
        return fail(`Already fetched ${params.url} this session — even the headless-browser rung returned ${remembered}. This page cannot be read here; use a different source or ask the user.`);
      }

      let host = "";
      try { host = new URL(params.url).hostname; } catch { /* fetch will error */ }
      const botwalled = BOTWALL.test(host) || remembered !== undefined;
      let structured: string | null = null;

      // 1) Jina reader: clean markdown, strips nav/junk (huge token savings).
      //    Skipped for bot-walled domains — they serve it JS bootstrap or 403.
      if (!botwalled) {
        try {
          const headers: Record<string, string> = { "User-Agent": UA, "X-Return-Format": "markdown" };
          const jinaKey = homeEnv("JINA_API_KEY");
          if (jinaKey) headers.Authorization = `Bearer ${jinaKey}`;
          const res = await fetch(`https://r.jina.ai/${params.url}`, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
          if (res.ok) {
            const text = sanitizeWhitespace(await res.text());
            if (!junkKind(text)) return ok("jina", text, null);
            if (looksLikeMarkup(text)) {
              structured = extractStructured(text);
              const stripped = stripHtml(text);
              if (!junkKind(stripped)) return ok("jina, stripped", stripped, structured);
            }
          }
        } catch { /* fall through */ }

        // 2) Direct fetch + local strip
        try {
          const res = await fetch(params.url, {
            headers: { "User-Agent": UA, Accept: "text/html,application/json,text/plain,*/*" },
            redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });
          if (res.ok) {
            const type = res.headers.get("content-type") || "";
            const body = await res.text();
            if (!type.includes("html")) return ok("direct", sanitizeWhitespace(body), null);
            structured = extractStructured(body) ?? structured;
            const stripped = stripHtml(body);
            if (!junkKind(stripped)) return ok("direct", stripped, structured);
          }
        } catch { /* fall through */ }
      }

      // 3) Headless Chrome: renders JS, walks bot walls. Last and best rung.
      try {
        const r = await browserFetch(params.url);
        structured = r.structured ?? structured;
        const kind = junkKind(r.text);
        if (!kind) return ok("browser", r.text, structured);
        if (structured) return ok("browser (page body unreadable — structured data only)", "", structured);
        fetchMemory.set(params.url, "browser-junk");
        return fail(`Fetch failed: page rendered but yielded ${kind}. Do not refetch this URL — use a different source.`);
      } catch (e: any) {
        fetchMemory.set(params.url, "browser-error");
        return fail(`Fetch failed after all rungs (jina/direct/browser): ${String(e?.message ?? e).slice(0, 200)}. Do not refetch this URL with different maxChars — pick a different source.`);
      }
    },
  });

  pi.on("session_shutdown", async () => { try { await pwBrowser?.close(); } catch { /* gone */ } });
}
