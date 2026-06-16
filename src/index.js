/**
 * YouTube for TitanOS — Entry Point
 *
 * Strategy: Register all hooks (fetch interception, XHR patching, DOM observers)
 * BEFORE redirecting to YouTube TV (youtube.com/tv). The hooks persist through
 * the navigation because they're registered on the window/document prototypes.
 *
 * This mirrors how youtube-webos works with its userScript.js injection, but
 * adapted for TitanOS where we don't have a special injection directory.
 */

import { preventScreensaver, showNotification, getDeviceInfo, isTitanOS } from './platform.js';
import { KEYS, onRemoteKey } from './remote-keys.js';

// ─── YouTube TV URL ─────────────────────────────────────────────────────────

const YT_TV_BASE = 'https://www.youtube.com/tv';

/**
 * Build the YouTube TV URL with appropriate query parameters.
 */
function buildYTUrl(launchParams = {}) {
  const params = new URLSearchParams();

  // Force Cobalt/leanback TV interface
  params.set('env_forceFullAnimation', '1');

  // If we have a video ID from deep link, include it
  if (launchParams.videoId) {
    params.set('v', launchParams.videoId);
  }

  // If we have a playlist
  if (launchParams.listId) {
    params.set('list', launchParams.listId);
  }

  const qs = params.toString();
  return qs ? `${YT_TV_BASE}?${qs}` : YT_TV_BASE;
}

/**
 * Extract launch parameters from the current URL.
 * TitanOS passes deep-link data as URL query parameters.
 */
function extractLaunchParams() {
  const url = new URL(window.location.href);
  return {
    videoId: url.searchParams.get('v') || url.searchParams.get('videoId') || null,
    listId: url.searchParams.get('list') || url.searchParams.get('listId') || null,
  };
}

// ─── Hook Registration ──────────────────────────────────────────────────────

/**
 * Pre-register all fetch/XHR interception hooks BEFORE navigating to YouTube TV.
 * These hooks survive the same-origin navigation because they modify prototypes.
 *
 * NOTE: This function imports modules that patch global objects (fetch, XHR).
 * The actual module code runs at import time via side effects.
 */
async function registerHooks() {
  // Ad blocking — patches fetch() and XMLHttpRequest
  await import('./adblock.js');

  // Config system — must load before UI
  await import('./config.js');

  // SponsorBlock — patches fetch for segment data
  await import('./sponsorblock.js');

  // Return YouTube Dislike — patches fetch for like/dislike data
  await import('./return-dislike.js');

  // Video quality enforcement
  await import('./video-quality.js');

  // Thumbnail quality upgrades
  await import('./thumbnail-quality.js');

  // UI overlay (settings panel, key bindings)
  await import('./ui.js');

  // YouTube-specific CSS/behavioral fixes
  await import('./yt-fixes.js');

  // Playback monitoring
  await import('./watch.js');

  console.info('[YT-TitanOS] All hooks registered');
}

// ─── Boot Sequence ──────────────────────────────────────────────────────────

async function boot() {
  console.info('[YT-TitanOS] Booting...');

  // 1. Get device info (async, non-blocking)
  getDeviceInfo().then((info) => {
    console.info('[YT-TitanOS] Running on:', info);
  });

  // 2. Prevent screensaver during video playback
  await preventScreensaver();

  // 3. Register all script hooks
  await registerHooks();

  // 4. Extract launch params
  const params = extractLaunchParams();
  console.info('[YT-TitanOS] Launch params:', params);

  // 5. Hide loading screen
  const loadingScreen = document.getElementById('loading-screen');
  if (loadingScreen) {
    loadingScreen.style.transition = 'opacity 0.3s ease';
    loadingScreen.style.opacity = '0';
    loadingScreen.addEventListener('transitionend', () => loadingScreen.remove(), { once: true });
  }

  // 6. Navigate to YouTube TV
  // We use location.replace so the user can't "back" into our loading screen
  const ytUrl = buildYTUrl(params);
  console.info('[YT-TitanOS] Navigating to:', ytUrl);

  // Small delay to ensure hooks are fully registered
  setTimeout(() => {
    window.location.replace(ytUrl);
  }, 100);
}

// ─── Start ──────────────────────────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
