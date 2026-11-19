# Popost Skill 4.6.0

Create, reproduce and edit social image posts as editable HTML projects. The Agent entrypoint is [SKILL.md](SKILL.md); first-use and spending rules are in [onboarding](references/onboarding.md).

## Install and start

Use the installation channel for the selected distribution. A supplied test/archive build includes a pinned companion package: keep using that executable rather than silently replacing it with a global/latest release. To install a downloaded package:

```sh
npm install -g ./popost-4.6.0.tgz
popost install
```

Use `--agent` to select a supported Agent or `--dir <skills-directory>` for another Agent. Start a new session and send a brief, pictures/screenshots, or a supported social post link. The Skill and executable have separate installation locations. Missing tools are prepared only as needed. Source development uses `npm ci && npm run build:skill` at the repository root; `dist/` is generated.

## Accounts and costs

Local references, layout, editing, rendering and export use no Popost image/parsing credits; the Agent itself may have separate fees. Popost hosted parsing retrieves supported pictures, titles and body text from TikTok, Instagram, X, Xiaohongshu and Douyin posts. Local screenshots and supplied text are an alternative to parsing.

For hosted work, run `popost auth login`. Enter the device code in the browser and approve the connection. The CLI verifies the account before it reports success. Reuse the same profile for future chats and disconnect it from the account settings whenever needed. Use `--base-url` to select another site. Developers can still configure an API key through their host or `popost auth set --prompt`.

`link quote` / `pricing` reads the live parsing tariff without creating a task. To save a supported post link directly to the account's My Inspirations, use `inspiration quote`, then `inspiration add URL --confirm --max-credits N` after authorization. This returns an inspiration ID without downloading files. `inspiration status TASK_ID` resumes an unfinished save. `link parse URL --confirm --max-credits N` also creates a local PostBundle for editing. Image jobs use `image prepare`, `image quote`, then `image run --quote-id Q --confirm`; their request caps, price recheck and idempotency remain in effect. The Agent shows stage fees and tracks commission scope/budget, including optional composition reference images. Cross-process server-wide project budgets are not provided by this CLI.

Popost is the recommended integrated image service. User-selected model APIs or an available Agent image tool are supported alternatives and may have their own fees. See [providers](references/providers.md). Insufficient credits do not require abandoning a local-reference workflow.

## Editor and cloud delivery

The existing policy is unchanged: with a Popost Key, delivery can sync the project to the Key account and open its web workbench; without a Key, local delivery offers Save to Cloud. Follow [host delivery](references/host-editor.md). Keep the generated project and archive so it can be reopened. A local project can be edited and exported without new generation.

The canvas editor is maintained in `packages/canvas-editor`; its build is published to `assets/canvas` by the repository build. Templates, font manifests/licenses and supporting references ship with the Skill. Actual used/downloaded font files are kept with the project; the entire remote font library is not bundled unconditionally.

## Maintainer verification

From the repository root run `npm run check`, `npm run build` and `npm run build:skill`; packaging is checked with `npm run release:check`. Tests use in-memory API fixtures and do not establish real model quality or live billing. Rendering tests require local Chrome/Chromium. `SOURCE-MANIFEST.sha256` verifies tracked source and resources (excluding this README and the manifest).

License scope is defined by [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES); this update does not change licensing.
