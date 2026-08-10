---
name: video-pack
description: Video, animation, and motion-graphics work (HyperFrames). Use for ANY request to make, edit, animate, caption, or render a video, promo, explainer, slideshow, title card, talking-head recut, music video, or Remotion port. Loads the right specialist skill from the video pack on demand.
---

# Video pack router

The full video/HyperFrames skill set lives in `~/.agents/skill-packs/video/` (kept out of the always-on prompt to save ~2,400 tokens per turn). Pick the ONE skill that owns the task below, then `read` its SKILL.md at `~/.agents/skill-packs/video/<name>/SKILL.md` and follow it. Start with `hyperframes` when unsure — it is the mandatory entry point for fresh video creation.

| Skill | When |
|---|---|
| hyperframes | ENTRY POINT: any request to make/edit/animate/render a video or motion graphic; resumes project state and routes to the owning workflow |
| hyperframes-core | Composition contract: structure, data-* timing, tracks, validation. Read before writing composition HTML |
| hyperframes-cli | CLI loop: init, add, capture, check, preview, render, publish, cloud; diagnosing build/render failures |
| hyperframes-animation | Motion rules, scene blueprints, transitions, runtime adapters (GSAP, Lottie, Three.js...) |
| hyperframes-creative | Design specs, palettes, typography, narration, beat planning, brand decisions |
| hyperframes-keyframes | Seek-safe 2D/3D keyframes, GSAP timelines, CSS keyframes, paths, masks, SVG morph |
| hyperframes-media | Voiceover/TTS, BGM, SFX, transcription, captions, background removal |
| hyperframes-registry | Installing/wiring registry blocks and components, hyperframes.json |
| media-use | Resolve any media asset (music, SFX, image, icon, logo, voice, LUT) into a frozen local file |
| general-video | Custom multi-scene compositions, brand reels, montages, freeform builds |
| motion-graphics | Short unnarrated motion-first unit, animated titles |
| faceless-explainer | Turn text/notes/a topic into a faceless explainer video with invented visuals |
| product-launch-video | Promo or tour video built FROM a website |
| pr-to-video | Turn a GitHub PR into a video |
| slideshow | Slideshow or interactive deck output |
| music-to-video | Build video from/around a music track |
| embedded-captions | Add captions/subtitles to existing talking-head footage (35-style catalog) |
| talking-head-recut | Recut/edit existing talking-head footage |
| remotion-to-hyperframes | Port a Remotion project to HyperFrames |

In dedicated video projects, `.pi/settings.json` registers the whole pack natively (`"skills": ["~/.agents/skill-packs/video"]`) — there this router is redundant and the specialist skills appear as normal `/skill:` commands.
