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
 */

const GH_PAGES_BASE = 'https://Omaaar90.github.io/youtube-titanos';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Serve our local app assets (index.js, chunk files, css, assets/*) from GitHub Pages
    const isProjectAsset = 
      url.pathname === '/index.js' || 
      url.pathname.endsWith('.index.js') || 
      url.pathname.startsWith('/assets/') ||
      url.pathname.endsWith('.css') ||
      url.pathname.endsWith('.js.map');

    if (isProjectAsset) {
      const assetUrl = `${GH_PAGES_BASE}${url.pathname}`;
      const response = await fetch(assetUrl);
      
      // Return asset with correct headers
      const headers = new Headers(response.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      return new Response(response.body, {
        status: response.status,
        headers
      });
    }

    // 2. Serve YouTube TV HTML and inject our script
    if (url.pathname === '/' || url.pathname === '/tv' || url.pathname.startsWith('/tv/')) {
      const targetUrl = new URL('https://www.youtube.com/tv');
      url.searchParams.forEach((value, key) => targetUrl.searchParams.set(key, value));

      // Force TV User-Agent to avoid redirection
      const headers = new Headers(request.headers);
      headers.set('User-Agent', 'Mozilla/5.0 (WebOS; SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');

      const response = await fetch(targetUrl, { headers });
      let html = await response.text();

      // Inject our Webpack bundle into the head
      html = html.replace('<head>', '<head><script src="/index.js"></script>');

      // Remove Security Headers that prevent iframe embedding or script loading
      const newHeaders = new Headers(response.headers);
      newHeaders.delete('content-security-policy');
      newHeaders.delete('x-frame-options');
      newHeaders.set('Access-Control-Allow-Origin', '*');

      return new Response(html, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders
      });
    }

    // 3. Proxy all other assets and API requests to YouTube
    const targetUrl = new URL(request.url);
    targetUrl.hostname = 'www.youtube.com';

    const headers = new Headers(request.headers);
    // Ensure we keep the TV User-Agent for all sub-requests
    headers.set('User-Agent', 'Mozilla/5.0 (WebOS; SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');

    const response = await fetch(targetUrl, {
      method: request.method,
      headers: headers,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined
    });

    const newHeaders = new Headers(response.headers);
    newHeaders.set('Access-Control-Allow-Origin', '*');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders
    });
  }
};
