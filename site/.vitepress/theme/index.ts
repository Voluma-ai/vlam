import DefaultTheme from 'vitepress/theme';
import { h } from 'vue';
import type { Theme } from 'vitepress';
import ExampleEmbed from './ExampleEmbed.vue';
import NavVersion from './NavVersion.vue';
import './custom.css';

/**
 * `<ExampleEmbed slug="…">` runs an example in place; see site/examples/.
 */
export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      'nav-bar-title-after': () => h(NavVersion),
    }),
  enhanceApp({ app }) {
    app.component('ExampleEmbed', ExampleEmbed);
  },
} satisfies Theme;
