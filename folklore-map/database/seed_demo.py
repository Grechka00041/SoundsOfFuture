"""Добавляет демо-треки и их семплы (WAV из public/audio). Безопасно запускать повторно."""
import sqlite3

import data_manager
from initialize_bd import init_database

DEMO = [
    ("Поле русское", "Иван Петров", "ЦФО", "Московская область", 16, False, [
        ("Голос", "/audio/pole-voice.wav"),
        ("Балалайка", "/audio/pole-balalaika.wav"),
        ("Бурдон", "/audio/pole-drone.wav"),
    ]),
    ("Балалайка-прима", "", "ЦФО", "Московская область", 16, True, [
        ("Прима", "/audio/balalaika-prima.wav"),
        ("Бас", "/audio/balalaika-bass.wav"),
        ("Ритм", "/audio/balalaika-rhythm.wav"),
    ]),
    ("Казачья песня", "Кубанский Хор", "ЮФО", "Краснодарский край", 16, False, [
        ("Запевала", "/audio/kazak-lead.wav"),
        ("Подголосок", "/audio/kazak-second.wav"),
        ("Бубен", "/audio/kazak-bubn.wav"),
    ]),
]

BYRANBAY_SAMPLES = [("Игил", "/audio/byranbay-igil.wav"), ("Горловое пение", "/audio/byranbay-throat.wav")]


def main():
    init_database()
    conn = sqlite3.connect(data_manager.DB_NAME)
    existing = {row[0] for row in conn.execute("SELECT name_of_track FROM ethno_tracks")}
    first_byranbay = conn.execute(
        "SELECT MIN(id) FROM ethno_tracks WHERE name_of_track='Byranbay'").fetchone()[0]
    conn.close()

    for title, artist, fo, region, duration, is_instrument, samples in DEMO:
        if title in existing:
            continue
        track_id = data_manager.add_to_db(title, artist, fo, region, duration, is_instrument, samples[0][1])
        for order, (name, url) in enumerate(samples):
            data_manager.add_sample(track_id, name, url, order)

    if first_byranbay is not None:
        conn = sqlite3.connect(data_manager.DB_NAME)
        has = conn.execute("SELECT COUNT(*) FROM track_samples WHERE track_id=?", (first_byranbay,)).fetchone()[0]
        conn.close()
        if not has:
            for order, (name, url) in enumerate(BYRANBAY_SAMPLES):
                data_manager.add_sample(first_byranbay, name, url, order)
    print("Демо-данные готовы.")


if __name__ == "__main__":
    main()
