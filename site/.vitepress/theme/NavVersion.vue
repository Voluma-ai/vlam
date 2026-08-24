<script setup lang="ts">
// Read at build time from the published package, so the badge can never drift
// from the version people actually install.
import pkg from '../../../package.json';
</script>

<template>
  <span class="vlam-nav-version">v{{ pkg.version }}</span>
</template>
