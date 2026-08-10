import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Deterministic skill router. Small local models often ignore the skill
// descriptions in the system prompt; this matches the USER'S text with plain
// regexes and appends an explicit instruction to read the matching SKILL.md.
// Harness-level routing — works identically for every model size.

const ROUTES: Array<{ skill: string; path: string; re: RegExp }> = [
  {
    // Must come before immersive-web: editorial-specific words win, everything
    // 3D/cinematic/scrubbed still falls through to immersive-web below.
    skill: "editorial-web",
    path: "~/.pi/agent/skills/editorial-web/SKILL.md",
    re: /\b(editorial\s+(web\s?site|site|page|landing)|magazine[\s-]*(style|like|site)|premium\s+(landing|brand)\s?(page|site)?|brand\s+site|saas\s+(landing|site|page)|marketing\s+(site|page)|serif\s+(site|landing)|clean\s+(landing|editorial))\b/i,
  },
  {
    skill: "immersive-web",
    path: "~/.pi/agent/skills/immersive-web/SKILL.md",
    re: /(web\s?site|landing\s?page|portfolio|web\s?page|webgl|three\.?js|immersive|cinematic|scroll[\s-]*(driven|site|page|experience|story)|award[\s-]*(site|winning)|site\s+like|scrubb?(ed|y)?\s+video\s+site)/i,
  },
  {
    skill: "video-pack",
    path: "~/.pi/agent/skills/video-pack/SKILL.md",
    re: /(make|create|build|edit|render|produce).{0,40}\b(video|animation|motion\s?graphic|explainer|promo|slideshow|captions?)\b|\bhyperframes\b/i,
  },
  {
    skill: "handoff",
    path: "~/.pi/agent/skills/handoff/SKILL.md",
    re: /\b(handoff|hand\s?off|wrap(ping)?\s+(up|it up)|save\s+(where we are|a summary|progress)|tldr|end\s+of\s+session)\b/i,
  },
  {
    skill: "prime",
    path: "~/.pi/agent/skills/prime/SKILL.md",
    re: /\b(prime|catch\s+me\s+up|where\s+(were|are)\s+we|get\s+up\s+to\s+speed|resume\s+(the\s+)?project|pick\s+up\s+where)\b/i,
  },
  {
    skill: "deep-research",
    path: "~/.pi/agent/skills/deep-research/SKILL.md",
    re: /\b(research\s+(this|the|a|an|into|on|about|\w+)|deep\s+research|find\s+(me\s+)?the\s+best|compare\s+\w+\s+(options|prices|vendors|tools)|look\s+into|investigate|what('s| is| are)\s+the\s+(latest|current|best)\b)/i,
  },
  {
    skill: "apify-pack",
    path: "~/.pi/agent/skills/apify-pack/SKILL.md",
    re: /\b(scrape|scraping|scraper|apify|lead\s?gen|find\s+leads|influencers?\b.{0,30}(find|research)|competitor\s+(analysis|research))\b/i,
  },
];

const nudged = new Set<string>();

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => { nudged.clear(); });

  pi.on("input", async (event) => {
    const text: string = (event as any).text ?? "";
    // leave commands, skill invocations, and extension-injected messages alone
    if (text.startsWith("/") || (event as any).source === "extension") return;

    for (const route of ROUTES) {
      if (nudged.has(route.skill) || !route.re.test(text)) continue;
      nudged.add(route.skill);
      return {
        action: "transform",
        text:
          text +
          `\n\n[harness note: this task matches the "${route.skill}" skill. ` +
          `Before doing anything else, use the read tool on ${route.path} and follow it.]`,
      };
    }
  });
}
