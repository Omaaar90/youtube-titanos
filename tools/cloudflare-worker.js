/**
 * YouTube-TitanOS — Cloudflare Worker Reverse Proxy v6
 *
 * v6 changes:
 *  - FIXED: Strip is_account_switch=1, hrld=1, fltor=1 params before
 *           forwarding to YouTube TV — these caused an infinite reload loop.
 *  - FIXED: Forward Set-Cookie headers from YouTube auth responses back to
 *           the TV browser so the session cookie persists across navigations.
 *  - FIXED: Exclude /__log XHR responses from tvlog() to stop the recursive
 *           log storm that caused ~35ms polling loops flooding the log buffer.
 */

const GH_PAGES_BASE = 'https://Omaaar90.github.io/youtube-titanos';
const TV_UA = 'Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/5.0 TV Safari/538.1';
const SESSION_KV_KEY = 'yt_session_cookies';
const SESSION_TTL = 60 * 60;
const LOG_MAX = 200; // in-memory ring buffer size

// Params YouTube TV uses internally to trigger account-switch UI loops.
// We strip them before forwarding so YT boots cleanly.
const STRIP_PARAMS = ['is_account_switch', 'hrld', 'fltor'];

const GOOGLE_FAMILY_RE = /(?:googlevideo|ytimg|ggpht|gstatic|googleapis)\.com$|doubleclick\.(?:com|net)$|(?:^|\.)(?:youtube|google|accounts\.google)\.com$/;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

// ── In-memory ring buffer ────────────────────────────────────────────────────
const LOG_RING = [];

function ringPush(entry) {
  LOG_RING.push(entry);
  if (LOG_RING.length > LOG_MAX) LOG_RING.shift();
}

function trace(reqId, stage, data) {
  const entry = Object.assign({ reqId, stage, ts: Date.now() }, data);
  console.log('[trace]', JSON.stringify(entry));
  ringPush(entry);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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

/**
 * Forward Set-Cookie headers from a YouTube response back to the TV browser.
 * Rewrites the domain/path attributes so the cookie is set on our Worker
 * origin (yt.abduljawad.de) instead of .youtube.com, which the browser
 * would otherwise reject as a cross-origin cookie.
 */
function forwardSetCookies(upstreamHeaders, outHeaders, workerHostname) {
  const setCookies = upstreamHeaders.getAll
    ? upstreamHeaders.getAll('set-cookie')
    : [upstreamHeaders.get('set-cookie')].filter(Boolean);

  for (const raw of setCookies) {
    // Rewrite Domain= to our worker hostname and ensure SameSite=None; Secure
    // is NOT set (TV uses http://), so we strip Secure and SameSite.
    let rewritten = raw
      .replace(/;?\s*domain=[^;]*/gi, '')
      .replace(/;?\s*secure/gi, '')
      .replace(/;?\s*samesite=[^;]*/gi, '')
      .replace(/;?\s*partitioned/gi, '');
    rewritten += `; Domain=${workerHostname}; Path=/`;
    outHeaders.append('set-cookie', rewritten);
  }
}

// ── Main export ──────────────────────────────────────────────────────────────

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

// ── Request handler ──────────────────────────────────────────────────────────

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const reqId = Math.random().toString(36).slice(2, 10);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  // ── /__log  — browser telemetry endpoint ───────────────────────────────────
  if (url.pathname === '/__log') {
    if (request.method === 'POST') {
      try {
        const body = await request.json();
        const entry = Object.assign({ _src: 'browser', ts: Date.now() }, body);
        console.log('[browser]', JSON.stringify(entry));
        ringPush(entry);
      } catch (e) {
        // malformed — ignore silently
      }
      return new Response('ok', { status: 200, headers: CORS });
    }
    // GET — return ring buffer as pretty JSON
    const n = Math.min(parseInt(url.searchParams.get('n') || '100', 10), LOG_MAX);
    const slice = LOG_RING.slice(-n);
    return new Response(JSON.stringify(slice, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  }

  // ── Fast-path: youtubei/v1/* API calls ────────────────────────────────────
  if (url.pathname.startsWith('/youtubei/')) {
    const apiUrl = new URL(request.url);
    apiUrl.protocol = 'https:';
    apiUrl.hostname = 'www.youtube.com';
    apiUrl.port = '';

    let body = undefined;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      body = await request.arrayBuffer();
    }

    const reqHeaders = new Headers(request.headers);
    reqHeaders.set('host', 'www.youtube.com');
    reqHeaders.set('origin', 'https://www.youtube.com');
    reqHeaders.set('referer', 'https://www.youtube.com/tv');
    reqHeaders.delete('cf-connecting-ip');
    reqHeaders.delete('cf-ray');
    reqHeaders.delete('cf-visitor');
    reqHeaders.delete('cf-ipcountry');
    reqHeaders.delete('x-forwarded-for');

    trace(reqId, 'youtubei_req', { method: request.method, path: url.pathname, search: url.search });

    const res = await fetch(apiUrl.toString(), {
      method: request.method,
      headers: reqHeaders,
      body,
      redirect: 'follow',
    });

    trace(reqId, 'youtubei_res', {
      status: res.status,
      type: res.headers.get('content-type'),
      location: res.headers.get('location'),
    });

    const h = new Headers(res.headers);
    h.delete('content-security-policy');
    h.delete('content-security-policy-report-only');
    for (const [k, v] of Object.entries(CORS)) h.set(k, v);
    return new Response(res.body, { status: res.status, headers: h });
  }

  let reqBody = undefined;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    reqBody = await request.arrayBuffer();
    const isOAuth = url.pathname.includes('/oauth2/');
    if (isOAuth) {
      try {
        let bodyText = new TextDecoder().decode(reqBody);
        trace(reqId, 'oauth_body_in', { path: url.pathname, body: bodyText.slice(0, 300) });
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

  // ── 1. Our built assets from GitHub Pages ─────────────────────────────────
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

  // ── Service Worker ─────────────────────────────────────────────────────────
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

  // ── 2. YouTube TV HTML — inject fixes + tracing script ────────────────────
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
    trace(reqId, 'yt_page_req', { method: request.method, path: url.pathname, search: url.search });

    const ytUrl = new URL('https://www.youtube.com/tv');
    url.searchParams.forEach((v, k) => {
      // FIX 1: Strip params that cause YouTube TV to enter the account-switch
      // reload loop. When these are forwarded, YT keeps redirecting back to
      // itself with is_account_switch=1 forever, preventing any page from loading.
      if (!STRIP_PARAMS.includes(k)) {
        ytUrl.searchParams.set(k, v);
      } else {
        trace(reqId, 'stripped_param', { param: k, value: v });
      }
    });

    const reqHeaders = new Headers(request.headers);
    reqHeaders.set('User-Agent', TV_UA);
    reqHeaders.delete('host');
    reqHeaders.set('cookie', mergeCookies(sessionCookies, request.headers.get('cookie')));
    reqHeaders.set('accept-language', 'en-US,en;q=0.9');
    cleanRequestHeaders(reqHeaders);

    const res = await fetch(ytUrl.toString(), { headers: reqHeaders });
    let html = await res.text();

    trace(reqId, 'yt_page_res', {
      status: res.status,
      location: res.headers.get('location'),
      type: res.headers.get('content-type'),
    });

    const WORKER_ORIGIN = url.origin;
    const WORKER_HOSTNAME = url.hostname;
    const GOOGLE_RE_SRC = String.raw`(?:googlevideo|ytimg|ggpht|gstatic|googleapis)\.com$|doubleclick\.(?:com|net)$|(?:^|\.)(?:youtube|google)\.com$`;

    // ── Injected script (ES5, Vewd/Chromium 60 safe) ──────────────────────
    // FIX 3: tvlog() now skips logging for /__log XHR responses to prevent
    // the recursive storm where each log POST triggers another xhr_res event.
    const inlineInterceptor = '<script>\n' +
'(function(){\n' +
'  var WORKER = ' + JSON.stringify(WORKER_ORIGIN) + ';\n' +
'  var GOOGLE_RE = new RegExp(' + JSON.stringify(GOOGLE_RE_SRC) + ');\n' +
'  var _rl = window.location;\n' +
'\n' +
'  // ── Telemetry: POST events to /__log ──────────────────────────────────\n' +
'  function tvlog(type, payload) {\n' +
'    try {\n' +
'      var body = JSON.stringify({ type: type, payload: payload, href: _rl.href, ts: Date.now() });\n' +
'      var xhr = new XMLHttpRequest();\n' +
'      xhr.open("POST", WORKER + "/__log", true);\n' +
'      xhr.setRequestHeader("content-type", "application/json");\n' +
'      xhr.send(body);\n' +
'    } catch(e) {}\n' +
'  }\n' +
'\n' +
'  // ── URL helpers ───────────────────────────────────────────────────────\n' +
'  function isGoogleHost(u) {\n' +
'    try { return GOOGLE_RE.test(new URL(u).hostname); } catch(e) { return false; }\n' +
'  }\n' +
'\n' +
'  function rewriteGV(u) {\n' +
'    if (typeof u !== "string" || !isGoogleHost(u)) return u;\n' +
'    var host = new URL(u).hostname;\n' +
'    if (u.indexOf(WORKER) === 0) return u;\n' +
'    return u.replace(/https?:\\/\\/[^\\/?#]+/, WORKER + "/__proxy/" + host);\n' +
'  }\n' +
'\n' +
'  function rewriteUrl(u) {\n' +
'    if (typeof u !== "string") return u;\n' +
'    if (u.indexOf(WORKER) === 0) return u;\n' +
'    try {\n' +
'      var parsed = new URL(u, _rl.href);\n' +
'      if (parsed.hostname === "www.youtube.com" || parsed.hostname === "youtube.com") {\n' +
'        return WORKER + parsed.pathname + parsed.search + parsed.hash;\n' +
'      }\n' +
'    } catch(e) {}\n' +
'    return u;\n' +
'  }\n' +
'\n' +
'  function flagSpecial(u) {\n' +
'    if (!u) return;\n' +
'    var flags = [];\n' +
'    if (u.indexOf("account_switch") !== -1) flags.push("ACCOUNT_SWITCH");\n' +
'    if (u.indexOf("signin") !== -1 || u.indexOf("ServiceLogin") !== -1) flags.push("SIGNIN");\n' +
'    if (u.indexOf("videoplayback") !== -1) flags.push("MEDIA_STREAM");\n' +
'    if (u.indexOf("initplayback") !== -1) flags.push("INITPLAYBACK");\n' +
'    if (u.indexOf("/watch") !== -1) flags.push("WATCH");\n' +
'    if (flags.length) tvlog("special_url", { url: u, flags: flags });\n' +
'  }\n' +
'\n' +
'  // ── Patch fetch ───────────────────────────────────────────────────────\n' +
'  var _fetch = window.fetch;\n' +
'  window.fetch = function(input, init) {\n' +
'    var u = (typeof input === "string") ? input : (input && input.url) || "";\n' +
'    flagSpecial(u);\n' +
'    var rw = rewriteGV(u);\n' +
'    if (rw !== u) {\n' +
'      tvlog("fetch_rewrite", { from: u, to: rw });\n' +
'      if (typeof input === "string") input = rw;\n' +
'      else if (input && input.url) input = new Request(rw, input);\n' +
'    }\n' +
'    var p = _fetch.call(this, input, init);\n' +
'    p.then(function(r) {\n' +
'      tvlog("fetch_res", { url: u, status: r.status, type: r.headers.get("content-type") });\n' +
'    }).catch(function(err) {\n' +
'      tvlog("fetch_err", { url: u, error: String(err) });\n' +
'    });\n' +
'    return p;\n' +
'  };\n' +
'\n' +
'  // ── Patch XHR ────────────────────────────────────────────────────────\n' +
'  var _xhrOpen = XMLHttpRequest.prototype.open;\n' +
'  XMLHttpRequest.prototype.open = function(method, u) {\n' +
'    flagSpecial(u);\n' +
'    var rw = rewriteGV(u);\n' +
'    if (rw !== u) tvlog("xhr_rewrite", { from: u, to: rw });\n' +
'    return _xhrOpen.apply(this, [method, rw].concat(\n' +
'      Array.prototype.slice.call(arguments, 2)\n' +
'    ));\n' +
'  };\n' +
'\n' +
'  var _xhrSend = XMLHttpRequest.prototype.send;\n' +
'  XMLHttpRequest.prototype.send = function() {\n' +
'    var self = this;\n' +
'    self.addEventListener("load", function() {\n' +
'      // FIX 3: Skip logging /__log responses — logging them causes a recursive\n' +
'      // storm where every tvlog() POST fires another xhr_res, which fires another\n' +
'      // tvlog(), flooding the buffer with ~35ms interval /__log entries.\n' +
'      if (self.responseURL && self.responseURL.indexOf("/__log") !== -1) return;\n' +
'      tvlog("xhr_res", { status: self.status, url: self.responseURL });\n' +
'    });\n' +
'    self.addEventListener("error", function() {\n' +
'      if (self.responseURL && self.responseURL.indexOf("/__log") !== -1) return;\n' +
'      tvlog("xhr_err", { status: self.status, url: self.responseURL });\n' +
'    });\n' +
'    return _xhrSend.apply(this, arguments);\n' +
'  };\n' +
'\n' +
'  // ── Patch window.open ─────────────────────────────────────────────────\n' +
'  var _winOpen = window.open;\n' +
'  window.open = function(u, target, features) {\n' +
'    tvlog("window_open", { url: u || "(empty)", target: target || "(none)" });\n' +
'    if (!u || u === "about:blank" || u === "about:newtab" || u === "") return null;\n' +
'    flagSpecial(u);\n' +
'    u = rewriteUrl(u);\n' +
'    if (target === "_self" || target === "_top" || target === "_parent") {\n' +
'      return _winOpen.call(window, u, target, features);\n' +
'    }\n' +
'    _rl.href = u;\n' +
'    return null;\n' +
'  };\n' +
'\n' +
'  // ── MutationObserver: strip _blank from injected anchors ──────────────\n' +
'  var _mo = new MutationObserver(function(mutations) {\n' +
'    for (var i = 0; i < mutations.length; i++) {\n' +
'      var nodes = mutations[i].addedNodes;\n' +
'      for (var j = 0; j < nodes.length; j++) {\n' +
'        var node = nodes[j];\n' +
'        if (node.nodeType !== 1) continue;\n' +
'        if (node.tagName === "A" && node.target) node.removeAttribute("target");\n' +
'        var anchors = node.querySelectorAll ? node.querySelectorAll("a[target]") : [];\n' +
'        for (var k = 0; k < anchors.length; k++) anchors[k].removeAttribute("target");\n' +
'      }\n' +
'    }\n' +
'  });\n' +
'  _mo.observe(document.documentElement || document, { childList: true, subtree: true });\n' +
'\n' +
'  // ── Click capture: rewrite cross-origin YouTube links ─────────────────\n' +
'  document.addEventListener("click", function(e) {\n' +
'    var a = e.target && e.target.closest ? e.target.closest("a") : null;\n' +
'    if (!a) return;\n' +
'    var t = a.getAttribute("target");\n' +
'    if (t && (t === "_blank" || t === "_new")) a.removeAttribute("target");\n' +
'    var href = a.getAttribute("href");\n' +
'    if (!href) return;\n' +
'    tvlog("anchor_click", { href: a.href, target: a.target || null });\n' +
'    flagSpecial(a.href);\n' +
'    try {\n' +
'      var parsed = new URL(a.href, _rl.href);\n' +
'      if ((parsed.hostname === "www.youtube.com" || parsed.hostname === "youtube.com")\n' +
'          && a.href.indexOf(WORKER) !== 0) {\n' +
'        e.preventDefault();\n' +
'        e.stopPropagation();\n' +
'        _rl.href = WORKER + parsed.pathname + parsed.search + parsed.hash;\n' +
'      }\n' +
'    } catch(err) {}\n' +
'  }, true);\n' +
'\n' +
'  // ── <video> element events ────────────────────────────────────────────\n' +
'  var _vidMo = new MutationObserver(function(mutations) {\n' +
'    for (var i = 0; i < mutations.length; i++) {\n' +
'      var nodes = mutations[i].addedNodes;\n' +
'      for (var j = 0; j < nodes.length; j++) {\n' +
'        var node = nodes[j];\n' +
'        if (node.nodeType !== 1) continue;\n' +
'        var vids = [];\n' +
'        if (node.tagName === "VIDEO") vids.push(node);\n' +
'        var found = node.querySelectorAll ? node.querySelectorAll("video") : [];\n' +
'        for (var fi = 0; fi < found.length; fi++) vids.push(found[fi]);\n' +
'        for (var vi = 0; vi < vids.length; vi++) {\n' +
'          (function(vid) {\n' +
'            ["loadstart","loadedmetadata","canplay","stalled","waiting","error","abort","ended"].forEach(function(ev) {\n' +
'              vid.addEventListener(ev, function() {\n' +
'                var errCode = vid.error ? vid.error.code : null;\n' +
'                var errMsg  = vid.error ? vid.error.message : null;\n' +
'                tvlog("video_" + ev, {\n' +
'                  src: vid.currentSrc || vid.src || "(none)",\n' +
'                  readyState: vid.readyState,\n' +
'                  networkState: vid.networkState,\n' +
'                  errCode: errCode,\n' +
'                  errMsg: errMsg\n' +
'                });\n' +
'              });\n' +
'            });\n' +
'          })(vids[vi]);\n' +
'        }\n' +
'      }\n' +
'    }\n' +
'  });\n' +
'  _vidMo.observe(document.documentElement || document, { childList: true, subtree: true });\n' +
'\n' +
'  // ── Global error hooks ────────────────────────────────────────────────\n' +
'  window.onerror = function(msg, src, line, col, err) {\n' +
'    tvlog("js_error", { message: msg, source: src, line: line, col: col, stack: err ? String(err.stack) : null });\n' +
'    return false;\n' +
'  };\n' +
'\n' +
'  window.addEventListener("unhandledrejection", function(e) {\n' +
'    tvlog("promise_reject", { reason: String(e.reason) });\n' +
'  });\n' +
'\n' +
'  tvlog("boot", { userAgent: navigator.userAgent, href: _rl.href });\n' +
'\n' +
'})();\n' +
'<\/script>\n' +
'<style>\n' +
'  /* Hide cursor — TV is remote-controlled */\n' +
'  *, *::before, *::after { cursor: none !important; }\n' +
'<\/style>';

    html = html.replace('<head>', '<head>' + inlineInterceptor + '<script src="/index.js?v=10"><\/script>');

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

    // FIX 2: Forward Set-Cookie headers from YouTube's response back to the
    // TV browser, rewritten to our Worker domain. Without this the TV browser
    // never receives auth cookies (LOGIN, SID, SSID, etc.) and every page load
    // looks like an unauthenticated session, triggering is_account_switch again.
    forwardSetCookies(res.headers, h, WORKER_HOSTNAME);

    return new Response(html, { status: res.status, headers: h });
  }

  // ── 3. Sub-path proxy — /__proxy/<host>/path ──────────────────────────────
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

    const isMedia = upPath.includes('videoplayback') || upHost.includes('googlevideo');
    trace(reqId, 'proxy_req', {
      method: request.method,
      upstream: upHost,
      path: upPath,
      search: url.search,
      range: request.headers.get('range'),
      isMedia,
    });

    const res = await fetch(`https://${upHost}${upPath}${url.search}`, {
      method: request.method,
      headers: reqHeaders,
      body: reqBody,
      redirect: 'follow',
    });

    trace(reqId, 'proxy_res', {
      status: res.status,
      upstream: upHost,
      location: res.headers.get('location'),
      type: res.headers.get('content-type'),
      contentRange: res.headers.get('content-range'),
      isMedia,
    });

    const h = new Headers(res.headers);
    h.delete('content-security-policy');
    h.delete('content-security-policy-report-only');
    h.delete('x-frame-options');
    for (const [k, v] of Object.entries(CORS)) h.set(k, v);

    // Also forward auth cookies from proxied Google/accounts responses
    if (upHost.includes('accounts.google') || upHost.includes('google.com')) {
      forwardSetCookies(res.headers, h, url.hostname);
    }

    return new Response(res.body, { status: res.status, headers: h });
  }

  // ── 4. Everything else → proxy to youtube.com ─────────────────────────────
  const isOAuthPath = url.pathname.startsWith('/o/oauth2/') ||
                      url.pathname.startsWith('/oauth2/');
  const isInitPlayback = url.pathname.startsWith('/initplayback');

  const targetUrl = new URL(request.url);
  targetUrl.protocol = 'https:';

  if (isOAuthPath) {
    targetUrl.hostname = 'www.youtube.com';
  } else if (isInitPlayback) {
    targetUrl.hostname = 'redirector.googlevideo.com';
  } else {
    targetUrl.hostname = 'www.youtube.com';
  }
  targetUrl.port = '';

  trace(reqId, 'fallback_req', {
    method: request.method,
    path: url.pathname,
    search: url.search,
    upstream: targetUrl.hostname,
    isOAuth: isOAuthPath,
    isInitPlayback,
  });

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

  trace(reqId, 'fallback_res', {
    status: res.status,
    location: res.headers.get('location'),
    type: res.headers.get('content-type'),
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

    // Forward auth cookies on fallback text responses too (OAuth flows)
    forwardSetCookies(res.headers, finalHeaders, url.hostname);

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
