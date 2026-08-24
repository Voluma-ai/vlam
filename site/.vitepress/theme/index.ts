import DefaultTheme from 'vitepress/theme';
import { h } from 'vue';
import type { Theme } from 'vitepress';
import ExampleEmbed from './ExampleEmbed.vue';
import ApiPreReleaseNotice from './ApiPreReleaseNotice.vue';
import PreReleaseNotice from './PreReleaseNotice.vue';
import NavVersion from './NavVersion.vue';
import './custom.css';

/**
 * `<ExampleEmbed slug="…">` runs an example in place; see site/examples/.
 * `<PreReleaseNotice variant="hero">` is the shared pre-release wording.
 */
export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      'doc-before': () => h(ApiPreReleaseNotice),
      'nav-bar-title-after': () => h(NavVersion),
    }),
  enhanceApp({ app }) {
    app.component('ExampleEmbed', ExampleEmbed);
    app.component('PreReleaseNotice', PreReleaseNotice);
  },
} satisfies Theme;
