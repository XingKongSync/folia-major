// src/utils/mobileViewport.ts
// Two iOS Safari behaviours that fight a full-screen player, and have to be turned off in the page.
//
// 1. Two-finger pinch zooms the page. In a player there is nothing to read at 2x, and on a car
//    screen the gesture is easy to trigger by accident and impossible to spot until the layout has
//    already moved. Safari's own `gesturestart` / `gesturechange` / `gestureend` events are the only
//    reliable way to stop it: the viewport's `user-scalable=no` has been ignored since iOS 10.
//    These events are WebKit's alone, so nothing here runs on a desktop browser - and on macOS
//    Safari, where they do fire, losing pinch is the same trade.
//
// 2. A control whose font-size is under 16px zooms the page when it takes focus, and the page stays
//    zoomed after the keyboard closes. That one is fixed in CSS (index.css), not here, because it
//    has to match the control rather than the gesture.

const PINCH_GESTURES = ['gesturestart', 'gesturechange', 'gestureend'];

let installed = false;

/** Blocks Safari's pinch-zoom gestures for the life of the document. Safe to call more than once. */
export const installPinchZoomGuard = (): void => {
    if (installed || typeof document === 'undefined') return;
    installed = true;
    const block = (event: Event) => event.preventDefault();
    for (const type of PINCH_GESTURES) {
        // Not passive: the listener exists only to cancel the gesture.
        document.addEventListener(type, block, { passive: false });
    }
};
