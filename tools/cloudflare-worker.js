/**
 * YouTube-TitanOS — Cloudflare Worker Reverse Proxy v3
 *
 * Changes from v2:
 *  - KV-backed session cookie bootstrapping to fix /youtubei/v1/ 403s
 *  - Player config JSON rewriting to fix redirector.googlevideo.com CORS
 *  - Consent cookie injection to bypass GDPR redirect loops
 */

const GH_PAGES_BASE = 'https://Omaaar90.github.io/youtube-titanos';
const TV_UA = 'Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/5.0 TV Safari/538.1';
const SESSION_KV_KEY = 'yt_session_cookies';
const SESSION_TTL = 60 * 60; // refresh session every 1 hour

const REWRITE_HOSTS = [
  'www.gstatic.com',
  'fonts.gstatic.com',
  'clients1.google.com',
  'suggestqueries.google.com',
  'jnn-pa.googleapis.com',
  'www.googleapis.com',
  'oauth2.googleapis.com',
  'redirector.googlevideo.com',
  'static.doubleclick.net',
  'eligibility-panelresearch.googlevideo.com',
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

function buildRewriteRegex(host) {
  return new RegExp(
    `(?:https?:)?(?:/|\\\\/){2}${host.replace(/\./g, '\\.')}`,
    'g'
  );
}

function rewriteHosts(text) {
  for (const host of REWRITE_HOSTS) {
    text = text.replace(buildRewriteRegex(host), `/__proxy/${host}`);
  }
  return text;
}

/**
 * Fetch a fresh YouTube TV session and extract cookies.
 * Stores them in KV with a TTL so we don't hammer YouTube on every request.
 */
async function getSessionCookies(env) {
  // Try KV cache first
  if (env.YT_SESSION) {
    const cached = await env.YT_SESSION.get(SESSION_KV_KEY);
    if (cached) return cached;
  }

  // Bootstrap a fresh session
  const res = await fetch('https://www.youtube.com/tv', {
    headers: {
      'User-Agent': TV_UA,
      'Accept-Language': 'en-US,en;q=0.9',
      // Inject CONSENT cookie to skip GDPR/cookie-consent redirect
      'Cookie': 'CONSENT=YES+; SOCS=CAESEwgDEgk0ODE3Nzk3MjkaAmVuIAEaBgiA_LysBg==',
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

  const cookieString = Object.entries(cookieMap)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

  // Cache in KV
  if (env.YT_SESSION) {
    await env.YT_SESSION.put(SESSION_KV_KEY, cookieString, { expirationTtl: SESSION_TTL });
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
  reqHeaders.delete('x-forwarded-for'); // Do NOT forward x-forwarded-for — causes bot-detection 403s
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // Get (or bootstrap) session cookies — do this early for all routes
    const sessionCookies = await getSessionCookies(env);

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

    // ── Service Worker for Network-Level Interceptions ──────────────────
    if (url.pathname === '/sw.js') {
      const swCode = `
        self.addEventListener('install', (event) => {
          self.skipWaiting();
        });
        self.addEventListener('activate', (event) => {
          event.waitUntil(clients.claim());
        });
        self.addEventListener('fetch', (event) => {
          const url = event.request.url;
          
          // Intercept redirector.googlevideo.com requests
          if (url.includes('redirector.googlevideo.com')) {
            const proxied = url.replace(
              /https?:\\/\\/redirector\\.googlevideo\\.com/,
              self.location.origin + '/__proxy/redirector.googlevideo.com'
            );
            event.respondWith(
              fetch(proxied, {
                method: event.request.method,
                headers: event.request.headers,
                body: event.request.method !== 'GET' && event.request.method !== 'HEAD'
                  ? event.request.body : undefined,
                redirect: 'follow',
              })
            );
            return;
          }

          // Intercept *.googlevideo.com CDN nodes (rr*.googlevideo.com)
          const googlevideoMatch = url.match(/https?:\\/\\/([a-z0-9-]+\\.googlevideo\\.com)/);
          if (googlevideoMatch) {
            const host = googlevideoMatch[1];
            const proxied = url.replace(
              new RegExp('https?:\\\\/\\\\/' + host.replace(/\\./g, '\\\\.')),
              self.location.origin + '/__proxy/' + host
            );
            event.respondWith(
              fetch(proxied, {
                method: event.request.method,
                headers: event.request.headers,
                body: event.request.method !== 'GET' && event.request.method !== 'HEAD'
                  ? event.request.body : undefined,
                redirect: 'follow',
              })
            );
            return;
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

      html = html.replace('<head>', '<head><script src="/index.js"></script>');

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

      const isAllowedHost =
        REWRITE_HOSTS.includes(upHost) ||
        upHost.endsWith('.googlevideo.com') ||
        upHost.endsWith('.googleapis.com') ||
        upHost.endsWith('.gstatic.com') ||
        upHost.endsWith('.google.com') ||
        upHost.endsWith('.doubleclick.net') ||
        upHost === 'www.youtube.com';

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
      targetUrl.hostname = 'oauth2.googleapis.com';
      targetUrl.pathname = url.pathname.replace(/^\/o\/oauth2/, '/oauth2');
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
  },
};