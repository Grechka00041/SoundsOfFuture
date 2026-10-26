import os
import sqlite3

DB_NAME = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sounds_of_past.db")


def init_database():
    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()

    cursor.execute('''
CREATE TABLE IF NOT EXISTS ethno_tracks (
id INTEGER PRIMARY KEY AUTOINCREMENT,
name_of_track TEXT NOT NULL,
performer TEXT NOT NULL,
global_region TEXT NOT NULL,
region TEXT NOT NULL,
duration_sec Integer NOT NULL,
is_instrument BOOLEAN NOT NULL,
url_for_track TEXT NOT NULL
)
''')
    # Семплы (стемы) трека: по одной дорожке в мини-DAW.
    cursor.execute('''
CREATE TABLE IF NOT EXISTS track_samples (
id INTEGER PRIMARY KEY AUTOINCREMENT,
track_id INTEGER NOT NULL REFERENCES ethno_tracks(id) ON DELETE CASCADE,
name TEXT NOT NULL,
url TEXT NOT NULL,
sort_order INTEGER NOT NULL DEFAULT 0
)
''')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_track_samples_track ON track_samples(track_id)')
    conn.commit()
    conn.close()


if __name__ == "__main__":
    init_database()
    print("База данных успешно создана.")
