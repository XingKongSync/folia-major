import { fft } from '../automix/signalAnalysis';

// src/services/audioEnvelope/envelopeAnalysis.ts
// A decoded track turned into the five band envelopes the visualizer reads.
//
// Why this exists: on iOS WebKit the media element cannot be wired into a Web Audio graph without
// losing an external output route (utils/platform.ts, `canBuildPlaybackGraph`), so there is no live
// analyser there and `components/app/playback/bridges/usePlaybackVisualizerBridge.ts` would fall
// through to its idle "breath" forever. The visualizer never actually needs the analyser, though:
// every mode reads the same five numbers plus a spectrum, all written by that one bridge. Those
// numbers can come from a pass over the track instead of from a tap on the element, which is what
// this file computes.
//
// The numbers are deliberately produced in the analyser's own scale (0..255 per frame, per band),
// not in some nicer unit: the consumer then applies exactly the same `process(value, boost)` curve
// it applies to live bytes, so the two paths differ only in where the bytes came from.
//
// Matching the live analyser
// --------------------------
// The live path runs an AnalyserNode at the output rate with fftSize 2048, then maps each band's
// bins with `Math.floor(hz / 21.5)` (usePlaybackVisualizerBridge.ts). 21.5 Hz is 44100/2048. This
// pass runs at ENVELOPE_SAMPLE_RATE with FFT_SIZE 1024, which is 22050/1024 = 21.53 Hz - the same
// bin width, so the band index maths is the same expression and needs no rescaling. The consequence
// is that the offline spectrum stops at the 11 kHz Nyquist, so the treble band is measured over
// 3.5-11 kHz instead of 3.5-12 kHz. That is the one band whose measurement differs.
//
// The magnitude convention is `hypot(re, im) / fftSize` in dB against the analyser's own
// MIN_DB..MAX_DB range, with the node's SMOOTHING applied per bin in the linear domain (the spec's
// one-pole, in the order the spec states it: smooth the magnitude, then convert). This is the
// convention that leaves room above a dense mix: music's per-bin magnitudes sit far below a tone's,
// which is why the live bytes are not pinned at 255.
//
// Calibration: the constants below are the only knob. If the visuals read too flat or sit pinned at
// the top on a real track, `stats` says which way to move them - it is the same readout the live
// path's values would give, so one comparison against a speaker session pins the offset.

/** The rate this pass decodes and analyses at: half the CD rate, and the low end `decodeAtRate` wants. */
export const ENVELOPE_SAMPLE_RATE = 22050;

/** Bin width here is 22050/1024 = 21.53 Hz, the 21.5 the live bridge divides by. */
const FFT_SIZE = 1024;
const BIN_COUNT = FFT_SIZE / 2;

/** 512 samples at 22.05 kHz: one frame per 23.2 ms of the track. */
const HOP = 512;

/** The analyser node's own default, and what usePlaybackAudioBridge sets on the live node. */
const SMOOTHING = 0.6;

const MIN_DB = -100;
const MAX_DB = -30;

/** The live bridge's ranges, in Hz. Treble is clamped to Nyquist by `bandBins`. */
const BAND_HZ = {
    bass: [20, 150],
    lowMid: [150, 400],
    mid: [400, 1200],
    vocal: [1000, 3500],
    treble: [3500, 12000],
} as const;

export type EnvelopeBand = keyof typeof BAND_HZ;

export const ENVELOPE_BANDS: readonly EnvelopeBand[] = ['bass', 'lowMid', 'mid', 'vocal', 'treble'];

/**
 * The slice the live-analyser comparison is taken over: the track's first minute.
 *
 * A percentile over a whole track cannot be checked against a desktop session unless the whole
 * track was played, which is a lot to ask for one number. Both sides therefore also report this
 * window, so one minute of playback settles it - and a whole-track run still gives the stronger
 * comparison. Device-independent: this pass always runs at ENVELOPE_SAMPLE_RATE.
 */
export const ENVELOPE_COMPARE_WINDOW_SECONDS = 60;

/** One entry per frame, in the analyser's 0..255 scale. */
export type EnvelopeBands = Record<EnvelopeBand, Uint8Array>;

export interface EnvelopeBandStats {
    /** Median of the band over the track, 0..255. */
    p50: number;
    /** 90th percentile, 0..255. */
    p90: number;
    max: number;
}

export interface AudioEnvelope {
    /** Seconds of track one frame covers. */
    frameSeconds: number;
    /** Number of frames; all band arrays are this long. */
    frames: number;
    /** Seconds of audio actually covered (may trail the track's tail by under one frame). */
    durationSeconds: number;
    bands: EnvelopeBands;
    /** Per band, so a scale that reads wrong can be recognised from a log rather than by eye. */
    stats: Record<EnvelopeBand, EnvelopeBandStats>;
    /** The same readout over the track's first ENVELOPE_COMPARE_WINDOW_SECONDS only. */
    statsFirstWindow: Record<EnvelopeBand, EnvelopeBandStats>;
    /** Seconds of audio `statsFirstWindow` actually covers (shorter for a very short track). */
    firstWindowSeconds: number;
}

/** The Blackman window the analyser applies before its FFT. */
const blackman = (size: number): Float64Array => {
    const window = new Float64Array(size);
    for (let index = 0; index < size; index += 1) {
        const x = (2 * Math.PI * index) / (size - 1);
        window[index] = 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x);
    }
    return window;
};

/** The bin range a band covers, clamped to the bins this rate actually resolves. */
const bandBins = (sampleRate: number, [lowHz, highHz]: readonly [number, number]): [number, number] => {
    const binHz = sampleRate / FFT_SIZE;
    const low = Math.max(0, Math.floor(lowHz / binHz));
    const high = Math.min(BIN_COUNT - 1, Math.floor(highHz / binHz));
    return [low, Math.max(low, high)];
};

/** One linear magnitude to the analyser's byte scale. */
const toByte = (magnitude: number): number => {
    if (!(magnitude > 0)) return 0;
    const db = 20 * Math.log10(magnitude);
    const scaled = ((db - MIN_DB) / (MAX_DB - MIN_DB)) * 255;
    if (!(scaled > 0)) return 0;
    return scaled >= 255 ? 255 : Math.round(scaled);
};

/** Sorted percentile of a byte array, copied so the caller's array keeps its order. */
const percentile = (values: Uint8Array, fraction: number): number => {
    if (values.length === 0) return 0;
    const sorted = Uint8Array.from(values).sort();
    const at = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
    return sorted[at];
};

const summarise = (values: Uint8Array): EnvelopeBandStats => {
    let max = 0;
    for (let index = 0; index < values.length; index += 1) {
        if (values[index] > max) max = values[index];
    }
    return { p50: percentile(values, 0.5), p90: percentile(values, 0.9), max };
};

/** Frames per yield: short enough that a pass never blocks a frame for long. */
const FRAMES_PER_YIELD = 512;

/**
 * Analyses `mono` into band envelopes.
 *
 * `sampleRate` is the rate `mono` was decoded at; anything but ENVELOPE_SAMPLE_RATE still works but
 * the bin width no longer matches the live bridge's 21.5 Hz assumption.
 */
export const analyseAudioEnvelope = async (
    mono: Float32Array,
    sampleRate: number,
): Promise<AudioEnvelope> => {
    const frameSeconds = HOP / sampleRate;
    const frames = mono.length >= FFT_SIZE ? Math.floor((mono.length - FFT_SIZE) / HOP) + 1 : 0;

    const bands = ENVELOPE_BANDS.reduce((all, band) => {
        all[band] = new Uint8Array(frames);
        return all;
    }, {} as EnvelopeBands);

    const ranges = ENVELOPE_BANDS.map(band => bandBins(sampleRate, BAND_HZ[band] as unknown as readonly [number, number]));

    const window = blackman(FFT_SIZE);
    const real = new Float64Array(FFT_SIZE);
    const imag = new Float64Array(FFT_SIZE);
    // The analyser smooths per bin and holds that state across calls; the same one-pole here, so a
    // frame's value accounts for the frames before it exactly as the live node's would.
    const smoothed = new Float64Array(BIN_COUNT);
    const bins = new Uint8Array(BIN_COUNT);

    for (let frame = 0; frame < frames; frame += 1) {
        const start = frame * HOP;
        for (let index = 0; index < FFT_SIZE; index += 1) {
            real[index] = (mono[start + index] ?? 0) * window[index];
            imag[index] = 0;
        }
        fft(real, imag);

        for (let bin = 0; bin < BIN_COUNT; bin += 1) {
            // Divided by the transform length: the convention that leaves a dense mix inside the
            // analyser's -100..-30 window instead of pinning every bin above -30.
            const magnitude = Math.hypot(real[bin], imag[bin]) / FFT_SIZE;
            const next = SMOOTHING * smoothed[bin] + (1 - SMOOTHING) * magnitude;
            smoothed[bin] = next;
            bins[bin] = toByte(next);
        }

        for (let band = 0; band < ranges.length; band += 1) {
            const [low, high] = ranges[band];
            let sum = 0;
            for (let bin = low; bin <= high; bin += 1) sum += bins[bin];
            bands[ENVELOPE_BANDS[band]][frame] = Math.round(sum / (high - low + 1));
        }

        if (frame > 0 && frame % FRAMES_PER_YIELD === 0) {
            await new Promise<void>(resolve => { setTimeout(resolve, 0); });
        }
    }

    const stats = ENVELOPE_BANDS.reduce((all, band) => {
        all[band] = summarise(bands[band]);
        return all;
    }, {} as Record<EnvelopeBand, EnvelopeBandStats>);

    // The same readout over the opening window, for a desktop session to be compared against
    // without playing the track to its end.
    const firstWindowFrames = Math.min(frames, Math.round(ENVELOPE_COMPARE_WINDOW_SECONDS / frameSeconds));
    const statsFirstWindow = ENVELOPE_BANDS.reduce((all, band) => {
        all[band] = summarise(bands[band].subarray(0, firstWindowFrames));
        return all;
    }, {} as Record<EnvelopeBand, EnvelopeBandStats>);

    return {
        frameSeconds,
        frames,
        durationSeconds: frames * frameSeconds,
        bands,
        stats,
        statsFirstWindow,
        firstWindowSeconds: firstWindowFrames * frameSeconds,
    };
};

/**
 * One frame of the envelope, in the live path's scale.
 *
 * `power` is derived here the way the bridge derives it from live bytes - the mean of bass and
 * lowMid - so the consumer applies its own `process()` curve to the same inputs either way.
 * Past either end the nearest frame answers: a track's last fraction of a second has no frame of
 * its own, and holding the last one keeps the visuals alive instead of dropping to idle.
 */
export const readEnvelopeFrame = (
    envelope: AudioEnvelope,
    timeSeconds: number,
): { bass: number; lowMid: number; mid: number; vocal: number; treble: number; power: number } | null => {
    if (envelope.frames === 0) return null;
    const raw = Math.floor(timeSeconds / envelope.frameSeconds);
    const frame = raw < 0 ? 0 : raw >= envelope.frames ? envelope.frames - 1 : raw;
    const bass = envelope.bands.bass[frame];
    const lowMid = envelope.bands.lowMid[frame];
    return {
        bass,
        lowMid,
        mid: envelope.bands.mid[frame],
        vocal: envelope.bands.vocal[frame],
        treble: envelope.bands.treble[frame],
        power: (bass + lowMid) / 2,
    };
};
