/**
 * Platform abstraction layer.
 * Provides a unified API so the rest of the codebase stays platform-agnostic.
 */

import { getDeviceInfo, isTitanOS, getPlatformVersion } from './titanos-utils.js';

// ─── Notifications ──────────────────────────────────────────────────────────

let toastContainer = null;

function ensureToastContainer() {
  if (toastContainer) return toastContainer;
  toastContainer = document.createElement('div');
  toastContainer.id = 'yt-titan-toast-container';
  Object.assign(toastContainer.style, {
    position: 'fixed',
    bottom: '80px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: '999999',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '8px',
    pointerEvents: 'none',
  });
  document.body.appendChild(toastContainer);
  return toastContainer;
}

/**
 * Show a toast notification on screen.
 */
export function showNotification(message, duration = 3000) {
  const container = ensureToastContainer();
  const toast = document.createElement('div');
  toast.textContent = message;
  Object.assign(toast.style, {
    background: 'rgba(0, 0, 0, 0.85)',
    color: '#fff',
    padding: '12px 24px',
    borderRadius: '8px',
    fontSize: '18px',
    fontFamily: 'YouTube Noto, Roboto, Arial, sans-serif',
    opacity: '0',
    transition: 'opacity 0.3s ease',
    maxWidth: '600px',
    textAlign: 'center',
  });
  container.appendChild(toast);

  // Fade in
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
  });

  // Fade out and remove
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, duration);
}

// ─── Screensaver / Wake Lock ────────────────────────────────────────────────

let wakeLock = null;

/**
 * Prevent the screen from dimming/screensaver activation.
 * Uses the Wake Lock API (supported in modern Chromium).
 */
export async function preventScreensaver() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        console.info('[Platform] Wake lock released');
      });
      console.info('[Platform] Wake lock acquired');
    }
  } catch (e) {
    console.warn('[Platform] Wake lock failed:', e);
  }
}

/**
 * Re-acquire wake lock after visibility change (tab/app switch).
 */
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && !wakeLock) {
    await preventScreensaver();
  }
});

// ─── Re-exports ─────────────────────────────────────────────────────────────

export { getDeviceInfo, isTitanOS, getPlatformVersion };
