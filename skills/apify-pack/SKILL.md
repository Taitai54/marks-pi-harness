---
name: apify-pack
description: Web scraping and data extraction via Apify. Use for scraping any platform (Instagram, TikTok, YouTube, LinkedIn, Google Maps, Amazon...), lead generation, competitor/brand/trend/influencer research, or building Apify Actors. Loads the right specialist skill on demand.
---

# Apify pack router

The full Apify skill set lives in `~/.agents/skill-packs/apify/` (kept out of the always-on prompt). Pick the ONE skill that owns the task, then `read` its SKILL.md at `~/.agents/skill-packs/apify/<name>/SKILL.md` and follow it. API token: `APIFY_TOKEN` in `~/.env`.

| Skill | When |
|---|---|
| apify-ultimate-scraper | DEFAULT: universal scraper for any platform or data extraction task |
| apify-lead-generation | B2B/B2C lead lists from Maps, LinkedIn, socials |
| apify-competitor-intelligence | Competitor strategy, content, pricing analysis |
| apify-brand-reputation-monitoring | Reviews, ratings, sentiment, mentions |
| apify-trend-analysis | Emerging trends across Google Trends and socials |
| apify-influencer-discovery | Find and vet influencers |
| apify-audience-analysis | Audience demographics and engagement quality |
| apify-content-analytics | Engagement metrics, campaign ROI |
| apify-market-research | Market conditions, geographic and pricing research |
| apify-ecommerce | Amazon/Walmart/eBay pricing, reviews, sellers |
| apify-actor-development | Build/debug/deploy Apify Actors |
| apify-actorization | Convert an existing project into an Actor |
| apify-sdk-integration | Add apify-client to an existing app |
| apify-generate-output-schema | Generate Actor output schemas |
