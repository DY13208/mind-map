<template>
  <svg
    class="menuIcon"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    style="pointer-events: none"
  >
    <path :d="paths[name]" />
  </svg>
</template>
<script>
// Menu-only paths keep all actions at the same stroke weight without a new dependency.
const paths = {
  plus: 'M12 5v14M5 12h14',
  sibling: 'M4 5v7h15m-5-5 5 5-5 5',
  collapse: 'm8 3 4 4 4-4m-8 18 4-4 4 4M5 12h14',
  expand: 'm8 7 4-4 4 4m-8 10 4 4 4-4M5 12h14',
  share:
    'M21 5a3 3 0 1 0-6 0 3 3 0 1 0 6 0M9 12a3 3 0 1 0-6 0 3 3 0 1 0 6 0M21 19a3 3 0 1 0-6 0 3 3 0 1 0 6 0M8.5 10.5l7-4M8.5 13.5l7 4',
  clipboard: 'M9 4H6v17h12V4h-3M9 3h6v4H9z',
  network: 'M9 3h6v5H9zM3 16h6v5H3zM15 16h6v5h-6zM12 8v4M6 16v-4h12v4',
  pencil: 'm4 16-1 5 5-1L20 8l-4-4zM14 6l4 4',
  palette:
    'M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 0-4h-1a2 2 0 0 1 0-4h6a3 3 0 0 0 3-3 9 9 0 0 0-9-7zM7 9h.01M11 6h.01M16 7h.01M6 14h.01',
  ellipsis: 'M5 12h.01M12 12h.01M19 12h.01',
  chevron: 'm9 6 6 6-6 6',
  chevronLeft: 'm15 6-6 6 6 6',
  copy: 'M8 8h13v13H8zM16 8V3H3v13h5',
  scissors: 'M9 6a3 3 0 1 0-6 0 3 3 0 1 0 6 0M9 18a3 3 0 1 0-6 0 3 3 0 1 0 6 0M8 8l13 13M8 16 21 3',
  paste: 'M9 4H5v16h5M9 3h6v4H9zM15 4h4v5M13 12h8v9h-8z',
  up: 'M12 20V4m-6 6 6-6 6 6',
  down: 'M12 4v16m-6-6 6 6 6-6',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  house: 'm3 10 9-7 9 7M5 9v12h5v-7h4v7h5V9',
  maximize: 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  eraser: 'm3 14 9-11 9 9-9 9H9zM7 10l9 9M12 21h9',
  focus:
    'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
  summary: 'M5 3h3v18H5M8 12h11M16 9l3 3-3 3',
  link:
    'm10 14 4-4M8 16l-2 2a4 4 0 0 1-5-5l5-5a4 4 0 0 1 5 0M16 8l2-2a4 4 0 0 1 5 5l-5 5a4 4 0 0 1-5 0',
  unlink: 'M3 3l18 18M8 16l-2 2a4 4 0 0 1-5-5l3-3M16 8l2-2a4 4 0 0 1 5 5l-3 3',
  attachment: 'm8 12 7-7a4 4 0 0 1 6 6L10 22a6 6 0 0 1-8-8L13 3M5 17l10-10',
  image: 'M3 3h18v18H3zM3 17l6-6 5 5 3-3 4 4M16 7h.01',
  brush: 'M15 4l5 5M14 5l5 5-9 9H5v-5z',
  smiley: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 10h.01M16 10h.01M8 15c1.5 2 6.5 2 8 0',
  note: 'M6 3h9l4 4v14H6zM15 3v4h4M9 12h6M9 16h6',
  comment: 'M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4h0A2.5 2.5 0 0 1 4 13.5zM8 8.5h8M8 12h5',
  tag: 'M3 12V4h8l10 10-8 8zM7 8h.01',
  formula: 'M6 5h6M9 5c2 5-2 9 2 14M14 10h6M14 16h6M16 8l4 10',
  frame: 'M4 4h16v16H4zM8 4v16M4 8h16',
  curve: 'M4 16c4-10 12-10 16 0M4 16h.01M20 16h.01',
  spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2 2M16 16l2 2M18 6l-2 2M8 16l-2 2',
  external: 'M14 3h7v7M21 3l-9 9M10 5H5v14h14v-5'
}
export default { props: { name: String }, data: () => ({ paths }) }
</script>
