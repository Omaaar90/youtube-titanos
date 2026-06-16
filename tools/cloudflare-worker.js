/**
 * YouTube-TitanOS — Cloudflare Worker Reverse Proxy
 *
 * TitanOS loads apps as hosted web URLs. There's no native script injection
 * mechanism (unlike webOS's webOSUserScripts/). This Worker is the only way to:
 *   1. Serve YouTube TV HTML with our bundle injected
 *   2. Strip CSP / X-Frame-Options so our script can run
 *   3. Proxy gstatic.com fonts (CORS-blocked without this)
 *   4. Proxy YouTube API calls same-origin
 *
 * Deploy: Cloudflare Workers & Pages → Create Worker → paste this file.
 * Point TitanOS DevView / App Store URL to your worker domain.
 */

const GH_PAGES_BASE = 'https://Omaaar90.github.io/youtube-titanos';
const TV_UA = 'Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/5.0 TV Safari/538.1';

// Hosts whose absolute URLs in the HTML/JS/CSS we rewrite to /__proxy/<host>/...
// so the browser never makes a cross-origin request directly.
const REWRITE_HOSTS = [
  'www.gstatic.com',
  'clients1.google.com',
  'suggestqueries.google.com',
  'jnn-pa.googleapis.com',
  'www.googleapis.com',
  'redirector.googlevideo.com',
  'eligibility-panelresearch.googlevideo.com',
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Preflight — answer immediately so nothing blocks
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── 1. Our built assets from GitHub Pages ──────────────────────────────
    if (
      url.pathname === '/index.js' ||
      url.pathname.endsWith('.index.js') ||
      url.pathname.startsWith('/assets/') ||
      url.pathname.endsWith('.css') ||
      url.pathname.endsWith('.js.map')
    ) {
      const res = await fetch(`${GH_PAGES_BASE}${url.pathname}`);
      const h = new Headers(res.headers);
      Object.assign(h, CORS); // spread doesn't work on Headers; use loop
      for (const [k, v] of Object.entries(CORS)) h.set(k, v);
      return new Response(res.body, { status: res.status, headers: h });
    }

    // ── 2. YouTube TV HTML — inject bundle + strip security headers ────────
    if (url.pathname === '/' || url.pathname === '/tv' || url.pathname.startsWith('/tv/')) {
      const ytUrl = new URL('https://www.youtube.com/tv');
      url.searchParams.forEach((v, k) => ytUrl.searchParams.set(k, v));

      const reqHeaders = new Headers(request.headers);
      reqHeaders.set('User-Agent', TV_UA);
      reqHeaders.delete('host');

      const res = await fetch(ytUrl.toString(), { headers: reqHeaders });
      let html = await res.text();

      // Inject our bundle first
      html = html.replace('<head>', '<head><script src="/index.js"></script>');

      // Rewrite cross-origin URLs to go via /__proxy/<host>/path
      for (const host of REWRITE_HOSTS) {
        const re = new RegExp(`https://${host.replace(/\./g, '\\.')}/`, 'g');
        html = html.replace(re, `/__proxy/${host}/`);
      }

      const h = new Headers(res.headers);
      h.delete('content-security-policy');
      h.delete('content-security-policy-report-only');
      h.delete('x-frame-options');
      h.delete('content-encoding');   // decoded by .text()
      h.delete('transfer-encoding');
      h.set('content-type', 'text/html; charset=utf-8');
      for (const [k, v] of Object.entries(CORS)) h.set(k, v);

      return new Response(html, { status: res.status, headers: h });
    }

    // ── 3. Sub-path proxy — /__proxy/<host>/path ───────────────────────────
    // Handles rewritten URLs for gstatic.com fonts, googleapis, etc.
    if (url.pathname.startsWith('/__proxy/')) {
      const rest = url.pathname.slice(9); // strip '/__proxy/'
      const slash = rest.indexOf('/');
      const upHost = slash === -1 ? rest : rest.slice(0, slash);
      const upPath = slash === -1 ? '/' : rest.slice(slash);

      const reqHeaders = new Headers(request.headers);
      reqHeaders.set('host', upHost);
      reqHeaders.set('User-Agent', TV_UA);
      reqHeaders.set('origin', 'https://www.youtube.com');
      reqHeaders.set('referer', 'https://www.youtube.com/tv');

      const res = await fetch(`https://${upHost}${upPath}${url.search}`, {
        method: request.method,
        headers: reqHeaders,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
        redirect: 'follow',
      });

      const h = new Headers(res.headers);
      h.delete('content-security-policy');
      h.delete('x-frame-options');
      for (const [k, v] of Object.entries(CORS)) h.set(k, v);
      return new Response(res.body, { status: res.status, headers: h });
    }

    // ── 4. Everything else → proxy to youtube.com ─────────────────────────
    // YouTube TV's API calls (/youtubei/v1/*, /api/*, etc.) are relative URLs
    // so the browser sends them to our Worker domain. Forward them to YT.
    const targetUrl = new URL(request.url);
    targetUrl.protocol = 'https:';
    targetUrl.hostname = 'www.youtube.com';
    targetUrl.port = '';

    const reqHeaders = new Headers(request.headers);
    reqHeaders.set('User-Agent', TV_UA);
    reqHeaders.set('host', 'www.youtube.com');
    reqHeaders.set('origin', 'https://www.youtube.com');
    reqHeaders.set('referer', 'https://www.youtube.com/tv');

    const res = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: reqHeaders,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
      redirect: 'follow',
    });

    const contentType = res.headers.get('content-type') || '';
    const isText = contentType.includes('text/') || 
                   contentType.includes('application/javascript') || 
                   contentType.includes('text/javascript') ||
                   contentType.includes('application/json');

    if (isText && res.status === 200) {
      let text = await res.text();
      for (const host of REWRITE_HOSTS) {
        const re = new RegExp(`https://${host.replace(/\./g, '\\.')}/`, 'g');
        text = text.replace(re, `/__proxy/${host}/`);
      }
      
      const h = new Headers(res.headers);
      h.delete('content-security-policy');
      h.delete('content-security-policy-report-only');
      h.delete('x-frame-options');
      h.delete('content-encoding');   // decoded by .text()
      h.delete('transfer-encoding');
      for (const [k, v] of Object.entries(CORS)) h.set(k, v);
      
      return new Response(text, { status: res.status, headers: h });
    }

    const h = new Headers(res.headers);
    h.delete('content-security-policy');
    h.delete('content-security-policy-report-only');
    h.delete('x-frame-options');
    for (const [k, v] of Object.entries(CORS)) h.set(k, v);

    return new Response(res.body, { status: res.status, headers: h });
  },
};
