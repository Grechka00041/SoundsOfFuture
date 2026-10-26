import {useState} from 'react';
import type {Studio, SampleStatus} from '../hooks/useStudio';
import type {Track, TrackSample} from '../types/map';
import {trackService} from '../services/trackService';
import {MiniDaw} from './MiniDaw';
import styles from './SidePanel.module.css';

interface Props {
    regionName: string | null;
    tracks: Track[];
    loading: boolean;
    studio: Studio;
}

const formatDuration = (seconds: number) =>
    `${Math.floor(seconds / 60)}:${Math.round(seconds % 60).toString().padStart(2, '0')}`;

const STATUS_LABEL: Record<SampleStatus, string> = {
    loading: 'ЗАГРУЗКА…',
    ready: 'В DAW',
    error: 'ОШИБКА',
    off: 'ВЫКЛ',
};

export const SidePanel = ({regionName, tracks, loading, studio}: Props) => {
    const {openedTrack, samples, samplesLoading, sampleStates, mixedTracks} = studio;
    const [downloadState, setDownloadState] = useState<string | null>(null);

    /** Скачивает все семплы открытого трека (по одному файлу на семпл). */
    const downloadAllSamples = async () => {
        if (openedTrack === null || downloadState !== null) return;
        setDownloadState('…');
        try {
            const {data: list} = samples.length > 0
                ? {data: samples as TrackSample[]}
                : await trackService.getSamples(openedTrack);
            for (let index = 0; index < list.length; index++) {
                const sample = list[index];
                setDownloadState(`${index + 1}/${list.length}`);
                try {
                    const response = await fetch(trackService.resolveAudioUrl(sample.url));
                    if (!response.ok) continue;
                    const blob = await response.blob();
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement('a');
                    const extension = sample.url.split('.').pop()?.split(/[?#]/)[0] ?? 'mp3';
                    link.href = url;
                    link.download = `${sample.name.replace(/[\\/:*?"<>|]+/g, '_')}.${extension}`;
                    link.click();
                    setTimeout(() => URL.revokeObjectURL(url), 10_000);
                } catch {
                    /* пропускаем недоступный семпл */
                }
                await new Promise(resolve => setTimeout(resolve, 350));
            }
        } finally {
            setDownloadState(null);
        }
    };

    /** Ещё одна копия того же семпла — отдельная дорожка в DAW. */
    const addCopy = (sample: TrackSample) => {
        if (openedTrack === null) return;
        void studio.addSampleCopy(sample);
    };

    return (
        <div className={styles.panel}>
            <section className={`${styles.section} ${styles.tracks}`}>
                <h2 className={styles.heading}>
                    <span>ТРЕКИ</span>
                    {regionName && <span className={styles.region} title={regionName}>{regionName}</span>}
                </h2>

                <div className={styles.scroll}>
                    {!regionName && (
                        <p className={styles.hint}>Выберите регион на карте — здесь появится список записей.</p>
                    )}
                    {regionName && loading && <p className={`${styles.hint} ${styles.blink}`}>ЗАГРУЗКА ТРЕКОВ…</p>}
                    {regionName && !loading && tracks.length === 0 && (
                        <p className={styles.hint}>В этом регионе пока нет записей.</p>
                    )}

                    <ul className={styles.list}>
                        {tracks.map(track => {
                            const isOpen = openedTrack?.id === track.id;
                            const inMixer = mixedTracks.some(item => item.id === track.id);
                            return (
                                <li
                                    key={track.id}
                                    className={`${styles.row} ${isOpen ? styles.rowActive : ''}`}
                                    onClick={() => void studio.openTrack(track)}
                                    title="Открыть трек: его семплы появятся в DAW"
                                >
                                    <div className={styles.rowMain}>
                                        <span className={styles.rowTitle}>{track.title}</span>
                                        <span className={styles.rowMeta}>
                                            {track.artist ?? (track.isInstrument ? 'инструмент' : 'исполнитель не указан')}
                                            {' · '}{formatDuration(track.duration)}
                                            {' · '}{track.samplesCount ?? 0} сэмпл.
                                        </span>
                                    </div>
                                    <button
                                        className={styles.iconBtn}
                                        disabled={isOpen && inMixer && mixedTracks.length === 1}
                                        onClick={event => {
                                            event.stopPropagation();
                                            void studio.addTrack(track);
                                        }}
                                        title="Добавить в микшер (к уже открытым трекам)"
                                    >{inMixer ? '✓' : '+'}</button>
                                    <button
                                        className={`${styles.iconBtn} ${styles.iconPlay}`}
                                        onClick={event => {
                                            event.stopPropagation();
                                            void studio.openTrack(track, {autoplay: true});
                                        }}
                                        title="Открыть и слушать"
                                    >▶</button>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            </section>

            {openedTrack && (
                <section className={`${styles.section} ${styles.samples}`}>
                    <h2 className={styles.heading}>
                        <span>СЕМПЛЫ</span>
                        <span className={styles.region} title={openedTrack.title}>{openedTrack.title}</span>
                        <button
                            className={styles.iconBtn}
                            onClick={() => void downloadAllSamples()}
                            disabled={samplesLoading || samples.length === 0 || downloadState !== null}
                            title="Скачать все семплы этого трека"
                        >{downloadState === null ? '⭳ ВСЕ' : downloadState}</button>
                        <button className={styles.close} onClick={studio.closeTrack} title="Закрыть трек">✕</button>
                    </h2>
                    <div className={styles.scroll}>
                        {samplesLoading && <p className={`${styles.hint} ${styles.blink}`}>ЗАГРУЗКА СЕМПЛОВ…</p>}
                        {!samplesLoading && samples.length === 0 && (
                            <p className={styles.hint}>У этого трека пока нет семплов.</p>
                        )}
                        <ul className={styles.list}>
                            {samples.map(sample => {
                                const state = sampleStates[sample.id];
                                const status: SampleStatus = state?.status ?? 'loading';
                                const enabled = status === 'ready' || status === 'loading';
                                const copies = studio.copyCount(sample);
                                return (
                                    <li
                                        key={sample.id}
                                        className={`${styles.sample} ${enabled ? '' : styles.sampleOff}`}
                                        onClick={() => void studio.toggleSample(sample)}
                                        title={status === 'error' ? state?.error : 'Клик — добавить/убрать дорожку в DAW'}
                                    >
                                        <span className={`${styles.check} ${enabled ? styles.checkOn : ''}`}>
                                            {enabled ? '■' : '□'}
                                        </span>
                                        <span className={styles.rowTitle}>{sample.name}</span>
                                        {copies > 1 && <span className={styles.copies}>×{copies}</span>}
                                        <button
                                            className={styles.iconBtn}
                                            onClick={event => {
                                                event.stopPropagation();
                                                addCopy(sample);
                                            }}
                                            disabled={!enabled}
                                            title="Добавить ещё одну копию семпла на отдельную дорожку"
                                        >⧉</button>
                                        <span className={`${styles.status} ${styles[`status_${status}`]}`}>
                                            {STATUS_LABEL[status]}
                                        </span>
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                </section>
            )}

            <section className={styles.daw}>
                <MiniDaw studio={studio}/>
            </section>
        </div>
    );
};
