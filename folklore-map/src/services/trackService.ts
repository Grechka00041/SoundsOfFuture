import type {Track, TrackSample} from '../types/map';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export type {Track, TrackSample};

export const trackService = {

    getTracksByRegion: async (regionName: string): Promise<Track[]> => {
        try {
            // encodeURIComponent нужен для безопасной передачи кириллицы в URL
            const response = await fetch(`${API_BASE_URL}/api/tracks/${encodeURIComponent(regionName)}`);

            if (!response.ok) {
                if (response.status === 404) return []; // Возвращаем пустой массив, если регион пуст
                throw new Error(`Ошибка загрузки треков: ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            console.error(`Не удалось получить треки для "${regionName}":`, error);
            return [];
        }
    },

    /** Семплы трека. `error` заполнен, если не удалось связаться с сервером. */
    getSamples: async (track: Track): Promise<{ data: TrackSample[]; error?: string }> => {
        try {
            const response = await fetch(`${API_BASE_URL}/api/tracks/${track.id}/samples`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data: TrackSample[] = await response.json();
            return {data: data.sort((a, b) => a.order - b.order)};
        } catch (error) {
            console.error(`Не удалось получить семплы трека ${track.id}:`, error);
            return {data: [], error: error instanceof Error ? error.message : String(error)};
        }
    },

    /** Абсолютные ссылки (http…) — как есть; `/audio/x.wav` — файл из public фронтенда. */
    resolveAudioUrl: (url: string): string => {
        if (/^https?:\/\//i.test(url)) return url;
        return `${import.meta.env.BASE_URL.replace(/\/$/, '')}/${url.replace(/^\//, '')}`;
    },
};
