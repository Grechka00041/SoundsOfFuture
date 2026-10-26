# Запуск

```bash
# бэкенд (порт 8000)
cd database
pip install fastapi uvicorn python-dotenv
python seed_demo.py          # демо-треки и семплы (можно запускать повторно)
python -m uvicorn main:app --port 8000

# фронтенд (порт 5173)
npm install
npm run dev
```

Нужен Chromium-браузер (Chrome/Edge) или Firefox ≥ 133: OpenDAW требует `crossOriginIsolated`,
заголовки COOP/COEP уже настроены в `vite.config.ts`. WASM-модули движка копируются в
`dist/wasm-engine` при сборке, а в dev отдаются напрямую из node_modules (см. `vite.config.ts`).

Свои семплы: `data_manager.add_to_db(...)` → `data_manager.add_sample(track_id, имя, url, порядок)`.
URL вида `/audio/x.wav` берётся из `public/audio`, `https://…` — внешний файл (нужен CORS).
