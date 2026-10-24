import { LyricParserFactory } from './lyrics/LyricParserFactory';
import type { LyricData } from '../types';
import type { NavidromeConfig, NavidromeMatchData, NavidromeSong, StructuredLyric } from '../types/navidrome';
import { getNavidromeMatchCacheKeyForId } from '../types/navidrome';
import { navidromeApi } from '../services/navidromeService';
import { getFromCache, saveToCache } from '../services/db';
import { getProviderSongMetadata } from '../services/onlineMusic/songMetadata';
import { hasRenderableLyrics } from './appPlaybackHelpers';
import {
    hasEnhancedNavidromeStructuredLyrics,
    isNavidromeStructuredLyricCollection,
    selectPreferredNavidromeStructuredLyric,
} from './lyrics/navidromeStructuredLyrics';

// Navidrome lyric selection and hydration helpers kept outside App.tsx.
export const selectPreferredStructuredLyric = (items: StructuredLyric[] | null | undefined): StructuredLyric | null => {
    return selectPreferredNavidromeStructuredLyric(items);
};

const getCachedMainStructuredLyric = (
    cachedStructuredLyrics: NavidromeSong['cachedStructuredLyrics']
): StructuredLyric | null => {
    if (isNavidromeStructuredLyricCollection(cachedStructuredLyrics)) {
        return selectPreferredNavidromeStructuredLyric(cachedStructuredLyrics);
    }

    return Array.isArray(cachedStructuredLyrics) ? null : cachedStructuredLyrics ?? null;
};

export const resolvePreferredNavidromeLyrics = async (
    navidromeSong: Pick<NavidromeSong, 'cachedStructuredLyrics' | 'cachedPlainLyrics'>
): Promise<LyricData | null> => {
    const cachedStructuredLyrics = navidromeSong.cachedStructuredLyrics;
    const structuredLyrics = Array.isArray(cachedStructuredLyrics) && !isNavidromeStructuredLyricCollection(cachedStructuredLyrics)
        ? cachedStructuredLyrics.filter(line => (line.value || '').trim().length > 0)
        : cachedStructuredLyrics;
    const cachedMainStructuredLyric = getCachedMainStructuredLyric(cachedStructuredLyrics);
    const shouldPreferPlainLyrics = Boolean(cachedMainStructuredLyric && !hasEnhancedNavidromeStructuredLyrics(cachedMainStructuredLyric));
    let parsedStructuredLyrics: LyricData | null = null;

    if (structuredLyrics && (Array.isArray(structuredLyrics) ? structuredLyrics.length > 0 : structuredLyrics.line.length > 0 || structuredLyrics.cueLine?.length)) {
        parsedStructuredLyrics = await LyricParserFactory.parse({ type: 'navidrome', structuredLyrics });
        if (hasRenderableLyrics(parsedStructuredLyrics) && !shouldPreferPlainLyrics) {
            return parsedStructuredLyrics;
        }
    }

    const plainLyrics = navidromeSong.cachedPlainLyrics?.trim();
    if (plainLyrics) {
        const parsedPlainLyrics = await LyricParserFactory.parse({ type: 'navidrome', plainLyrics });
        if (hasRenderableLyrics(parsedPlainLyrics)) {
            return parsedPlainLyrics;
        }
    }

    return hasRenderableLyrics(parsedStructuredLyrics) ? parsedStructuredLyrics : null;
};

export const hydrateNavidromeLyricPayload = async (config: NavidromeConfig, navidromeSong: NavidromeSong): Promise<void> => {
    const navidromeId = navidromeSong.navidromeData?.id;
    if (!navidromeId) {
        return;
    }

    const cachedStructuredLyrics = navidromeSong.cachedStructuredLyrics;
    const hasCurrentStructuredLyrics = isNavidromeStructuredLyricCollection(cachedStructuredLyrics)
        ? cachedStructuredLyrics.some(item => item.line.length > 0 || item.cueLine?.length)
        : !Array.isArray(cachedStructuredLyrics)
            && Boolean(cachedStructuredLyrics?.line.length || cachedStructuredLyrics?.cueLine?.length);
    const cachedMainStructuredLyric = getCachedMainStructuredLyric(cachedStructuredLyrics);
    const needsPlainLyrics = !navidromeSong.cachedPlainLyrics
        && (!cachedMainStructuredLyric || !hasEnhancedNavidromeStructuredLyrics(cachedMainStructuredLyric));
    if (!hasCurrentStructuredLyrics || needsPlainLyrics) {
        try {
            const structuredLyrics = hasCurrentStructuredLyrics
                ? null
                : await navidromeApi.getLyricsBySongId(config, navidromeId);
            const preferredStructuredLyrics = structuredLyrics
                ? selectPreferredStructuredLyric(structuredLyrics)
                : cachedMainStructuredLyric;

            if (preferredStructuredLyrics?.line?.length || preferredStructuredLyrics?.cueLine?.length) {
                navidromeSong.cachedStructuredLyrics = structuredLyrics ?? navidromeSong.cachedStructuredLyrics;
            }
            if ((!preferredStructuredLyrics || !hasEnhancedNavidromeStructuredLyrics(preferredStructuredLyrics)) && !navidromeSong.cachedPlainLyrics) {
                const artistName = getProviderSongMetadata(navidromeSong).artists[0]?.name
                    || navidromeSong.artists?.[0]?.name
                    || '';
                const plainLyrics = await navidromeApi.getLyrics(config, artistName, navidromeSong.name);
                if (plainLyrics?.trim()) {
                    navidromeSong.cachedPlainLyrics = plainLyrics;
                }
            }
        } catch (e) {
            console.warn('[App] Failed to fetch Navidrome lyrics:', e);
        }
    }
};

/**
 * 把一份导入的歌词记成这首歌的匹配结果。
 *
 * Navidrome 歌曲只有一个歌词读取口：`navidrome_match_<id>`。播放那条路不读 `lyric_*_state`
 * （那是在线歌曲的存档方式），所以单曲导入与批量导入都写这里——播放、以及歌词导出，因此看到同一份。
 * 已有的匹配记录是合并而不是替换：封面和匹配到的元数据属于另一件事，不该被一份歌词文件抹掉。
 */
export const saveImportedNavidromeLyrics = async (
    navidromeId: string,
    lyrics: LyricData,
): Promise<void> => {
    const key = getNavidromeMatchCacheKeyForId(navidromeId);
    const previous = await getFromCache<NavidromeMatchData>(key);
    await saveToCache(key, {
        ...previous,
        matchedLyrics: lyrics,
        matchedIsPureMusic: false,
        lyricsSource: 'online',
        useOnlineLyrics: true,
    } satisfies NavidromeMatchData);
};
