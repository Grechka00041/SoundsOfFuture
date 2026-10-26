import { useState, useEffect } from 'react';
import type {RegionGeoJSON} from '../types/map';

export const useGeoData = (url: string) => {
    const [data, setData] = useState<RegionGeoJSON | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);

        fetch(url)
            .then(res => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.json();
            })
            .then(json => {
                if (!cancelled) {
                    setData(json);
                    setLoading(false);
                }
            })
            .catch(err => {
                if (!cancelled) {
                    setError(err.message);
                    setLoading(false);
                }
            });

        return () => { cancelled = true; };
    }, [url]);

    return { data, loading, error };
};