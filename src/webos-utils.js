export let simulatorMode = false;

export function getWebOSVersion() {
  // Return a high version to bypass legacy/ancient webOS compatibility checks
  return 99;
}

export function isWebOS25() {
  return false;
}

export function isLegacyWebOS() {
  return false;
}
