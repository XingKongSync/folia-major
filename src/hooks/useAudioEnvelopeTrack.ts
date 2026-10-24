import { useEffect } from 'react';
import { usePlaybackStore } from '../stores/usePlaybackStore';
import { getPlaybackAnalysisKey } from '../services/playbackRecovery/representationRegistry';
import { canBuildPlaybackGraph } from '../utils/platform';
import { loadAudioEnvelope } from '../services/audioEnvelope/audioEnvelopeSource';
import {
    clearLiveAudioEnvelope,
    setLiveAudioEnvelope,
} from '../services/audioEnvelope/audioEnvelopeLive';

// src/hooks/useAudioEnvelopeTrack.ts
// Loads the on-screen track's audio envelope whenever there is no live analyser to read instead.
//
// That is the iOS case (utils/platform.ts, `canBuildPlaybackGraph`): the media element is not wired
// into Web Audio there, so the visualizer's five band values have no analyser behind them and the
// frame loop would breathe forever. Everywhere else the analyser is live and this does nothing - a
// desktop session pays no decode and no download for it.
//
// Only the track identity enters React; the frames stay in services/audioEnvelope/audioEnvelopeLive,
// which is what the frame loop reads.
//
// An online track's stream URL is resolved by playback around the same time as this lookup, so a
// track with no bytes yet is asked again shortly - the same shape as the beat list's load
// (hooks/useBeatFxTrack.ts).

const RETRY_ATTEMPTS = 4;
const RETRY_DELAY_MS = 3000;

/** Whether the envelope is what drives the visualizer here; the frame loop asks this only for logging. */
export function useAudioEnvelopeTrack(): boolean {
    const wanted = !canBuildPlaybackGraph();
    // The same expression as the store's `selectDisplaySong`, written out here so this hook needs no
    // named export from that module. Several tests mock it partially and a name they do not list
    // throws at import (test/unit/playback/previewLyricClock.test.ts did exactly that).
    const song = usePlaybackStore(state => state.transitionDisplay?.song ?? state.currentSong);
    const identity = wanted && song ? getPlaybackAnalysisKey(song) : null;

    useEffect(() => {
        if (!wanted || !identity || !song) {
            clearLiveAudioEnvelope();
            return undefined;
        }

        let cancelled = false;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        // The retry may resolve another key (a transcode registering meanwhile), and the loop follows
        // whichever the loader names.
        const load = (attempt: number) => {
            const { key, envelope } = loadAudioEnvelope(song);
            void envelope.then((result) => {
                if (cancelled) return;
                if (result) {
                    setLiveAudioEnvelope(key, result);
                    return;
                }
                // No bytes yet (an online track's stream not resolved) or a failed decode: worth
                // asking again only while the track is young.
                if (attempt < RETRY_ATTEMPTS) {
                    retryTimer = setTimeout(() => load(attempt + 1), RETRY_DELAY_MS);
                    return;
                }
                console.info('[AudioEnvelope] no envelope for this track; the visualizer will breathe');
            }).catch((error) => {
                if (!cancelled) console.warn('[AudioEnvelope] envelope lookup failed', error);
            });
        };
        load(0);

        return () => {
            cancelled = true;
            if (retryTimer) clearTimeout(retryTimer);
            clearLiveAudioEnvelope();
        };
        // Keyed on the track identity: the song object changes for unrelated reasons.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [identity, wanted]);

    return wanted;
}
