import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";

// Web tools v4.
// Search: multi-query (2-5 different-intent queries in ONE call) fused with
// weighted Reciprocal Rank Fusion; optional date window (Brave `freshness`,
// HN Algolia numericFilters, GitHub created:>, Reddit t=); optional extra
// keyless sources (hn, github, reddit). DDG has NO date filter — windowed
// searches that fall through to DDG are labeled [unwindowed].
// Fetch: content-type routing first (YouTube transcript via yt-dlp, GitHub via
// gh CLI, RSS/Atom parsed directly), then jina -> direct -> headless Chrome
// with quality gates, structured-data extraction, bot-challenge fingerprints,
// and per-URL failure memory. Optional `goal` runs a local-LLM extraction pass
// so only goal-relevant verbatim evidence enters agent context, not the page.
// netguard.ts blocks all of this when offline.

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 20_000;
const PW_PATH = `${process.env.HOME}/.pi/agent/node_modules/playwright-core`;
const BROWSER_IDLE_KILL_MS = 120_000;
const LMSTUDIO = "http://127.0.0.1:1234";
const EXTRACT_MIN_CHARS = 2_800;
const YT_TMP = "/tmp/pi-yt";

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

// ---- text hygiene ----------------------------------------------------------

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

// Bot-challenge fingerprints (first 4KB, case-folded). The pairing rules avoid
// false-positives on articles that merely DISCUSS captchas.
function challengeKind(text: string): string | null {
  const head = text.slice(0, 4096).toLowerCase();
  const cfTitle = head.includes("attention required! | cloudflare");
  const cfMarker = head.includes("ray id") || head.includes("/cdn-cgi/challenge-platform/");
  if (cfTitle && cfMarker) return "cloudflare challenge";
  const challengeStruct = head.includes("just a moment...") || head.includes("## performing security verification") || cfTitle;
  if (head.includes("warning:") && head.includes("requiring captcha") && challengeStruct) return "captcha challenge";
  return null;
}

function junkKind(text: string): string | null {
  const t = text.trim();
  if (!t) return "empty";
  if (t.length < 200) return "near-empty";
  const c = challengeKind(t);
  if (c) return c;
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

type Hit = { title: string; url: string; snippet: string; src: string; unwindowed?: boolean };

function normalizeUrl(u: string): string {
  try {
    const p = new URL(u);
    p.hash = "";
    for (const k of [...p.searchParams.keys()]) if (/^utm_/i.test(k)) p.searchParams.delete(k);
    let host = p.hostname.toLowerCase().replace(/^(www|m|old)\./, "");
    let path = p.pathname.replace(/\/$/, "");
    return `${host}${path}${p.search}`;
  } catch { return u; }
}

function isAdLink(link: string): boolean {
  return /duckduckgo\.com\/y\.js|bing\.com\/aclick|ad_provider=|doubleclick\.net/i.test(link);
}

function dateFrom(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

async function braveSearch(query: string, max: number, key: string, days?: number): Promise<Hit[] | null> {
  let url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(max, 20)}`;
  if (days) url += `&freshness=${dateFrom(days)}to${new Date().toISOString().slice(0, 10)}`;
  const res = await fetch(url, { headers: { "X-Subscription-Token": key, Accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) return null;
  const data = await res.json();
  const results = data?.web?.results;
  if (!Array.isArray(results) || !results.length) return null;
  return results.slice(0, max).map((r: any) => ({
    title: r.title ?? "", url: r.url ?? "", snippet: (r.description ?? "").replace(/<[^>]+>/g, ""), src: "brave",
  }));
}

// DDG serves per-endpoint captcha challenges unpredictably, so both endpoints
// are tried; a challenge page simply yields zero matches and we move on.
// DDG has NO date filter — hits from a windowed search are marked unwindowed.
async function ddgSearch(endpoint: "html" | "lite", query: string, max: number, windowed: boolean): Promise<Hit[] | null> {
  const url = endpoint === "html"
    ? "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query)
    : "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(query);
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) return null;
  const html = await res.text();
  const re = endpoint === "html"
    ? /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g
    : /<a[^>]+href="([^"]+)"[^>]*class="result-link"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result-snippet"[^>]*>([\s\S]*?)<\/td>)?/g;
  const out: Hit[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < max) {
    let link = m[1];
    const uddg = /uddg=([^&]+)/.exec(link);
    if (uddg) link = decodeURIComponent(uddg[1]);
    if (link.startsWith("//")) link = "https:" + link;
    if (isAdLink(link)) continue; // tracker redirects poison context and can't be fetched
    out.push({ title: stripHtml(m[2]), url: link, snippet: stripHtml(m[3] || ""), src: `ddg-${endpoint}`, unwindowed: windowed });
  }
  return out.length ? out : null;
}

// Keyless recency sources. HN via Algolia (real date filtering; points>N in
// numericFilters 400s, so low-engagement filtering is client-side). GitHub
// anon tier (~10 req/min — cap results). Reddit via search RSS (t= bucket).
async function hnSearch(query: string, max: number, days?: number): Promise<Hit[] | null> {
  const q = query.replace(/[,-]/g, " ");
  const tokens = q.split(/\s+/).filter(Boolean);
  let url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=${max * 2}`;
  if (tokens.length > 1) url += `&optionalWords=${encodeURIComponent(tokens.slice(1).join(" "))}`;
  if (days) {
    const from = Math.floor(Date.now() / 1000) - days * 86_400;
    url += `&numericFilters=${encodeURIComponent(`created_at_i>${from},created_at_i<${Math.floor(Date.now() / 1000)}`)}`;
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) return null;
  const data = await res.json();
  const hits = (data?.hits ?? []).filter((h: any) => (h.points ?? 0) >= 2).slice(0, max);
  if (!hits.length) return null;
  return hits.map((h: any) => ({
    title: h.title ?? h.story_title ?? "",
    url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    snippet: `${h.points} points, ${h.num_comments ?? 0} comments (${(h.created_at ?? "").slice(0, 10)}) — thread: https://news.ycombinator.com/item?id=${h.objectID}`,
    src: "hn",
  }));
}

async function githubSearch(query: string, max: number, days?: number): Promise<Hit[] | null> {
  // GitHub honors only the FIRST qualifier of a kind — strip user-supplied created:
  let q = query.replace(/\bcreated:[^\s]+/gi, "").trim();
  if (days) q += ` created:>${dateFrom(days)}`;
  const res = await fetch(
    `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&sort=reactions&order=desc&per_page=${Math.min(max, 10)}`,
    { headers: { Accept: "application/vnd.github+json", "User-Agent": UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  if (!res.ok) return null;
  const data = await res.json();
  const items = data?.items;
  if (!Array.isArray(items) || !items.length) return null;
  return items.map((it: any) => ({
    title: it.title ?? "",
    url: it.html_url ?? "",
    snippet: `${it.state}, ${it.comments} comments (${(it.created_at ?? "").slice(0, 10)}) ${(it.body ?? "").slice(0, 150).replace(/\s+/g, " ")}`,
    src: "github",
  }));
}

function parseFeed(xml: string, max: number, src: string): Hit[] {
  const out: Hit[] = [];
  const entryRe = /<(entry|item)[\s>][\s\S]*?<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) && out.length < max) {
    const e = m[0];
    const title = stripHtml((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(e)?.[1] ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"));
    const link = /<link[^>]*href=["']([^"']+)["']/i.exec(e)?.[1] ?? stripHtml(/<link[^>]*>([\s\S]*?)<\/link>/i.exec(e)?.[1] ?? "");
    const date = /<(pubDate|published|updated)[^>]*>([\s\S]*?)<\/\1>/i.exec(e)?.[2]?.trim() ?? "";
    const desc = stripHtml((/<(description|summary|content)[^>]*>([\s\S]*?)<\/\1>/i.exec(e)?.[2] ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).slice(0, 200);
    if (title || link) out.push({ title, url: link, snippet: `${date ? date + " — " : ""}${desc}`, src });
  }
  return out;
}

async function redditSearch(query: string, max: number, days?: number): Promise<Hit[] | null> {
  // Anonymous reddit .json endpoints 403 since late 2025 — the RSS lane is the
  // only keyless path. RSS carries no scores.
  const t = !days ? "all" : days <= 1 ? "day" : days <= 7 ? "week" : days <= 31 ? "month" : "year";
  const res = await fetch(
    `https://www.reddit.com/search.rss?q=${encodeURIComponent(query)}&sort=relevance&t=${t}`,
    { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  if (!res.ok) return null;
  const hits = parseFeed(await res.text(), max, "reddit");
  return hits.length ? hits : null;
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

// ---- content-type routed fetchers ------------------------------------------

async function execCmd(pi: ExtensionAPI, cmd: string, timeout = 90_000): Promise<{ code: number; out: string }> {
  try {
    const r: any = await (pi as any).exec("/bin/zsh", ["-lc", cmd], { timeout });
    const code = r?.exitCode ?? r?.code ?? 0;
    const out = [r?.stdout ?? "", r?.stderr ?? ""].filter(Boolean).join("\n");
    return { code, out };
  } catch (e: any) {
    return { code: 1, out: String(e?.message ?? e) };
  }
}

// Auto-generated subtitles duplicate overlapping lines — collapse them.
function vttToText(vtt: string): string {
  const lines: string[] = [];
  for (let raw of vtt.split("\n")) {
    const line = raw.replace(/<[^>]+>/g, "").trim();
    if (!line || /^WEBVTT|^Kind:|^Language:|^NOTE|-->|^\d+$/.test(line)) continue;
    if (lines.length && (lines[lines.length - 1] === line || lines[lines.length - 1].endsWith(line))) continue;
    if (lines.length && line.startsWith(lines[lines.length - 1])) { lines[lines.length - 1] = line; continue; }
    lines.push(line);
  }
  return lines.join("\n");
}

async function youtubeFetch(pi: ExtensionAPI, url: string): Promise<string | null> {
  try { mkdirSync(YT_TMP, { recursive: true }); } catch { /* exists */ }
  const meta = await execCmd(pi, `yt-dlp --dump-json --no-warnings ${JSON.stringify(url)} 2>/dev/null | head -c 200000`);
  let head = "";
  if (meta.code === 0 && meta.out.trim()) {
    try {
      const j = JSON.parse(meta.out);
      head = `${j.title ?? ""}\nChannel: ${j.uploader ?? "?"} | Uploaded: ${j.upload_date ?? "?"} | Duration: ${j.duration_string ?? j.duration ?? "?"} | Views: ${j.view_count ?? "?"}\n${(j.description ?? "").slice(0, 500)}\n`;
    } catch { /* not json */ }
  }
  const sub = await execCmd(pi,
    `rm -rf ${YT_TMP}/dl && mkdir -p ${YT_TMP}/dl && cd ${YT_TMP}/dl && yt-dlp --skip-download --write-sub --write-auto-sub --sub-lang "en.*,en" --sub-format vtt -o "dl" --no-warnings ${JSON.stringify(url)} >/dev/null 2>&1; find . -name "*.vtt" -maxdepth 1 | head -1`);
  const vttName = sub.out.trim().split("\n")[0];
  if (vttName && /\.vtt$/.test(vttName)) {
    try {
      const transcript = vttToText(readFileSync(`${YT_TMP}/dl/${vttName.replace(/^\.\//, "")}`, "utf8"));
      try { rmSync(`${YT_TMP}/dl`, { recursive: true, force: true }); } catch { /* tmp */ }
      if (transcript.length > 100) return `${head}\n[transcript]\n${transcript}`;
    } catch { /* read failed */ }
  }
  return head ? `${head}\n[no English captions available on this video]` : null;
}

async function githubFetch(pi: ExtensionAPI, url: string): Promise<string | null> {
  const m = /github\.com\/([^/]+)\/([^/#?]+)(?:\/(issues|pull|discussions)\/(\d+))?/.exec(url);
  if (!m) return null;
  const repo = `${m[1]}/${m[2]}`;
  let cmd: string;
  if (m[3] === "issues" && m[4]) cmd = `gh issue view ${m[4]} --repo ${repo}`;
  else if (m[3] === "pull" && m[4]) cmd = `gh pr view ${m[4]} --repo ${repo}`;
  else if (!m[3]) cmd = `gh repo view ${repo}`;
  else return null; // discussions etc — let the generic ladder handle it
  const r = await execCmd(pi, `${cmd} 2>&1 | head -c 50000`);
  if (r.code !== 0 || r.out.trim().length <= 100) return null;
  let out = r.out;
  if (m[4]) {
    // gh's --comments flag emits nothing on gh 2.96 — pull comments via the API
    const c = await execCmd(pi,
      `gh api "repos/${repo}/issues/${m[4]}/comments?per_page=10" --jq '.[] | "--- " + .user.login + " (" + (.created_at | .[0:10]) + "): " + (.body | .[0:1200])' 2>/dev/null | head -c 20000`);
    if (c.code === 0 && c.out.trim()) out += `\n\n[comments]\n${c.out}`;
  }
  return out;
}

// ---- goal-conditioned extraction (ReSum/Search-o1 pattern) -----------------

const STOPWORDS = new Set("a an the of and or for to in on at by with from is are was were be been this that what which how current status".split(" "));

// Deterministic goal filter: sliding word windows scored by overlap with the
// goal's tokens. Instant and model-free — the default, because a reasoning
// model spends minutes per page on an LLM extraction pass.
function goalFilter(text: string, goal: string): string | null {
  const goalTokens = goal.toLowerCase().split(/[^\p{L}\p{N}$]+/u).filter((t) => t.length > 2 && !STOPWORDS.has(t));
  if (!goalTokens.length) return null;
  const words = text.split(/\s+/);
  if (words.length < 250) return null; // already small — no point filtering
  const WIN = 120, STEP = 60;
  const scored: { i: number; score: number }[] = [];
  for (let i = 0; i < words.length; i += STEP) {
    const win = words.slice(i, i + WIN).join(" ").toLowerCase();
    let score = 0;
    for (const t of goalTokens) if (win.includes(t)) score++;
    // numbers/prices near goal tokens are usually the payload
    if (score && /[$€£]\s?\d|\d{2,}/.test(win)) score += 1;
    if (score) scored.push({ i, score });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  const picked = scored.slice(0, 6).sort((a, b) => a.i - b.i);
  // merge overlapping/adjacent windows
  const spans: [number, number][] = [];
  for (const { i } of picked) {
    const last = spans[spans.length - 1];
    if (last && i <= last[1]) last[1] = Math.max(last[1], i + WIN);
    else spans.push([i, i + WIN]);
  }
  const parts = spans.map(([a, b]) => words.slice(a, b).join(" "));
  return `[goal-relevant excerpts — ${spans.length} of ${Math.ceil(words.length / STEP)} sections matched; refetch without goal for the full page]\n\n${parts.join("\n\n[...]\n\n")}`;
}

// Optional LLM extraction: only when PI_EXTRACT_MODEL names a model in ~/.env —
// point it at a SMALL fast model; a 27B reasoning model takes minutes per page.
async function extractForGoal(text: string, goal: string, url: string): Promise<string | null> {
  try {
    const model = homeEnv("PI_EXTRACT_MODEL");
    if (!model) return null;
    const res = await fetch(`${LMSTUDIO}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        // reasoning models (qwen3.x) spend heavily on reasoning_content before
        // emitting content — a small cap returns an empty extraction
        max_tokens: 4500,
        messages: [{
          role: "user",
          content:
            `You are extracting information from a fetched web page for a specific goal.\n` +
            `GOAL: ${goal}\nURL: ${url}\n\n` +
            `Respond in exactly this format:\n` +
            `RATIONAL: which parts of the page relate to the goal, one or two sentences.\n` +
            `EVIDENCE: the relevant passages QUOTED VERBATIM from the page — be generous, never paraphrase, keep numbers/prices/dates exact. If nothing relates, write "none".\n` +
            `SUMMARY: one paragraph — what this page contributes to the goal, and what it does NOT answer.\n\n` +
            `PAGE CONTENT:\n${text.slice(0, 24_000)}`,
        }],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) return null;
    const out = (await res.json())?.choices?.[0]?.message?.content;
    return typeof out === "string" && out.trim().length > 40 ? out.trim() : null;
  } catch { return null; }
}

// ---- extension -------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // Session memory: URLs already shown by web_search (dedup), and URLs whose
  // fetch produced junk (stop the raise-maxChars-and-retry loop).
  const seenUrls = new Set<string>();
  const fetchMemory = new Map<string, string>(); // url -> failure kind

  // Weighted Reciprocal Rank Fusion across every (query, source) stream.
  // Needs no score calibration between sources — the whole point.
  function fuse(streams: Hit[][], max: number): Hit[] {
    const score = new Map<string, { hit: Hit; s: number }>();
    for (const stream of streams) {
      stream.forEach((hit, rank) => {
        const key = normalizeUrl(hit.url);
        const entry = score.get(key);
        if (entry) {
          entry.s += 1 / (60 + rank);
          if (hit.snippet.length > entry.hit.snippet.length) entry.hit.snippet = hit.snippet;
          if (!hit.unwindowed) entry.hit.unwindowed = false; // any windowed source confirms the date
        } else {
          score.set(key, { hit: { ...hit }, s: 1 / (60 + rank) });
        }
      });
    }
    // cap 3 per domain so one loud site can't monopolize the pool
    const perDomain = new Map<string, number>();
    const out: Hit[] = [];
    for (const { hit } of [...score.values()].sort((a, b) => b.s - a.s)) {
      let dom = "";
      try { dom = new URL(hit.url).hostname.replace(/^www\./, ""); } catch { /* keep */ }
      const n = perDomain.get(dom) ?? 0;
      if (n >= 3) continue;
      perDomain.set(dom, n + 1);
      out.push(hit);
      if (out.length >= max) break;
    }
    return out;
  }

  // Repeat results still show title+URL (the model may need them) but drop
  // their snippet and are flagged, so re-searches stop re-paying full price.
  function formatResults(hits: Hit[]): string {
    let repeats = 0;
    const lines = hits.map((h, i) => {
      const repeat = h.url && seenUrls.has(h.url);
      if (h.url) seenUrls.add(h.url);
      const tag = `[${h.src}${h.unwindowed ? ", unwindowed — verify the date on the page" : ""}]`;
      if (repeat) { repeats++; return `${i + 1}. (seen earlier) ${h.title}\n   ${h.url}`; }
      return `${i + 1}. ${tag} ${h.title}\n   ${h.url}\n   ${h.snippet}`.trimEnd();
    });
    const note = repeats
      ? `\n\n[${repeats} of ${hits.length} results were already returned this session — searching the same intent again mostly re-buys what you have. Fetch pages or change the query's intent.]`
      : "";
    return lines.join("\n\n") + note;
  }

  pi.registerTool({
    name: "web_search",
    label: "Web search",
    description:
      "Search the web. Accepts ONE query or an ARRAY of 2-5 queries with DIFFERENT intents (listings vs reviews vs specs) " +
      "fused into one ranked list — prefer one batched call over sequential searches. " +
      "Queries are keyword bags, not wishes: stock status, shipping speed, and prices live on product pages, not in " +
      "search indexes, so never put phrases like 'in stock', 'under a week', 'recent', or year numbers in a query — " +
      "use the `days` parameter for recency instead. Optional extra sources: hn (Hacker News), github (issues/PRs), " +
      "reddit (no scores, RSS). Snippets and titles are NOT verified facts — follow up with web_fetch.",
    parameters: Type.Object({
      query: Type.Union([Type.String(), Type.Array(Type.String())], { description: "Search query, or array of 2-5 different-intent queries" }),
      maxResults: Type.Optional(Type.Number({ description: "Max results (default 8)" })),
      days: Type.Optional(Type.Number({ description: "Only results from the last N days (real filter on brave/hn/github/reddit; ddg results get an 'unwindowed' label)" })),
      sources: Type.Optional(Type.Array(Type.String(), { description: 'Extra sources besides web: "hn", "github", "reddit"' })),
    }),
    async execute(_id, params) {
      const max = params.maxResults ?? 8;
      const queries = (Array.isArray(params.query) ? params.query : [params.query]).filter((q: string) => q?.trim()).slice(0, 5);
      if (!queries.length) return { content: [{ type: "text", text: "No query given." }], isError: true, details: {} };
      const days = params.days;
      const extra = new Set((params.sources ?? []).map((s: string) => s.toLowerCase()));
      const errors: string[] = [];
      const streams: Hit[][] = [];
      const engines: Set<string> = new Set();

      const webEngine = async (q: string): Promise<Hit[] | null> => {
        const brave = homeEnv("BRAVE_API_KEY");
        if (brave) {
          try {
            const r = await braveSearch(q, max, brave, days);
            if (r) { engines.add("brave"); return r; }
            errors.push("brave: no results");
          } catch (e: any) { errors.push(`brave: ${e?.message ?? e}`); }
        }
        for (const endpoint of ["html", "lite"] as const) {
          try {
            const r = await ddgSearch(endpoint, q, max, days !== undefined);
            if (r) { engines.add(`ddg-${endpoint}`); return r; }
            errors.push(`ddg-${endpoint}: no results/challenge`);
          } catch (e: any) { errors.push(`ddg-${endpoint}: ${e?.message ?? e}`); }
        }
        return null;
      };

      const jobs: Promise<void>[] = [];
      for (const q of queries) {
        jobs.push(webEngine(q).then((r) => { if (r) streams.push(r); }));
        if (extra.has("hn")) jobs.push(hnSearch(q, max, days).then((r) => { if (r) { engines.add("hn"); streams.push(r); } }).catch((e) => { errors.push(`hn: ${e?.message ?? e}`); }));
        if (extra.has("github")) jobs.push(githubSearch(q, max, days).then((r) => { if (r) { engines.add("github"); streams.push(r); } }).catch((e) => { errors.push(`github: ${e?.message ?? e}`); }));
        if (extra.has("reddit")) jobs.push(redditSearch(q, max, days).then((r) => { if (r) { engines.add("reddit"); streams.push(r); } }).catch((e) => { errors.push(`reddit: ${e?.message ?? e}`); }));
      }
      await Promise.all(jobs);

      if (streams.length) {
        const fused = fuse(streams, max);
        const header = `[via ${[...engines].join("+")}${queries.length > 1 ? `, ${queries.length} queries fused` : ""}${days ? `, window ${days}d` : ""}]`;
        const failNote = errors.length ? `\n\n[some sources failed: ${errors.join("; ")} — a failed source is NOT evidence of no discussion there]` : "";
        return { content: [{ type: "text", text: `${header}\n${formatResults(fused)}${failNote}` }], details: {} };
      }

      const orKey = homeEnv("OPENROUTER_API_KEY");
      if (orKey) {
        try {
          const r = await openrouterSearch(queries.join(" | "), orKey);
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
      "Fetch a URL and return clean readable text. Routes by content type first: YouTube URLs return metadata + transcript, " +
      "GitHub repo/issue/PR URLs go through gh (works on private repos), RSS/Atom feeds are parsed directly. Everything else: " +
      "reader -> direct -> headless browser (JS-heavy retail sites render automatically; [structured data] blocks carry " +
      "machine-read price/stock facts). Pass `goal` to get only goal-relevant VERBATIM evidence instead of the whole page — " +
      "strongly recommended during research. If a fetch errors, do NOT retry it with a larger maxChars — the tool already " +
      "escalated through every method it has; pick a different source.",
    parameters: Type.Object({
      url: Type.String({ description: "Full URL including https://" }),
      maxChars: Type.Optional(Type.Number({ description: "Max characters returned (default 20000)" })),
      goal: Type.Optional(Type.String({ description: "What you are trying to learn from this page — output becomes goal-relevant verbatim evidence + summary instead of the full page" })),
    }),
    async execute(_id, params) {
      const max = params.maxChars ?? 20000;
      const clip = (text: string) =>
        text.length > max
          ? text.slice(0, max) + `\n\n[truncated at ${max} of ${text.length} chars. If the fact you need isn't above, prefer a more specific page over refetching this one bigger.]`
          : text;
      const ok = async (via: string, text: string, structured: string | null) => {
        let body = text;
        let label = via;
        if (params.goal && text.length > EXTRACT_MIN_CHARS) {
          const extracted = await extractForGoal(text, params.goal, params.url);
          if (extracted) { body = extracted; label = `${via}, LLM-extracted for goal`; }
          else {
            const filtered = goalFilter(text, params.goal);
            if (filtered) { body = filtered; label = `${via}, goal-filtered`; }
          }
        }
        return {
          content: [{ type: "text" as const, text: `[via ${label}]\n${structured ? structured + "\n\n" : ""}${clip(body)}` }],
          details: {},
        };
      };
      const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true, details: {} });

      // Failure memory: a URL that already produced junk this session gets no
      // plain retry — bigger maxChars cannot fix an unreadable page.
      const remembered = fetchMemory.get(params.url);
      if (remembered === "browser-junk") {
        return fail(`Already fetched ${params.url} this session — even the headless-browser rung returned junk. This page cannot be read here; use a different source or ask the user.`);
      }

      // Content-type routing: some content is NOT reachable by any HTML fetcher.
      if (/(?:youtube\.com\/(?:watch|shorts|live)|youtu\.be\/)/i.test(params.url)) {
        const yt = await youtubeFetch(pi, params.url);
        if (yt) return ok("yt-dlp", yt, null);
        // fall through to the generic ladder if yt-dlp produced nothing
      }
      if (/github\.com\//i.test(params.url)) {
        const gh = await githubFetch(pi, params.url);
        if (gh) return ok("gh", gh, null);
      }
      // Feed-shaped URLs: fetch + parse directly — jina would just prettify the XML
      if (/\.(rss|xml|atom)([?#]|$)|\/(feed|rss|atom)s?(\/|[?#]|$)|hnrss\.org/i.test(params.url)) {
        try {
          const res = await fetch(params.url, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
          if (res.ok) {
            const items = parseFeed(await res.text(), 25, "feed");
            if (items.length) return ok("rss", items.map((it, i) => `${i + 1}. ${it.title}\n   ${it.url}\n   ${it.snippet}`).join("\n\n"), null);
          }
        } catch { /* fall to generic ladder */ }
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
            headers: { "User-Agent": UA, Accept: "text/html,application/xml,application/json,text/plain,*/*" },
            redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });
          if (res.ok) {
            const type = res.headers.get("content-type") || "";
            const body = await res.text();
            // RSS/Atom feeds: parse, don't strip
            if (/xml|rss|atom/i.test(type) || /^\s*<\?xml|<rss[\s>]|<feed[\s>]/i.test(body.slice(0, 300))) {
              const items = parseFeed(body, 25, "feed");
              if (items.length) {
                return ok("rss", items.map((it, i) => `${i + 1}. ${it.title}\n   ${it.url}\n   ${it.snippet}`).join("\n\n"), null);
              }
            }
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
