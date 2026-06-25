<script setup lang="ts">
// Inline brand mark: the xacpx "X" as four rounded capsules — a green ∨ (arc-bottom
// chevron) over two splayed blue legs — followed by the "XACPX HUB" lockup. Uses the
// brand green/blue solids (#69D689 / #4F9BF5). Kept in sync with public/icon.svg,
// public/mask-icon.svg and assets/pwa-source.svg.
</script>

<template>
  <div class="flex items-center gap-2 select-none">
    <svg data-test="brand-x" width="22" height="22" viewBox="28.5 9 83 83" fill="none" aria-hidden="true">
      <g stroke-width="22" stroke-linecap="round" stroke-linejoin="round">
        <path d="M40 20 L54.5 34.5 A22 22 0 0 0 85.5 34.5 L100 20" stroke="#69D689" />
        <path d="M53 68 L40 81" stroke="#4F9BF5" />
        <path d="M87 68 L100 81" stroke="#4F9BF5" />
      </g>
    </svg>
    <span class="text-[15px] font-semibold tracking-tight text-fg">XACPX</span>
    <span class="text-fg-muted text-xs font-medium tracking-wide">HUB</span>
  </div>
</template>
