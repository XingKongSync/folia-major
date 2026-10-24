import { strFromU8, unzip } from 'fflate';
import {
    looksLikeFoliaLyricDocument,
    parseFoliaLyricDocument,
    parseFoliaLyricDocumentMeta,
} from '../../utils/lyrics/foliaLyricDocument';
import { saveImportedNavidromeLyrics } from '../../utils/appNavidromeLyrics';
import { saveOnlineLyricsStateForSongKey } from '../../utils/onlineLyricsState';
import { throwIfAborted } from './types';

// src/services/lyricExport/importLyricArchive.ts
// Puts a `.fia` archive back where it came from: one lyric per song, placed by the key the document
// carries rather than by what happens to be playing.
//
// Why this file: the single-song import applies a chosen file to the song on screen
// (components/panelTab/LyricFileButton.tsx). That is the right shape for one file and the wrong one
// for five hundred - the whole point of exporting a library is to carry it to another device, and
// there is nothing there that knows which of the files belongs to which song. A `.fia` does know:
// `song.key` is `getPlaybackSongKey`, e.g. `navidrome:abc` or `online:netease:1`. This reads that
// and writes the lyric to the song it names, with nothing playing.
//
// Where a lyric is written depends on the song, because the two playback paths read different
// stores, not because the format differs:
//  - `navidrome:<id>`: playback reads `navidrome_match_<id>` (the record an online match fills), so an
//    imported document is filed there. `lyric_navidrome:<id>_state` is not read by that path at all.
//  - `online:<provider>:<id>`: playback reads the `lyric_<key>_state` override, so an imported
//    document becomes an `imported` state there.
// Anything else (`local:`, `embedded:`) is refused rather than guessed: a local song's lyrics live on
// the local file record, which a `.fia` cannot address on its own.
//
// Only `.fia` documents can be placed. Enhanced LRC carries no song identity, so a `.lrc` in the zip
// is reported and left alone instead of being attached to whatever it happens to sort next to.

/** Why a file in the archive was not imported. */
export type LyricArchiveSkipReason = 'notFoliaDocument' | 'noSongKey' | 'unsupportedSong' | 'unreadable';

export interface LyricArchiveSkippedFile {
    fileName: string;
    reason: LyricArchiveSkipReason;
}

export interface LyricArchiveImportResult {
    imported: number;
    /** The song keys written, so a caller can refresh the one on screen. */
    importedSongKeys: string[];
    skipped: LyricArchiveSkippedFile[];
}

const NAVIDROME_KEY_PREFIX = 'navidrome:';
const ONLINE_KEY_PREFIX = 'online:';

/** A `.fia`, or a `.json` that turns out to be one; everything else in the zip is ignored. */
const isCandidate = (fileName: string): boolean => /\.(fia|json)$/i.test(fileName);

const readZip = (bytes: Uint8Array): Promise<Record<string, Uint8Array>> => new Promise((resolve, reject) => {
    unzip(bytes, (error, files) => (error ? reject(error) : resolve(files)));
});

/**
 * Writes one document to the song its key names.
 *
 * The previous match record is merged over, not replaced: a Navidrome song may already carry a cover
 * and metadata match this document says nothing about, and dropping them would undo a match the
 * listener made.
 */
const importOne = async (
    fileName: string,
    text: string,
): Promise<{ songKey: string } | LyricArchiveSkippedFile> => {
    if (!looksLikeFoliaLyricDocument(text)) return { fileName, reason: 'notFoliaDocument' };

    const meta = parseFoliaLyricDocumentMeta(text);
    const lyrics = parseFoliaLyricDocument(text);
    if (!meta || !lyrics) return { fileName, reason: 'notFoliaDocument' };

    const songKey = meta.song?.key?.trim();
    if (!songKey) return { fileName, reason: 'noSongKey' };

    if (songKey.startsWith(NAVIDROME_KEY_PREFIX)) {
        const navidromeId = songKey.slice(NAVIDROME_KEY_PREFIX.length);
        if (!navidromeId) return { fileName, reason: 'noSongKey' };
        // The one writer both import paths use, so a single-song import and this one cannot drift
        // apart on which record they fill.
        await saveImportedNavidromeLyrics(navidromeId, lyrics);
        return { songKey };
    }

    if (songKey.startsWith(ONLINE_KEY_PREFIX)) {
        await saveOnlineLyricsStateForSongKey(songKey, {
            lyricsSource: 'imported',
            importedLyrics: lyrics,
            importedLyricsName: fileName,
        });
        return { songKey };
    }

    // `local:` and anything else: no store this importer can address.
    return { fileName, reason: 'unsupportedSong' };
};

/**
 * Imports every placeable `.fia` in the zip. One bad file never aborts the run - it is reported in
 * `skipped` and the rest carry on, which is what makes a partially-exported archive still useful.
 */
export const importLyricArchive = async (
    bytes: Uint8Array,
    { signal }: { signal?: AbortSignal } = {},
): Promise<LyricArchiveImportResult> => {
    const files = await readZip(bytes);
    throwIfAborted(signal);

    const result: LyricArchiveImportResult = { imported: 0, importedSongKeys: [], skipped: [] };
    const entries = Object.entries(files)
        .filter(([fileName, data]) => isCandidate(fileName) && data.length > 0 && !fileName.endsWith('/'));

    for (const [fileName, data] of entries) {
        throwIfAborted(signal);
        try {
            const outcome = await importOne(fileName, strFromU8(data));
            if ('reason' in outcome) {
                result.skipped.push(outcome);
                continue;
            }
            result.imported += 1;
            result.importedSongKeys.push(outcome.songKey);
        } catch (error) {
            console.warn('[LyricImport] could not import a file', error);
            result.skipped.push({ fileName, reason: 'unreadable' });
        }
    }

    console.info(`[LyricImport] ${result.imported} imported, ${result.skipped.length} skipped of ${entries.length}`);
    return result;
};
