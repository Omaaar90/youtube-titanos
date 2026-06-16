/**
 * YouTube-TitanOS — Cloudflare Worker Reverse Proxy
 *
 * Since TitanOS hosted apps cannot run local scripts inside cross-origin pages
 * (like youtube.com/tv) due to the Same-Origin Policy, we use this lightweight
 * proxy to load YouTube TV under our own domain and inject our scripts.
 *
 * How to deploy:
 * 1. Create a free account on cloudflare.com
 * 2. Go to Workers & Pages -> Create Application -> Create Worker
 * 3. Copy/paste this code into the Worker editor and save.
 * 4. Point your TV's DevView (or desktop browser) to your worker URL.
 *
 * CORS strategy:
 * - Our Worker URL becomes the "origin" for the browser.
 * - All sub-resources that YouTube TV loads (fonts, video, API) are made by
 *   the browser directly from that origin — and those third-party servers do
 *   NOT include Access-Control-Allow-Origin headers for our domain.
 * - Solution: the Worker proxies ALL requests to their real upstream host,
 *   adding CORS headers on the way back out. The browser never hits a
 *   cross-origin server directly.
 */

const GH_PAGES_BASE = 'https://Omaaar90.github.io/youtube-titanos';
const TV_UA = 'Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/5.0 TV Safari/538.1';

// Domains that should be proxied through us (YouTube TV sub-resource ecosystem)
const PROXY_DOMAINS = new Set([
  'www.youtube.com',
  'youtube.com',
  'www.gstatic.com',
  'gstatic.com',
  'redirector.googlevideo.com',
  'clients1.google.com',
  'www.google.com',
  'yt3.ggpht.com',
  'lh3.googleusercontent.com',
  'i.ytimg.com',
  'i9.ytimg.com',
  'manifest.googlevideo.com',
  'rr1.googlevideo.com',
  'rr2.googlevideo.com',
  'rr3.googlevideo.com',
  'rr4.googlevideo.com',
  'rr5.googlevideo.com',
  'rr6.googlevideo.com',
  'rr7.googlevideo.com',
  'r1---sn-googlevideo.com',
  'suggestqueries.google.com',
  'suggestqueries-clients6.youtube.com',
  'jnn-pa.googleapis.com',
  'www.googleapis.com',
]);

// Suffix match for wildcard subdomains we can't enumerate (e.g. *.googlevideo.com)
const PROXY_SUFFIXES = ['.googlevideo.com', '.youtube.com', '.ytimg.com'];

function shouldProxy(hostname) {
  if (PROXY_DOMAINS.has(hostname)) return true;
  return PROXY_SUFFIXES.some(s => hostname.endsWith(s));
}

function corsHeaders(origin = '*') {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight — respond immediately so browsers don't block anything
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // 1. Serve our app assets (index.js, webpack chunks, css) from GitHub Pages
    const isProjectAsset =
      url.pathname === '/index.js' ||
      url.pathname.endsWith('.index.js') ||
      url.pathname.startsWith('/assets/') ||
      url.pathname.endsWith('.css') ||
      url.pathname.endsWith('.js.map');

    if (isProjectAsset) {
      const assetUrl = `${GH_PAGES_BASE}${url.pathname}`;
      const res = await fetch(assetUrl);
      const headers = new Headers(res.headers);
      Object.entries(corsHeaders()).forEach(([k, v]) => headers.set(k, v));
      return new Response(res.body, { status: res.status, headers });
    }

    // 2. Serve YouTube TV HTML (root path) — inject our bundle
    if (url.pathname === '/' || url.pathname === '/tv' || url.pathname.startsWith('/tv/')) {
      const targetUrl = new URL('https://www.youtube.com/tv');
      url.searchParams.forEach((value, key) => targetUrl.searchParams.set(key, value));

      const headers = new Headers(request.headers);
      headers.set('User-Agent', TV_UA);
      headers.delete('host');

      const res = await fetch(targetUrl.toString(), { headers });
      let html = await res.text();

      // Inject our Webpack bundle before any other scripts
      html = html.replace('<head>', '<head><script src="/index.js"></script>');

      // Rewrite cross-origin resource URLs to flow through this Worker via /__proxy/
      // This fixes CORS for fonts (gstatic.com), API calls, and images.
      // We only rewrite https:// absolute URLs that would cause cross-origin requests.
      const REWRITE_HOSTS = [
        'www.gstatic.com',
        'gstatic.com',
        'clients1.google.com',
        'suggestqueries.google.com',
        'suggestqueries-clients6.youtube.com',
        'jnn-pa.googleapis.com',
        'www.googleapis.com',
      ];
      for (const host of REWRITE_HOSTS) {
        // Replace both single-quoted and double-quoted URL occurrences
        const escaped = host.replace(/\./g, '\\.');
        html = html.replace(new RegExp(`https://${escaped}/`, 'g'), `/__proxy/${host}/`);
      }
      const newHeaders = new Headers(res.headers);
      newHeaders.delete('content-security-policy');
      newHeaders.delete('content-security-policy-report-only');
      newHeaders.delete('x-frame-options');
      newHeaders.delete('content-encoding'); // We decoded it via .text()
      newHeaders.delete('transfer-encoding');
      newHeaders.set('content-type', 'text/html; charset=utf-8');
      Object.entries(corsHeaders()).forEach(([k, v]) => newHeaders.set(k, v));

      return new Response(html, {
        status: res.status,
        statusText: res.statusText,
        headers: newHeaders,
      });
    }

    // 3. Sub-path proxy for cross-origin resources.
    //
    // The HTML rewrite changes URLs like:
    //   https://www.gstatic.com/ytlr/fonts/Roboto.ttf
    // to:
    //   /__proxy/www.gstatic.com/ytlr/fonts/Roboto.ttf
    //
    // These arrive at the Worker with /__proxy/<host>/... pathname.
    // We strip the prefix, restore the real host, and forward the request.
    if (url.pathname.startsWith('/__proxy/')) {
      const rest = url.pathname.slice('/__proxy/'.length); // "www.gstatic.com/ytlr/..."
      const slashIdx = rest.indexOf('/');
      const upHost = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
      const upPath = slashIdx === -1 ? '/' : rest.slice(slashIdx);

      const targetUrl = `https://${upHost}${upPath}${url.search}`;
      const upHeaders = new Headers(request.headers);
      upHeaders.set('host', upHost);
      upHeaders.set('User-Agent', TV_UA);
      upHeaders.delete('origin');
      upHeaders.delete('referer');

      const res = await fetch(targetUrl, {
        method: request.method,
        headers: upHeaders,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
        redirect: 'follow',
      });

      const newHeaders = new Headers(res.headers);
      newHeaders.delete('content-security-policy');
      newHeaders.delete('x-frame-options');
      Object.entries(corsHeaders()).forEach(([k, v]) => newHeaders.set(k, v));
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: newHeaders });
    }

    // Determine upstream hostname — default to www.youtube.com for YT APIs
    const upstreamHost = request.headers.get('x-upstream-host') || 'www.youtube.com';

    const targetUrl = new URL(request.url);
    targetUrl.protocol = 'https:';
    targetUrl.hostname = upstreamHost;
    targetUrl.port = '';

    const upHeaders = new Headers(request.headers);
    upHeaders.set('User-Agent', TV_UA);
    upHeaders.set('host', upstreamHost);
    upHeaders.delete('origin');
    upHeaders.delete('referer');
    upHeaders.delete('x-upstream-host');

    const res = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: upHeaders,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
      redirect: 'follow',
    });

    const newHeaders = new Headers(res.headers);
    newHeaders.delete('content-security-policy');
    newHeaders.delete('content-security-policy-report-only');
    newHeaders.delete('x-frame-options');
    Object.entries(corsHeaders()).forEach(([k, v]) => newHeaders.set(k, v));

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: newHeaders,
    });
  },
};
