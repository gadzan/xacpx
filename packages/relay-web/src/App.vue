<script setup lang="ts">
import ConfirmDialog from "./components/ConfirmDialog.vue";
import ImageLightbox from "./components/ImageLightbox.vue";
import { useImageLightbox } from "./lib/use-image-lightbox";

// Exactly one viewer instance app-wide; v-if on the singleton state makes
// mount == open, so its scroll-lock/focus/modal-stack side effects only exist
// while an image set is actually shown.
const { state: lightboxState } = useImageLightbox();
</script>

<template>
  <RouterView />
  <ConfirmDialog />
  <ImageLightbox v-if="lightboxState" />
</template>
