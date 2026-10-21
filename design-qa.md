# Mobile editor and attachment preview verification

Date: 2026-10-21. Base: `origin/main` at `009a1535`.

## Findings and fixes

| Severity | Finding | Fix and post-fix evidence |
| --- | --- | --- |
| P2, resolved | Six header buttons squeezed the reference title at 393px. | Keep 44px touch targets; put Refresh in the existing file menu at widths up to 420px. `final-phone.png` shows the full `UN项目工程` title and saved state; the file-menu capture retains Refresh. Long titles still truncate with their full title available. |
| P2, resolved | Icon-font generated content polluted bottom-button accessible names. | Give Theme, Style, Map and More explicit labels, hide their decorative icons from accessibility. Real role-based taps pass in Chromium and WebKit. |
| P1, resolved | The first long press could claim the gesture without opening a menu because `node_active` arrives after the handler. | Seed the pressed node immediately and open the action sheet. A unit regression and native Chromium touch sequence now pass. |
| P2, resolved | Phone-only CSS hid the reference's right tool rail and left iPad using desktop chrome. | Use one editor-specific width/coarse-pointer query, a scrollable right rail, five-item bottom dock and bottom sheets. Portrait, landscape and desktop transition checks pass. |

## Visual comparison

Source: the user-supplied `codex-clipboard-60844d16-e014-4882-a12b-18fa812a1136.png`, 941 × 1672 pixels. It contains a phone frame and OS chrome. Crop the app-owned area `(96,151)-(845,1615)` and normalize it to **393 × 768**. The implementation capture uses the same CSS viewport, screenshot scale `css`, device scale factor 1, light theme and an authenticated synthetic room. The source and implementation were inspected together in `output/playwright/reference-editor/design-comparison.png`, with focused header, rail and dock comparisons in `design-comparison-details.png`.

The synthetic room supplies three branches and Chinese node text. User content, comments, notifications, attachments and map theme are data-dependent, so the source's exact graph and avatar are not copied into production data. Existing map typography is preserved. This change adapts editor chrome; it does not replace users' themes or map contents.

Required fidelity surfaces checked:

- **Typography:** navy system-font chrome, readable bold title and green saved chip; bottom labels remain on one line. Source canvas fonts remain controlled by each map's theme.
- **Spacing/layout:** single white header, right vertical rail, separate zoom controls and rounded bottom dock with a central green plus. All tested persistent buttons have at least 44 × 44px targets. Short landscape uses a horizontal zoom strip and a scrollable rail; iPad uses a centered dock and a 360px panel.
- **Colors/tokens:** white surfaces, navy icons/text, muted grey labels and green add/saved states follow the reference. Dark mode inherits separate editor surface/text tokens. Existing notification indicators remain functional.
- **Image/icon quality:** sharp existing Element UI/project vector and icon-font assets; no screenshot layers, phone frame, OS status bar or home indicator inserted into the app. The rail keeps existing product action icons and permissions.
- **Copy/content:** Theme / Style / Add / Map / More follow the reference. Existing file operations, permissions, import/export and history remain reachable. Refresh moves into the file sheet on narrow phones to preserve touch area and title legibility.

The larger rail/zoom/add targets compared with the normalized mock are intentional for touch usability. Desktop chrome remains unchanged. No open P0/P1/P2 findings remain.

## Functional verification

- `npm run test:attachment-preview`: existing decoding, progressive loading and PDF/PPT/image lifecycle checks, plus new CSV/TSV and real workbook-worker cases. Covers UTF-8/BOM, GB18030, UTF-16 LE/BE, quoted separators/newlines, leading zeros, long numbers, literal formulas, empty files, malformed input and row bounds. XLSX/XLS/XLSB/ODS multi-sheet values are checked.
- `npm run test:touch-editor`: live selection/history on mount, first long press, read-only guards, panels, keyboard chrome and listener disposal.
- `npm run test:mobile`: 14 gesture regressions and 3 insert/move/ACK persistence regressions pass.
- Browser layout: **14 cases**, Chromium and WebKit, each at 393×852, 320×740, 820×1180, 1194×834, 1366×1024, 852×393 and desktop 1440×900. No horizontal overflow, clipped persistent controls, rail/zoom overlap or out-of-viewport panels.
- Browser attachments: Chromium and WebKit at desktop, phone and iPad sizes. CSV/GBK CSV/TSV show real table cells and exact identifiers; XLSX/XLS/XLSB/ODS switch sheets and keep bounded DOM rows. Empty CSV, WAV metadata, unsupported video codec fallback, DOCX, PDF, PPTX, Markdown, ZIP, denied access and closing/reopening a pending preview pass. Browser runs report zero uncaught page errors.
- Authenticated editor → API → isolated local PostgreSQL: tap to add/edit two nodes, save acknowledgements, zoom/fit, read-only controls, orientation and desktop/touch switching, permission sheet and member-list height. Chromium native touch additionally verifies pan, pinch, touch cancellation, long press, drag-to-reparent, undo and redo. Reload restores edits and hierarchy. WebKit verifies edit/save/reload and menu/viewport behavior.
- Normal local preview: `/files` returns HTTP 200; collaboration health reports `ok: true` and a healthy PostgreSQL event bus. Production build and focused ESLint pass; existing Browserslist/deprecation/bundle-size notices remain.

## Scope and evidence

Browser emulation is not physical-device acceptance. iPhone/iPad OS keyboards, Apple Pencil and each media codec still depend on the real device/browser. Attachment content/permission tests use a local fixture HTTP server with the production preview components; they do not validate production object-storage uploads or production SSO. Spreadsheet preview retains its existing 5 MiB, 10-sheet, 10,000-row and 40-column limits and download fallback. Legacy DOC/PPT and unsupported formats retain download fallback.

Raw browser artifacts are local, uncommitted test output under `output/playwright/reference-editor/`: `layout-report.json`, `preview-report.json`, `interaction-report.json`, `final-phone.png`, `final-ipad.png`, `final-dark.png`, `final-file-menu.png`, `chromium-phone-csv.png` and both visual comparison images. Temporary test accounts/rooms live in a dedicated local QA database, never in the user's working maps.

Implementation checklist: responsive reference chrome, narrow-title fix, first-long-press fix, typed delimited-text preview, other spreadsheet formats, media controls/fallback, read-only/history behavior, build/lint/tests, source/render comparison — complete.

final result: passed
