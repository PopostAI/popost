# Skill distribution at launch

How the popost Skill reaches users. On 2026-11-19 the repository went public (fresh repository, one squashed commit) and
`popost@4.6.0` was published to npm from a local checkout (so without provenance). Two routes, both ending with the
Skill in the user's coding agent:

| Route | User command (same on macOS, Windows, Linux) | Needs |
|---|---|---|
| npm | `npx popost@latest install` | the package on the npm registry |
| GitHub | `npx skills add PopostAI/popost -g` | the repository public, the Skill on its default branch |

On first use the Skill finds the executable (`popost --version`) or installs it (`npm install -g popost`), and any command
that needs platform credits guides the user to `https://popost.ai/account/api-keys` and stores the key with
`popost auth set --stdin` (`~/.popost/credentials.json`). The GitHub route copies the Skill folder only (no `dist/`), so
it depends on the npm package for the executable: publish to npm first.

## Before launch (once)

1. An npm account that will own the name `popost`, with two-factor authentication on for writes (`npm profile enable-2fa auth-and-writes`).
   Confirm the name is free or ours: `npm view popost` must answer 404 (or list us as maintainer). If an organisation is
   wanted, create it first and add the maintainers; the name stays unscoped because the commands are `npx popost`.
2. The legal items in `TODO.md` section 3 are done, and the repository is public (fresh repository, squashed history).
3. The default branch (GitHub setting) contains `skills/popost/SKILL.md` with a valid `name` and `description` and no
   `metadata.internal: true`: the skills CLI clones the default branch and looks in `skills/`.
4. The version is the same in `skills/popost/package.json`, `skills/popost/src/version.ts` and the `metadata.version` of
   `skills/popost/SKILL.md` (`npm run release:check` fails when they differ). The server refuses clients older than its
   configured minimum, so tell the popost.ai side before raising `VERSION`.

## Check what will ship (any time, nothing is published)

```bash
npm ci
npm run check            # typecheck, lint, tests
npm run release:check    # builds, lists the tarball (npm pack --dry-run), fails on missing, private or developer-only files and on version drift
npm run release:smoke    # packs, installs the tarball in a scratch directory, runs --version, auth and install with an isolated HOME
```

Both scripts are plain Node and run unchanged on Windows. `release:smoke` installs the packed dependencies from the registry
(or the npm cache), so it needs network on a cold cache.

## Publish to npm

From a clean checkout of the release commit on the default branch:

```bash
npm ci
npm run release:check
npm run release:smoke
cd skills/popost
npm publish --access public --otp <code from the authenticator>
```

- `prepublishOnly` does not exist: `dist/` must have been built by `release:check` just before. `npm publish` runs from
  `skills/popost` (the package root), never from the repository root (private, `popost-repo`).
- Provenance: only from CI. A GitHub Actions job with `permissions: id-token: write` runs the same steps and ends with
  `npm publish --provenance --access public` (authenticated by an npm automation token or trusted publishing). A local
  publish cannot carry provenance; do not pass `--provenance` there.
- Versions follow semver. A pre-release is `4.2.0-rc.1` published with `--tag next`; users on `@latest` never get it.
  Only a stable version is published without `--tag`.
- Verify from a machine (or a scratch `HOME`) that has never seen the package:

  ```bash
  npx popost@latest --version                  # prints the version just published
  npx popost@latest install --agent all --dry-run
  npx popost@latest install                    # installs for the agents found
  popost auth status                           # after npm install -g popost
  ```

## Publish the GitHub route

1. Make the repository public and merge the release commit to the default branch.
2. In a scratch `HOME`: `npx skills add PopostAI/popost -g`. Pick the agents the prompt offers; check that
   `<agent skills dir>/popost/SKILL.md` exists and `npx skills list -g` shows `popost`.
3. The skills CLI copies the whole `skills/popost` folder of the repository: about 6.8 MB of tracked files including
   `src/`, `tests/` and `tools/`. It has no ignore mechanism (it skips only `.git`, `__pycache__`, `__pypackages__` and
   `metadata.json` files). That is acceptable; do not move `src/` to work around it, because `skills/popost` is also the npm package root.
4. Start the agent, ask for a post: it runs `popost --version`, installs the command with `npm install -g popost` when missing,
   and asks for an API key when credits are needed.

## Rollback

- A bad release: `npm deprecate popost@<version> "Broken: use <good version>"`, then publish a fixed patch version. Moving
  `latest` back: `npm dist-tag add popost@<good version> latest`.
- `npm unpublish popost@<version>` works only within 72 hours of publishing (and never for a version others depend on);
  after that only deprecate. A published version number is never reused.
- GitHub route: revert the commit on the default branch; users get the new state on the next `npx skills add`. Nothing is
  cached on the registry side.

## After launch

- Replace the install sections of `README.md`, `README.zh-CN.md` and `skills/popost/README.md` (they say both routes
  open at launch, with the local `npm run pack:skill` route until then): drop the "not yet available" wording.
- The popost.ai API Key page copy already uses these commands (`npx popost@latest install`, `popost auth set`); check it
  still matches the final syntax.
- Remove "not published to npm" statements in `AGENTS.md` and `skills/popost/README.md`; add the published package to
  `NOTICE` only if third-party licences changed.
