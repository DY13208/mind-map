# Login Grid integration

Source: [Canvas UI Grid](https://canvasui.dev/docs/components/grid),
official vanilla registry `https://canvasui.dev/r/grid-vanilla.json`, retrieved
2026-09-30. `grid.js` is the dependency-free vanilla TypeScript engine converted
to JavaScript for this project's Vue 2 / Vue CLI 4 build. `rect-cache.js` is
adapted from the upstream `src/lib/rect-cache.ts`. Preserve `LICENSE.md` and
attribution when updating. The license is **MIT + Commons Clause**, not
unrestricted MIT: application use is allowed; selling or redistributing these
components as standalone components or a component bundle is not allowed.

## Intentional local changes

- The Vue wrapper `../LoginGridBackground.vue` is decoration only. Never pass
  authentication content into Canvas or enable HTML capture: QR scanning, form
  semantics and OAuth buttons must stay ordinary DOM elements above it.
- `captureHtml: false` makes the non-experimental overlay path explicit.
- The render surface is capped at 1.4 million pixels / DPR 1.25, independently
  of monitor resolution. Idle ripples are disabled; animation stops when the
  pointer trail settles.
- Pointer events are read passively on the login screen. The decoration cannot
  intercept clicks, scrolling or focus.
- Touch input, reduced motion, missing observers, failed dynamic import,
  unavailable WebGL and context loss use the static CSS grid. Hidden documents
  and destroyed login pages release observers, listeners, RAF and GPU resources.
- Shader compile/link failures clean up partially created programs. Media-query
  listeners support older `addListener` implementations.
- Rect caching only observes resize; this fixed background never scrolls.

## Verification

From the repository root:

```sh
node web/tests/login-grid-background.test.cjs
docker compose build app
```

The browser regression checks use a clearly labeled mocked WeCom SDK panel and
mock OAuth navigation. They cover QR refresh, input access, explicit WorkBuddy
navigation, light/dark mode, 375px and 1440px layouts, idle RAF shutdown,
resolution budget, reduced motion and context-loss/no-WebGL fallback. Those
checks do **not** validate production OAuth identity or session issuance.
No auth backend, callback URL or `.env` changes are required for this effect.
