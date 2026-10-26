import {useCallback, useEffect, useRef, useState} from 'react';
import type {DawEngine, DawSnapshot} from '../daw/DawEngine';
import {trackService} from '../services/trackService';
import type {Track, TrackSample} from '../types/map';

export type SampleStatus = 'loading' | 'ready' | 'error' | 'off';

export interface SampleState {
    status: SampleStatus;
    error?: string;
}

export type EngineStatus = 'idle' | 'booting' | 'ready' | 'error';

const sourceId = (track: Track, sample: TrackSample) => `${track.id}:${sample.id}`;

/**
 * Связывает каталог (трек → семплы) с мини-DAW:
 * открытие трека пересоздаёт проект и раскладывает его семплы по дорожкам.
 * Тяжёлый движок OpenDAW подгружается лениво — при первом открытии трека.
 */
export const useStudio = () => {
    const engineRef = useRef<DawEngine | null>(null);
    const enginePromise = useRef<Promise<DawEngine> | null>(null);
    const openToken = useRef(0);

    const [engineStatus, setEngineStatus] = useState<EngineStatus>('idle');
    const [engineError, setEngineError] = useState<string | null>(null);
    const [snapshot, setSnapshot] = useState<DawSnapshot | null>(null);

    const [openedTrack, setOpenedTrack] = useState<Track | null>(null);
    const [samples, setSamples] = useState<TrackSample[]>([]);
    const [samplesLoading, setSamplesLoading] = useState(false);
    const [sampleStates, setSampleStates] = useState<Record<string, SampleState>>({});
    const [mixedTracks, setMixedTracks] = useState<Track[]>([]);
    const [engine, setEngine] = useState<DawEngine | null>(null);

    const ensureEngine = useCallback((): Promise<DawEngine> => {
        enginePromise.current ??= (async () => {
            setEngineStatus('booting');
            try {
                const {DawEngine: Engine} = await import('../daw/DawEngine');
                const created = await Engine.create();
                created.subscribe(setSnapshot);
                setSnapshot(created.snapshot);
                engineRef.current = created;
                setEngine(created);
                setEngineStatus('ready');
                return created;
            } catch (error) {
                console.error('Не удалось запустить OpenDAW:', error);
                setEngineError(error instanceof Error ? error.message : String(error));
                setEngineStatus('error');
                enginePromise.current = null;
                throw error;
            }
        })();
        return enginePromise.current;
    }, []);

    useEffect(() => () => {
        engineRef.current?.dispose();
        engineRef.current = null;
    }, []);

    const setState = useCallback((id: string | number, state: SampleState) => {
        setSampleStates(prev => ({...prev, [id]: state}));
    }, []);

    const loadSample = useCallback(async (daw: DawEngine, track: Track, sample: TrackSample, token: number) => {
        const id = sourceId(track, sample);
        setState(sample.id, {status: 'loading'});
        try {
            await daw.addSample({
                id,
                sourceTrackId: String(track.id),
                name: sample.name,
                group: track.title,
                url: trackService.resolveAudioUrl(sample.url),
            });
            if (token === openToken.current) setState(sample.id, {status: 'ready'});
        } catch (error) {
            console.warn(`Семпл «${sample.name}» не загрузился:`, error);
            if (token === openToken.current) {
                setState(sample.id, {status: 'error', error: error instanceof Error ? error.message : String(error)});
            }
        }
    }, [setState]);

    /** Открыть трек: заменить содержимое DAW семплами этого трека. */
    const openTrack = useCallback(async (track: Track, options: { autoplay?: boolean } = {}) => {
        const token = ++openToken.current;
        setOpenedTrack(track);
        setSamples([]);
        setSampleStates({});
        setMixedTracks([track]);
        setSamplesLoading(true);
        const [{data}, daw] = await Promise.all([
            trackService.getSamples(track),
            ensureEngine().catch(() => null),
        ]);
        if (token !== openToken.current) return;
        setSamples(data);
        setSamplesLoading(false);
        if (daw === null) return;
        daw.reset();
        setSampleStates(Object.fromEntries(data.map(sample => [sample.id, {status: 'loading' as const}])));
        for (const sample of data) {
            if (token !== openToken.current) return;
            await loadSample(daw, track, sample, token);
        }
        if (options.autoplay && token === openToken.current && daw.snapshot.lanes.length > 0) daw.play();
    }, [ensureEngine, loadSample]);

    /** «Добавить в микшер»: докинуть семплы трека в текущий проект, не сбрасывая его. */
    const addTrack = useCallback(async (track: Track) => {
        if (openedTrack === null) {
            await openTrack(track);
            return;
        }
        if (mixedTracks.some(item => item.id === track.id)) return;
        const token = openToken.current;
        setMixedTracks(prev => [...prev, track]);
        const [{data}, daw] = await Promise.all([
            trackService.getSamples(track),
            ensureEngine().catch(() => null),
        ]);
        if (daw === null || token !== openToken.current) return;
        for (const sample of data) {
            if (token !== openToken.current) return;
            try {
                await daw.addSample({
                    id: sourceId(track, sample),
                    sourceTrackId: String(track.id),
                    name: sample.name,
                    group: track.title,
                    url: trackService.resolveAudioUrl(sample.url),
                });
            } catch (error) {
                console.warn(`Семпл «${sample.name}» не загрузился:`, error);
            }
        }
    }, [ensureEngine, mixedTracks, openTrack, openedTrack]);

    /** Включить/выключить семпл открытого трека (дорожка появляется/пропадает в DAW). */
    const toggleSample = useCallback(async (sample: TrackSample) => {
        const daw = engineRef.current;
        if (daw === null || openedTrack === null) return;
        const id = sourceId(openedTrack, sample);
        if (daw.hasSource(id)) {
            daw.removeSource(id);
            setState(sample.id, {status: 'off'});
        } else {
            await loadSample(daw, openedTrack, sample, openToken.current);
        }
    }, [loadSample, openedTrack, setState]);

    /** Добавить ещё одну копию того же семпла — отдельную дорожку (её можно двигать независимо). */
    const addSampleCopy = useCallback(async (sample: TrackSample) => {
        const daw = engineRef.current;
        if (daw === null || openedTrack === null) return;
        const id = sourceId(openedTrack, sample);
        // если первой дорожки ещё нет — сначала создаём её (с загрузкой файла)
        if (!daw.hasSource(id)) {
            await loadSample(daw, openedTrack, sample, openToken.current);
            return;
        }
        const lane = daw.snapshot.lanes.find(lane => lane.sourceId === id);
        if (lane !== undefined) daw.duplicateLane(lane.id);
    }, [loadSample, openedTrack]);

    /** Сколько дорожек-копий этого семпла сейчас в DAW. */
    const copyCount = useCallback((sample: TrackSample): number => {
        const daw = engineRef.current;
        if (daw === null || openedTrack === null) return 0;
        return daw.copyCount(sourceId(openedTrack, sample));
    }, [openedTrack]);

    const closeTrack = useCallback(() => {
        openToken.current++;
        setOpenedTrack(null);
        setSamples([]);
        setSampleStates({});
        setMixedTracks([]);
        engineRef.current?.reset();
    }, []);

    return {
        engine, engineStatus, engineError, snapshot,
        openedTrack, samples, samplesLoading, sampleStates, mixedTracks,
        openTrack, addTrack, toggleSample, addSampleCopy, copyCount, closeTrack,
    };
};

export type Studio = ReturnType<typeof useStudio>;
