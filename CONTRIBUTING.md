# Contributing to Popost

Thanks for helping. Popost is developed by CLIPCAT AI LTD and released under the [LICENSE](LICENSE) in this
repository (a modified Apache License 2.0).

## Before you start

- Read [AGENTS.md](AGENTS.md). It covers the repository layout, the standard commands and what must never be
  committed (keys, private service addresses, upstream model names, internal pricing, real user data).
- Requirements: Node.js `^20.19.0 || >=22.12.0` and npm. Install with `npm ci` from the official npm registry;
  do not commit an `.npmrc` (put a personal mirror in your own `~/.npmrc`).
- Run `npm run check` before every commit, and `npm run test:skill` when you change `skills/`.

## Contributor terms

By submitting a contribution (a pull request, patch or any other code, documentation or asset) you confirm that:

1. You wrote it, or you otherwise have the right to submit it under the Popost license.
2. You agree to section 2 of the [LICENSE](LICENSE): CLIPCAT AI LTD may make the open-source license stricter
   or more permissive as it deems necessary, and your contribution may be used for commercial purposes,
   including CLIPCAT AI LTD's cloud services.
3. Third-party material in your contribution is clearly marked, keeps its original license, and is added to
   [NOTICE](NOTICE).

Add a `Signed-off-by: Your Name <email>` line to each commit (`git commit -s`) to record this agreement.
