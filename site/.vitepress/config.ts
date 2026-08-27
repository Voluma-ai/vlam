import { defineConfig } from 'vitepress';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { localHttpsCertificate, viewerDevPlugin } from './viewer-dev-plugin';

const siteDir = dirname(fileURLToPath(import.meta.url));
const sidebarPath = join(siteDir, '../api/typedoc-sidebar.json');
const httpsCertificate = localHttpsCertificate();

type SidebarItem = {
  text: string;
  link?: string;
  collapsed?: boolean;
  items?: SidebarItem[];
};

/** Drop `.md` suffixes so cleanUrls routes resolve. */
function normalizeSidebar(items: SidebarItem[]): SidebarItem[] {
  return items.map((item) => ({
    ...item,
    ...(item.link ? { link: item.link.replace(/\.md$/i, '') } : {}),
    ...(item.items ? { items: normalizeSidebar(item.items) } : {}),
  }));
}

/** TypeDoc sidebar when `site/api` has been generated; empty otherwise. */
function apiSidebar(): SidebarItem[] {
  if (!existsSync(sidebarPath)) return [];
  return normalizeSidebar(JSON.parse(readFileSync(sidebarPath, 'utf8')) as SidebarItem[]);
}

export default defineConfig({
  title: 'VLAM!',
  description: 'A lightweight WebGPU Gaussian splat viewer for three.js',
  cleanUrls: true,
  outDir: '../dist-site',
  // /demo is filled in after the VitePress build by build-site.mjs.
  ignoreDeadLinks: [/^\/demo/],
  vite: {
    plugins: [viewerDevPlugin()],
    server: {
      port: 5170,
      strictPort: true,
      host: true,
      ...(httpsCertificate ? { https: httpsCertificate } : {}),
      // Same-origin proxy so the viewer can fetch remote scenes without CORS.
      proxy: {
        '/remote': {
          target: 'https://assets.voluma.ai',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/remote/, ''),
        },
      },
    },
  },
  themeConfig: {
    logo: {
      light: '/vlam-icon-light.png',
      dark: '/vlam-icon-dark.png',
      alt: 'VLAM!',
    },
    siteTitle: 'VLAM!',
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Get started', link: '/get-started' },
      { text: 'Examples', link: '/examples/' },
      { text: 'FAQ', link: '/faq' },
      { text: 'API', link: '/api/' },
      // Same tab: the demo has its own menu back into the docs, so opening a
      // new tab each way just piles them up. `target` is still required -
      // it is what makes the VitePress router skip the link and do a real
      // navigation; `/demo/` is served by Vite, not a VitePress page.
      {
        text: 'Demo',
        link: '/demo/?scene=/remote/jack/v/Dehaar/Dehaar.lcc2&fallback=goose',
        target: '_self',
      },
    ],
    sidebar: {
      '/examples/': [
        {
          text: 'Examples',
          items: [
            { text: 'Overview', link: '/examples/' },
            { text: '1. Your first viewer', link: '/examples/first-viewer' },
            { text: '2. Open a local file', link: '/examples/open-local-file' },
            { text: '3. Streaming big scenes', link: '/examples/big-scenes' },
            { text: '4. Click on the world', link: '/examples/click-the-world' },
            { text: '5. Splats + 3D objects', link: '/examples/splats-and-objects' },
            { text: '6. Several captures', link: '/examples/many-captures' },
            { text: '7. Collision walk', link: '/examples/collision-walk' },
          ],
        },
        {
          text: 'Going further',
          items: [
            { text: '8. Frame the capture', link: '/examples/frame-the-camera' },
            { text: '9. Surface queries', link: '/examples/surface-queries' },
            { text: '10. Shader effects', link: '/examples/shader-effects' },
            { text: '11. Select and cut', link: '/examples/select-and-cut' },
            { text: '12. Depth of field', link: '/examples/depth-of-field' },
            { text: '13. Relight', link: '/examples/relight' },
            { text: '14. Tiny planet', link: '/examples/tiny-planet' },
            { text: '15. Write your own effect', link: '/examples/custom-effect' },
          ],
        },
        {
          text: 'Shipping it',
          items: [
            { text: '16. Use it from React', link: '/examples/react-viewer' },
            { text: '17. Annotations', link: '/examples/annotations' },
            { text: '18. Fast on a phone', link: '/examples/fast-on-phones' },
            { text: '19. The WebGL2 fallback', link: '/examples/webgl-fallback' },
            { text: '20. View it in VR', link: '/examples/in-vr' },
            { text: '21. Share a viewpoint', link: '/examples/share-a-viewpoint' },
          ],
        },
        {
          text: 'Reference',
          items: [{ text: 'All samples', link: '/examples/all-samples' }],
        },
      ],
      '/api/': [
        {
          text: 'API',
          items: apiSidebar(),
        },
      ],
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/Voluma-ai/vlam' },
      { icon: 'discord', link: 'https://discord.com/invite/fKUG4GWY8h' },
      // `icon.svg` is injected with `v-html`, so an <img> works, but only the
      // built-in icons get sized by the theme's scoped rules, hence the inline
      // size. The mark is a full-colour PNG; there is no SVG of it.
      {
        icon: {
          svg: '<img src="/voluma-logo.png" alt="" style="width:20px;height:20px;object-fit:contain" />',
        },
        ariaLabel: 'Voluma',
        link: 'https://voluma.ai',
      },
    ],
    footer: {
      message: 'MIT License',
      copyright:
        '<a href="https://voluma.ai" target="_blank" rel="noreferrer">&#169; 2026 VOLUMA</a>',
    },
  },
  head: [
    ['link', { rel: 'icon', href: '/favicon.ico' }],
    ['meta', { property: 'og:title', content: 'VLAM!' }],
    [
      'meta',
      {
        property: 'og:description',
        content: 'A lightweight WebGPU Gaussian splat viewer for three.js',
      },
    ],
    ['meta', { property: 'og:url', content: 'https://vlam.voluma.ai' }],
    ['meta', { property: 'og:image', content: 'https://vlam.voluma.ai/voluma-logo.png' }],
    ['meta', { name: 'twitter:card', content: 'summary' }],
  ],
});
