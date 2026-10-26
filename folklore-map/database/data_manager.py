import json
import sqlite3

from initialize_bd import DB_NAME, init_database

__all__ = ["DB_NAME", "get_tracks_by_region", "get_track_by_id_json", "get_samples_by_track",
           "add_to_db", "add_sample"]


def _connect() -> sqlite3.Connection:
    init_database()
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    return conn


def _track_to_dict(row: sqlite3.Row, samples_count: int = 0) -> dict:
    """Строка БД → форма, которую ждёт фронтенд (см. src/types/map.ts)."""
    return {
        "id": row["id"],
        "title": row["name_of_track"],
        "artist": row["performer"] or None,
        "duration": row["duration_sec"],
        "region": row["region"],
        "globalRegion": row["global_region"],
        "isInstrument": bool(row["is_instrument"]),
        "link": row["url_for_track"],
        "samplesCount": samples_count,
    }


def _samples_counts(conn: sqlite3.Connection) -> dict:
    return {row["track_id"]: row["n"] for row in conn.execute(
        "SELECT track_id, COUNT(*) AS n FROM track_samples GROUP BY track_id")}


def get_tracks_by_region(region_name: str) -> str:
    """Треки региона в JSON. Название региона сравнивается без учёта регистра
    («Красноярский Край» и «Красноярский край» — один регион), точные дубли схлопываются."""
    conn = _connect()
    rows = conn.execute("SELECT * FROM ethno_tracks ORDER BY id").fetchall()
    counts = _samples_counts(conn)
    conn.close()

    wanted = region_name.strip().casefold()
    seen = set()
    tracks = []
    for row in rows:
        if row["region"].strip().casefold() != wanted:
            continue
        key = (row["name_of_track"], row["performer"], row["url_for_track"])
        if key in seen:
            continue
        seen.add(key)
        tracks.append(_track_to_dict(row, counts.get(row["id"], 0)))
    return json.dumps(tracks, ensure_ascii=False)


def get_track_by_id_json(track_id: int) -> str:
    conn = _connect()
    row = conn.execute("SELECT * FROM ethno_tracks WHERE id=?", (track_id,)).fetchone()
    counts = _samples_counts(conn)
    conn.close()
    if row is None:
        return json.dumps({"error": "Track not found"}, ensure_ascii=False)
    return json.dumps(_track_to_dict(row, counts.get(row["id"], 0)), ensure_ascii=False)


def get_samples_by_track(track_id: int) -> str:
    conn = _connect()
    rows = conn.execute(
        "SELECT id, name, url, sort_order FROM track_samples WHERE track_id=? ORDER BY sort_order, id",
        (track_id,)).fetchall()
    conn.close()
    return json.dumps(
        [{"id": r["id"], "name": r["name"], "url": r["url"], "order": r["sort_order"]} for r in rows],
        ensure_ascii=False)


def add_to_db(name_of_track, performer, global_region, region, duration_sec, is_instrument, url_for_track) -> int:
    conn = _connect()
    cursor = conn.cursor()
    cursor.execute('''
INSERT INTO ethno_tracks (name_of_track, performer, global_region, region, duration_sec, is_instrument, url_for_track)
VALUES (?,?,?,?,?,?,?)
''', (name_of_track, performer, global_region, region, duration_sec, is_instrument, url_for_track))
    track_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return track_id


def add_sample(track_id: int, name: str, url: str, sort_order: int = 0) -> int:
    conn = _connect()
    cursor = conn.cursor()
    cursor.execute("INSERT INTO track_samples (track_id, name, url, sort_order) VALUES (?,?,?,?)",
                   (track_id, name, url, sort_order))
    sample_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return sample_id
