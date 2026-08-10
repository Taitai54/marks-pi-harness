import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Visual self-verification: the model looks at its own work. All local models
// here are vision models, so browser_check returns a SCREENSHOT the model can
// see, plus console errors and failed requests. Drives the installed system
// Chrome headlessly via playwright-core (no browser download).

const PW_PATH = `${process.env.HOME}/.pi/agent/node_modules/playwright-core`;
const IDLE_KILL_MS = 120_000;

let browser: any = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

async function getBrowser() {
  if (browser?.isConnected()) return browser;
  const { chromium } = await import(PW_PATH);
  browser = await chromium.launch({ channel: "chrome", headless: true });
  return browser;
}

function scheduleIdleKill() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { browser?.close().catch(() => {}); browser = null; }, IDLE_KILL_MS);
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "browser_check",
    label: "Browser check",
    description:
      "Open a URL in a headless browser and SEE it: returns a screenshot (you are a vision model — inspect it " +
      "critically) plus console errors and failed network requests. Use after building or changing any web UI " +
      "to verify it actually looks right. Pass `expect` with what SHOULD be visible and give an explicit " +
      "VERDICT: PASS or FAIL. Set mobile:true to also capture a 390px phone viewport. " +
      "Options: scrollTo (0..1 page progress), clickSelector, fullPage. " +
      "Loop: build -> check -> verdict -> fix -> re-check until PASS.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to open (e.g. http://localhost:5173)" }),
      expect: Type.Optional(Type.String({ description: "What should be visible, e.g. 'hero headline over a 3D blob, no overlap'. You must answer VERDICT: PASS/FAIL against it" })),
      mobile: Type.Optional(Type.Boolean({ description: "Also capture a 390x844 mobile screenshot (default false)" })),
      width: Type.Optional(Type.Number({ description: "Viewport width (default 1400)" })),
      height: Type.Optional(Type.Number({ description: "Viewport height (default 900)" })),
      fullPage: Type.Optional(Type.Boolean({ description: "Capture full page height (default false)" })),
      scrollTo: Type.Optional(Type.Number({ description: "Scroll to page progress 0..1 before capture" })),
      clickSelector: Type.Optional(Type.String({ description: "CSS selector to click before capture" })),
      waitMs: Type.Optional(Type.Number({ description: "Extra wait after load, ms (default 1200; raise for animations)" })),
    }),
    async execute(_id, params, signal) {
      let context: any = null;
      try {
        const b = await getBrowser();
        context = await b.newContext({
          viewport: { width: params.width ?? 1400, height: params.height ?? 900 },
          deviceScaleFactor: 1,
        });
        const page = await context.newPage();

        const consoleMsgs: string[] = [];
        const failures: string[] = [];
        page.on("console", (m: any) => {
          if (m.type() === "error" || m.type() === "warning")
            consoleMsgs.push(`[${m.type()}] ${m.text().slice(0, 200)}`);
        });
        page.on("pageerror", (e: any) => consoleMsgs.push(`[pageerror] ${String(e).slice(0, 200)}`));
        page.on("requestfailed", (r: any) =>
          failures.push(`${r.method()} ${r.url().slice(0, 120)} -> ${r.failure()?.errorText}`));
        page.on("response", (r: any) => {
          if (r.status() >= 400) failures.push(`${r.status()} ${r.url().slice(0, 120)}`);
        });

        await page.goto(params.url, { waitUntil: "networkidle", timeout: 30_000 });
        if (params.clickSelector) {
          await page.click(params.clickSelector, { timeout: 5_000 });
        }
        if (params.scrollTo !== undefined) {
          const p = Math.max(0, Math.min(1, params.scrollTo));
          await page.evaluate((frac: number) => {
            window.scrollTo(0, (document.documentElement.scrollHeight - window.innerHeight) * frac);
          }, p);
        }
        await page.waitForTimeout(params.waitMs ?? 1200);

        // JPEG q70 keeps each shot ~50-150KB — kind to local-model context
        const shot = () => page.screenshot({ fullPage: params.fullPage ?? false, type: "jpeg", quality: 70 });
        const desktop: Buffer = await shot();
        let mobileShot: Buffer | null = null;
        if (params.mobile) {
          await page.setViewportSize({ width: 390, height: 844 });
          await page.waitForTimeout(500);
          mobileShot = await shot();
        }

        const notes: string[] = [];
        notes.push(`Screenshot of ${params.url}` +
          (params.scrollTo !== undefined ? ` at scroll ${Math.round((params.scrollTo) * 100)}%` : "") +
          ` (${params.width ?? 1400}x${params.height ?? 900}${mobileShot ? ", plus 390x844 mobile" : ""}).`);
        notes.push(consoleMsgs.length
          ? `CONSOLE (${consoleMsgs.length}): ${consoleMsgs.slice(0, 8).join(" | ")}`
          : "Console: clean.");
        notes.push(failures.length
          ? `FAILED REQUESTS (${failures.length}): ${failures.slice(0, 8).join(" | ")}`
          : "Network: all requests OK.");
        notes.push(params.expect
          ? `EXPECTATION: ${params.expect}\nCompare the screenshot(s) against this expectation and reply with an explicit "VERDICT: PASS" or "VERDICT: FAIL — <what is wrong>". Judge honestly; a FAIL you catch now is cheaper than one Mark catches later.`
          : "Judge the screenshot honestly: layout, typography, spacing, contrast, whether the intended elements are actually visible. If it looks broken or bland, say so and fix it.");

        const content: any[] = [
          { type: "text", text: notes.join("\n") },
          { type: "image", data: desktop.toString("base64"), mimeType: "image/jpeg" },
        ];
        if (mobileShot) {
          content.push({ type: "text", text: "Mobile (390x844):" });
          content.push({ type: "image", data: mobileShot.toString("base64"), mimeType: "image/jpeg" });
        }
        return { content, details: {} };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `browser_check failed: ${String(e?.message ?? e).slice(0, 400)}` }],
          isError: true, details: {},
        };
      } finally {
        try { await context?.close(); } catch { /* already gone */ }
        scheduleIdleKill();
      }
    },
  });

  pi.on("session_shutdown", async () => { try { await browser?.close(); } catch { /* gone */ } });
}
