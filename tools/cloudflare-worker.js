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
const GOOGLE_FAMILY_RE = /(?:googlevideo|ytimg|ggpht|gstatic|googleapis)\.com$|doubleclick\.(?:com|net)$|(?:^|\.)(?:youtube|google|accounts\.google)\.com$/;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

function rewriteHosts(text, workerOrigin) {
  if (!workerOrigin) return text;
  return text.replace(
    /https?:\/\/([a-z0-9][a-z0-9\-\.]*\.(?:googlevideo|ytimg|ggpht|gstatic|googleapis)\.com|[a-z0-9][a-z0-9\-\.]*\.doubleclick\.(?:com|net)|(?:[a-z0-9][a-z0-9\-]*\.)*(?:youtube|google)\.com)/g,
    (match, host) => {
      if (host === 'www.youtube.com' || host === 'youtube.com') {
        return workerOrigin;
      }
      return `/__proxy/${host}`;
    }
  );
}

async function getSessionCookies(env, ctx) {
  if (env.YT_SESSION) {
    try {
      const cached = await env.YT_SESSION.get(SESSION_KV_KEY);
      if (cached) return cached;
    } catch (e) {
      console.warn('[session] KV read failed, falling back to live fetch:', e.message);
    }
  }

  const FALLBACK = 'CONSENT=YES+; SOCS=CAESEwgDEgk0ODE3Nzk3MjkaAmVuIAEaBgiA_LysBg==';

  let cookieString = FALLBACK;
  try {
    const res = await fetch('https://www.youtube.com/tv', {
      headers: {
        'User-Agent': TV_UA,
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie': FALLBACK,
      },
      redirect: 'follow',
    });

    const setCookies = res.headers.getAll
      ? res.headers.getAll('set-cookie')
      : [res.headers.get('set-cookie')].filter(Boolean);

    const cookieMap = {};
    cookieMap['CONSENT'] = 'YES+';
    cookieMap['SOCS'] = 'CAESEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg';

    for (const raw of setCookies) {
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

function mergeCookies(sessionCookies, requestCookies) {
  if (!requestCookies) return sessionCookies;
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

function cleanRequestHeaders(reqHeaders) {
  reqHeaders.delete('sec-fetch-site');
  reqHeaders.delete('sec-fetch-mode');
  reqHeaders.delete('sec-fetch-dest');
  reqHeaders.delete('sec-fetch-user');
  reqHeaders.delete('cf-connecting-ip');
  reqHeaders.delete('cf-ray');
  reqHeaders.delete('cf-visitor');
  reqHeaders.delete('cf-ipcountry');
  reqHeaders.delete('if-none-match');
  reqHeaders.delete('if-modified-since');
  reqHeaders.delete('x-forwarded-for');
}

export default {
  async fetch(request, env, ctx) {
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

  async scheduled(event, env, ctx) {
    console.info('[scheduled] Session refresh triggered at', new Date().toISOString());
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

    let reqBody = undefined;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      reqBody = await request.arrayBuffer();
      const isOAuth = url.pathname.includes('/oauth2/');
      if (isOAuth) {
        try {
          let bodyText = new TextDecoder().decode(reqBody);
          const targetClientId = env.CUSTOM_CLIENT_ID || '861556708454-d6dlm3lh05idd8npek18k6be8ba3oc68.apps.googleusercontent.com';
          const targetClientSecret = env.CUSTOM_CLIENT_SECRET || 'SboVhoG9s0rNafixCSGGKXAT';
          bodyText = bodyText.replace('861556708454-912i5jlic99ecvu3ro5kqirg0hldli5t.apps.googleusercontent.com', targetClientId);
          bodyText = bodyText.replace('861556708454-d6dlm3lh05idd8npek18k6be8ba3oc68.apps.googleusercontent.com', targetClientId);
          bodyText = bodyText.replace('ju2WuMJMOjilz_h_1dPgFdeU', targetClientSecret);
          bodyText = bodyText.replace('SboVhoG9s0rNafixCSGGKXAT', targetClientSecret);
          bodyText = bodyText.replace(/(\/\/__proxy\/gdata\.youtube\.com)/gi, 'http://gdata.youtube.com');
          bodyText = bodyText.replace(/\/__proxy\/([a-z0-9\-\.]+)/gi, 'https://$1');
          bodyText = bodyText.replace(/(%2[fF]__proxy%2[fF]gdata\.youtube\.com)/gi, 'http%3A%2F%2Fgdata.youtube.com');
          bodyText = bodyText.replace(/%2[fF]__proxy%2[fF]([a-z0-9\-\.]+)/gi, 'https%3A%2F%2F$1');
          reqBody = new TextEncoder().encode(bodyText);
        } catch (e) {
          console.error('[OAuth] Failed to rewrite credentials in request body:', e.message);
        }
      }
    }

    const sessionCookies = await getSessionCookies(env, ctx);

    // ── 1. Our built assets from GitHub Pages ──────────────────────────────
    if (
      url.pathname === '/index.js' ||
      url.pathname.endsWith('.index.js') ||
      url.pathname.startsWith('/assets/') ||
      url.pathname.endsWith('.css') ||
      url.pathname.endsWith('.js.map')
    ) {
      const res = await fetch(`${GH_PAGES_BASE}${url.pathname}${url.search}`);
      const h = new Headers(res.headers);
      for (const [k, v] of Object.entries(CORS)) h.set(k, v);
      return new Response(res.body, { status: res.status, headers: h });
    }

    // ── Service Worker ──────────────────────────────────────────────────────
    if (url.pathname === '/sw.js') {
      const GOOGLE_RE_SRC = String.raw`(?:googlevideo|ytimg|ggpht|gstatic|googleapis)\.com$|doubleclick\.(?:com|net)$|(?:^|\.)(?:youtube|google)\.com$`;
      const swCode = `
'use strict';
var GOOGLE_RE = new RegExp(${JSON.stringify(GOOGLE_RE_SRC)});
self.addEventListener('install', function(e){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function(event) {
  var dest = new URL(event.request.url);
  if (dest.origin === self.location.origin) return;
  if (GOOGLE_RE.test(dest.hostname)) {
    var proxied = self.location.origin + '/__proxy/' + dest.hostname + dest.pathname + dest.search;
    event.respondWith(
      fetch(proxied, {
        method: event.request.method,
        headers: event.request.headers,
        body: (event.request.method !== 'GET' && event.request.method !== 'HEAD')
          ? event.request.body : undefined,
        duplex: 'half',
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

    // ── 2. YouTube TV HTML — inject fixes + strip security headers ─────────
    const isYTPage =
      url.pathname === '/' ||
      url.pathname === '/tv' ||
      url.pathname.startsWith('/tv/') ||
      url.pathname.startsWith('/watch') ||
      url.pathname.startsWith('/shorts/') ||
      url.pathname.startsWith('/feed/') ||
      url.pathname.startsWith('/results') ||
      url.pathname.startsWith('/playlist') ||
      url.pathname.startsWith('/channel/') ||
      url.pathname.startsWith('/c/') ||
      url.pathname.startsWith('/@');

    if (isYTPage) {
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

      const WORKER_ORIGIN = url.origin;
      const GOOGLE_RE_SRC = String.raw`(?:googlevideo|ytimg|ggpht|gstatic|googleapis)\.com$|doubleclick\.(?:com|net)$|(?:^|\.)(?:youtube|google)\.com$`;

      const inlineInterceptor = `<script>
(function(){
  var WORKER = ${JSON.stringify(WORKER_ORIGIN)};
  var GOOGLE_RE = new RegExp(${JSON.stringify(GOOGLE_RE_SRC)});

  // ── FIX 1: Spoof window.location so YouTube's internal debug check sees
  // 'www.youtube.com' as the hostname. Without this, YouTube TV injects a red
  // "NO DEBUG ACCESS DOMAIN=<your-worker-url>" banner on every page load.
  try {
    var _realLocation = window.location;
    Object.defineProperty(window, 'location', {
      get: function() {
        return new Proxy(_realLocation, {
          get: function(target, prop) {
            if (prop === 'hostname' || prop === 'host') return 'www.youtube.com';
            if (prop === 'origin') return 'https://www.youtube.com';
            if (prop === 'href') return target.href.replace(WORKER, 'https://www.youtube.com');
            var val = target[prop];
            return (typeof val === 'function') ? val.bind(target) : val;
          }
        });
      },
      configurable: true,
    });
  } catch(e) { console.warn('[titanos] location spoof failed:', e); }

  function isGoogleHost(url) {
    try { return GOOGLE_RE.test(new URL(url).hostname); } catch(e) { return false; }
  }

  function rewriteGV(url) {
    if (typeof url !== 'string' || !isGoogleHost(url)) return url;
    var host = new URL(url).hostname;
    if (url.startsWith(WORKER)) return url;
    return url.replace(/https?:\/\/[^\/?#]+/, WORKER + '/__proxy/' + host);
  }

  function rewriteUrl(url) {
    if (typeof url !== 'string') return url;
    if (url.startsWith(WORKER)) return url;
    try {
      var u = new URL(url, window.location.href);
      if (u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com') {
        return WORKER + u.pathname + u.search + u.hash;
      }
    } catch(e) {}
    return url;
  }

  // ── Patch fetch ───────────────────────────────────────────────────────────
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

  // ── Patch XHR ─────────────────────────────────────────────────────────────
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    return _open.apply(this, [method, rewriteGV(url)].concat(
      Array.prototype.slice.call(arguments, 2)
    ));
  };
  try {
    var _NativeXHR = window.XMLHttpRequest;
    var _PatchedXHR = function() { return new _NativeXHR(); };
    _PatchedXHR.prototype = _NativeXHR.prototype;
    Object.defineProperty(window, 'XMLHttpRequest', {
      get: function() { return _PatchedXHR; },
      configurable: true,
    });
  } catch(e) {}

  // ── FIX 2: Block about:blank tab opens (TV browser video playback fix) ────
  // YouTube TV uses window.open('about:blank','_blank') as step 1 of a
  // two-phase video navigation. On a single-tab TV browser like Vewd this
  // creates a blank tab and kills the session. Return null to abort it.
  var _winOpen = window.open.bind(window);
  window.open = function(url, target, features) {
    // Block any call that would produce a blank/empty tab
    if (!url || url === 'about:blank' || url === 'about:newtab' || url === '') return null;
    url = rewriteUrl(url);
    if (target === '_self' || target === '_top' || target === '_parent') {
      return _winOpen(url, target, features);
    }
    // All other targets (_blank, named) → same-tab navigation
    window.location.href = url;
    return null;
  };

  // Strip target="_blank" from injected anchors via MutationObserver
  var _mo = new MutationObserver(function(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var nodes = mutations[i].addedNodes;
      for (var j = 0; j < nodes.length; j++) {
        var node = nodes[j];
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'A' && node.target) node.removeAttribute('target');
        var anchors = node.querySelectorAll ? node.querySelectorAll('a[target]') : [];
        for (var k = 0; k < anchors.length; k++) anchors[k].removeAttribute('target');
      }
    }
  });
  _mo.observe(document.documentElement || document, { childList: true, subtree: true });

  // Click capture — rewrite cross-origin YouTube links to go via Worker
  document.addEventListener('click', function(e) {
    var a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (!a) return;
    var t = a.getAttribute('target');
    if (t && (t === '_blank' || t === '_new')) a.removeAttribute('target');
    var href = a.getAttribute('href');
    if (!href) return;
    try {
      var u = new URL(a.href, window.location.href);
      if ((u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com') && !a.href.startsWith(WORKER)) {
        e.preventDefault();
        e.stopPropagation();
        window.location.href = WORKER + u.pathname + u.search + u.hash;
      }
    } catch(_) {}
  }, true);
})();
<\/script>
<style>
  /* FIX 3: Hide mouse cursor — TV is remote-controlled, no pointer needed.
     Using !important on every element overrides any YouTube TV inline style
     or specificity that might re-show the cursor on hover. */
  *, *::before, *::after { cursor: none !important; }
</style>`;

      html = html.replace('<head>', '<head>' + inlineInterceptor + '<script src="/index.js?v=9"><\/script>');

      html = rewriteHosts(html, WORKER_ORIGIN);

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
      h.delete('etag');
      h.delete('last-modified');
      h.set('content-type', 'text/html; charset=utf-8');
      h.set('cache-control', 'no-store, no-cache, must-revalidate, max-age=0');
      for (const [k, v] of Object.entries(CORS)) h.set(k, v);

      return new Response(html, { status: res.status, headers: h });
    }

    // ── 3. Sub-path proxy — /__proxy/<host>/path ───────────────────────────
    if (url.pathname.startsWith('/__proxy/')) {
      const rest = url.pathname.slice(9);
      const slash = rest.indexOf('/');
      const upHost = slash === -1 ? rest : rest.slice(0, slash);
      const upPath = slash === -1 ? '/' : rest.slice(slash);

      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/.test(upHost)) {
        return new Response(null, { status: 204, headers: CORS });
      }

      if (!GOOGLE_FAMILY_RE.test(upHost)) {
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

      reqHeaders.set('origin', 'https://www.youtube.com');
      reqHeaders.set('referer', 'https://www.youtube.com/tv');

      const res = await fetch(`https://${upHost}${upPath}${url.search}`, {
        method: request.method,
        headers: reqHeaders,
        body: reqBody,
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
    const isOAuthPath = url.pathname.startsWith('/o/oauth2/') ||
                        url.pathname.startsWith('/oauth2/');
    const isInitPlayback = url.pathname.startsWith('/initplayback');

    const targetUrl = new URL(request.url);
    targetUrl.protocol = 'https:';

    if (isOAuthPath) {
      if (reqBody) {
        try {
          const bodyText = new TextDecoder().decode(reqBody);
          console.log(`[OAuth-Proxy] Path: ${url.pathname}, Rewritten Body: ${bodyText}`);
        } catch (err) {
          console.error('[OAuth-Proxy] Failed to decode body:', err.message);
        }
      }
      targetUrl.hostname = 'www.youtube.com';
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

    reqHeaders.set('origin', 'https://www.youtube.com');
    reqHeaders.set('referer', 'https://www.youtube.com/tv');

    const res = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: reqHeaders,
      body: reqBody,
      redirect: 'follow',
    });

    const contentType = res.headers.get('content-type') || '';
    const isText =
      contentType.includes('text/') ||
      contentType.includes('javascript') ||
      contentType.includes('json');

    if (isText && res.status === 200) {
      let text = await res.text();
      text = rewriteHosts(text, url.origin);

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
