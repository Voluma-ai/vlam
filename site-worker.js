/**
 * Docs-site deploy worker: serves dist-site assets and mirrors the Vite
 * dev-server's `/remote` proxy so the deployed viewer can load the same
 * scene URLs as local dev without CORS.
 * The original request is forwarded (method, headers) so Range requests from
 * streamed loaders pass through untouched.
 */
const REMOTE_ORIGIN = 'https://assets.voluma.ai';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/remote/')) {
      const upstream = new URL(url.pathname.slice('/remote'.length) + url.search, REMOTE_ORIGIN);
      return fetch(new Request(upstream, request));
    }
    return env.ASSETS.fetch(request);
  },
};
