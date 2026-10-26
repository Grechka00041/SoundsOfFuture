import {useEffect, useState} from 'react';
import {trackService} from '../services/trackService';
import type {Track} from '../types/map';

/** Треки выбранного региона. Устаревшие ответы (быстрая смена региона) отбрасываются. */
export const useRegionTracks = (regionName: string | null) => {
    const [state, setState] = useState<{ region: string | null; tracks: Track[] }>({region: null, tracks: []});

    useEffect(() => {
        if (!regionName) return;
        let cancelled = false;
        trackService.getTracksByRegion(regionName).then(tracks => {
            if (!cancelled) setState({region: regionName, tracks});
        });
        return () => {
            cancelled = true;
        };
    }, [regionName]);

    // пока для выбранного региона ответ не пришёл — это «загрузка»
    const loading = regionName !== null && state.region !== regionName;
    const tracks = regionName !== null && !loading ? state.tracks : [];
    return {tracks, loading};
};
