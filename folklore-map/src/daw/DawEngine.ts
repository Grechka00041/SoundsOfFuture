import workersUrl from '@opendaw/studio-core/workers-main.js?worker&url'
import workletsUrl from '@opendaw/studio-core/processors.js?url'
import wasmProcessorUrl from '@opendaw/studio-core-wasm/wasm-processor.js?url'
import wasmOfflineWorkerUrl from '@opendaw/studio-core-wasm/wasm-offline-worker.js?worker&url'
import {DefaultObservableValue, Notifier, Option, panic, tryCatch, UUID} from '@opendaw/lib-std'
import type {Progress, Subscription} from '@opendaw/lib-std'
import {AudioData, PPQN, WavFile} from '@opendaw/lib-dsp'
import {SamplePeaks} from '@opendaw/lib-fusion'
import {AnimationFrame} from '@opendaw/lib-dom'
import {Box, BoxEditing} from '@opendaw/lib-box'
import {
    AudioFileBox,
    TrackBox,
    AudioUnitBox,
    DelayDeviceBox,
    FoldDeviceBox,
    RevampDeviceBox,
    ReverbDeviceBox,
    WaveshaperDeviceBox,
} from '@opendaw/studio-boxes'
import type {Float32Field} from '@opendaw/lib-box'
import {
    AudioRegionBoxAdapter,
    AudioUnitBoxAdapter,
    BpmDetector,
    InstrumentFactories,
    RegionEditing,
    TrackBoxAdapter,
} from '@opendaw/studio-adapters'
import type {AudioEffectDeviceAdapter, Sample} from '@opendaw/studio-adapters'
import {
    AudioContentFactory,
    AudioWorklets,
    EffectFactories,
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

/** номер ряда внутри «группы» одного источника; дубликаты одного семпла различаются им */
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
    effects: EffectInfo[]
}

// ───────────────────────── Эффекты дорожек ─────────────────────────

export type EffectKind = 'delay' | 'eq' | 'saturation' | 'distortion' | 'reverb'

export interface EffectParamSpec {
    key: string
    label: string
    min: number
    max: number
    step: number
    unit?: string
}

export interface EffectInfo {
    id: string
    kind: EffectKind
    label: string
    enabled: boolean
    params: {key: string, value: number}[]
}

const EFFECT_LABELS: Record<EffectKind, string> = {
    delay: 'DELAY', eq: 'EQ', saturation: 'SAT', distortion: 'DIST', reverb: 'REVERB',
}

export const PARAM_SPECS: Record<EffectKind, EffectParamSpec[]> = {
    delay: [
        {key: 'time', label: 'время', min: 10, max: 1500, step: 1, unit: 'мс'},
        {key: 'feedback', label: 'обр.', min: 0, max: 0.95, step: 0.01},
        {key: 'wet', label: 'wet', min: 0, max: 1, step: 0.01},
    ],
    eq: [
        {key: 'lowGain', label: 'низ', min: -18, max: 18, step: 0.5, unit: 'дБ'},
        {key: 'midGain', label: 'середина', min: -18, max: 18, step: 0.5, unit: 'дБ'},
        {key: 'highGain', label: 'верх', min: -18, max: 18, step: 0.5, unit: 'дБ'},
    ],
    saturation: [
        {key: 'inputGain', label: 'drive', min: 0, max: 1, step: 0.01},
        {key: 'mix', label: 'микс', min: 0, max: 1, step: 0.01},
    ],
    distortion: [
        {key: 'drive', label: 'drive', min: 0, max: 1, step: 0.01},
        {key: 'volume', label: 'выход', min: 0, max: 1, step: 0.01},
    ],
    reverb: [
        {key: 'decay', label: 'хвост', min: 0, max: 1, step: 0.01},
        {key: 'damp', label: 'демпф.', min: 0, max: 1, step: 0.01},
        {key: 'wet', label: 'wet', min: 0, max: 1, step: 0.01},
    ],
}

const DEFAULT_PARAMS: Record<EffectKind, Record<string, number>> = {
    delay: {time: 250, feedback: 0.35, wet: 0.3},
    eq: {lowGain: 0, midGain: 0, highGain: 0},
    saturation: {inputGain: 0.4, mix: 0.6},
    distortion: {drive: 0.5, volume: 0.7},
    reverb: {decay: 0.5, damp: 0.5, wet: 0.3},
}

interface EffectRecord {
    kind: EffectKind
    params: Record<string, number>
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
    /** все эффекты дорожки; удалённые (например, через undo) помечаются при refresh */
    effects: EffectRecord[]
}

const EFFECT_BOXES = {
    delay: DelayDeviceBox,
    eq: RevampDeviceBox,
    saturation: WaveshaperDeviceBox,
    distortion: FoldDeviceBox,
    reverb: ReverbDeviceBox,
} as const

/** Значение параметра эффекта в «мировых» единицах движка OpenDAW. */
const effectParamValue = (box: Box, kind: EffectKind, key: string): number => {
    switch (kind) {
        case 'delay': {
            const device = box as DelayDeviceBox
            if (key === 'time') return device.delayMillis.getValue() * 1000
            if (key === 'feedback') return device.feedback.getValue()
            return device.wet.getValue()
        }
        case 'eq': {
            const device = box as RevampDeviceBox
            if (key === 'lowGain') return device.lowShelf.gain.getValue()
            if (key === 'midGain') return device.midBell.gain.getValue()
            return device.highShelf.gain.getValue()
        }
        case 'saturation': {
            const device = box as WaveshaperDeviceBox
            if (key === 'inputGain') return device.inputGain.getValue()
            return device.mix.getValue()
        }
        case 'distortion': {
            const device = box as FoldDeviceBox
            if (key === 'drive') return device.drive.getValue()
            return device.volume.getValue()
        }
        case 'reverb': {
            const device = box as ReverbDeviceBox
            if (key === 'decay') return device.decay.getValue()
            if (key === 'damp') return device.damp.getValue()
            return device.wet.getValue()
        }
    }
}

/** Обратное преобразование: мировые значения параметров → unit-значения полей бокса. */
const effectFieldFor = (box: Box, kind: EffectKind, key: string): Float32Field | null => {
    switch (kind) {
        case 'delay': {
            const device = box as DelayDeviceBox
            if (key === 'time') return device.delayMillis
            if (key === 'feedback') return device.feedback
            return device.wet
        }
        case 'eq': {
            const device = box as RevampDeviceBox
            if (key === 'lowGain') return device.lowShelf.gain
            if (key === 'midGain') return device.midBell.gain
            return device.highShelf.gain
        }
        case 'saturation': {
            const device = box as WaveshaperDeviceBox
            if (key === 'inputGain') return device.inputGain
            return device.mix
        }
        case 'distortion': {
            const device = box as FoldDeviceBox
            if (key === 'drive') return device.drive
            return device.volume
        }
        case 'reverb': {
            const device = box as ReverbDeviceBox
            if (key === 'decay') return device.decay
            if (key === 'damp') return device.damp
            return device.wet
        }
    }
}

const unitToRaw = (kind: EffectKind, key: string, value: number): number => {
    if (kind === 'delay' && key === 'time') return value / 1000
    return value
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
        const generation = this.#generation
        const response = await fetch(source.url)
        if (!response.ok) throw new Error(`Не удалось загрузить «${source.name}» (HTTP ${response.status})`)
        const arrayBuffer = await response.arrayBuffer()
        const sample = await this.#runtime.sampleService.importFile({name: source.name, arrayBuffer})
        const uuid = UUID.parse(sample.uuid)
        let waveform = this.#waveforms.get(sample.uuid)
        if (waveform === undefined) {
            const audio = await this.#runtime.sampleManager.getAudioData(uuid)
            waveform = buildWaveform(audio)
            this.#waveforms.set(sample.uuid, waveform)
        }
        // Пока сэмпл грузился, проект могли пересоздать — тогда результат уже не нужен.
        if (generation !== this.#generation) return
        this.#addLane(source, sample, waveform!)
    }

    /** Создать дорожку с тем же сэмплом ещё раз (копия). Волновая форма и файл уже в кэше — мгновенно. */
    duplicateLane(laneId: string): void {
        const lane = this.#laneById(laneId)
        if (lane === undefined) return
        this.#addLane(lane.source, lane.sample, lane.waveform)
    }

    #addLane(source: SampleSource, sample: Sample, waveform: Waveform): void {
        const project = this.#project
        const {boxGraph, api, editing} = project
        const hue = source.hue ?? hueOf(source.name)
        let record: LaneRecord | null = null
        editing.modify(() => {
            const {audioUnitBox, instrumentBox, trackBox} = api.createInstrument(InstrumentFactories.Tape)
            instrumentBox.label.setValue(source.name)
            const uuid = UUID.parse(sample.uuid)
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
            record = {source, sample, waveform, audioUnitBox, trackBox, effects: []}
        })
        if (record !== null) {
            // новая копия — сразу после последней дорожки этого же источника
            const index = this.#lanes.reduce(
                (acc, lane, position) => lane.source.id === source.id ? position + 1 : acc, 0)
            this.#lanes.splice(index, 0, record)
        }
        this.#refresh()
    }

    removeSource(sourceId: string): void {
        const lane = this.#live().find(candidate => candidate.source.id === sourceId)
        if (lane === undefined) return
        this.#project.editing.modify(() => this.#project.api.deleteAudioUnit(lane.audioUnitBox))
        this.#refresh()
    }

    removeLane(laneId: string): void {
        const lane = this.#laneById(laneId)
        if (lane === undefined) return
        this.#project.editing.modify(() => this.#project.api.deleteAudioUnit(lane.audioUnitBox))
        this.#refresh()
    }

    copyCount(sourceId: string): number {
        return this.#live().filter(lane => lane.source.id === sourceId).length
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

    /** Переместить регион между дорожками (в том же ряду — просто сдвиг по времени). */
    moveRegionToLane(regionId: string, targetLaneId: string, startSeconds: number, live = false): void {
        const found = this.#find(regionId)
        if (found === null) return
        const target = this.#laneById(targetLaneId)
        if (target === undefined) return
        if (target === found.lane) {
            this.moveRegion(regionId, startSeconds, live)
            return
        }
        const {region, lane} = found
        // позиция на целевой дорожке — с учётом её соседей
        const neighbours = this.#regionAdapters(target)
        let position = Math.max(0, toPulses(startSeconds))
        const minPosition = neighbours.reduce((acc, other) => Math.max(acc, other.complete), 0)
        position = Math.max(position, minPosition)
        const srcStart = region.waveformOffset.getValue() + toSeconds(region.loopOffset)
        const hue = region.hue
        const label = region.label
        const muted = region.mute
        const sample = lane.sample
        const audioFileBox = this.#project.boxGraph.findBox<AudioFileBox>(UUID.parse(sample.uuid))
            .unwrapOrElse(() => panic('AudioFileBox потерян'))
        this.#project.editing.modify(() => {
            region.box.delete()
            const created = AudioContentFactory.createNotStretchedRegion({
                boxGraph: this.#project.boxGraph, sample, audioFileBox,
                position, targetTrack: target.trackBox, name: label,
            })
            created.hue.setValue(hue)
            created.mute.setValue(muted)
            created.loopOffset.setValue(toPulses(srcStart))
        }, !live)
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

    // ── Эффекты дорожек ──

    addEffect(laneId: string, kind: EffectKind): void {
        const lane = this.#laneById(laneId)
        if (lane === undefined) return
        const project = this.#project
        const unit = project.boxAdapters.adapterFor(lane.audioUnitBox, AudioUnitBoxAdapter)
        const field = unit.audioEffectsField.unwrap()
        let effectBox: Box | null = null
        project.editing.modify(() => {
            effectBox = project.api.insertEffect(field, EffectFactories[kind])
        })
        if (effectBox === null) return
        const box = effectBox as unknown as Box
        box.label.setValue(EFFECT_LABELS[kind])
        // включаем все полосы эквалайзера — иначе Revamp молчит
        if (kind === 'eq') {
            const device = box as RevampDeviceBox
            project.editing.modify(() => {
                device.lowShelf.enabled.setValue(true)
                device.midBell.enabled.setValue(true)
                device.highShelf.enabled.setValue(true)
            })
        }
        const record: EffectRecord = {kind, params: {...DEFAULT_PARAMS[kind]}}
        lane.effects.push(record)
        this.#applyAllEffectParams(box, record)
        this.#refresh()
    }

    removeEffect(effectId: string): void {
        const located = this.#locateEffect(effectId)
        if (located === null) return
        const {effect, lane, index} = located
        this.#project.editing.modify(() => effect.box.delete())
        lane.effects.splice(index, 1)
        this.#refresh()
    }

    setEffectEnabled(effectId: string, enabled: boolean): void {
        const located = this.#locateEffect(effectId)
        if (located === null) return
        this.#project.editing.modify(() => located.effect.enabledField.setValue(enabled))
    }

    /** Значение в «мировых» единицах из PARAM_SPECS (мс, дБ, 0..1). */
    setEffectParameter(effectId: string, key: string, value: number): void {
        const located = this.#locateEffect(effectId)
        if (located === null) return
        const {effect, lane, index} = located
        const kind = lane.effects[index].kind
        const field = effectFieldFor(effect.box, kind, key)
        if (field === null) return
        const raw = unitToRaw(kind, key, value)
        this.#project.editing.modify(() => field.setValue(raw), false)
        lane.effects[index].params[key] = value
    }

    #locateEffect(effectId: string): {effect: AudioEffectDeviceAdapter, lane: LaneRecord, index: number} | null {
        for (const lane of this.#live()) {
            const unit = this.#project.boxAdapters.adapterFor(lane.audioUnitBox, AudioUnitBoxAdapter)
            const effects = unit.audioEffects.map(collection => collection.asArray()).unwrapOr([])
            const index = effects.findIndex(effect => UUID.toString(effect.uuid) === effectId)
            if (index >= 0 && index < lane.effects.length) return {effect: effects[index], lane, index}
        }
        return null
    }

    #applyAllEffectParams(box: Box, record: EffectRecord): void {
        for (const spec of PARAM_SPECS[record.kind]) {
            const value = record.params[spec.key]
            if (value === undefined) continue
            const field = effectFieldFor(box, record.kind, spec.key)
            if (field !== null) field.setValue(unitToRaw(record.kind, spec.key, value))
        }
    }

    /**
     * Эффекты дорожки для снимка. Порядок цепочки — источник истины; записи параметров
     * чистятся, если эффект пропал (например, после undo).
     */
    #effectInfos(lane: LaneRecord, unit: AudioUnitBoxAdapter): EffectInfo[] {
        const effects = unit.audioEffects.map(collection => collection.asArray()).unwrapOr([])
        if (effects.length !== lane.effects.length) {
            lane.effects.splice(Math.min(lane.effects.length, effects.length), Number.MAX_SAFE_INTEGER)
        }
        return effects.map((effect, index) => {
            const kind = lane.effects[index]?.kind
            if (kind === undefined) return null
            // подтягиваем значения из бокса (undo/redo могли изменить их в обход движка)
            const params = PARAM_SPECS[kind].map(spec => ({
                key: spec.key,
                value: effectParamValue(effect.box, kind, spec.key),
            }))
            lane.effects[index].params = Object.fromEntries(params.map(item => [item.key, item.value]))
            return {
                id: UUID.toString(effect.uuid),
                kind,
                label: EFFECT_LABELS[kind],
                enabled: effect.enabledField.getValue(),
                params,
            } satisfies EffectInfo
        }).filter((info): info is EffectInfo => info !== null)
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
                effects: this.#effectInfos(lane, unit),
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
