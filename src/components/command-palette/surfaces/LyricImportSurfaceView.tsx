import React, { useCallback, useRef, useState } from 'react';
import { FileUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { importLyricArchive, type LyricArchiveSkipReason } from '../../../services/lyricExport/importLyricArchive';
import { setStatusMessage } from '../../../stores/useStatusMessageStore';

// src/components/command-palette/surfaces/LyricImportSurfaceView.tsx
// The batch lyric import panel: choose the zip a batch export produced, and put every `.fia` in it
// back on the song it names.
//
// Why a zip rather than loose files: the export writes one, and the identity needed to place a
// lyric is inside each document, not in its name - so picking a folder of files would work too, but
// a zip is one gesture and one picker. Plain `.lrc` cannot be placed at all (no song identity) and
// is reported as skipped rather than attached to whatever it sorts next to.
//
// The result is deliberately not a silent success: how many were placed and why the rest were not
// is the only thing a listener can act on.

type LyricImportSurfaceViewProps = {
    isDaylight: boolean;
    settingsCardClass: string;
};

type RunState =
    | { kind: 'idle' }
    | { kind: 'picked'; fileName: string; sizeBytes: number }
    | { kind: 'running'; fileName: string }
    | { kind: 'done'; imported: number; skipped: { fileName: string; reason: LyricArchiveSkipReason }[] };

const formatSize = (bytes: number): string => (
    bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
);

/** The file name without its folders, for a readable line. */
const baseName = (fileName: string): string => fileName.split('/').pop() || fileName;

const LyricImportSurfaceView: React.FC<LyricImportSurfaceViewProps> = ({ isDaylight, settingsCardClass }) => {
    const { t } = useTranslation();
    const [state, setState] = useState<RunState>({ kind: 'idle' });
    const inputRef = useRef<HTMLInputElement>(null);
    const pickedFileRef = useRef<File | null>(null);
    const textPrimary = isDaylight ? 'text-black' : 'text-white';
    const textSecondary = isDaylight ? 'text-black/60' : 'text-white/60';

    const choose = useCallback(() => inputRef.current?.click(), []);

    const onPick = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        // Emptied, so choosing the same archive twice is a change too.
        event.target.value = '';
        if (!file) return;
        pickedFileRef.current = file;
        setState({ kind: 'picked', fileName: file.name, sizeBytes: file.size });
    }, []);

    const run = useCallback(async () => {
        const file = pickedFileRef.current;
        if (!file) return;
        setState({ kind: 'running', fileName: file.name });
        try {
            const result = await importLyricArchive(new Uint8Array(await file.arrayBuffer()));
            setState({
                kind: 'done',
                imported: result.imported,
                skipped: result.skipped.map(entry => ({ fileName: entry.fileName, reason: entry.reason })),
            });
            setStatusMessage({
                type: result.imported > 0 ? 'success' : 'info',
                text: t('lyricImport.done', { count: result.imported }),
            });
        } catch (error) {
            console.error('[LyricImport] Import failed', error);
            setState({ kind: 'idle' });
            setStatusMessage({ type: 'error', text: t('lyricImport.failed') });
        }
    }, [t]);

    const reasonText = (reason: LyricArchiveSkipReason): string => t(`lyricImport.reason_${reason}`);

    return (
        <div className="flex flex-col gap-3">
            <input ref={inputRef} type="file" accept=".zip,application/zip" className="hidden" onChange={onPick} />

            <div className={`${settingsCardClass} flex flex-col gap-2 p-4`}>
                <button
                    type="button"
                    onClick={choose}
                    disabled={state.kind === 'running'}
                    className={`flex items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-3 text-sm transition-colors
                        ${isDaylight ? 'border-black/20 hover:bg-black/5' : 'border-white/20 hover:bg-white/5'}
                        ${state.kind === 'running' ? 'opacity-50' : ''}`}
                >
                    <FileUp size={16} />
                    {t('lyricImport.pick')}
                </button>

                {(state.kind === 'picked' || state.kind === 'running') && (
                    <p className={`text-xs ${textSecondary}`}>
                        {state.fileName}
                        {state.kind === 'picked' ? ` · ${formatSize(state.sizeBytes)}` : ''}
                    </p>
                )}

                {state.kind === 'picked' && (
                    <button
                        type="button"
                        onClick={() => void run()}
                        className="rounded-xl bg-blue-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-600"
                    >
                        {t('lyricImport.start')}
                    </button>
                )}

                {state.kind === 'running' && (
                    <p className={`text-sm ${textPrimary}`}>{t('lyricImport.running')}</p>
                )}
            </div>

            {state.kind === 'done' && (
                <div className={`${settingsCardClass} flex flex-col gap-2 p-4`}>
                    <p className={`text-sm font-medium ${textPrimary}`}>{t('lyricImport.done', { count: state.imported })}</p>
                    {state.skipped.length > 0 && (
                        <>
                            <p className={`text-xs ${textSecondary}`}>
                                {t('lyricImport.skipped', { count: state.skipped.length })}
                            </p>
                            <ul className={`flex max-h-40 flex-col gap-1 overflow-y-auto text-xs ${textSecondary}`}>
                                {state.skipped.slice(0, 40).map(entry => (
                                    <li key={`${entry.fileName}:${entry.reason}`} className="truncate">
                                        {baseName(entry.fileName)} — {reasonText(entry.reason)}
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}
                    <p className={`text-xs ${textSecondary}`}>{t('lyricImport.hint')}</p>
                </div>
            )}
        </div>
    );
};

export default LyricImportSurfaceView;
