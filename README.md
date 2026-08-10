# pi dev harness

A battle-tested config for the [pi coding agent](https://pi.dev) (`@earendil-works/pi-coding-agent`) running **fully local** against LM Studio models on a MacBook. No cloud LLM, no API spend. The daily workhorse is Qwen3.5 122B (MLX) on Apple Silicon, and this harness is what makes a local model reliable enough to one-shot real websites headlessly.

Everything here lives in `~/.pi/agent/` on the machine it came from. Copy what you want into your own pi config.

## What's in here

```
AGENTS.md            system rules the agent reads every session
settings.json        pi settings (local default model, compaction)
models.json          LM Studio provider + model definitions
design-history.md    append-only registry so generated site designs never repeat
extensions/          14 TypeScript extensions loaded at startup
skills/              6 skills, including two full website-building skills
```

## Extensions

| Extension | What it does |
|---|---|
| `browser.ts` | `browser_check` tool: headless system Chrome via playwright-core returns a screenshot + console errors + failed requests as image blocks. Local vision models literally SEE their work and must reply `VERDICT: PASS/FAIL` against an `expect` string. The single biggest reliability win in the whole harness. |
| `gate.ts` | `/goal` + `/gate` + `goal_complete`: declared success criteria, gate commands that must pass, and workspace-unchanged loop detection (ported from the prime-agent fork). |
| `netguard.ts` | Offline detection + default bash timeouts. A laptop is not a datacenter; this killed the 35-minute offline `brew install` hang class of failure. |
| `freshness.ts` | Guards against editing stale file state. |
| `web.ts` | Search + fetch chain built for keyless operation: Brave (if key) → DuckDuckGo html → DDG lite → OpenRouter `:online`; `web_fetch` via r.jina.ai reader for clean markdown. |
| `compactor.ts` | Caps giant tool results (~7.5k tokens) and watches context usage. LM Studio does no prompt caching, so context discipline matters double. |
| `modelfit.ts` | Per-model-size prompt notes (small models get sterner tool-calling guidance). |
| `skillrouter.ts` | Routes natural phrasing to skills ("editorial site" → editorial-web, "wrap up" → handoff, "where were we" → prime). |
| `watchdog.ts` | Session watchdog. |
| `background.ts` | `bash_background` / `background_status` / `background_kill` for dev servers and long-running processes. |
| `guard.ts` | Blocklist for destructive commands (disk erasure, force pushes, etc.). |
| `subagent.ts` | `task` tool for delegating grunt work to a cheaper/faster tier. |
| `todo.ts` | Todo widget with enforced one-item-in-progress discipline. |

## Skills

**`immersive-web/`** — build award-tier 3D/cinematic sites. Three archetypes: WebGL scroll-narrative (Three.js + GSAP + Lenis), video-driven no-WebGL (pre-rendered loops + scrims doing fake 3D), and scroll-scrubbed video (one video becomes the site's spine; ffmpeg frame extraction → sticky canvas scrub with overlaid text beats, fully scripted in `scripts/setup-scrub.sh`). Ships two verified Vite starter templates and reference docs distilled from reverse-engineering shipped award-site bundles.

**`editorial-web/`** — build premium editorial DOM sites (expressive serif display type at 9-11vw, soft warm canvases, rounded/arched media plates, alternating rows, card rails, calm reveals, zero WebGL). Includes a verified Vite + GSAP + Lenis template with `{{TOKENS}}`, a variation axis system so no two sites look alike, and a 10-recipe effects menu (magnetic buttons, cursor dot, film grain, clip-path reveals, anime.js v4 cascades...). A local 122B has one-shotted complete sites through this skill via `pi -p` headless with zero tool errors.

**`handoff/` + `prime/`** — session continuity pair. `handoff` writes a cold-start-ready summary into the project's `handoff/` folder; `prime` reads it back at the start of the next session. The skillrouter maps "wrap up" and "where were we" to them.

**`video-pack/` + `apify-pack/`** — tiny router skills demonstrating the skill-pack pattern: full specialist skill sets live outside the always-on prompt (saving thousands of tokens per turn), and these routers load the ONE relevant specialist on demand. The packs they point to are not included in this repo; the pattern is the point.

## Hard-won lessons baked in

- **Make the model look.** Vision-capable local models + a screenshot tool + a forced VERDICT beats any amount of "check the logs" prompting. `AGENTS.md` bans declaring web work done from logs alone, and bans dismissing console errors or 404s as "unrelated/pre-existing".
- **CSS-markup contract check.** A 122B will happily write CSS for elements it never added to the HTML. The editorial skill makes checking every added selector against the markup a mandatory gate.
- **Headless mode has no slash commands.** Skills instruct the agent to self-run its gate commands when running under `pi -p`.
- **Chrome won't load autoplay video in a never-focused tab** (`readyState` stays 0 forever). The templates ship a poster + explicit `load()`/`play()` kick so nobody chases that phantom again.
- **Design memory prevents clones.** Every generated site appends its typography/layout/accent picks to `design-history.md`; combinations may not repeat.
- **Laptops go offline.** The harness detects it and blocks installs/fetches instead of hanging.

## Setup

1. Install pi: `brew install earendil-works/tap/pi` (or see [pi.dev](https://pi.dev)).
2. Run LM Studio with a local server on `localhost:1234` and load a vision-capable model (adjust `models.json` to your models). Raise LM Studio's default context length; 8192 will hard-fail against a real system prompt plus skills.
3. Drop the contents of this repo into `~/.pi/agent/`.
4. `npm install` inside `~/.pi/agent/` (playwright-core for `browser_check`; uses your system Chrome, no browser download).

## License

MIT
