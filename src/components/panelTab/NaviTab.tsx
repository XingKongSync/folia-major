import React from 'react';
import { ReplayGainMode, SongResult } from '../../types';
import { Cloud } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getLyricProviderLabel } from '../../utils/lyrics/lyricSourceLabels';
import { resolveNavidromePlaybackCarrier } from '../../utils/appPlaybackGuards';
import SourceTab from './SourceTab';
import { EmptyState } from './shell/EmptyState';

// src/components/panelTab/NaviTab.tsx
// The song's tab for a song from a Navidrome server: hands SourceTab what it shows for it.
// It takes a lyric file like any other source: an imported lyric is filed as the song's match, which
// is the record its playback path reads (utils/appNavidromeLyrics.ts, saveImportedNavidromeLyrics).

interface NaviTabProps {
    currentSong: SongResult;
    hasLyrics: boolean;
    onMatchOnline: () => void;
    /** Takes the text of a chosen lyric file. */
    onImportLyrics?: (content: string, fileName: string) => void;
    lyricTimelineOffsetMs: number;
    onLyricTimelineOffsetChange: (offsetMs: number) => void;
    replayGainMode: ReplayGainMode;
    onChangeReplayGainMode: (mode: ReplayGainMode) => void;
    isDaylight: boolean;
}

const NaviTab: React.FC<NaviTabProps> = ({
    currentSong,
    hasLyrics,
    onMatchOnline,
    onImportLyrics,
    lyricTimelineOffsetMs,
    onLyricTimelineOffsetChange,
    replayGainMode,
    onChangeReplayGainMode,
    isDaylight,
}) => {
    const { t } = useTranslation();
    const navidromeSong = resolveNavidromePlaybackCarrier(currentSong);
    const navidromeData = navidromeSong?.navidromeData;

    if (!navidromeSong || !navidromeData) {
        return (
            <EmptyState icon={<Cloud size={28} />}>
                {t('localMusic.notALocalSong')}
            </EmptyState>
        );
    }

    // The unified player song retains the original Navidrome metadata carrier for lyric and gain details.
    const matchedLyrics = navidromeSong.matchedLyrics;
    const songLyricsSource = navidromeSong.lyricsSource;
    const matchedLyricsSource = navidromeSong.matchedLyricsSource;
    const matchedLyricsProviderPlatform = navidromeSong.matchedLyricsProviderPlatform;
    const hasMatchedLyrics = (matchedLyrics?.lines?.length ?? 0) > 0;
    const isOnline = hasMatchedLyrics && songLyricsSource === 'online';

    // The lyrics on screen come from one place: the matched online lyric, or the server.
    const lyricSources: { key: 'online' | 'server'; label: string }[] = [];
    if (isOnline) {
        lyricSources.push({ key: 'online', label: getLyricProviderLabel(matchedLyricsSource, matchedLyricsProviderPlatform) });
    } else if (hasLyrics) {
        lyricSources.push({ key: 'server', label: t('navidrome.server') });
    }

    return (
        <SourceTab
            key={navidromeData.id}
            lyricSources={lyricSources}
            onMatchOnline={onMatchOnline}
            onImportLyrics={onImportLyrics}
            gainValues={{
                trackGain: navidromeData.replayGain?.trackGain,
                albumGain: navidromeData.replayGain?.albumGain,
            }}
            replayGainMode={replayGainMode}
            onChangeReplayGainMode={onChangeReplayGainMode}
            lyricTimelineOffsetMs={lyricTimelineOffsetMs}
            onLyricTimelineOffsetChange={onLyricTimelineOffsetChange}
            facts={[{ label: 'Song ID', value: navidromeData.id, mono: true }]}
            isDaylight={isDaylight}
        />
    );
};

export default NaviTab;
