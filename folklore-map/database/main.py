import os
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
import data_manager
from initialize_bd import init_database

load_dotenv()
init_database()

app = FastAPI(title="Sounds of Past API")
raw_origins = os.getenv("ALLOWED_ORIGINS", "http://127.0.0.1:5173,http://localhost:5173")
origins = [origin.strip() for origin in raw_origins.split(",")]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,        
    allow_credentials=True,       
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],  
)

@app.get("/api/tracks/{track_id}/samples")
async def get_track_samples(track_id: int):
    """Семплы (стемы) трека — они раскладываются по дорожкам мини-DAW."""
    return Response(content=data_manager.get_samples_by_track(track_id), media_type="application/json")


@app.get("/api/tracks/{region_name}")
async def get_region_tracks(region_name: str):
    json_data = data_manager.get_tracks_by_region(region_name)
    if json_data == "[]":
        raise HTTPException(status_code=404, detail=f"Записи для региона '{region_name}' не найдены.")
    return Response(content=json_data, media_type="application/json")


@app.get("/api/standalone-track/{track_id}")
async def get_single_track(track_id: int):
    try:
        json_data = data_manager.get_track_by_id_json(track_id)
        if "Track not found" in json_data:
            raise HTTPException(
                status_code=404, 
                detail=f"Конкретный трек с ID {track_id} не зарегистрирован в системе."
            )
            
        return Response(content=json_data, media_type="application/json")
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(
            status_code=500, 
            detail=f"Ошибка сервера при извлечении трека: {error}"
        )
