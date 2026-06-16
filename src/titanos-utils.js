/**
 * TitanOS Platform Utilities
 * Wraps @titan-os/sdk for device info and platform detection.
 */

let cachedDeviceInfo = null;
let sdkAvailable = false;

/**
 * Attempt to load the Titan SDK. Gracefully degrades if not on TitanOS.
 */
async function initSDK() {
  try {
    const sdk = await import('@titan-os/sdk');
    sdkAvailable = true;
    return sdk;
  } catch {
    console.warn('[TitanOS] SDK not available — running in browser mode');
    return null;
  }
}

/**
 * Get device information from TitanOS.
 * Returns cached result on subsequent calls.
 */
export async function getDeviceInfo() {
  if (cachedDeviceInfo) return cachedDeviceInfo;

  const sdk = await initSDK();
  if (sdk?.DeviceInfo) {
    try {
      cachedDeviceInfo = await sdk.DeviceInfo.getDeviceInfo();
      console.info('[TitanOS] Device:', cachedDeviceInfo);
    } catch (e) {
      console.warn('[TitanOS] DeviceInfo failed:', e);
      cachedDeviceInfo = getFallbackDeviceInfo();
    }
  } else {
    cachedDeviceInfo = getFallbackDeviceInfo();
  }

  return cachedDeviceInfo;
}

function getFallbackDeviceInfo() {
  return {
    platform: 'browser',
    model: navigator.userAgent,
    firmwareVersion: 'unknown',
    isTitanOS: false,
  };
}

/**
 * Check if running on actual TitanOS hardware.
 */
export function isTitanOS() {
  // TitanOS user agents contain 'SmartTV' or 'Titan'
  const ua = navigator.userAgent;
  return sdkAvailable || /Titan|SmartTV/i.test(ua);
}

/**
 * Get the TitanOS platform version from the user agent or SDK.
 */
export function getPlatformVersion() {
  if (cachedDeviceInfo?.firmwareVersion) {
    return cachedDeviceInfo.firmwareVersion;
  }
  const match = navigator.userAgent.match(/TitanOS\/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}
