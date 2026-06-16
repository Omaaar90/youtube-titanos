/**
 * Remote control key mappings for TitanOS.
 * Based on https://docs.titanos.tv/remote-control
 *
 * TitanOS uses standard KeyboardEvent keyCodes.
 */

export const KEYS = {
  // D-pad
  UP: 38,
  DOWN: 40,
  LEFT: 37,
  RIGHT: 39,
  ENTER: 13,

  // Navigation
  BACK: 461,        // XF86Back
  BACKSPACE: 8,     // Fallback for Back

  // Channel
  CH_UP: 427,
  CH_DOWN: 428,

  // Colour buttons
  RED: 403,
  GREEN: 404,
  YELLOW: 405,
  BLUE: 406,

  // Media controls
  PLAY: 415,
  PAUSE: 19,
  STOP: 413,
  REWIND: 412,
  FAST_FORWARD: 417,

  // Numeric
  NUM_0: 48,
  NUM_1: 49,
  NUM_2: 50,
  NUM_3: 51,
  NUM_4: 52,
  NUM_5: 53,
  NUM_6: 54,
  NUM_7: 55,
  NUM_8: 56,
  NUM_9: 57,
};

/**
 * Check if a keydown event matches a specific remote key.
 */
export function isKey(event, keyName) {
  const code = KEYS[keyName];
  if (code === undefined) return false;

  // Handle BACK which can be either 461 or 8 (Backspace)
  if (keyName === 'BACK') {
    return event.keyCode === KEYS.BACK || event.keyCode === KEYS.BACKSPACE;
  }

  return event.keyCode === code;
}

/**
 * Register a global key handler for a specific remote key.
 * Returns an unsubscribe function.
 */
export function onRemoteKey(keyName, handler, options = {}) {
  const listener = (event) => {
    if (isKey(event, keyName)) {
      if (options.preventDefault) event.preventDefault();
      handler(event);
    }
  };
  document.addEventListener('keydown', listener);
  return () => document.removeEventListener('keydown', listener);
}
