<script setup lang="ts">
// Single source for the pre-release wording, used by the homepage hero and by
// every API reference page. Registered globally in theme/index.ts so markdown
// can write `<PreReleaseNotice variant="hero" />`.
withDefaults(defineProps<{ variant?: 'doc' | 'hero' }>(), { variant: 'doc' });
</script>

<template>
  <p class="vlam-warning" :class="`vlam-warning--${variant}`">
    <strong>Pre-release.</strong> The API can still change in breaking ways before v1.0. Great for
    prototypes and experiments, not yet recommended for production.
  </p>
</template>
