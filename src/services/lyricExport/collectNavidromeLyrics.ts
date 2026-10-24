import type { NavidromeConfig } from '../../types/navidrome';
import type { NavidromeMatchData } from '../../types/navidrome';
import { NAVIDROME_MATCH_CACHE_PREFIX } from '../../types/navidrome';
import { migrateLyricDataRenderHints } from '../../utils/lyrics/renderHints';
import { judgeLyricsForExport } from '../../utils/lyrics/exportableLyrics';
import { isPureMusicLyricText } from '../../utils/lyrics/pureMusic';
import { getNavidromeConfig, navidromeApi } from '../navidromeService';
import { readCacheEntriesByKey } from '../repositories/cacheRepository';
import {
    mapWithConcurrency,
    throwIfAborted,
    type ExportableLyric,
    type LyricCollectionResult,
    type LyricExportRunContext,
    type SkippedLyric,
} from './types';

// src/services/lyricExport/collectNavidromeLyrics.ts
// Gathers the lyrics matched for Navidrome songs.
//
// Why a third collector: a Navidrome song belongs to neither of the other two scopes. Its match is
// stored under `navidrome_match_<id>` (types/navidrome.ts, getNavidromeMatchCacheKey) rather than in
// the `lyric_<songKey>` cache the online collector walks, and the song itself is not one of
// `getLocalSongs()` either because a Navidrome library is never imported into Folia - it is queried
// from the server as it is browsed. So before this file a match made for a Navidrome song could be
// seen on screen and could not be exported at all.
//
// What is exported is what playback would show: `matchedLyrics` off the match record, with the same
// instrumental rule `collectLocalLyrics` applies (a recorded verdict is trusted as-is, otherwise the
// lyric text is read). Navidrome's own server-side lyrics are not part of a match record and are not
// collected here; a song that only has those has nothing to export through this scope.
//
// Names come from the server, one getSong per matched song: without them a file would be named after
// an opaque id, and titles are what a listener recognises. A failed lookup leaves the entry in place
// with whatever the lyric's own [ti:]/[ar:] tags give (resolveExportMetadata's fallback) - a missing
// name must not lose the lyrics.

/** The match record's key prefix, from getNavidromeMatchCacheKey. */
const MATCH_KEY_PREFIX = NAVIDROME_MATCH_CACHE_PREFIX;

/** saveToCache files a match under one of these (see the Navidrome match path in the playback controller). */
const CACHE_TABLES = ['metadata_cache', 'api_cache'] as const;

/** Name lookups are one request each, so a whole library's worth must not run at once. */
const LOOKUP_CONCURRENCY = 4;

type SongNames = {
    title?: string;
    artist?: string;
    album?: string;
    durationMs?: number;
};

type Collected =
    | { kind: 'entry'; entry: ExportableLyric }
    | { kind: 'skip'; skip: SkippedLyric };

/** The song's display names, or null when the server cannot answer (no config, offline, gone). */
const readSongNames = async (config: NavidromeConfig, navidromeId: string): Promise<SongNames | null> => {
    try {
        const subsonic = await navidromeApi.getSong(config, navidromeId);
        if (!subsonic) return null;
        const song = navidromeApi.toNavidromeSong(config, subsonic);
        const artist = song.artists?.map(entry => entry.name).filter(Boolean).join(', ');
        return {
            ...(song.name ? { title: song.name } : {}),
            ...(artist ? { artist } : {}),
            ...(song.album?.name ? { album: song.album.name } : {}),
            ...(Number.isFinite(song.durationMs) && song.durationMs > 0 ? { durationMs: song.durationMs } : {}),
        };
    } catch (error) {
        console.warn('[LyricExport] could not read a Navidrome song\'s names', error);
        return null;
    }
};

const collectOne = (
    navidromeId: string,
    match: NavidromeMatchData,
    names: SongNames | null,
): Collected => {
    const songKey = `navidrome:${navidromeId}`;
    const label = names?.title;
    const recorded = typeof match.matchedIsPureMusic === 'boolean' ? match.matchedIsPureMusic : undefined;
    const lyrics = match.matchedLyrics ? migrateLyricDataRenderHints(match.matchedLyrics).value : null;

    if (!lyrics) {
        return { kind: 'skip', skip: { songKey, label, reason: recorded ? 'pureMusic' : 'noLyrics' } };
    }

    // Same rule as collectLocalLyrics' isMatchedPureMusic: a recorded verdict is an answer, and only
    // a match from before verdicts were stored falls back to reading the text.
    const verdict = judgeLyricsForExport(lyrics, text => recorded ?? isPureMusicLyricText(text));
    if (verdict !== 'export') {
        return { kind: 'skip', skip: { songKey, label, reason: verdict } };
    }

    return {
        kind: 'entry',
        entry: {
            songKey,
            lyrics,
            source: 'online',
            song: { key: songKey, ...names },
            // The offset is stored under the Navidrome media id.
            offsetKey: navidromeId,
        },
    };
};

export const collectNavidromeLyrics = async (
    { signal }: LyricExportRunContext = {},
): Promise<LyricCollectionResult> => {
    const entries = await readCacheEntriesByKey<unknown>(
        key => key.startsWith(MATCH_KEY_PREFIX),
        [...CACHE_TABLES],
    );
    throwIfAborted(signal);

    const matches = entries.flatMap((entry) => {
        const navidromeId = entry.key.slice(MATCH_KEY_PREFIX.length);
        const match = entry.data as NavidromeMatchData | null | undefined;
        return navidromeId && match && typeof match === 'object' ? [{ navidromeId, match }] : [];
    });
    if (matches.length === 0) return { entries: [], skipped: [] };

    const config = getNavidromeConfig();
    const collected = await mapWithConcurrency(
        matches,
        LOOKUP_CONCURRENCY,
        async ({ navidromeId, match }) => {
            throwIfAborted(signal);
            return collectOne(navidromeId, match, config ? await readSongNames(config, navidromeId) : null);
        },
        signal,
    );

    const result: LyricCollectionResult = { entries: [], skipped: [] };
    for (const item of collected) {
        if (item.kind === 'entry') result.entries.push(item.entry);
        else result.skipped.push(item.skip);
    }
    return result;
};
