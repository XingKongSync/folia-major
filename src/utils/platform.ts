// src/utils/platform.ts
// One place to answer "is this a Mac" and "is this Windows", so keyboard handling, the shortcut
// hints the user reads and the places that offer a setting for one system can never disagree about
// it. Detection is by user agent because the renderer runs both in a browser and in Electron, and
// `window.electron?.platform` only exists in the latter.

export const isMacPlatform = typeof navigator !== 'undefined'
    && navigator.userAgent.toLowerCase().includes('mac');

/**
 * Whether this is Windows. Pausing for voice input is for the Windows desktop app only: the
 * settings window asks this before it offers the row, the settings search before it lists it, and
 * the command palette before it offers the command.
 */
export const runsOnWindows = (): boolean => (
    typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('win')
);

/**
 * The modifier a shortcut declared as `ctrl` actually uses here: Cmd on macOS, Ctrl elsewhere.
 * Shortcuts are declared once with `ctrl` and translated at the point of use, rather than each
 * declaration carrying a per-platform variant.
 */
export const isPrimaryModifierPressed = (event: KeyboardEvent): boolean => (
    isMacPlatform ? event.metaKey : event.ctrlKey
);

/** The modifier that must stay *up* for a primary-modifier shortcut to be unambiguous. */
export const isSecondaryModifierPressed = (event: KeyboardEvent): boolean => (
    isMacPlatform ? event.ctrlKey : event.metaKey
);

/** Label for the primary modifier, for shortcut hints shown in the UI. */
export const PRIMARY_MODIFIER_LABEL = isMacPlatform ? 'Cmd' : 'Ctrl';

/**
 * Whether this is iOS or iPadOS, in any browser - including one that rewrites its user agent.
 *
 * Every browser on iOS runs WebKit, so a Chrome or Firefox user agent there still means WebKit: the
 * question `canBuildPlaybackGraph` asks is about the engine, not about the brand in the user agent.
 *
 * Three signals, because a host app may present itself as something else entirely. A CarPlay
 * browser that opens the car screen for a web app is exactly that case: it ships a macOS Chrome
 * agent, which on an iPhone would otherwise read as "desktop" and put the playback graph back on
 * the one engine that cannot route it.
 *
 *  1. the agent names an iDevice;
 *  2. the agent says Macintosh while the device reports multi-touch - what iPadOS 13+ sends by
 *     default, and what a rewritten macOS agent looks like on a phone;
 *  3. the agent claims to be Chromium but the engine is not: Blink exposes `navigator.userAgentData`
 *     and `window.chrome`, WebKit exposes neither. This one does not look at the agent's brand at
 *     all, so it survives whichever desktop agent a host app picks.
 */
export const runsOnIosWebKit = (): boolean => {
    if (typeof navigator === 'undefined') return false;
    const agent = navigator.userAgent;
    const touchPoints = navigator.maxTouchPoints ?? 0;
    if (/iPad|iPhone|iPod/i.test(agent)) return true;
    if (/Macintosh/i.test(agent) && touchPoints > 1) return true;
    if (!/Chrome\/|Chromium\/|CriOS\/|Edg\//i.test(agent) || touchPoints <= 1) return false;
    const chromiumEngine = Boolean((navigator as Navigator & { userAgentData?: unknown }).userAgentData)
        || (typeof window !== 'undefined' && Boolean((window as Window & { chrome?: unknown }).chrome));
    return !chromiumEngine;
};

/**
 * Whether the Web Audio graph may be built on this machine.
 *
 * Not a preference: on iOS WebKit, `createMediaElementSource` cuts the media element off from an
 * external output route. Measured here on 2026-10-16 across three routes - the built-in speaker
 * plays the graph normally, AirPlay goes completely silent the moment the element is wired in, and
 * CarPlay plays about a second of the track and then goes silent. The graph itself is fine on both
 * external routes: a decoded `AudioBufferSourceNode` through the same `destination` is audible, and
 * an element that is never wired in is audible. Only the element's own feed into the graph fails.
 * `playbackRate` is 1 throughout (no `ratechange` fires), so this is not a speed problem, and both
 * sample rates fail, so it is not a format problem either. WebKit's own reports: 293891 (an element
 * goes silent once a source node is created) and 311000 (`preservesPitch` ignored under a context).
 *
 * The binding cannot be undone - a `MediaElementAudioSourceNode` may be created once per element
 * and disconnecting it only silences it - and it fails whichever route is current when it is made,
 * so "wire it up only on the speaker" is not an option: a track that starts on the speaker and
 * reaches the car goes silent there. The graph is therefore not built at all on iOS, and the
 * visualizer is driven by `services/audioEnvelope` instead of a live analyser.
 *
 * What is given up on iOS: the equaliser, the effect chain, automix's deck graph, and live FFT.
 * Volume is unaffected - `syncOutputGain` falls back to `element.volume`, the transport's fade
 * falls back to plain pause/play, and every other consumer already handles a null analyser.
 */
export const canBuildPlaybackGraph = (): boolean => {
    if (typeof window === 'undefined') return false;
    // The desktop app is Chromium, and it is where the equaliser, effects and automix actually run.
    if (Boolean((window as Window & { electron?: unknown }).electron)) return true;
    return !runsOnIosWebKit();
};
