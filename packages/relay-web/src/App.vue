<script setup lang="ts">
import ConfirmDialog from "./components/ConfirmDialog.vue";
import ImageLightbox from "./components/ImageLightbox.vue";
</script>

<template>
  <RouterView />
  <ConfirmDialog />
  <ImageLightbox />
</template>
