import type { SongResult } from '../../types';
import type { PlaybackRepresentation } from '../../types/playbackRecovery';
import { decodeAtRate, readLocalTrackBytes, toMidSide } from '../analysis/trackAudio';
import { decodeTrackAtRate, loadTrackBytes } from '../analysis/trackBytes';
import { getPlaybackAnalysisTarget } from '../playbackRecovery/representationRegistry';
import { isCacheableAudioResponse } from '../playbackRecovery/mediaCacheGuard';
import { getPrefetchedData, isUrlValid } from '../prefetchService';
import { getPlaybackSourceRef } from '../../utils/appPlaybackGuards';
import { whyNotTheSong } from '../wholeSongCheck';
import { analyseAudioEnvelope, ENVELOPE_SAMPLE_RATE, ENVELOPE_BANDS, type AudioEnvelope } from './envelopeAnalysis';

// src/services/audioEnvelope/audioEnvelopeSource.ts
// Where the visualizer's envelope for a track comes from.
//
// The bytes are read through analysis/trackBytes.ts, the same shared cache automix's profile, stem
// separation and 智能动感模式 read through: whichever analyser asks first reads the track, the others
// are handed a copy, and nothing is read twice for a track already in hand. That is what keeps this
// pass from costing a second download - the beats' read and this one share one file.
//
// The decode is at ENVELOPE_SAMPLE_RATE through the same per-(key, rate) join, and the result is
// thrown away as soon as the envelopes are out of it: what is kept is five byte arrays per track,
// about 65 KB for a five-minute one, not the decoded audio.
//
// The read ladder mirrors beatFxSource.ts' private one (local representation, media cache, local
// file or URL, then the stream URL playback resolved). It is duplicated rather than shared for now:
// consolidating the two belongs with that file's own refactor, and this pass must not be able to
// disturb the beats path. Both are keyed by `getPlaybackAnalysisTarget`, so they share bytes either
// way - the duplication is the ladder, not the work.
//
// Nothing is persisted across sessions yet: a session's second play of a track is answered from
// `memory`, and a fresh session re-analyses (one decode plus one FFT pass, a few hundred ms).

/** Envelopes kept at once. ~65 KB each, so this is well under a megabyte. */
const MAX_TRACKS = 12;

const memory = new Map<string, Promise<AudioEnvelope | null>>();

/** An online track's bytes from the stream URL its playback resolved, if there is a live one. */
const readStreamedTrackBytes = async (song: SongResult): Promise<ArrayBuffer | null> => {
    if (getPlaybackSourceRef(song).kind !== 'online') return null;
    const prefetched = getPrefetchedData(song);
    const url = prefetched?.audioUrl;
    if (!url || url === 'CACHED_IN_DB' || !isUrlValid(prefetched.audioUrlFetchedAt) || !/^https?:/.test(url)) return null;
    try {
        const response = await fetch(url);
        const blob = await response.blob();
        // An error page or a cut-off download decoded would be stored as this track's envelope.
        if (!isCacheableAudioResponse(response, blob)) return null;
        const notTheSong = await whyNotTheSong(song, url, blob);
        if (notTheSong) {
            console.info(`[AudioEnvelope] not analysing the stream: it is ${notTheSong}`);
            return null;
        }
        return await blob.arrayBuffer();
    } catch (error) {
        console.warn('[AudioEnvelope] could not read the stream', error);
        return null;
    }
};

const resolveEnvelope = async (
    song: SongResult,
    key: string,
    representation: PlaybackRepresentation | null,
): Promise<AudioEnvelope | null> => {
    const { bytes, source } = await loadTrackBytes(key, async () => {
        const found = await readLocalTrackBytes(song, { representation });
        const local = found && 'bytes' in found ? found.bytes : null;
        // A representation's bytes are what the key names; an online track's stream is read only
        // when there is none.
        if (local || representation) return local;
        return await readStreamedTrackBytes(song);
    });
    if (!bytes) return null;

    const decoded = await decodeTrackAtRate(key, ENVELOPE_SAMPLE_RATE, bytes, decodeAtRate, 'envelope', source);
    if (!decoded) return null;

    const envelope = await analyseAudioEnvelope(toMidSide(decoded).mid, decoded.sampleRate);
    // The line that says whether this pass's scale matches the live analyser's: the same readout is
    // printed by the desktop session (services/audioEnvelope/liveAnalyserProbe.ts), so the two can
    // be put side by side. Both the whole track and the opening window are printed; the window is
    // what one minute of desktop playback can be compared against.
    const line = (stats: typeof envelope.stats) => ENVELOPE_BANDS
        .map(band => `${band} ${stats[band].p50}/${stats[band].p90}/${stats[band].max}`)
        .join(', ');
    console.info(`[AudioEnvelope] ${key}: ${envelope.durationSeconds.toFixed(1)}s, ${envelope.frames} frames`
        + ` @${envelope.frameSeconds.toFixed(3)}s, bytes ${source}; p50/p90/max ${line(envelope.stats)}`);
    console.info(`[AudioEnvelope] ${key}: first ${envelope.firstWindowSeconds.toFixed(0)}s p50/p90/max ${line(envelope.statsFirstWindow)}`);
    return envelope;
};

/**
 * The envelope for a track and the analysis key it belongs to, computed once per session and shared
 * by concurrent callers. Null means "not now" - no bytes yet, a decode failure - and is not
 * remembered, so a later play (with the track cached, or its stream resolved) tries again.
 */
export const loadAudioEnvelope = (song: SongResult): { key: string; envelope: Promise<AudioEnvelope | null> } => {
    const { key, representation } = getPlaybackAnalysisTarget(song);
    const existing = memory.get(key);
    if (existing) return { key, envelope: existing };

    const pending = resolveEnvelope(song, key, representation);
    memory.set(key, pending);
    while (memory.size > MAX_TRACKS) {
        const oldest = memory.keys().next().value;
        if (oldest === undefined) break;
        memory.delete(oldest);
    }
    void pending.then((result) => {
        if (!result && memory.get(key) === pending) memory.delete(key);
    }).catch(() => { memory.delete(key); });
    return { key, envelope: pending };
};

/** Test-only: forgets every envelope and run in flight. */
export const resetAudioEnvelopesForTests = (): void => {
    memory.clear();
};
