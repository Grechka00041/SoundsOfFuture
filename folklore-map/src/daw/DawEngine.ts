import workersUrl from '@opendaw/studio-core/workers-main.js?worker&url'
import workletsUrl from '@opendaw/studio-core/processors.js?url'
import wasmProcessorUrl from '@opendaw/studio-core-wasm/wasm-processor.js?url'
import wasmOfflineWorkerUrl from '@opendaw/studio-core-wasm/wasm-offline-worker.js?worker&url'
import {DefaultObservableValue, Option, panic, UUID} from '@opendaw/lib-std'
import type {Progress, Subscription} from '@opendaw/lib-std'
import {PPQN, WavFile} from '@opendaw/lib-dsp'
import {AnimationFrame} from '@opendaw/lib-dom'
import {BoxEditing} from '@opendaw/lib-box'
import type {AudioData} from '@opendaw/lib-dsp'
import {AudioFileBox, TrackBox, AudioUnitBox} from '@opendaw/studio-boxes'
import {
    AudioRegionBoxAdapter,
    AudioUnitBoxAdapter,
    BpmDetector,
    InstrumentFactories,
    RegionEditing,
    TrackBoxAdapter,
} from '@opendaw/studio-adapters'
import type {Sample} from '@opendaw/studio-adapters'
import {
    AudioContentFactory,
    AudioWorklets,
    FactoryCatalog,
    GlobalSampleLoaderManager,
    GlobalSoundfontLoaderManager,
    OfflineEngineRenderer,
    Project,
    SampleService,
    SoundfontService,
    Workers,
} from '@opendaw/studio-core'
import type {ProjectEnv} from '@opendaw/studio-core'
import {WasmEngine} from '@opendaw/studio-core-wasm'

// ───────────────────────── Публичные типы (то, что видит UI) ─────────────────────────

export interface RegionInfo {
    id: string
    /** начало региона на таймлайне, секунды */
    start: number
    /** длительность региона, секунды */
    duration: number
    /** с какой секунды файла начинается звук региона */
    srcStart: number
    /** сколько секунд звука осталось в файле после srcStart (предел растягивания края) */
    srcAvailable: number
    label: string
    muted: boolean
}

export interface LaneInfo {
    id: string
    /** id источника (`${trackId}:${sampleId}`) — по нему список семплов узнаёт, что дорожка есть */
    sourceId: string
    title: string
    /** название трека-источника (важно, когда в микшере несколько треков) */
    group: string
    /** id исходного трека из каталога (для группировки/удаления) */
    sourceTrackId: string
    hue: number
    mute: boolean
    solo: boolean
    volumeDb: number
    regions: RegionInfo[]
    waveform: Waveform
}

export interface Waveform {
    /** пары min/max на каждый бин, амплитуда -1..1 */
    peaks: Float32Array
    /** секунд аудио в одном бине */
    secondsPerBin: number
    duration: number
}

export interface SampleSource {
    id: string
    sourceTrackId: string
    name: string
    group: string
    url: string
    hue?: number
}

export interface DawSnapshot {
    lanes: LaneInfo[]
    bpm: number
    canUndo: boolean
    canRedo: boolean
    /** конец последнего региона, секунды */
    length: number
}

// ───────────────────────── Бутстрап движка (один раз на страницу) ─────────────────────────

const BPM = 120
const PEAK_BIN_FRAMES = 128

interface Runtime {
    context: AudioContext
    env: ProjectEnv
    sampleService: SampleService
    sampleManager: GlobalSampleLoaderManager
}

// Воркеры/AudioWorklet OpenDAW ставятся один раз на всю страницу, а состояние держим в globalThis:
// иначе горячая перезагрузка модуля (HMR) или повторная попытка после сбоя падают с «Workers are already installed».
interface BootState {
    promise: Promise<Runtime> | null
    workersInstalled: boolean
    worklets: boolean
}

const bootState: BootState = ((globalThis as any).__sopDawBoot ??= {promise: null, workersInstalled: false, worklets: false})

const bootRuntime = (): Promise<Runtime> => {
    bootState.promise ??= (async () => {
        if (!window.crossOriginIsolated) {
            throw new Error('Страница не изолирована (crossOriginIsolated=false): нужны заголовки COOP/COEP.')
        }
        if (!bootState.workersInstalled) {
            await Workers.install(workersUrl)
            bootState.workersInstalled = true
            AnimationFrame.start(window)
        }
        if (!bootState.worklets) {
            AudioWorklets.install(workletsUrl)
            bootState.worklets = true
        }
        const context = new AudioContext({sampleRate: 48000, latencyHint: 'interactive'})
        const audioWorklets = await AudioWorklets.createFor(context)
        WasmEngine.install({
            processorUrl: wasmProcessorUrl,
            offlineWorkerUrl: wasmOfflineWorkerUrl,
            wasmUrl: `${import.meta.env.BASE_URL.replace(/\/$/, '')}/wasm-engine`,
        })
        if (!(await WasmEngine.ensureReady(context))) {
            throw new Error('Не удалось загрузить аудиодвижок OpenDAW (WASM).')
        }
        FactoryCatalog.install({samples: async () => [], soundfonts: async () => [], presets: async () => []})
        // Сэмплы импортируются через SampleService (в OPFS), поэтому внешний провайдер не нужен.
        const sampleManager = new GlobalSampleLoaderManager({
            fetch: async (): Promise<never> => panic('Сэмпл не найден в локальном хранилище'),
        })
        const soundfontManager = new GlobalSoundfontLoaderManager({
            fetch: async (): Promise<never> => panic('Soundfont-ы не используются'),
        })
        const sampleService = new SampleService(context, BpmDetector.Unknown)
        const soundfontService = new SoundfontService()
        const env: ProjectEnv = {
            audioContext: context,
            audioWorklets,
            sampleManager,
            soundfontManager,
            sampleService,
            soundfontService,
        }
        return {context, env, sampleService, sampleManager}
    })().catch(error => {
        bootState.promise = null
        throw error
    })
    return bootState.promise
}

const buildWaveform = (audio: AudioData): Waveform => {
    const bins = Math.max(1, Math.ceil(audio.numberOfFrames / PEAK_BIN_FRAMES))
    const peaks = new Float32Array(bins * 2)
    for (let bin = 0; bin < bins; bin++) {
        const from = bin * PEAK_BIN_FRAMES
        const to = Math.min(audio.numberOfFrames, from + PEAK_BIN_FRAMES)
        let min = 0
        let max = 0
        for (let channel = 0; channel < audio.numberOfChannels; channel++) {
            const data = audio.frames[channel]
            for (let index = from; index < to; index++) {
                const value = data[index]
                if (value < min) min = value
                else if (value > max) max = value
            }
        }
        peaks[bin * 2] = min
        peaks[bin * 2 + 1] = max
    }
    return {peaks, secondsPerBin: PEAK_BIN_FRAMES / audio.sampleRate, duration: audio.numberOfFrames / audio.sampleRate}
}

interface LaneRecord {
    source: SampleSource
    sample: Sample
    waveform: Waveform
    audioUnitBox: AudioUnitBox
    trackBox: TrackBox
}

const toSeconds = (ppqn: number): number => PPQN.pulsesToSeconds(ppqn, BPM)
const toPulses = (seconds: number): number => PPQN.secondsToPulses(seconds, BPM)
const hueOf = (text: string): number => {
    let hash = 0
    for (let index = 0; index < text.length; index++) hash = (hash * 31 + text.charCodeAt(index)) >>> 0
    return hash % 360
}

// ───────────────────────── Сам движок мини-DAW ─────────────────────────

export class DawEngine {
    static async create(): Promise<DawEngine> {
        const runtime = await bootRuntime()
        return new DawEngine(runtime)
    }

    readonly #runtime: Runtime
    readonly #listeners = new Set<(snapshot: DawSnapshot) => void>()
    readonly #lanes: LaneRecord[] = []
    readonly #waveforms = new Map<string, Waveform>()
    #project: Project
    #subscriptions: Subscription[] = []
    #scheduled = false
    #generation = 0
    #snapshot: DawSnapshot = {lanes: [], bpm: BPM, canUndo: false, canRedo: false, length: 0}

    private constructor(runtime: Runtime) {
        this.#runtime = runtime
        this.#project = this.#startProject()
    }

    get snapshot(): DawSnapshot {return this.#snapshot}

    get project(): Project {return this.#project}

    get context(): AudioContext {return this.#runtime.context}

    subscribe(listener: (snapshot: DawSnapshot) => void): () => void {
        this.#listeners.add(listener)
        return () => {this.#listeners.delete(listener)}
    }

    #startProject(): Project {
        const project = Project.new(this.#runtime.env)
        project.startAudioWorklet()
        project.editing.modify(() => project.api.setBpm(BPM))
        if (project.editing instanceof BoxEditing) project.editing.clear() // стартовое состояние не должно попадать в историю undo
        this.#subscriptions = [
            project.boxGraph.subscribeToAllUpdates({onUpdate: () => this.#scheduleRefresh()}),
            project.editing.subscribe(() => this.#scheduleRefresh()),
        ]
        return project
    }

    #scheduleRefresh(): void {
        if (this.#scheduled) return
        this.#scheduled = true
        queueMicrotask(() => {
            this.#scheduled = false
            this.#refresh()
        })
    }

    // ── Транспорт ──

    play(): void {this.#project.engine.play()}

    pause(): void {this.#project.engine.stop(false)}

    stop(): void {
        this.#project.engine.stop(true)
    }

    get isPlaying(): boolean {return this.#project.engine.isPlaying.getValue()}

    /** текущая позиция проигрывания, секунды */
    get position(): number {return toSeconds(this.#project.engine.position.getValue())}

    seek(seconds: number): void {this.#project.engine.setPosition(toPulses(Math.max(0, seconds)))}

    // ── Загрузка треков/сэмплов ──

    /** Начать с чистого проекта (при открытии другого трека). */
    reset(): void {
        this.#generation++
        this.stop()
        this.#subscriptions.forEach(subscription => subscription.terminate())
        this.#project.terminate()
        this.#lanes.length = 0
        this.#project = this.#startProject()
        this.#refresh()
    }

    // Undo/redo может убрать или вернуть дорожку, поэтому «живыми» считаем только те, чей юнит ещё в проекте.
    #live(): LaneRecord[] {
        return this.#lanes.filter(lane => lane.audioUnitBox.isAttached())
    }

    hasSource(sourceId: string): boolean {
        return this.#live().some(lane => lane.source.id === sourceId)
    }

    async addSample(source: SampleSource): Promise<void> {
        if (this.hasSource(source.id)) return
        const generation = this.#generation
        const response = await fetch(source.url)
        if (!response.ok) throw new Error(`Не удалось загрузить «${source.name}» (HTTP ${response.status})`)
        const arrayBuffer = await response.arrayBuffer()
        const sample = await this.#runtime.sampleService.importFile({name: source.name, arrayBuffer})
        const uuid = UUID.parse(sample.uuid)
        const audio = await this.#runtime.sampleManager.getAudioData(uuid)
        let waveform = this.#waveforms.get(sample.uuid)
        if (waveform === undefined) {
            waveform = buildWaveform(audio)
            this.#waveforms.set(sample.uuid, waveform)
        }
        // Пока сэмпл грузился, проект могли пересоздать — тогда результат уже не нужен.
        if (generation !== this.#generation || this.hasSource(source.id)) return
        const project = this.#project
        const {boxGraph, api, editing} = project
        const hue = source.hue ?? hueOf(source.name)
        let record: LaneRecord | null = null
        editing.modify(() => {
            const {audioUnitBox, instrumentBox, trackBox} = api.createInstrument(InstrumentFactories.Tape)
            instrumentBox.label.setValue(source.name)
            const audioFileBox = boxGraph.findBox<AudioFileBox>(uuid).unwrapOrElse(() =>
                AudioFileBox.create(boxGraph, uuid, box => {
                    box.fileName.setValue(source.name)
                    box.startInSeconds.setValue(0)
                    box.endInSeconds.setValue(sample.duration)
                }))
            const region = AudioContentFactory.createNotStretchedRegion({
                boxGraph, sample, audioFileBox, position: 0, targetTrack: trackBox, name: source.name,
            })
            region.hue.setValue(hue)
            record = {source, sample, waveform: waveform!, audioUnitBox, trackBox}
        })
        if (record !== null) {
            const index = this.#lanes.findIndex(lane => lane.source.id === source.id)
            if (index >= 0) this.#lanes.splice(index, 1)
            this.#lanes.push(record)
        }
        this.#refresh()
    }

    removeSource(sourceId: string): void {
        const lane = this.#live().find(candidate => candidate.source.id === sourceId)
        if (lane === undefined) return
        this.#project.editing.modify(() => this.#project.api.deleteAudioUnit(lane.audioUnitBox))
        this.#refresh()
    }

    // ── Редактирование ──

    #regionAdapters(lane: LaneRecord): AudioRegionBoxAdapter[] {
        const trackAdapter = this.#project.boxAdapters.adapterFor(lane.trackBox, TrackBoxAdapter)
        return trackAdapter.regions.collection.asArray().filter(
            (region): region is AudioRegionBoxAdapter => region.isAudioRegion())
    }

    #find(regionId: string): {lane: LaneRecord, region: AudioRegionBoxAdapter, neighbours: AudioRegionBoxAdapter[]} | null {
        for (const lane of this.#live()) {
            const regions = this.#regionAdapters(lane)
            const region = regions.find(candidate => UUID.toString(candidate.uuid) === regionId)
            if (region !== undefined) return {lane, region, neighbours: regions.filter(other => other !== region)}
        }
        return null
    }

    /** Переместить регион, не наезжая на соседей (начало, секунды). */
    moveRegion(regionId: string, startSeconds: number, live = false): void {
        const found = this.#find(regionId)
        if (found === null) return
        const {region, neighbours} = found
        const duration = region.duration
        let position = Math.max(0, toPulses(startSeconds))
        const before = neighbours.filter(other => other.position < region.position)
        const after = neighbours.filter(other => other.position > region.position)
        const minPosition = before.reduce((acc, other) => Math.max(acc, other.complete), 0)
        const maxPosition = after.reduce((acc, other) => Math.min(acc, other.position - duration), Infinity)
        position = Math.min(Math.max(position, minPosition), maxPosition)
        if (Math.abs(position - region.position) < 1) return
        this.#project.editing.modify(() => {region.position = position}, !live)
    }

    /** Обрезать начало региона: новое начало в секундах на таймлайне. */
    trimStart(regionId: string, startSeconds: number, live = false): void {
        const found = this.#find(regionId)
        if (found === null) return
        const {region, neighbours} = found
        const minPulses = neighbours.filter(other => other.complete <= region.position)
            .reduce((acc, other) => Math.max(acc, other.complete), 0)
        const srcStartPulses = toPulses(region.waveformOffset.getValue()) + region.loopOffset
        const minByAudio = region.position - srcStartPulses
        const target = Math.min(Math.max(toPulses(startSeconds), Math.max(minPulses, minByAudio)),
            region.complete - toPulses(0.02))
        const delta = target - region.position
        if (Math.abs(delta) < 1) return
        this.#project.editing.modify(() => region.moveContentStart(delta), !live)
    }

    /** Обрезать конец региона: новый конец в секундах на таймлайне. */
    trimEnd(regionId: string, endSeconds: number, live = false): void {
        const found = this.#find(regionId)
        if (found === null) return
        const {region, neighbours} = found
        const nextStart = neighbours.filter(other => other.position >= region.complete)
            .reduce((acc, other) => Math.min(acc, other.position), Infinity)
        const maxByAudio = region.position + (region.loopDuration - region.loopOffset)
        const end = Math.min(Math.max(toPulses(endSeconds), region.position + toPulses(0.02)), nextStart, maxByAudio)
        const duration = end - region.position
        if (Math.abs(duration - region.duration) < 1) return
        this.#project.editing.modify(() => {region.duration = duration}, !live)
    }

    /** Разрезать регион на две части в точке (секунды на таймлайне). */
    splitRegion(regionId: string, atSeconds: number): boolean {
        const found = this.#find(regionId)
        if (found === null) return false
        const cut = toPulses(atSeconds)
        const result = this.#project.editing.modify(() => RegionEditing.cut(found.region, cut, false))
        return result.nonEmpty() && result.unwrap().nonEmpty()
    }

    /** Разрезать несколько регионов в одной точке одним шагом истории (один Ctrl+Z отменяет все разрезы). */
    splitRegions(regionIds: string[], atSeconds: number): number {
        const cut = toPulses(atSeconds)
        const found = regionIds.map(id => this.#find(id)).filter(item => item !== null)
        if (found.length === 0) return 0
        this.#project.editing.modify(() => {
            found.forEach(({region}) => RegionEditing.cut(region, cut, false))
        })
        return found.length
    }

    deleteRegion(regionId: string): void {
        const found = this.#find(regionId)
        if (found === null) return
        this.#project.editing.modify(() => found.region.box.delete())
    }

    toggleRegionMute(regionId: string): void {
        const found = this.#find(regionId)
        if (found === null) return
        this.#project.editing.modify(() => found.region.box.mute.setValue(!found.region.mute))
    }

    setLaneMute(laneId: string, mute: boolean): void {
        const lane = this.#laneById(laneId)
        if (lane !== undefined) this.#project.editing.modify(() => lane.audioUnitBox.mute.setValue(mute))
    }

    setLaneSolo(laneId: string, solo: boolean): void {
        const lane = this.#laneById(laneId)
        if (lane !== undefined) this.#project.editing.modify(() => lane.audioUnitBox.solo.setValue(solo))
    }

    setLaneVolume(laneId: string, volumeDb: number): void {
        const lane = this.#laneById(laneId)
        if (lane !== undefined) this.#project.editing.modify(() => lane.audioUnitBox.volume.setValue(volumeDb), false)
    }

    /** Завершает жест перетаскивания: все live-правки становятся одним шагом истории. */
    commitEdit(): void {this.#project.editing.mark()}

    undo(): void {this.#project.editing.undo()}

    redo(): void {this.#project.editing.redo()}

    #laneById(laneId: string): LaneRecord | undefined {
        return this.#live().find(lane => UUID.toString(lane.audioUnitBox.address.uuid) === laneId)
    }

    // ── Экспорт ──

    /** Сводит проект в WAV (оффлайн-рендер в движке OpenDAW). */
    async exportWav(onProgress?: (value: number) => void): Promise<Blob> {
        if (this.#live().length === 0) throw new Error('Нечего экспортировать')
        const progress = new DefaultObservableValue(0)
        const subscription = progress.subscribe(owner => onProgress?.(owner.getValue()))
        try {
            const audio = await OfflineEngineRenderer.start(this.#project.copy(), Option.None, progress, undefined, 48000)
            const buffer = WavFile.encodeFloats({
                frames: audio.frames,
                numberOfFrames: audio.numberOfFrames,
                numberOfChannels: audio.numberOfChannels,
                sampleRate: audio.sampleRate,
            })
            return new Blob([buffer], {type: 'audio/wav'})
        } finally {
            subscription.terminate()
        }
    }

    // ── Снимок состояния для UI ──

    #refresh(): void {
        const {editing} = this.#project
        const lanes: LaneInfo[] = this.#live().map(lane => {
            const unit = this.#project.boxAdapters.adapterFor(lane.audioUnitBox, AudioUnitBoxAdapter)
            const regions = this.#regionAdapters(lane).map<RegionInfo>(region => {
                const srcStart = region.waveformOffset.getValue() + toSeconds(region.loopOffset)
                return {
                    id: UUID.toString(region.uuid),
                    start: toSeconds(region.position),
                    duration: toSeconds(region.duration),
                    srcStart,
                    srcAvailable: Math.max(0, lane.waveform.duration - srcStart),
                    label: region.label,
                    muted: region.mute,
                }
            })
            return {
                id: UUID.toString(unit.uuid),
                title: lane.source.name,
                sourceId: lane.source.id,
                group: lane.source.group,
                sourceTrackId: lane.source.sourceTrackId,
                hue: lane.source.hue ?? hueOf(lane.source.name),
                mute: lane.audioUnitBox.mute.getValue(),
                solo: lane.audioUnitBox.solo.getValue(),
                volumeDb: lane.audioUnitBox.volume.getValue(),
                regions,
                waveform: lane.waveform,
            }
        })
        const length = lanes.reduce((acc, lane) => lane.regions.reduce(
            (inner, region) => Math.max(inner, region.start + region.duration), acc), 0)
        this.#snapshot = {lanes, bpm: BPM, canUndo: editing.canUndo(), canRedo: editing.canRedo(), length}
        this.#listeners.forEach(listener => listener(this.#snapshot))
    }

    dispose(): void {
        this.stop()
        this.#subscriptions.forEach(subscription => subscription.terminate())
        this.#project.terminate()
        this.#listeners.clear()
    }
}

export type {Progress}
