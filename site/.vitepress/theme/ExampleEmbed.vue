<script setup lang="ts">
import { computed, ref } from 'vue';

const props = withDefaults(
  defineProps<{
    /** Folder under /examples/live/ - matches EXAMPLE_APPS in viewer-dev-plugin.ts. */
    slug: string;
    /** One line of "here is what to do with it", shown on the poster. */
    hint?: string;
    /** Frame aspect ratio. */
    ratio?: string;
  }>(),
  { hint: '', ratio: '16 / 10' },
);

const href = computed(() => `/examples/live/${props.slug}/`);

// Nothing is fetched and no GPU device is created until this flips: a reader
// who only wants the source pays nothing for the embed. `reloads` is part of
// the iframe key, so Reload remounts the frame rather than reaching into a
// document Vue does not own.
const started = ref(false);
const reloads = ref(0);
</script>

<template>
  <div class="example-embed">
    <div v-if="!started" class="poster" :style="{ aspectRatio: ratio }">
      <button class="run" type="button" @click="started = true">Run this example</button>
      <p v-if="hint" class="hint">{{ hint }}</p>
      <!--p class="note">Loads a 1.8 MB capture</p-->
    </div>

    <template v-else>
      <div class="bar">
        <span class="hint">{{ hint }}</span>
        <span class="actions">
          <button type="button" @click="reloads++">Reload</button>
          <a :href="href" target="_blank" rel="noreferrer">Open full page ↗</a>
        </span>
      </div>
      <iframe
        :key="reloads"
        :src="href"
        :style="{ aspectRatio: ratio }"
        :title="`Live example: ${slug}`"
        loading="lazy"
        allowfullscreen
      />
    </template>
  </div>
</template>

<style scoped>
.example-embed {
  margin: 24px 0 32px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  overflow: hidden;
}

.poster,
iframe {
  width: 100%;
  max-height: 70vh;
  display: block;
}

iframe {
  border: 0;
  background: #1a1a1f;
  touch-action: none;
}

.poster {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: var(--vp-c-bg-soft);
  padding: 24px;
  text-align: center;
}

.run {
  border-radius: 20px;
  padding: 9px 22px;
  font-size: 14px;
  font-weight: 600;
  color: var(--vp-c-white);
  background: var(--vp-c-brand-1);
  transition: opacity 0.2s;
}

.run:hover {
  opacity: 0.85;
}

.hint {
  margin: 0;
  font-size: 14px;
  color: var(--vp-c-text-2);
}

.note {
  margin: 0;
  font-size: 12px;
  color: var(--vp-c-text-3);
}

.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 8px 12px;
  background: var(--vp-c-bg-soft);
  border-bottom: 1px solid var(--vp-c-divider);
}

.bar .hint {
  font-size: 13px;
}

.actions {
  display: flex;
  gap: 14px;
  font-size: 13px;
  white-space: nowrap;
}

.actions button,
.actions a {
  color: var(--vp-c-brand-1);
  font-weight: 500;
}

.actions button:hover,
.actions a:hover {
  text-decoration: underline;
}
</style>
