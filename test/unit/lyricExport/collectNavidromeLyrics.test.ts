import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LyricData } from '@/types';

// test/unit/lyricExport/collectNavidromeLyrics.test.ts
// A Navidrome match is filed under `navidrome_match_<id>` and belongs to neither of the other export
// scopes, so it is gathered here. The two things worth pinning: the key prefix decides what is read,
// and a failed name lookup must not lose the lyrics.

const cacheMock = vi.hoisted(() => vi.fn());
vi.mock('@/services/repositories/cacheRepository', () => ({ readCacheEntriesByKey: cacheMock }));

const configMock = vi.hoisted(() => vi.fn());
const getSongMock = vi.hoisted(() => vi.fn());
const toNavidromeSongMock = vi.hoisted(() => vi.fn());
vi.mock('@/services/navidromeService', () => ({
    getNavidromeConfig: configMock,
    navidromeApi: { getSong: getSongMock, toNavidromeSong: toNavidromeSongMock },
}));

const { collectNavidromeLyrics } = await import('@/services/lyricExport/collectNavidromeLyrics');

const lyrics = (text: string): LyricData => ({
    isWordByWord: false,
    lines: [{ startTime: 1, endTime: 2, fullText: text, words: [] }],
});

const match = (patch: Record<string, unknown> = {}) => ({
    matchedLyrics: lyrics('from the match'),
    matchedIsPureMusic: false,
    matchedLyricsSource: 'netease',
    lyricsSource: 'online',
    ...patch,
});

const serverSong = () => toNavidromeSongMock.mockReturnValue({
    name: 'Song Title',
    artists: [{ id: 0, name: 'Artist' }],
    album: { id: 0, name: 'Album' },
    durationMs: 123000,
    navidromeData: { id: 'abc', path: '/music/Artist/Album/01 Song.flac' },
});

beforeEach(() => {
    cacheMock.mockReset();
    configMock.mockReset();
    getSongMock.mockReset();
    toNavidromeSongMock.mockReset();
    // The predicate is the collector's own filter, so exercise it rather than bypassing it.
    cacheMock.mockImplementation(async (predicate: (key: string) => boolean, tables: string[]) => {
        expect(tables).toEqual(['metadata_cache', 'api_cache']);
        return [
            { key: 'navidrome_match_abc', data: match() },
            { key: 'lyric_online:netease:1', data: match() },
        ].filter(entry => predicate(entry.key));
    });
    configMock.mockReturnValue({ serverUrl: 'https://navi.test', username: 'u', password: 'p' });
    getSongMock.mockResolvedValue({ id: 'abc' });
    serverSong();
});

describe('collectNavidromeLyrics', () => {
    it('exports only the match records, with the names the server reports', async () => {
        const result = await collectNavidromeLyrics();

        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]).toMatchObject({
            songKey: 'navidrome:abc',
            offsetKey: 'abc',
            source: 'online',
            song: { key: 'navidrome:abc', title: 'Song Title', artist: 'Artist', album: 'Album', durationMs: 123000 },
        });
        expect(result.entries[0].lyrics.lines[0].fullText).toBe('from the match');
        expect(result.skipped).toEqual([]);
    });

    it('keeps the lyrics when the server cannot name the song', async () => {
        getSongMock.mockRejectedValue(new Error('offline'));

        const result = await collectNavidromeLyrics();

        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].songKey).toBe('navidrome:abc');
        expect(result.entries[0].song.title).toBeUndefined();
    });

    it('exports nothing when no Navidrome is configured, but still takes the matches', async () => {
        configMock.mockReturnValue(null);

        const result = await collectNavidromeLyrics();

        expect(getSongMock).not.toHaveBeenCalled();
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].song.title).toBeUndefined();
    });

    it('reports a match that concluded the song is instrumental', async () => {
        cacheMock.mockImplementation(async (predicate: (key: string) => boolean) => [
            { key: 'navidrome_match_inst', data: match({ matchedLyrics: undefined, matchedIsPureMusic: true }) },
        ].filter(entry => predicate(entry.key)));

        const result = await collectNavidromeLyrics();

        expect(result.entries).toEqual([]);
        expect(result.skipped).toEqual([expect.objectContaining({ songKey: 'navidrome:inst', reason: 'pureMusic' })]);
    });

    it('reports a match that has no lyrics at all', async () => {
        cacheMock.mockImplementation(async (predicate: (key: string) => boolean) => [
            { key: 'navidrome_match_empty', data: match({ matchedLyrics: undefined, matchedIsPureMusic: undefined }) },
        ].filter(entry => predicate(entry.key)));

        const result = await collectNavidromeLyrics();

        expect(result.entries).toEqual([]);
        expect(result.skipped).toEqual([expect.objectContaining({ reason: 'noLyrics' })]);
    });
});
