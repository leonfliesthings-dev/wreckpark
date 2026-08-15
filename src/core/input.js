/**
 * Keyboard input. Tracks held keys plus one-frame "pressed" edges.
 * Everything the game asks for is expressed as an intent (throttle, steer…)
 * so remapping later is a one-line change.
 */

const HELD = new Set();
const PRESSED = new Set();
let enabled = true;

// Keys we never want to bubble up to the browser while driving.
const SWALLOW = new Set([
  'Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyR', 'KeyC', 'KeyT',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
  'AltLeft', 'AltRight', 'KeyX', 'KeyF', 'KeyG',
]);

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  if (enabled && SWALLOW.has(e.code)) e.preventDefault();
  HELD.add(e.code);
  PRESSED.add(e.code);
});

window.addEventListener('keyup', (e) => {
  HELD.delete(e.code);
  // macOS swallows keyup for other keys while CMD is down, which would leave
  // the throttle jammed on. Releasing CMD clears the lot.
  if (e.code === 'MetaLeft' || e.code === 'MetaRight') HELD.clear();
});

// Losing focus mid-drive should not leave the throttle pinned.
window.addEventListener('blur', () => HELD.clear());

export const Input = {
  setEnabled(v) { enabled = v; if (!v) HELD.clear(); },

  held: (code) => HELD.has(code),
  pressed: (code) => PRESSED.has(code),
  anyHeld: (...codes) => codes.some((c) => HELD.has(c)),

  /** Call at the very end of each frame. */
  endFrame() { PRESSED.clear(); },

  clear() { HELD.clear(); PRESSED.clear(); },

  /** Reads the driving intent for this frame. */
  sample() {
    const wUp = HELD.has('KeyW'), wDown = HELD.has('KeyS');
    const wLeft = HELD.has('KeyA'), wRight = HELD.has('KeyD');
    const aUp = HELD.has('ArrowUp'), aDown = HELD.has('ArrowDown');
    const aLeft = HELD.has('ArrowLeft'), aRight = HELD.has('ArrowRight');

    const up = wUp || aUp, down = wDown || aDown;
    const left = wLeft || aLeft, right = wRight || aRight;

    return {
      throttle: (up ? 1 : 0) - (down ? 1 : 0),      // +1 forward, -1 brake/reverse
      steer:    (left ? 1 : 0) - (right ? 1 : 0),   // +1 left  (matches Rapier steering sign)

      // On the ground the arrows are just another way to drive. In the air they
      // become a fine trim control at a fraction of the rotation rate, so you
      // can straighten the car up and actually land the trick instead of
      // over-rotating past it.
      airPitch: (wUp ? 1 : 0) - (wDown ? 1 : 0),
      airRoll:  (wLeft ? 1 : 0) - (wRight ? 1 : 0),
      trimPitch: (aUp ? 1 : 0) - (aDown ? 1 : 0),
      trimRoll:  (aLeft ? 1 : 0) - (aRight ? 1 : 0),
      yaw:      (HELD.has('KeyQ') ? 1 : 0) - (HELD.has('KeyE') ? 1 : 0),
      boost:    HELD.has('ShiftLeft') || HELD.has('ShiftRight'),

      // Handbrake sits on OPTION (right next to CMD), with CTRL and X as
      // alternatives. Deliberately NOT CMD: the browser owns CMD+W and CMD+Q,
      // so holding CMD and tapping throttle would close the tab mid-corner and
      // no web page is allowed to prevent that.
      handbrake: HELD.has('AltLeft') || HELD.has('AltRight')
              || HELD.has('ControlLeft') || HELD.has('ControlRight')
              || HELD.has('KeyX'),

      // SPACE jumps on the ground and flip-dashes in the air.
      jump:     PRESSED.has('Space'),
      dash:     PRESSED.has('Space'),
      jumpHeld: HELD.has('Space'),
      fire:     HELD.has('KeyF'),
      firePress:PRESSED.has('KeyF'),
      deploy:   PRESSED.has('KeyG'),
      reset:    PRESSED.has('KeyR'),
      camera:   PRESSED.has('KeyC'),
      scores:   HELD.has('Tab'),
    };
  },
};

export const NEUTRAL_INTENT = {
  throttle: 0, steer: 0, yaw: 0,
  airPitch: 0, airRoll: 0, trimPitch: 0, trimRoll: 0, boost: false, handbrake: false,
  dash: false, jump: false, jumpHeld: false, reset: false, camera: false, scores: false,
  fire: false, firePress: false, deploy: false,
};
