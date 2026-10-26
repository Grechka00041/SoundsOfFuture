import react from '@vitejs/plugin-react'
import {defineConfig, type Plugin} from 'vite'
import {existsSync, readdirSync, readFileSync} from 'node:fs'
import type {IncomingMessage, ServerResponse} from 'node:http'
import {join, resolve, sep} from 'node:path'

// OpenDAW (SharedArrayBuffer + AudioWorklet) требует cross-origin isolation.
// `credentialless` — чтобы тайлы карты (Esri) и шрифты Google по-прежнему грузились без CORP-заголовков.
const isolationHeaders = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'credentialless',
}

// WASM-модули аудиодвижка лежат в node_modules; движок ждёт их по `${BASE}/wasm-engine/wasm/*`.
// В dev отдаём их middleware-ом напрямую (копирование в public/ ненадёжно: vite запоминает список
// public-файлов при старте, и новые файлы получали в ответ index.html), в build — кладём в dist.
const WASM_DIR = resolve('node_modules/@opendaw/studio-core-wasm/dist/wasm')
const WASM_PREFIX = '/wasm-engine/wasm/'

const listFiles = (dir: string, base = ''): string[] =>
    readdirSync(join(dir, base), {withFileTypes: true}).flatMap(entry =>
        entry.isDirectory() ? listFiles(dir, join(base, entry.name)) : [join(base, entry.name)])

const serveWasm = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = (req.url ?? '').split('?')[0]
    if (!url.startsWith(WASM_PREFIX)) return next()
    const file = resolve(WASM_DIR, decodeURIComponent(url.slice(WASM_PREFIX.length)))
    if (!file.startsWith(WASM_DIR) || !existsSync(file)) {
        res.statusCode = 404
        res.end('not found')
        return
    }
    res.setHeader('Content-Type', 'application/wasm')
    res.end(readFileSync(file))
}

const openDawWasm = (): Plugin => ({
    name: 'opendaw-wasm',
    configureServer(server) {
        if (!existsSync(WASM_DIR)) throw new Error('Не найден @opendaw/studio-core-wasm — выполните npm install')
        server.middlewares.use(serveWasm)
    },
    generateBundle() {
        for (const file of listFiles(WASM_DIR)) {
            this.emitFile({
                type: 'asset',
                fileName: `wasm-engine/wasm/${file.split(sep).join('/')}`,
                source: readFileSync(join(WASM_DIR, file)),
            })
        }
    },
})

export default defineConfig({
    plugins: [openDawWasm(), react()],
    server: {headers: isolationHeaders},
    preview: {headers: isolationHeaders},
    worker: {format: 'es'},
    build: {target: 'es2023'},
})
