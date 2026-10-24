import { getPlaybackAnalysisKey } from '../playbackRecovery/representationRegistry';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import {
    ENVELOPE_BANDS,
    ENVELOPE_COMPARE_WINDOW_SECONDS,
    type EnvelopeBand,
    type EnvelopeBandStats,
} from './envelopeAnalysis';

// src/services/audioEnvelope/liveAnalyserProbe.ts
// Diagnostic: prints the live analyser's band readout in the same shape as `[AudioEnvelope]`, so the
// two scales can be put side by side without needing a device that can do both at once.
//
// NOT WIRED. To use it, import `probeLiveAnalyserBands` in the live branch of
// components/app/playback/bridges/usePlaybackVisualizerBridge.ts and call it with the five raw band
// values and the element's `currentTime`; nothing else changes. While nothing imports it the bundle
// leaves it out, and it can only ever run where an analyser exists, so the envelope path pays
// nothing for it.
//
// Measured 2026-10-22 on `navidrome:cHHRTDMcWOeDOkintOBJxi`, first 60 s, Safari 18 live vs the
// iPhone's envelope, p50 per band: bass 220.9/216, lowMid 215.4/214, mid 183.3/182, vocal 154.8/152,
// treble 124.2/116. Everything inside ~3 bytes except treble's ~8 - the offline pass stops at
// 11 kHz (22.05 kHz Nyquist) where the analyser reaches 12. No calibration constant was changed:
// -100..-30 dB, /fftSize, Blackman and 0.6 smoothing reproduce WebKit's byte scale.
//
// What it measures is the raw band bytes the live path computes - before the `process()` curve -
// which is exactly what the envelope stores. Only the first ENVELOPE_COMPARE_WINDOW_SECONDS of the
// track are needed for the comparison, and those are accumulated separately, so one minute of
// desktop playback is enough; the whole-track figures come along for free if more is played.
//
// It only ever runs where an analyser exists (everywhere but iOS), so it costs the envelope path
// nothing.

/** One running line every this many seconds of the track, so a long session is readable. */
const LOG_EVERY_SECONDS = 30;

/** Bound on what is kept: ~7 minutes of frames at 60 Hz, per accumulator. */
const MAX_SAMPLES = 24000;

type BandValues = Record<EnvelopeBand, number>;
type BandSamples = Record<EnvelopeBand, number[]>;

const freshSamples = (): BandSamples => ENVELOPE_BANDS.reduce((all, band) => {
    all[band] = [];
    return all;
}, {} as BandSamples);

let currentKey: string | null = null;
let lastSong: unknown = null;
let played: BandSamples = freshSamples();
let opening: BandSamples = freshSamples();
/** Seconds of the track the `opening` samples actually cover, so the line never overstates it. */
let openingSeconds = 0;
let sampleCount = 0;
let nextLogAt = LOG_EVERY_SECONDS;
let reminded = false;

/** The analysis key of the track on screen; a changed song starts both accumulators over. */
const syncKey = (): string | null => {
    const song = usePlaybackStore.getState().currentSong;
    if (song === lastSong) return currentKey;
    lastSong = song;
    currentKey = song ? getPlaybackAnalysisKey(song) : null;
    played = freshSamples();
    opening = freshSamples();
    openingSeconds = 0;
    sampleCount = 0;
    nextLogAt = LOG_EVERY_SECONDS;
    return currentKey;
};

const statsOf = (values: number[]): EnvelopeBandStats => {
    if (values.length === 0) return { p50: 0, p90: 0, max: 0 };
    const sorted = [...values].sort((a, b) => a - b);
    const at = (fraction: number): number => {
        const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
        return sorted[index];
    };
    return { p50: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1] };
};

/** The same `band p50/p90/max, ...` text the envelope's line uses. */
const format = (samples: BandSamples): string => ENVELOPE_BANDS.map((band) => {
    const stats = statsOf(samples[band]);
    return `${band} ${stats.p50}/${stats.p90}/${stats.max}`;
}).join(', ');

/**
 * One frame of live band bytes. Cheap enough for the frame loop: five pushes and a counter.
 *
 * `trackTimeSeconds` is the element's own clock, so the opening window is the first minute of the
 * TRACK rather than the first minute of listening - which is what the envelope's window is.
 */
export const probeLiveAnalyserBands = (bands: BandValues, trackTimeSeconds: number): void => {
    if (!Number.isFinite(trackTimeSeconds)) return;
    const key = syncKey();
    if (!key) return;

    if (sampleCount < MAX_SAMPLES) {
        sampleCount += 1;
        const inOpeningWindow = trackTimeSeconds <= ENVELOPE_COMPARE_WINDOW_SECONDS;
        for (const band of ENVELOPE_BANDS) {
            played[band].push(bands[band]);
            if (inOpeningWindow) opening[band].push(bands[band]);
        }
        if (inOpeningWindow) openingSeconds = Math.max(openingSeconds, trackTimeSeconds);
    }

    if (trackTimeSeconds < nextLogAt) return;
    nextLogAt = trackTimeSeconds + LOG_EVERY_SECONDS;
    if (!reminded) {
        reminded = true;
        console.info('[LiveAnalyser] comparison needs volume 100%, equaliser and effects off, ReplayGain off:'
            + ' the analyser sits after all three, the envelope does not.');
    }
    console.info(`[LiveAnalyser] ${key}: played ${trackTimeSeconds.toFixed(1)}s, ${sampleCount} frames; p50/p90/max ${format(played)}`);
    if (opening[ENVELOPE_BANDS[0]].length > 0) {
        // The covered span, not the window's length: at the 30 s line only half of it is in hand.
        console.info(`[LiveAnalyser] ${key}: first ${openingSeconds.toFixed(0)}s p50/p90/max ${format(opening)}`);
    }
};
