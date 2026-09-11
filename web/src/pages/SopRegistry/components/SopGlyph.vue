<template>
  <svg
    class="sopGlyph"
    :class="[`kind-${kind}`, sizeClass]"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <!-- C: cube -->
    <g v-if="kind === 'C'">
      <path
        d="M12 3.2L20 7.5v9L12 20.8 4 16.5v-9L12 3.2z"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linejoin="round"
      />
      <path
        d="M12 12.2L20 7.5M12 12.2L4 7.5M12 12.2V20.8"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linejoin="round"
      />
    </g>
    <!-- P: flag -->
    <g v-else-if="kind === 'P'">
      <path
        d="M6 21V4.5"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
      />
      <path
        d="M6.5 5.2h9.2l-2.2 3.4 2.2 3.4H6.5"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linejoin="round"
      />
    </g>
    <!-- D / d: document -->
    <g v-else-if="kind === 'D' || kind === 'd'">
      <path
        d="M7 3.8h7.2L19 8.6V20.2a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.8a1 1 0 0 1 1-1z"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linejoin="round"
      />
      <path
        d="M14 3.9V8.4h4.6"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linejoin="round"
      />
      <path
        d="M9 12.2h6M9 15.4h6"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
      />
    </g>
    <!-- play -->
    <g v-else-if="kind === 'play'">
      <path
        d="M9 6.8v10.4l8.2-5.2L9 6.8z"
        fill="currentColor"
      />
    </g>
    <!-- refresh -->
    <g v-else-if="kind === 'refresh'">
      <path
        d="M20 12a8 8 0 1 1-2.2-5.5"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
      />
      <path
        d="M20 4.8V9h-4.2"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </g>
    <!-- search -->
    <g v-else-if="kind === 'search'">
      <circle cx="11" cy="11" r="6.2" stroke="currentColor" stroke-width="1.8" />
      <path
        d="M16 16.2L20 20"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
      />
    </g>
    <!-- map / open -->
    <g v-else-if="kind === 'map'">
      <circle cx="8.2" cy="9" r="2.2" stroke="currentColor" stroke-width="1.6" />
      <circle cx="16" cy="14.5" r="2.2" stroke="currentColor" stroke-width="1.6" />
      <path
        d="M10 9.8l4.2 3.4"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
      />
      <path
        d="M5 18.5h14"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        opacity="0.45"
      />
    </g>
    <!-- cards / nodes view -->
    <g v-else-if="kind === 'cards'">
      <circle cx="7" cy="8" r="2" stroke="currentColor" stroke-width="1.6" />
      <circle cx="17" cy="8" r="2" stroke="currentColor" stroke-width="1.6" />
      <circle cx="12" cy="16" r="2" stroke="currentColor" stroke-width="1.6" />
      <path
        d="M8.8 8.8l2.4 5.2M15.2 8.8l-2.4 5.2"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
      />
    </g>
    <!-- list -->
    <g v-else-if="kind === 'list'">
      <path
        d="M8 7h11M8 12h11M8 17h11"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
      />
      <circle cx="4.5" cy="7" r="1.2" fill="currentColor" />
      <circle cx="4.5" cy="12" r="1.2" fill="currentColor" />
      <circle cx="4.5" cy="17" r="1.2" fill="currentColor" />
    </g>
    <!-- info -->
    <g v-else-if="kind === 'info'">
      <circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.6" />
      <path
        d="M12 10.2V16.5M12 7.6h.01"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
      />
    </g>
    <!-- more vertical -->
    <g v-else-if="kind === 'more'">
      <circle cx="12" cy="6" r="1.5" fill="currentColor" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
      <circle cx="12" cy="18" r="1.5" fill="currentColor" />
    </g>
    <!-- chevron -->
    <g v-else-if="kind === 'chevron-down'">
      <path
        d="M6.5 9.5L12 15l5.5-5.5"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </g>
    <g v-else-if="kind === 'chevron-up'">
      <path
        d="M6.5 14.5L12 9l5.5 5.5"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </g>
    <g v-else-if="kind === 'chevron-right'">
      <path
        d="M9.5 6.5L15 12l-5.5 5.5"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </g>
    <!-- default node -->
    <g v-else>
      <circle cx="12" cy="12" r="3.2" stroke="currentColor" stroke-width="1.6" />
    </g>
  </svg>
</template>

<script>
export default {
  name: 'SopGlyph',
  props: {
    kind: { type: String, default: 'node' },
    size: { type: String, default: 'md' } // sm | md | lg | xl
  },
  computed: {
    sizeClass() {
      return `size-${this.size}`
    }
  }
}

export function inferNodeKind(text) {
  const t = String(text || '')
    .trim()
    .replace(/^[-*•●]\s*/, '')
  if (/^C\s*[：:]/i.test(t)) return 'C'
  if (/^P\s*[：:]/i.test(t)) return 'P'
  if (/^D(?!\d)\s*[：:]/i.test(t)) return 'D'
  if (/^d(?!\d)\s*[：:]/.test(t)) return 'd'
  return 'node'
}
</script>

<style scoped>
.sopGlyph {
  display: inline-block;
  flex-shrink: 0;
  vertical-align: middle;
}
.size-sm {
  width: 14px;
  height: 14px;
}
.size-md {
  width: 16px;
  height: 16px;
}
.size-lg {
  width: 20px;
  height: 20px;
}
.size-xl {
  width: 28px;
  height: 28px;
}
.kind-C {
  color: #0f766e;
}
.kind-P {
  color: #0d9488;
}
.kind-D,
.kind-d {
  color: #059669;
}
</style>
