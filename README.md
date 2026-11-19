<h1 align="center">Popost</h1>

<h3 align="center">One post link. A whole new carousel. Every page still yours to edit.</h3>

<p align="center">Paste a social post into your AI agent. Make its hook, page rhythm, layout, and style work for your own story.<br>Then change the words, swap the pictures, and move things around on a real canvas.</p>

<p align="center">
  <a href="https://popost.ai"><strong>Try Popost</strong></a>
  &nbsp;·&nbsp;
  <a href="#start-creating"><strong>Install the Skill</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/PopostAI/popost"><strong>⭐ Star this repo</strong></a>
  &nbsp;·&nbsp;
  <a href="./README.zh-CN.md"><strong>简体中文</strong></a>
</p>

## See the whole post, then the edit

### TikTok photo commerce · From a conversation to a product reveal

The [reference TikTok post](https://www.tiktok.com/@ehotty/photo/7708462300897758495) uses two pages: a text-message hook, then a product answer. We kept that **question → reveal** rhythm and rebuilt both pages for a canvas tote. The conversation and headline are new; the product picture is a [freely usable Pexels photo](https://www.pexels.com/photo/handcrafted-canvas-tote-in-natural-light-setting-35685413/). Then we changed the second page's words and composition on the same editable project.

| Reference · 2 pages | Popost adaptation · 2 pages | Same page, edited |
| :---: | :---: | :---: |
| <img src="https://static.popost.ai/templates/tiktok-sms-product-recommendation/page-01-adeb60930ec9.webp" width="155" alt="Reference text-message hook"> <img src="https://static.popost.ai/templates/tiktok-sms-product-recommendation/page-02-202cf2ab098f.webp" width="155" alt="Reference product reveal"> | <img src="https://static.popost.ai/readme/cases/tiktok-tote/tote-chat-6242d0f08669.webp" width="155" alt="New editable text-message hook about a tote"> <img src="https://static.popost.ai/readme/cases/tiktok-tote/tote-reveal-d50713e6889e.webp" width="155" alt="New product reveal using a canvas tote photograph"> | <img src="https://static.popost.ai/readme/cases/tiktok-tote/tote-edited-61559e6f1392.webp" width="155" alt="Product page with revised headline and layout"> |

**What carried over:** the chat-style hook, the two-page pacing, and the photographic payoff. **What changed:** the topic, script, product, photo, headline, and final layout. The conversation is an illustrative script, not a customer testimonial.

[Open the reference post](https://www.tiktok.com/@ehotty/photo/7708462300897758495) · [See the Skill template](./skills/popost/templates/community/tiktok-sms-product-recommendation/) · [Download the editable Popost project](https://static.popost.ai/readme/cases/tiktok-tote/tote-demo-a30718e26149.popost.zip) · [Photo by Daniel & Hannah Snipes on Pexels](https://www.pexels.com/photo/handcrafted-canvas-tote-in-natural-light-setting-35685413/)

### Xiaohongshu sharing · A method people can actually save

This three-page [feedback-loop template](./skills/popost/templates/community/minimal-feedback-loop/) turns “Why do I forget the words I learned?” into a cover hook, a four-step routine, and a worked example. It shows how Popost can keep **one visual system and one story across the entire carousel**. Change the topic and examples; keep the page logic.

| 01 · Hook | 02 · Method | 03 · Example |
| :---: | :---: | :---: |
| <img src="https://static.popost.ai/templates/minimal-feedback-loop/page-01-fca2f99e0597.webp" width="205" alt="Xiaohongshu sharing template cover"> | <img src="https://static.popost.ai/templates/minimal-feedback-loop/page-02-4ff4c40ac215.webp" width="205" alt="Xiaohongshu sharing template method page"> | <img src="https://static.popost.ai/templates/minimal-feedback-loop/page-03-797040778775.webp" width="205" alt="Xiaohongshu sharing template example page"> |

These are **template previews**, not a claimed remake of a specific Xiaohongshu post. Give the Skill a post link when you have one, or start from this template when you do not.

### Instagram editorial carousel · Next case

**Case storyboard, awaiting a verified source post and finished output.** Pick a five-page editorial carousel with a distinctive cover, image grid, type scale, and closing beat. Remake all five pages for a different brand story, then show the cover headline, photo, and grid changing in the canvas. The published case will put the source, the full new carousel, and the edited version side by side.

| Cover | Context | Image grid | Detail | Closing beat |
| :--- | :--- | :--- | :--- | :--- |
| Keep the hook pattern | Rewrite the story | Keep the layout logic | Replace the imagery | Give a new takeaway |

## Paste. Remake. Keep editing.

1. **Paste a post link.** The Skill works with accessible TikTok, Douyin, X, Xiaohongshu, and Instagram posts. You can also begin with a screenshot, a description, or a Skill template.
2. **Give it your subject and assets.** Your agent adapts the opening, page order, copy hierarchy, images, and layout into a complete single-image post or multi-page carousel.
3. **Make it yours on the canvas.** Edit real text, replace images, rearrange layers and pages, then export PNGs. Ordinary edits do not require another paid generation run.

The same workbench is available beside your agent and on [popost.ai](https://popost.ai). With a connected account, the Skill can sync a project to your account; without one, you can start locally and choose **Save to Cloud** later. You can also save supported post links to **My Inspirations** for later use.

## Start creating

Install the current development version from GitHub:

<!-- install:start -->
~~~bash
git clone --branch develop https://github.com/PopostAI/popost.git
cd popost
npm ci
npm run build:skill
npm install -g ./skills/popost
popost install
~~~

Node.js 20.19+ · macOS, Windows, and Linux. <code>popost install</code> detects Codex and Claude Code; use <code>popost install --dir &lt;skills directory&gt;</code> for another agent. The npm package is not yet public, so keep this checkout: the global CLI points to it.
<!-- install:end -->

Then tell your agent:

~~~text
/popost Use this two-page TikTok post as the reference:
https://www.tiktok.com/@ehotty/photo/7708462300897758495
Make it about my canvas tote. Keep the question → reveal rhythm,
write a new conversation, and use my product photo from ./photos/tote.jpg.
Open the complete result in the canvas so I can edit it.
~~~

No reference link? Ask for a five-page Xiaohongshu post from a topic, or ask the agent to use a [Skill template](./skills/popost/templates/community/). See the [Skill instructions](./skills/popost/SKILL.md) for the full workflow.

## What costs credits?

| Action | Popost credits |
| --- | --- |
| Parse or save a social post link to My Inspirations | Yes; check the live quote before confirming |
| Generate pictures with Popost models | Yes; the agent shows the quote before the run |
| Write and edit copy, adjust layout, render, use the canvas, export PNGs | No |

Run <code>popost auth login</code> to connect your Agent in the browser. Enter its device code and approve. Manage the connection in your account settings. <code>popost link quote</code> and <code>popost inspiration quote</code> show current link costs. You can use your own image provider or your agent's image tool instead of Popost picture generation; see [providers](./skills/popost/references/providers.md).

## Built in the open

This repository contains the [Popost Skill and CLI](./skills/popost/) and the [canvas editor source](./packages/canvas-editor/). The hosted website, accounts, credits, and cloud projects are provided by popost.ai. Source is available under this repository's [modified Apache 2.0 license](./LICENSE); read its terms before reuse.

<details>
<summary>For contributors: build, tests, and repository layout</summary>

Run <code>npm ci</code>, then <code>npm run check</code>, <code>npm run build</code>, and <code>npm run build:skill</code>. <code>npm run check</code> covers type checking, linting, and tests for the Skill and editor. The editor lives in <code>packages/canvas-editor/</code>; the CLI and templates live in <code>skills/popost/</code>. See [CONTRIBUTING.md](./CONTRIBUTING.md), [AGENTS.md](./AGENTS.md), and the editor's [embedding guide](./packages/canvas-editor/EMBEDDING.md). Third-party notices are in [NOTICE](./NOTICE).

</details>

<p align="center"><strong>Found a post worth remaking? Give Popost the link.</strong><br><a href="https://github.com/PopostAI/popost">⭐ Star Popost on GitHub</a> · <a href="https://popost.ai">Try the web app</a></p>
