# Collapsed node count badge

Base: `origin/main` at `46abd0ad` (2026-09-30).

## Fix

- Two-digit counts no longer use the fixed icon circle. Wider labels have a padded pill sized from the glyph width plus a conservative estimate.
- Measure only when the count, formatter, side, size or relevant style changes. Unchanged hover updates keep the existing click target mounted.
- Use plain SVG text so recentering cannot leave an old child `tspan` position.
- Layout clearance uses the measured badge width when available. Detached SVGs retain a safe fallback when measurement is unavailable.
- No changes to stored map data, descendant-count semantics, collaboration protocol, history, or ENV.

## Verification

- `node simple-mind-map/test/nodeExpandCountRefresh.test.js`: passed; 1–5 digits, formatter changes, measured wide labels, left anchoring, style changes, layout clearance, detached measurement fallback and unchanged hover.
- `node simple-mind-map/test/nodeControlPlacement.test.js`: passed.
- Connector cleanup and multi-move regression tests: 20 passed.
- `npm run test:collab:history`, `collabTreeAuthority.test.js`, `collabLayoutGhost.test.js`: passed.
- Docker production build: passed; local `/api/health`: HTTP 200.
- Real-browser production-bundle checks: 22 scenarios covering logical right/left, mind-map, organization and compact layouts at 50%, 100%, 150%, 200%, dark theme, and pointer expand/collapse. Labels 1, 9, 10, 38, 72, 99, 100, 254, 1000, 99999 remain centered inside their badge with padding. Large counts use lazy descendant metadata rather than allocating 100k nodes.

Browser artifacts and diagnostic fixtures are not part of the branch. Original user maps are not modified by the isolated verification.
