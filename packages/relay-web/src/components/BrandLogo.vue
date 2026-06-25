<script setup lang="ts">
// Inline brand mark: a rounded geometric "X" stroked with the xacpx blue→green
// gradient, followed by the "XACPX HUB" lockup. Gradient is used ONLY here.
</script>

<template>
  <div class="flex items-center gap-2 select-none">
    <svg data-test="brand-x" width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="xacpxBrand" x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
          <stop stop-color="#4F9BF5" />
          <stop offset="1" stop-color="#69D689" />
        </linearGradient>
      </defs>
      <path d="M5 5 L19 19 M19 5 L5 19" stroke="url(#xacpxBrand)" stroke-width="3.2"
            stroke-linecap="round" />
    </svg>
    <span class="text-[15px] font-semibold tracking-tight text-fg">XACPX</span>
    <span class="text-fg-muted text-xs font-medium tracking-wide">HUB</span>
  </div>
</template>
