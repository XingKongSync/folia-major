import type { CommandPaletteSurface } from './types';
import { settingsCardClassFor } from '../../modal/settings/settingsCardClasses';

// src/components/command-palette/surfaces/lyricImportSurface.ts
// Declares the batch lyric import panel. The view owns the run (pick, import, result), so only the
// panel dressing is mapped across.

export const lyricImportSurface: CommandPaletteSurface = {
    load: () => import('./LyricImportSurfaceView'),
    mapProps: ({ isDaylight }) => ({
        isDaylight,
        settingsCardClass: settingsCardClassFor(isDaylight),
    }),
};
