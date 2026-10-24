import { beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import type { LyricData } from '@/types';

// test/unit/lyricExport/importLyricArchive.test.ts
// A `.fia` names its own song, which is what makes a library archive restorable on another device.
// What matters here: the document's key decides where the lyric goes, and a file that carries no
// key is refused rather than attached to something. The Navidrome write itself (merging over the
// previous match record) is pinned in saveImportedNavidromeLyrics.test.ts.

const navidromeSaverMock = vi.hoisted(() => vi.fn());
vi.mock('@/utils/appNavidromeLyrics', () => ({ saveImportedNavidromeLyrics: navidromeSaverMock }));

const stateWriterMock = vi.hoisted(() => vi.fn());
vi.mock('@/utils/onlineLyricsState', () => ({ saveOnlineLyricsStateForSongKey: stateWriterMock }));

const { importLyricArchive } = await import('@/services/lyricExport/importLyricArchive');
const { buildFoliaLyricDocument, serializeFoliaLyricDocument } =
    await import('@/utils/lyrics/foliaLyricDocument');

const lyrics = (text: string): LyricData => ({
    isWordByWord: false,
    lines: [{ startTime: 1, endTime: 2, fullText: text, words: [] }],
});

const fia = (key: string | undefined, text = 'from the archive'): string => serializeFoliaLyricDocument(
    buildFoliaLyricDocument(lyrics(text), key ? { song: { key } } : {}),
);

const zip = (files: Record<string, string>): Uint8Array => zipSync(
    Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])),
);

beforeEach(() => {
    navidromeSaverMock.mockReset();
    stateWriterMock.mockReset();
});

describe('importLyricArchive', () => {
    it('places a Navidrome document on the song its key names', async () => {
        const result = await importLyricArchive(zip({
            'fia/Artist - Song.fia': fia('navidrome:abc'),
        }));

        expect(result.imported).toBe(1);
        expect(result.importedSongKeys).toEqual(['navidrome:abc']);
        expect(result.skipped).toEqual([]);
        expect(navidromeSaverMock).toHaveBeenCalledTimes(1);
        const [navidromeId, written] = navidromeSaverMock.mock.calls[0];
        expect(navidromeId).toBe('abc');
        expect(written.lines[0].fullText).toBe('from the archive');
        expect(stateWriterMock).not.toHaveBeenCalled();
    });

    it('places an online document as an imported lyric state', async () => {
        const result = await importLyricArchive(zip({
            'fia/online.fia': fia('online:netease:1'),
        }));

        expect(result.imported).toBe(1);
        expect(stateWriterMock).toHaveBeenCalledTimes(1);
        const [key, state] = stateWriterMock.mock.calls[0];
        expect(key).toBe('online:netease:1');
        expect(state).toMatchObject({ lyricsSource: 'imported', importedLyricsName: 'fia/online.fia' });
        expect(state.importedLyrics.lines[0].fullText).toBe('from the archive');
        expect(navidromeSaverMock).not.toHaveBeenCalled();
    });

    it('refuses a document with no song key instead of guessing', async () => {
        const result = await importLyricArchive(zip({ 'fia/anonymous.fia': fia(undefined) }));

        expect(result.imported).toBe(0);
        expect(result.skipped).toEqual([{ fileName: 'fia/anonymous.fia', reason: 'noSongKey' }]);
        expect(navidromeSaverMock).not.toHaveBeenCalled();
        expect(stateWriterMock).not.toHaveBeenCalled();
    });

    it('refuses a local song key: that lyric lives on the file record, not in an archive', async () => {
        const result = await importLyricArchive(zip({ 'fia/local.fia': fia('local:abc') }));

        expect(result.imported).toBe(0);
        expect(result.skipped).toEqual([{ fileName: 'fia/local.fia', reason: 'unsupportedSong' }]);
    });

    it('reports a non-Folia file and ignores plain LRC entirely', async () => {
        const result = await importLyricArchive(zip({
            'fia/plain.fia': '{ "format": "something-else" }',
            'lrc/song.lrc': '[00:01.00]not a document',
        }));

        expect(result.imported).toBe(0);
        // The .lrc never reaches the importer: only documents can be placed, and reporting every LRC
        // in an archive exported with both formats would drown the real problems.
        expect(result.skipped).toEqual([{ fileName: 'fia/plain.fia', reason: 'notFoliaDocument' }]);
    });
});
