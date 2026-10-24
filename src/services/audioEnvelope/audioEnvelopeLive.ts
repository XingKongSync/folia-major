import { readEnvelopeFrame, type AudioEnvelope } from './envelopeAnalysis';

// src/services/audioEnvelope/audioEnvelopeLive.ts
// The envelope of the track on screen, for the frame loop to read.
//
// Kept out of React on purpose: the visualizer's loop asks for one frame of it per animation frame,
// and re-rendering for that would be a render per frame. What React carries is only "this track's
// envelope is ready" - the value itself is read straight from here, the way the beat clock is read
// from services/beatFx/beatFxLive.

let currentKey: string | null = null;
let currentEnvelope: AudioEnvelope | null = null;

/** Makes an analysed track's envelope the one the frame loop reads. */
export const setLiveAudioEnvelope = (key: string, envelope: AudioEnvelope): void => {
    currentKey = key;
    currentEnvelope = envelope;
};

/** Drops the envelope, or only the one `key` names - a stale load must not clear a newer track's. */
export const clearLiveAudioEnvelope = (key?: string): void => {
    if (key !== undefined && key !== currentKey) return;
    currentKey = null;
    currentEnvelope = null;
};

/** Whether a track's envelope is in hand; false while it is still being analysed. */
export const hasLiveAudioEnvelope = (): boolean => currentEnvelope !== null;

/** One frame at `timeSeconds`, in the live analyser's scale; null when no envelope is ready. */
export const readLiveEnvelopeFrame = (timeSeconds: number) => (
    currentEnvelope ? readEnvelopeFrame(currentEnvelope, timeSeconds) : null
);
