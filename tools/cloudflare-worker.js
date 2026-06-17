/**
 * YouTube-TitanOS — Cloudflare Worker Reverse Proxy v4
 *
 * v4 changes:
 *  - Catch-all GOOGLE_FAMILY_RE replaces fragile per-host pattern lists.
 *    Any *.googlevideo.com, *.c.youtube.com, *.ytimg.com, *.ggpht.com,
 *    *.gstatic.com, *.googleapis.com, *.google.com, accounts.google.com,
 *    *.doubleclick.net request is intercepted automatically — no more
 *    whack-a-mole when YouTube adds a new CDN edge hostname.
 */

const GH_PAGES_BASE = 'https://Omaaar90.github.io/youtube-titanos';
const TV_UA = 'Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/5.0 TV Safari/538.1';
const SESSION_KV_KEY = 'yt_session_cookies';
const SESSION_TTL = 60 * 60; // refresh session every 1 hour

// Single source-of-truth for every Google/YouTube domain family we proxy.
// Covers: video CDN, YouTube CDN edge, images, avatars, static assets,
// APIs, OAuth, ads. Add new TLDs here and they flow everywhere automatically.
const GOOGLE_FAMILY_RE = /(?:googlevideo|ytimg|ggpht|gstatic|googleapis|doubleclick)\.com$|(?:^|\.)(?:youtube|google|accounts\.google)\.com$/;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

// Rewrite any baked-in Google/YouTube URL in HTML/JS text responses so they
// go through our /__proxy/<host> tunnel instead of hitting the origin directly.
// IMPORTANT: Only rewrite https?:// prefixed URLs — NOT protocol-relative //
// URLs, which may appear inside JSON data blobs and config objects where they
// are not navigable URLs and rewriting them would corrupt the data.
function rewriteHosts(text) {
  return text.replace(
    /https?:\/\/([a-z0-9][a-z0-9\-\.]*\.(?:googlevideo|ytimg|ggpht|gstatic|googleapis|doubleclick)\.com|(?:[a-z0-9][a-z0-9\-]*\.)*(?:youtube|google)\.com)/g,
    (match, host) => {
      // Don't rewrite www.youtube.com — main page handled by route 2 directly.
      if (host === 'www.youtube.com') return match;
      return `/__proxy/${host}`;
    }
  );
}

/**
 * Fetch a fresh YouTube TV session and extract cookies.
 * Stores them in KV with a TTL so we don't hammer YouTube on every request.
 * Falls back to consent-only cookies on any network error so the worker
 * doesn't hard-crash when YouTube is slow or rate-limiting us.
 */
async function getSessionCookies(env, ctx) {
  // Try KV cache first
  if (env.YT_SESSION) {
    try {
      const cached = await env.YT_SESSION.get(SESSION_KV_KEY);
      if (cached) return cached;
    } catch (e) {
      console.warn('[session] KV read failed, falling back to live fetch:', e.message);
    }
  }

  // Consent-only fallback — returned immediately if the bootstrap fetch fails
  const FALLBACK = 'CONSENT=YES+; SOCS=CAESEwgDEgk0ODE3Nzk3MjkaAmVuIAEaBgiA_LysBg==';

  let cookieString = FALLBACK;
  try {
    // Bootstrap a fresh session
    const res = await fetch('https://www.youtube.com/tv', {
      headers: {
        'User-Agent': TV_UA,
        'Accept-Language': 'en-US,en;q=0.9',
        // Inject CONSENT cookie to skip GDPR/cookie-consent redirect
        'Cookie': FALLBACK,
      },
      redirect: 'follow',
    });

    // Collect Set-Cookie headers
    const setCookies = res.headers.getAll
      ? res.headers.getAll('set-cookie')          // Cloudflare Workers supports getAll
      : [res.headers.get('set-cookie')].filter(Boolean);

    // Parse into a single Cookie header string
    const cookieMap = {};

    // Seed with consent cookies first
    cookieMap['CONSENT'] = 'YES+';
    cookieMap['SOCS'] = 'CAESEwgDEgk0ODE3Nzk3MjkaAmVuIAEaBgiA_LysBg==';

    for (const raw of setCookies) {
      // Each raw value is like: "NAME=VALUE; Path=/; ..."
      const pair = raw.split(';')[0].trim();
      const eq = pair.indexOf('=');
      if (eq > 0) {
        const name = pair.slice(0, eq).trim();
        const val = pair.slice(eq + 1).trim();
        cookieMap[name] = val;
      }
    }

    cookieString = Object.entries(cookieMap)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');

    // Cache in KV — use ctx.waitUntil() so the KV write doesn't block the
    // response. The next request will benefit from the cached value.
    if (env.YT_SESSION && ctx) {
      ctx.waitUntil(
        env.YT_SESSION.put(SESSION_KV_KEY, cookieString, { expirationTtl: SESSION_TTL })
          .catch(e => console.warn('[session] KV write failed:', e.message))
      );
    }
  } catch (e) {
    console.error('[session] Bootstrap fetch failed, using consent-only fallback:', e.message);
  }

  return cookieString;
}

/**
 * Merge session cookies with any cookies already on the request.
 * Request cookies take priority (user may be logged in).
 */
function mergeCookies(sessionCookies, requestCookies) {
  if (!requestCookies) return sessionCookies;
  // Build map from session, then overlay request cookies
  const map = {};
  for (const part of sessionCookies.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k) map[k.trim()] = rest.join('=');
  }
  for (const part of requestCookies.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k) map[k.trim()] = rest.join('=');
  }
  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join('; ');
}

// Strip Cloudflare-injected and browser security headers before forwarding
// to YouTube. Sending these upstream triggers YouTube's bot-detection and
// returns 403s. None of them add value on the upstream side.
function cleanRequestHeaders(reqHeaders) {
  // sec-fetch-* reveal the request initiator context — TV clients don't send these
  reqHeaders.delete('sec-fetch-site');
  reqHeaders.delete('sec-fetch-mode');
  reqHeaders.delete('sec-fetch-dest');
  reqHeaders.delete('sec-fetch-user');
  // Cloudflare-specific headers — meaningless to YouTube, flag us as a proxy
  reqHeaders.delete('cf-connecting-ip');
  reqHeaders.delete('cf-ray');
  reqHeaders.delete('cf-visitor');
  reqHeaders.delete('cf-ipcountry');
  // Cache validators — strip so YouTube always sends fresh content through the proxy
  reqHeaders.delete('if-none-match');
  reqHeaders.delete('if-modified-since');
  // x-forwarded-for reveals the true client IP and triggers bot-detection 403s
  reqHeaders.delete('x-forwarded-for');
}

export default {
  async fetch(request, env, ctx) {
    // Top-level guard: catch any unhandled error so the user never sees a raw
    // stack trace. Errors are logged for `wrangler tail` inspection.
    try {
      return await handleRequest(request, env, ctx);
    } catch (e) {
      console.error('[worker] Unhandled error:', e.message, e.stack);
      return new Response(JSON.stringify({ error: 'Internal proxy error', detail: e.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }
  },

  // Stub for future cron-based session refresh (add a triggers.crons entry
  // in wrangler.toml to activate). Runs in the background without a request.
  async scheduled(event, env, ctx) {
    console.info('[scheduled] Session refresh triggered at', new Date().toISOString());
    // Force-invalidate the KV cache so the next request bootstraps a fresh session.
    if (env.YT_SESSION) {
      await env.YT_SESSION.delete(SESSION_KV_KEY)
        .catch(e => console.warn('[scheduled] KV delete failed:', e.message));
    }
  },
};

async function handleRequest(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // Get (or bootstrap) session cookies — pass ctx so KV write can be
    // deferred via ctx.waitUntil() without blocking the response.
    const sessionCookies = await getSessionCookies(env, ctx);

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
      for (const [k, v] of Object.entries(CORS)) h.set(k, v);
      return new Response(res.body, { status: res.status, headers: h });
    }

    // ── Service Worker — catch-all Google/YouTube family proxy ─────────────
    if (url.pathname === '/sw.js') {
      // GOOGLE_RE: matches every Google/YouTube CDN host family in one pattern.
      // Written as a string so it survives the template-literal → JS serialisation
      // without backslash mangling (same trick as the inline interceptor below).
      const GOOGLE_RE_SRC = String.raw`(?:googlevideo|ytimg|ggpht|gstatic|googleapis|doubleclick)\.com$|(?:^|\.)(?:youtube|google)\.com$`;
      const swCode = `
'use strict';
var GOOGLE_RE = new RegExp(${JSON.stringify(GOOGLE_RE_SRC)});
self.addEventListener('install', function(e){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function(event) {
  var dest = new URL(event.request.url);
  // Pass through requests already going to our own worker origin.
  if (dest.origin === self.location.origin) return;
  // Proxy every cross-origin Google/YouTube family request.
  if (GOOGLE_RE.test(dest.hostname)) {
    var proxied = self.location.origin + '/__proxy/' + dest.hostname + dest.pathname + dest.search;
    event.respondWith(
      fetch(proxied, {
        method: event.request.method,
        headers: event.request.headers,
        body: (event.request.method !== 'GET' && event.request.method !== 'HEAD')
          ? event.request.body : undefined,
        redirect: 'follow',
      })
    );
  }
});
`;
      return new Response(swCode, {
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Service-Worker-Allowed': '/',
          ...CORS
        }
      });
    }

    // ── 2. YouTube TV HTML — inject bundle + strip security headers ────────
    if (url.pathname === '/' || url.pathname === '/tv' || url.pathname.startsWith('/tv/')) {
      const ytUrl = new URL('https://www.youtube.com/tv');
      url.searchParams.forEach((v, k) => ytUrl.searchParams.set(k, v));

      const reqHeaders = new Headers(request.headers);
      reqHeaders.set('User-Agent', TV_UA);
      reqHeaders.delete('host');
      reqHeaders.set('cookie', mergeCookies(sessionCookies, request.headers.get('cookie')));
      reqHeaders.set('accept-language', 'en-US,en;q=0.9');
      cleanRequestHeaders(reqHeaders);

      const res = await fetch(ytUrl.toString(), { headers: reqHeaders });
      let html = await res.text();

      // Inject our bundle + an inline XHR/fetch monkey-patch.
      // Catches ALL cross-origin Google/YouTube family requests before the browser
      // blocks them — no per-host pattern needed, one broad regex covers everything.
      const WORKER_ORIGIN = url.origin;
      // GOOGLE_RE_SRC: serialised as a JSON string so backslashes survive the
      // template-literal → HTML → JS parser chain without double-evaluation.
      const GOOGLE_RE_SRC = String.raw`(?:googlevideo|ytimg|ggpht|gstatic|googleapis|doubleclick)\.com$|(?:^|\.)(?:youtube|google)\.com$`;
      const inlineInterceptor = `<script>
(function(){
  var WORKER = ${JSON.stringify(WORKER_ORIGIN)};
  // Matches every Google/YouTube CDN family — auto-covers new edge hostnames.
  var GOOGLE_RE = new RegExp(${JSON.stringify(GOOGLE_RE_SRC)});
  function isGoogleHost(url) {
    try { return GOOGLE_RE.test(new URL(url).hostname); } catch(e) { return false; }
  }

  function rewriteGV(url) {
    if (typeof url !== 'string' || !isGoogleHost(url)) return url;
    var host = new URL(url).hostname;
    // Don't double-proxy — if already pointing at our worker, pass through.
    if (url.startsWith(WORKER)) return url;
    return url.replace(/https?:\/\/[^/?#]+/, WORKER + '/__proxy/' + host);
  }

  // ── Patch fetch ──────────────────────────────────────────────────────────
  var _fetch = window.fetch;
  window.fetch = function(input, init) {
    var url = (typeof input === 'string') ? input : (input && input.url) || '';
    var rw = rewriteGV(url);
    if (rw !== url) {
      if (typeof input === 'string') input = rw;
      else if (input && input.url) input = new Request(rw, input);
    }
    return _fetch.call(this, input, init);
  };

  // ── Patch XHR prototype.open (catches new XHR() after this script) ───────
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    return _open.apply(this, [method, rewriteGV(url)].concat(
      Array.prototype.slice.call(arguments, 2)
    ));
  };

  // ── Patch XHR constructor (catches cached references taken before this) ──
  // The YouTube player stores: var XHR = window.XMLHttpRequest; early on.
  // Overriding the global constructor makes those cached refs go through our
  // patched prototype because they still share the same prototype chain.
  // Additional safety: wrap the constructor so any 'new XHR()' call from a
  // captured reference gets an object whose prototype.open is already patched.
  try {
    var _NativeXHR = window.XMLHttpRequest;
    var _PatchedXHR = function() { return new _NativeXHR(); };
    _PatchedXHR.prototype = _NativeXHR.prototype; // share prototype — patch above applies
    Object.defineProperty(window, 'XMLHttpRequest', {
      get: function() { return _PatchedXHR; },
      configurable: true,
    });
  } catch(e) {}
})();
<\/script>`;
      html = html.replace('<head>', '<head>' + inlineInterceptor + '<script src="/index.js"></script>');

      // Rewrite static host URLs
      html = rewriteHosts(html);

      // FIX: Also rewrite redirector.googlevideo.com inside ytInitialPlayerResponse
      // and ytcfg JSON blobs — the player reads these at runtime to build stream URLs
      html = html.replace(
        /"(?:redirectorUrl|basejsUrl|hlsvp|dashManifestUrl)":\s*"(https?:\/\/redirector\.googlevideo\.com[^"]+)"/g,
        (match, capturedUrl) => match.replace(capturedUrl, capturedUrl.replace('https://redirector.googlevideo.com', '/__proxy/redirector.googlevideo.com'))
      );

      const h = new Headers(res.headers);
      h.delete('content-security-policy');
      h.delete('content-security-policy-report-only');
      h.delete('x-frame-options');
      h.delete('content-encoding');
      h.delete('transfer-encoding');
      h.set('content-type', 'text/html; charset=utf-8');
      for (const [k, v] of Object.entries(CORS)) h.set(k, v);

      return new Response(html, { status: res.status, headers: h });
    }

    // ── 3. Sub-path proxy — /__proxy/<host>/path ───────────────────────────
    if (url.pathname.startsWith('/__proxy/')) {
      const rest = url.pathname.slice(9);
      const slash = rest.indexOf('/');
      const upHost = slash === -1 ? rest : rest.slice(0, slash);
      const upPath = slash === -1 ? '/' : rest.slice(slash);

      // Block unresolvable UUID-prefixed googlevideo subdomains
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/.test(upHost)) {
        return new Response(null, { status: 204, headers: CORS });
      }

      // Single regex allowlist — same source-of-truth as GOOGLE_FAMILY_RE above.
      const isAllowedHost = GOOGLE_FAMILY_RE.test(upHost);

      if (!isAllowedHost) {
        return new Response('Forbidden upstream host', { status: 403, headers: CORS });
      }

      const reqHeaders = new Headers(request.headers);
      reqHeaders.set('host', upHost);
      reqHeaders.set('cookie', mergeCookies(sessionCookies, request.headers.get('cookie')));
      reqHeaders.set('accept-language', 'en-US,en;q=0.9');

      if (request.method === 'POST') {
        const ct = request.headers.get('content-type');
        if (ct) reqHeaders.set('content-type', ct);
      }

      cleanRequestHeaders(reqHeaders);

      if (request.headers.has('origin')) {
        reqHeaders.set('origin', 'https://www.youtube.com');
      } else {
        reqHeaders.delete('origin');
      }
      if (request.headers.has('referer')) {
        reqHeaders.set('referer', 'https://www.youtube.com/tv');
      } else {
        reqHeaders.delete('referer');
      }

      const res = await fetch(`https://${upHost}${upPath}${url.search}`, {
        method: request.method,
        headers: reqHeaders,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
        redirect: 'follow',
      });

      const h = new Headers(res.headers);
      h.delete('content-security-policy');
      h.delete('content-security-policy-report-only');
      h.delete('x-frame-options');
      for (const [k, v] of Object.entries(CORS)) h.set(k, v);
      return new Response(res.body, { status: res.status, headers: h });
    }

    // ── 4. Everything else → proxy to youtube.com ─────────────────────────
    // FIX: OAuth device flow lives on oauth2.googleapis.com, not youtube.com
    const isOAuthPath = url.pathname.startsWith('/o/oauth2/') || 
                        url.pathname.startsWith('/oauth2/');
    const isInitPlayback = url.pathname.startsWith('/initplayback');

    const targetUrl = new URL(request.url);
    targetUrl.protocol = 'https:';
    
    if (isOAuthPath) {
      // /o/oauth2/device/code lives on accounts.google.com, not oauth2.googleapis.com
      // oauth2.googleapis.com uses /token and /revoke without the /o/ prefix
      targetUrl.hostname = url.pathname.startsWith('/o/oauth2/')
        ? 'accounts.google.com'
        : 'oauth2.googleapis.com';
    } else if (isInitPlayback) {
      targetUrl.hostname = 'redirector.googlevideo.com';
    } else {
      targetUrl.hostname = 'www.youtube.com';
    }
    targetUrl.port = '';

    const reqHeaders = new Headers(request.headers);
    reqHeaders.set('host', targetUrl.hostname);
    reqHeaders.set('cookie', mergeCookies(sessionCookies, request.headers.get('cookie')));
    reqHeaders.set('accept-language', 'en-US,en;q=0.9');

    if (request.method === 'POST') {
      const ct = request.headers.get('content-type');
      if (ct) reqHeaders.set('content-type', ct);
    }

    cleanRequestHeaders(reqHeaders);

    if (request.headers.has('origin')) {
      reqHeaders.set('origin', 'https://www.youtube.com');
    } else {
      reqHeaders.delete('origin');
    }
    if (request.headers.has('referer')) {
      reqHeaders.set('referer', 'https://www.youtube.com/tv');
    } else {
      reqHeaders.delete('referer');
    }

    const res = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: reqHeaders,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
      redirect: 'follow',
    });

    const contentType = res.headers.get('content-type') || '';
    const isText =
      contentType.includes('text/') ||
      contentType.includes('javascript') ||
      contentType.includes('json');

    if (isText && res.status === 200) {
      let text = await res.text();
      text = rewriteHosts(text);

      const finalHeaders = new Headers(res.headers);
      finalHeaders.delete('content-security-policy');
      finalHeaders.delete('content-security-policy-report-only');
      finalHeaders.delete('x-frame-options');
      finalHeaders.delete('content-encoding');
      finalHeaders.delete('transfer-encoding');
      finalHeaders.delete('cache-control');
      finalHeaders.delete('etag');
      finalHeaders.delete('last-modified');
      for (const [k, v] of Object.entries(CORS)) finalHeaders.set(k, v);

      return new Response(text, {
        status: res.status,
        statusText: res.statusText,
        headers: finalHeaders,
      });
    }

    const h = new Headers(res.headers);
    h.delete('content-security-policy');
    h.delete('content-security-policy-report-only');
    h.delete('x-frame-options');
    for (const [k, v] of Object.entries(CORS)) h.set(k, v);
    return new Response(res.body, { status: res.status, headers: h });
}