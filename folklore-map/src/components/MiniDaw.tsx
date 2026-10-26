import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent} from 'react';
import type {EffectKind, LaneInfo, RegionInfo} from '../daw/DawEngine';
import {PARAM_SPECS} from '../daw/DawEngine';
import type {Studio} from '../hooks/useStudio';
import styles from './MiniDaw.module.css';

const HEADER_W = 156;
const LANE_H = 68;
const RULER_H = 26;
const MIN_PPS = 4;
const MAX_PPS = 480;
const EDGE_PX = 7;
const NICE_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

const EFFECT_KINDS: {kind: EffectKind, label: string}[] = [
    {kind: 'delay', label: 'Delay'},
    {kind: 'eq', label: 'EQ'},
    {kind: 'saturation', label: 'Сатурация'},
    {kind: 'distortion', label: 'Дисторшн'},
    {kind: 'reverb', label: 'Реверб'},
];

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const formatTime = (seconds: number, precise = true) => {
    const safe = Math.max(0, seconds);
    const minutes = Math.floor(safe / 60);
    const rest = safe - minutes * 60;
    const whole = Math.floor(rest);
    const head = `${minutes}:${whole.toString().padStart(2, '0')}`;
    return precise ? `${head}.${Math.floor((rest - whole) * 100).toString().padStart(2, '0')}` : head;
};

const laneColor = (hue: number, alpha = 1) => `hsl(${hue} 85% 62% / ${alpha})`;

type DragMode = 'move' | 'trim-start' | 'trim-end';

interface DragState {
    mode: DragMode;
    regionId: string;
    pointerX: number;
    pointerY: number;
    laneIndex: number;
    start: number;
    duration: number;
    moved: boolean;
}

interface Props {
    studio: Studio;
}

export const MiniDaw = ({studio}: Props) => {
    const {engine, engineStatus, engineError, snapshot, openedTrack, mixedTracks} = studio;

    const rootRef = useRef<HTMLDivElement>(null);
    const scrollerRef = useRef<HTMLDivElement>(null);
    const rulerRef = useRef<HTMLDivElement>(null);
    const playheadRef = useRef<HTMLDivElement>(null);
    const timeRef = useRef<HTMLSpanElement>(null);
    const canvasRefs = useRef(new Map<string, HTMLCanvasElement>());
    const dragRef = useRef<DragState | null>(null);
    const userZoomed = useRef(false);
    const drawQueued = useRef(false);

    const [pps, setPps] = useState(40);
    const [viewport, setViewport] = useState({width: 600, height: 300});
    const [selectedRegion, setSelectedRegion] = useState<string | null>(null);
    const [playing, setPlaying] = useState(false);
    const [exporting, setExporting] = useState<number | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const [fxOpen, setFxOpen] = useState<Record<string, boolean>>({});

    const lanes = snapshot?.lanes ?? [];
    const lanesRef = useRef<LaneInfo[]>([]);
    lanesRef.current = lanes;
    const length = snapshot?.length ?? 0;
    const trackAreaWidth = Math.max(viewport.width - HEADER_W, 100);
    const contentWidth = Math.max(trackAreaWidth, (length + 6) * pps + 40);

    // ── размеры области таймлайна ──
    useEffect(() => {
        const scroller = scrollerRef.current;
        if (!scroller) return;
        const observer = new ResizeObserver(() => {
            setViewport({width: scroller.clientWidth, height: scroller.clientHeight});
        });
        observer.observe(scroller);
        setViewport({width: scroller.clientWidth, height: scroller.clientHeight});
        return () => observer.disconnect();
    }, []);

    // ── первое «вписать по ширине» после загрузки семплов ──
    useEffect(() => {
        if (lanes.length === 0) {
            userZoomed.current = false;
            return;
        }
        if (userZoomed.current || length <= 0) return;
        setPps(clamp((trackAreaWidth - 28) / (length + 0.5), MIN_PPS, MAX_PPS));
    }, [lanes.length, length, trackAreaWidth]);

    useEffect(() => {
        if (selectedRegion !== null && !lanes.some(lane => lane.regions.some(region => region.id === selectedRegion))) {
            setSelectedRegion(null);
        }
    }, [lanes, selectedRegion]);

    // ── отрисовка волновых форм ──
    const draw = useCallback(() => {
        const scroller = scrollerRef.current;
        if (!scroller) return;
        const scrollLeft = scroller.scrollLeft;
        const dpr = window.devicePixelRatio || 1;
        const width = trackAreaWidth;
        lanes.forEach(lane => {
            const canvas = canvasRefs.current.get(lane.id);
            if (!canvas) return;
            const pxW = Math.max(1, Math.round(width * dpr));
            const pxH = Math.round(LANE_H * dpr);
            if (canvas.width !== pxW || canvas.height !== pxH) {
                canvas.width = pxW;
                canvas.height = pxH;
            }
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, width, LANE_H);
            const {peaks, secondsPerBin} = lane.waveform;
            const mid = LANE_H / 2;
            const amp = mid - 8;
            lane.regions.forEach(region => {
                const x0 = region.start * pps - scrollLeft;
                const x1 = x0 + region.duration * pps;
                if (x1 < 0 || x0 > width) return;
                ctx.fillStyle = region.muted || lane.mute
                    ? laneColor(lane.hue, 0.28) : laneColor(lane.hue, 0.95);
                for (let px = Math.max(0, Math.floor(x0)); px < Math.min(width, Math.ceil(x1)); px++) {
                    const regionTime = (px + scrollLeft) / pps - region.start;
                    if (regionTime < 0 || regionTime > region.duration) continue;
                    const src0 = region.srcStart + regionTime;
                    const bin0 = Math.max(0, Math.floor(src0 / secondsPerBin));
                    const bin1 = Math.max(bin0 + 1, Math.ceil((src0 + 1 / pps) / secondsPerBin));
                    let min = 0;
                    let max = 0;
                    for (let bin = bin0; bin < bin1 && bin * 2 + 1 < peaks.length; bin++) {
                        if (peaks[bin * 2] < min) min = peaks[bin * 2];
                        if (peaks[bin * 2 + 1] > max) max = peaks[bin * 2 + 1];
                    }
                    const top = mid - max * amp;
                    const bottom = mid - min * amp;
                    ctx.fillRect(px, top, 1, Math.max(1, bottom - top));
                }
            });
        });
    }, [lanes, pps, trackAreaWidth]);

    const scheduleDraw = useCallback(() => {
        if (drawQueued.current) return;
        drawQueued.current = true;
        requestAnimationFrame(() => {
            drawQueued.current = false;
            draw();
        });
    }, [draw]);

    useEffect(() => {
        scheduleDraw();
    }, [scheduleDraw, selectedRegion, viewport]);

    // ── плейхед, время, состояние play/pause ──
    useEffect(() => {
        if (!engine) return;
        let frame = 0;
        let lastPlaying = false;
        const tick = () => {
            const time = engine.position;
            const isPlaying = engine.isPlaying;
            if (isPlaying !== lastPlaying) {
                lastPlaying = isPlaying;
                setPlaying(isPlaying);
            }
            const head = playheadRef.current;
            if (head) head.style.transform = `translateX(${HEADER_W + time * pps}px)`;
            if (timeRef.current) timeRef.current.textContent = formatTime(time);
            const scroller = scrollerRef.current;
            if (scroller && isPlaying) {
                const x = time * pps;
                if (x > scroller.scrollLeft + trackAreaWidth - 30 || x < scroller.scrollLeft) {
                    scroller.scrollLeft = Math.max(0, x - 30);
                }
            }
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [engine, pps, trackAreaWidth]);

    // ── транспорт и правки ──
    const togglePlay = useCallback(() => {
        if (!engine || lanes.length === 0) return;
        if (engine.isPlaying) engine.pause();
        else {
            // после конца последнего региона начинаем сначала
            if (length > 0 && engine.position >= length - 0.02) engine.seek(0);
            engine.play();
        }
    }, [engine, lanes.length, length]);

    const stop = useCallback(() => {
        engine?.stop();
    }, [engine]);

    const findRegion = useCallback((id: string | null): { lane: LaneInfo, region: RegionInfo } | null => {
        if (id === null) return null;
        for (const lane of lanes) {
            const region = lane.regions.find(item => item.id === id);
            if (region) return {lane, region};
        }
        return null;
    }, [lanes]);

    const split = useCallback(() => {
        if (!engine) return;
        const time = engine.position;
        const inside = (region: RegionInfo) => time > region.start + 0.02 && time < region.start + region.duration - 0.02;
        const selected = findRegion(selectedRegion);
        const targets = selected && inside(selected.region)
            ? [selected.region]
            : lanes.flatMap(lane => lane.regions.filter(inside));
        if (targets.length === 0) {
            setMessage('Поставьте курсор внутрь региона (клик по линейке), затем нажмите «Разрезать».');
            return;
        }
        engine.splitRegions(targets.map(region => region.id), time);
    }, [engine, findRegion, lanes, selectedRegion]);

    const removeSelected = useCallback(() => {
        if (!engine || selectedRegion === null) return;
        engine.deleteRegion(selectedRegion);
        setSelectedRegion(null);
    }, [engine, selectedRegion]);

    /** Убрать дорожку: все её копии или только выбранную (если копий несколько). */
    const closeLane = useCallback((lane: LaneInfo) => {
        if (!engine) return;
        const copies = lanes.filter(item => item.sourceId === lane.sourceId).length;
        if (copies > 1) engine.removeLane(lane.id);
        else engine.removeSource(lane.sourceId);
    }, [engine, lanes]);

    const zoomBy = useCallback((factor: number) => {
        userZoomed.current = true;
        setPps(value => clamp(value * factor, MIN_PPS, MAX_PPS));
    }, []);

    const fitToView = useCallback(() => {
        userZoomed.current = false;
        if (length > 0) setPps(clamp((trackAreaWidth - 28) / (length + 0.5), MIN_PPS, MAX_PPS));
    }, [length, trackAreaWidth]);

    const exportWav = useCallback(async () => {
        if (!engine || exporting !== null) return;
        setExporting(0);
        setMessage(null);
        try {
            const blob = await engine.exportWav(value => setExporting(value));
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `${(openedTrack?.title ?? 'mix').replace(/[\\/:*?"<>|]+/g, '_')} (правка).wav`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 10_000);
        } catch (error) {
            setMessage(`Экспорт не удался: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setExporting(null);
        }
    }, [engine, exporting, openedTrack]);

    // ── мышь: перемещение/обрезка регионов ──
    const onRegionPointerDown = (event: ReactPointerEvent<HTMLDivElement>, region: RegionInfo) => {
        if (!engine || event.button !== 0) return;
        event.stopPropagation();
        rootRef.current?.focus({preventScroll: true});
        setSelectedRegion(region.id);
        const rect = event.currentTarget.getBoundingClientRect();
        const offsetX = event.clientX - rect.left;
        const mode: DragMode = offsetX <= EDGE_PX ? 'trim-start'
            : offsetX >= rect.width - EDGE_PX ? 'trim-end' : 'move';
        dragRef.current = {
            mode, regionId: region.id, pointerX: event.clientX, pointerY: event.clientY,
            laneIndex: lanes.findIndex(lane => lane.regions.some(item => item.id === region.id)),
            start: region.start, duration: region.duration, moved: false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const onRegionPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!engine || !drag) return;
        const delta = (event.clientX - drag.pointerX) / pps;
        if (!drag.moved && Math.abs(event.clientX - drag.pointerX) < 2) return;
        drag.moved = true;
        if (drag.mode === 'move') {
            // вертикаль — перенос региона на другую дорожку
            const laneDelta = Math.round((event.clientY - drag.pointerY) / LANE_H);
            const target = clamp(drag.laneIndex + laneDelta, 0, lanesRef.current.length - 1);
            const targetLane = lanesRef.current[target];
            if (targetLane !== undefined) engine.moveRegionToLane(drag.regionId, targetLane.id, drag.start + delta, true);
            else engine.moveRegion(drag.regionId, drag.start + delta, true);
        }
        else if (drag.mode === 'trim-start') engine.trimStart(drag.regionId, drag.start + delta, true);
        else engine.trimEnd(drag.regionId, drag.start + drag.duration + delta, true);
    };

    const onRegionPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        dragRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        if (engine && drag?.moved) engine.commitEdit();
    };

    // ── мышь: перемотка по линейке и пустым местам дорожек ──
    const timeAtClientX = (clientX: number) => {
        const rect = rulerRef.current?.getBoundingClientRect();
        return rect ? Math.max(0, (clientX - rect.left) / pps) : 0;
    };

    const seekDragging = useRef(false);
    const onSeekDown = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!engine || event.button !== 0) return;
        rootRef.current?.focus({preventScroll: true});
        seekDragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        engine.seek(timeAtClientX(event.clientX));
        if (event.currentTarget !== rulerRef.current) setSelectedRegion(null);
    };
    const onSeekMove = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (seekDragging.current && engine) engine.seek(timeAtClientX(event.clientX));
    };
    const onSeekUp = (event: ReactPointerEvent<HTMLDivElement>) => {
        seekDragging.current = false;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    };

    // ── клавиатура ──
    const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
        const target = event.target as HTMLElement;
        if (target.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'range') return;
        const key = event.key.toLowerCase();
        const mod = event.ctrlKey || event.metaKey;
        if (event.key === ' ') {
            event.preventDefault();
            togglePlay();
        } else if (mod && key === 'z') {
            event.preventDefault();
            if (event.shiftKey) engine?.redo(); else engine?.undo();
        } else if (mod && key === 'y') {
            event.preventDefault();
            engine?.redo();
        } else if (!mod && key === 's') {
            event.preventDefault();
            split();
        } else if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            removeSelected();
        } else if (event.key === 'Escape') {
            setSelectedRegion(null);
        } else if (event.key === 'Home') {
            engine?.seek(0);
        }
    };

    // ── линейка ──
    const ticks = useMemo(() => {
        const step = NICE_STEPS.find(candidate => candidate * pps >= 72) ?? NICE_STEPS[NICE_STEPS.length - 1];
        const result: { x: number, label: string }[] = [];
        for (let time = 0; time * pps < contentWidth; time += step) {
            result.push({x: time * pps, label: formatTime(time, step < 1)});
        }
        return result;
    }, [pps, contentWidth]);

    const hasLanes = lanes.length > 0;
    const canUndo = snapshot?.canUndo ?? false;
    const canRedo = snapshot?.canRedo ?? false;
    const booting = engineStatus === 'booting';

    const subtitle = mixedTracks.length > 1
        ? `${mixedTracks.length} трека в микшере`
        : openedTrack?.title ?? 'трек не выбран';

    return (
        <div
            ref={rootRef}
            className={styles.daw}
            tabIndex={0}
            onKeyDown={onKeyDown}
            aria-label="Мини-DAW на движке OpenDAW"
        >
            <div className={styles.toolbar}>
                <div className={styles.group}>
                    <button className={styles.btn} onClick={stop} disabled={!hasLanes} title="Стоп (в начало)">■</button>
                    <button
                        className={`${styles.btn} ${styles.primary}`}
                        onClick={togglePlay}
                        disabled={!hasLanes}
                        title="Играть / пауза (Пробел)"
                    >
                        {playing ? '❚❚' : '▶'}
                    </button>
                    <span className={styles.time}><span ref={timeRef}>0:00.00</span>
                        <span className={styles.timeTotal}> / {formatTime(length)}</span></span>
                </div>
                <div className={styles.group}>
                    <button className={styles.btn} onClick={() => engine?.undo()} disabled={!canUndo}
                            title="Отменить (Ctrl+Z)">↶</button>
                    <button className={styles.btn} onClick={() => engine?.redo()} disabled={!canRedo}
                            title="Повторить (Ctrl+Shift+Z)">↷</button>
                    <button className={styles.btn} onClick={split} disabled={!hasLanes}
                            title="Разрезать регион в позиции курсора (S)">✂ РАЗРЕЗАТЬ</button>
                    <button className={styles.btn} onClick={removeSelected} disabled={selectedRegion === null}
                            title="Удалить выбранный регион (Delete)">✕ УДАЛИТЬ</button>
                </div>
                <div className={styles.group}>
                    <button className={styles.btn} onClick={() => zoomBy(1 / 1.5)} title="Уменьшить масштаб">−</button>
                    <button className={styles.btn} onClick={fitToView} disabled={!hasLanes}
                            title="Вписать в ширину">⤢</button>
                    <button className={styles.btn} onClick={() => zoomBy(1.5)} title="Увеличить масштаб">+</button>
                    <button className={`${styles.btn} ${styles.accent}`} onClick={exportWav}
                            disabled={!hasLanes || exporting !== null} title="Сохранить сведение в WAV">
                        {exporting === null ? '⭳ WAV' : `${Math.round(exporting * 100)}%`}
                    </button>
                </div>
            </div>

            <div className={styles.titleRow}>
                <span className={styles.dawName}>OPENDAW · MINI</span>
                <span className={styles.subtitle} title={subtitle}>{subtitle}</span>
            </div>

            <div className={styles.body}>
                <div ref={scrollerRef} className={styles.scroller} onScroll={scheduleDraw}>
                    <div className={styles.content} style={{width: HEADER_W + contentWidth}}>
                        <div className={styles.rulerRow} style={{height: RULER_H}}>
                            <div className={styles.corner} style={{width: HEADER_W}}>ДОРОЖКИ</div>
                            <div
                                ref={rulerRef}
                                className={styles.ruler}
                                style={{width: contentWidth}}
                                onPointerDown={onSeekDown}
                                onPointerMove={onSeekMove}
                                onPointerUp={onSeekUp}
                            >
                                {ticks.map(tick => (
                                    <div key={tick.x} className={styles.tick} style={{left: tick.x}}>
                                        <span>{tick.label}</span>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {lanes.map(lane => (
                            <div key={lane.id} className={styles.lane} style={{height: LANE_H}}>
                                <div className={styles.laneHeader} style={{width: HEADER_W}}>
                                    <div className={styles.laneTop}>
                                        <span className={styles.dot} style={{background: laneColor(lane.hue)}}/>
                                        <span className={styles.laneName} title={`${lane.title} — ${lane.group}`}>
                                            {lane.title}
                                        </span>
                                        <button
                                            className={styles.laneClose}
                                            title="Дублировать дорожку (ещё одна копия семпла)"
                                            onClick={() => engine?.duplicateLane(lane.id)}
                                        >⧉</button>
                                        <button
                                            className={styles.laneClose}
                                            title="Убрать дорожку"
                                            onClick={() => closeLane(lane)}
                                        >✕</button>
                                    </div>
                                    {mixedTracks.length > 1 &&
                                        <div className={styles.laneGroup} title={lane.group}>{lane.group}</div>}
                                    <div className={styles.laneControls}>
                                        <button
                                            className={`${styles.mini} ${lane.mute ? styles.miniOnMute : ''}`}
                                            onClick={() => engine?.setLaneMute(lane.id, !lane.mute)}
                                            title="Заглушить"
                                        >M</button>
                                        <button
                                            className={`${styles.mini} ${lane.solo ? styles.miniOnSolo : ''}`}
                                            onClick={() => engine?.setLaneSolo(lane.id, !lane.solo)}
                                            title="Соло"
                                        >S</button>
                                        <button
                                            className={`${styles.mini} ${lane.effects.length > 0 ? styles.miniOnFx : ''}`}
                                            onClick={() => setFxOpen(prev => ({...prev, [lane.id]: !prev[lane.id]}))}
                                            title="Эффекты дорожки"
                                        >FX{lane.effects.length > 0 ? ` ${lane.effects.length}` : ''}</button>
                                        <input
                                            className={styles.volume}
                                            type="range"
                                            min={-60}
                                            max={6}
                                            step={0.5}
                                            value={lane.volumeDb}
                                            onChange={event => engine?.setLaneVolume(lane.id, Number(event.target.value))}
                                            onPointerUp={() => engine?.commitEdit()}
                                            title={`Громкость: ${lane.volumeDb.toFixed(1)} дБ`}
                                            aria-label={`Громкость ${lane.title}`}
                                        />
                                    </div>
                                    {fxOpen[lane.id] && (
                                        <div className={styles.fxPanel} onPointerDown={event => event.stopPropagation()}>
                                            {lane.effects.map(effect => (
                                                <div key={effect.id} className={styles.fxItem}>
                                                    <div className={styles.fxItemTop}>
                                                        <button
                                                            className={`${styles.mini} ${effect.enabled ? '' : styles.miniOffEffect}`}
                                                            onClick={() => engine?.setEffectEnabled(effect.id, !effect.enabled)}
                                                            title={effect.enabled ? 'Выключить эффект' : 'Включить эффект'}
                                                        >{effect.label}</button>
                                                        <button
                                                            className={styles.laneClose}
                                                            onClick={() => engine?.removeEffect(effect.id)}
                                                            title="Удалить эффект"
                                                        >✕</button>
                                                    </div>
                                                    {(PARAM_SPECS[effect.kind] ?? effect.params.map(param => ({
                                                        key: param.key, label: param.key, min: 0, max: 1, step: 0.01,
                                                    }))).map(spec => {
                                                        const current = effect.params.find(p => p.key === spec.key)?.value ?? spec.min;
                                                        return (
                                                            <label key={spec.key} className={styles.fxParam}>
                                                                <span>{spec.label}{spec.unit ? `, ${spec.unit}` : ''}: {Math.round(current * 100) / 100}</span>
                                                                <input
                                                                    type="range"
                                                                    min={spec.min}
                                                                    max={spec.max}
                                                                    step={spec.step}
                                                                    value={current}
                                                                    onChange={event => engine?.setEffectParameter(effect.id, spec.key, Number(event.target.value))}
                                                                    onPointerUp={() => engine?.commitEdit()}
                                                                />
                                                            </label>
                                                        );
                                                    })}
                                                </div>
                                            ))}
                                            <select
                                                className={styles.fxSelect}
                                                value=""
                                                onChange={event => {
                                                    const kind = event.target.value as EffectKind | '';
                                                    if (kind !== '') engine?.addEffect(lane.id, kind);
                                                }}
                                            >
                                                <option value="" disabled>＋ добавить эффект…</option>
                                                {EFFECT_KINDS.map(item => (
                                                    <option key={item.kind} value={item.kind}>{item.label}</option>
                                                ))}
                                            </select>
                                        </div>
                                    )}
                                </div>
                                <div
                                    className={styles.laneArea}
                                    style={{width: contentWidth, height: LANE_H}}
                                    onPointerDown={onSeekDown}
                                    onPointerMove={onSeekMove}
                                    onPointerUp={onSeekUp}
                                >
                                    <canvas
                                        ref={element => {
                                            if (element) canvasRefs.current.set(lane.id, element);
                                            else canvasRefs.current.delete(lane.id);
                                        }}
                                        className={styles.canvas}
                                        style={{left: HEADER_W, width: trackAreaWidth, height: LANE_H}}
                                    />
                                    {lane.regions.map(region => (
                                        <div
                                            key={region.id}
                                            className={[
                                                styles.region,
                                                selectedRegion === region.id ? styles.regionSelected : '',
                                                region.muted ? styles.regionMuted : '',
                                            ].join(' ')}
                                            style={{
                                                left: region.start * pps,
                                                width: Math.max(2, region.duration * pps),
                                                borderColor: laneColor(lane.hue, 0.9),
                                                background: laneColor(lane.hue, selectedRegion === region.id ? 0.22 : 0.1),
                                            }}
                                            onPointerDown={event => onRegionPointerDown(event, region)}
                                            onPointerMove={event => {
                                                onRegionPointerMove(event);
                                                const rect = event.currentTarget.getBoundingClientRect();
                                                const x = event.clientX - rect.left;
                                                event.currentTarget.style.cursor =
                                                    x <= EDGE_PX || x >= rect.width - EDGE_PX ? 'ew-resize' : 'grab';
                                            }}
                                            onPointerUp={onRegionPointerUp}
                                            onPointerCancel={onRegionPointerUp}
                                            onDoubleClick={() => engine?.toggleRegionMute(region.id)}
                                            title="Перетащите — переместить; края — обрезать; двойной клик — без звука"
                                        >
                                            <span className={styles.regionLabel}>{region.label}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ))}

                        {hasLanes && (
                            <div
                                ref={playheadRef}
                                className={styles.playhead}
                                style={{top: 0, height: RULER_H + lanes.length * LANE_H}}
                            />
                        )}
                    </div>

                    {!hasLanes && (
                        <div className={styles.empty}>
                            {booting && <p className={styles.blink}>ЗАГРУЗКА ДВИЖКА OPENDAW…</p>}
                            {engineStatus === 'error' && (
                                <>
                                    <p className={styles.error}>ДВИЖОК НЕ ЗАПУСТИЛСЯ</p>
                                    <p className={styles.hint}>{engineError}</p>
                                </>
                            )}
                            {engineStatus !== 'booting' && engineStatus !== 'error' && (
                                openedTrack
                                    ? <p className={styles.blink}>ЗАГРУЗКА СЕМПЛОВ…</p>
                                    : <>
                                        <p>ДОРОЖЕК НЕТ</p>
                                        <p className={styles.hint}>
                                            Выберите регион на карте и откройте трек (▶) —
                                            его семплы появятся здесь.
                                        </p>
                                    </>
                            )}
                        </div>
                    )}
                </div>
            </div>

            <div className={styles.status}>
                {message
                    ? <span className={styles.statusWarn} onClick={() => setMessage(null)}>{message}</span>
                    : <span>Пробел — играть · S — разрезать · Delete — удалить · Ctrl+Z — отмена ·
                        края региона — обрезка · двойной клик — тишина</span>}
            </div>
        </div>
    );
};
