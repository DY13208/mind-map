<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 256 256"
    fill="none"
    focusable="false"
    v-bind="$attrs"
  >
    <g stroke="currentColor" stroke-width="18" stroke-linecap="round" stroke-linejoin="round">
      <path d="M198 48h12a25 25 0 0 1 25 25v146a25 25 0 0 1-25 25H76a25 25 0 0 1-25-25v-13" />
      <rect x="22" y="14" width="176" height="192" rx="28" />
      <path d="m61 124 36-44 28 68 35-39" stroke-width="12" />
    </g>
    <g fill="currentColor">
      <circle cx="61" cy="124" r="14" />
      <circle cx="97" cy="80" r="14" />
      <circle cx="125" cy="148" r="14" />
      <circle cx="160" cy="109" r="14" />
    </g>
  </svg>
</template>

<script>
export default {
  name: 'WcpdLogoMark',
  inheritAttrs: false
}
</script>
