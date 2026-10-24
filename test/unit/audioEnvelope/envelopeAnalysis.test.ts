import { describe, expect, it } from 'vitest';
import {
    analyseAudioEnvelope,
    readEnvelopeFrame,
    ENVELOPE_COMPARE_WINDOW_SECONDS,
    ENVELOPE_SAMPLE_RATE,
} from '../../../src/services/audioEnvelope/envelopeAnalysis';

// test/unit/audioEnvelope/envelopeAnalysis.test.ts
// The envelope pass is what stands in for a live analyser on iOS, and nothing about it is visible
// when it goes wrong: the visualizer would just read flat or pinned. So the arithmetic is pinned
// here instead - a tone lands in the band that contains it, the scale stays inside the analyser's
// byte range, and the lookup clamps at both ends of a track.

/** A mono buffer of `seconds` at the envelope rate, filled by `sample`. */
const makeMono = (seconds: number, sample: (time: number) => number): Float32Array => {
    const length = Math.round(seconds * ENVELOPE_SAMPLE_RATE);
    const mono = new Float32Array(length);
    for (let index = 0; index < length; index += 1) mono[index] = sample(index / ENVELOPE_SAMPLE_RATE);
    return mono;
};

const mean = (values: Uint8Array, from: number, to: number): number => {
    let sum = 0;
    for (let index = from; index < to; index += 1) sum += values[index];
    return sum / Math.max(1, to - from);
};

describe('analyseAudioEnvelope', () => {
    it('puts a low tone in the bass band and a mid tone in the mid band', async () => {
        // Half a second of 60 Hz, then half a second of 700 Hz: bass belongs to the first half,
        // mid (400-1200 Hz) to the second.
        const mono = makeMono(1, (time) => 0.8 * Math.sin(2 * Math.PI * (time < 0.5 ? 60 : 700) * time));
        const envelope = await analyseAudioEnvelope(mono, ENVELOPE_SAMPLE_RATE);

        expect(envelope.frames).toBeGreaterThan(10);
        expect(envelope.frameSeconds).toBeGreaterThan(0);
        expect(envelope.durationSeconds).toBeGreaterThan(0.9);

        const half = Math.floor(envelope.frames / 2);
        const bassFirst = mean(envelope.bands.bass, 0, half);
        const bassSecond = mean(envelope.bands.bass, half, envelope.frames);
        const midFirst = mean(envelope.bands.mid, 0, half);
        const midSecond = mean(envelope.bands.mid, half, envelope.frames);

        expect(bassFirst).toBeGreaterThan(bassSecond);
        expect(midSecond).toBeGreaterThan(midFirst);
    });

    it('reports the opening window the live analyser is compared against', async () => {
        // 90 seconds, silent until 62 and a 4 kHz tone after. The window is the opening 60 seconds;
        // the tone starts two seconds later rather than at 60 because one frame's FFT window
        // straddles the boundary (1024 samples, ~46 ms) and would otherwise see the tone.
        const mono = makeMono(90, time => (time < 62 ? 0 : 0.8 * Math.sin(2 * Math.PI * 4000 * (time - 62))));
        const envelope = await analyseAudioEnvelope(mono, ENVELOPE_SAMPLE_RATE);

        expect(envelope.firstWindowSeconds).toBeGreaterThan(ENVELOPE_COMPARE_WINDOW_SECONDS - 1);
        expect(envelope.firstWindowSeconds).toBeLessThan(envelope.durationSeconds);
        expect(envelope.statsFirstWindow.treble.max).toBe(0);
        expect(envelope.stats.treble.max).toBeGreaterThan(0);
    });

    it('keeps every frame inside the analyser byte range', async () => {
        const mono = makeMono(0.5, time => 0.9 * Math.sin(2 * Math.PI * 440 * time));
        const envelope = await analyseAudioEnvelope(mono, ENVELOPE_SAMPLE_RATE);

        for (const band of Object.values(envelope.bands)) {
            expect(band).toHaveLength(envelope.frames);
            for (const value of band) {
                expect(value).toBeGreaterThanOrEqual(0);
                expect(value).toBeLessThanOrEqual(255);
            }
        }
        // A 440 Hz tone sits in the mid band (400-1200 Hz), and a tone this loud must register,
        // or the scale is wrong by a constant.
        expect(envelope.stats.mid.max).toBeGreaterThan(0);
    });

    it('reports zero frames for audio shorter than one transform', async () => {
        const envelope = await analyseAudioEnvelope(new Float32Array(100), ENVELOPE_SAMPLE_RATE);
        expect(envelope.frames).toBe(0);
        expect(readEnvelopeFrame(envelope, 0)).toBeNull();
    });
});

describe('readEnvelopeFrame', () => {
    it('derives power the way the live bridge does, and clamps at both ends', async () => {
        const mono = makeMono(1, time => 0.7 * Math.sin(2 * Math.PI * 60 * time));
        const envelope = await analyseAudioEnvelope(mono, ENVELOPE_SAMPLE_RATE);
        expect(envelope.frames).toBeGreaterThan(10);

        const middle = readEnvelopeFrame(envelope, 0.5);
        expect(middle).not.toBeNull();
        expect(middle!.power).toBeCloseTo((middle!.bass + middle!.lowMid) / 2, 6);

        // Before the first frame and past the last one the nearest frame answers rather than
        // dropping the visuals to idle.
        const before = readEnvelopeFrame(envelope, -10);
        const after = readEnvelopeFrame(envelope, envelope.durationSeconds + 60);
        expect(before).not.toBeNull();
        expect(after).not.toBeNull();
        expect(before!.bass).toBe(envelope.bands.bass[0]);
        expect(after!.bass).toBe(envelope.bands.bass[envelope.frames - 1]);
    });
});
