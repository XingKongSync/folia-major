import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LyricData } from '@/types';

// test/unit/lyricExport/saveImportedNavidromeLyrics.test.ts
// One writer for an imported Navidrome lyric, used by both the single-song import and the archive
// import. Two things must hold: it fills the record playback actually reads, and it does not throw
// away a match that already put a cover and metadata on the song.

const cacheMock = vi.hoisted(() => ({ getFromCache: vi.fn(), saveToCache: vi.fn() }));
vi.mock('@/services/db', () => cacheMock);
vi.mock('@/services/navidromeService', () => ({ navidromeApi: {}, getNavidromeConfig: () => null }));
vi.mock('@/services/onlineMusic/songMetadata', () => ({ getProviderSongMetadata: () => ({ artists: [] }) }));

const { saveImportedNavidromeLyrics } = await import('@/utils/appNavidromeLyrics');

const lyrics = (text: string): LyricData => ({
    isWordByWord: false,
    lines: [{ startTime: 1, endTime: 2, fullText: text, words: [] }],
});

beforeEach(() => {
    cacheMock.getFromCache.mockReset();
    cacheMock.saveToCache.mockReset();
});

describe('saveImportedNavidromeLyrics', () => {
    it('writes the match record playback reads, keeping what the previous match knew', async () => {
        cacheMock.getFromCache.mockResolvedValue({ matchedSongId: 42, useOnlineCover: true });

        await saveImportedNavidromeLyrics('abc', lyrics('imported line'));

        expect(cacheMock.getFromCache).toHaveBeenCalledWith('navidrome_match_abc');
        const [key, saved] = cacheMock.saveToCache.mock.calls[0];
        expect(key).toBe('navidrome_match_abc');
        expect(saved).toMatchObject({
            matchedSongId: 42,
            useOnlineCover: true,
            matchedIsPureMusic: false,
            lyricsSource: 'online',
            useOnlineLyrics: true,
        });
        expect(saved.matchedLyrics.lines[0].fullText).toBe('imported line');
    });

    it('works on a song with no previous match', async () => {
        cacheMock.getFromCache.mockResolvedValue(null);

        await saveImportedNavidromeLyrics('fresh', lyrics('first lyric'));

        const [, saved] = cacheMock.saveToCache.mock.calls[0];
        expect(saved).toMatchObject({ matchedIsPureMusic: false, lyricsSource: 'online' });
        expect(saved.matchedLyrics.lines[0].fullText).toBe('first lyric');
    });
});
