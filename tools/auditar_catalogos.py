from __future__ import annotations

from pathlib import Path
import json
import re

ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / "data" / "catalogs.json").read_text(encoding="utf-8"))
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")

total = 0
verified = 0
youtube_complete = 0
bad_verified: list[str] = []
bad_youtube: list[str] = []
bad_counts: list[str] = []
seen_ids: set[str] = set()
duplicate_ids: list[str] = []

print("CGO Music - Auditoria de catalogos")
print("=" * 86)

for entry in manifest["catalogs"]:
    path = ROOT / entry["path"]
    data = json.loads(path.read_text(encoding="utf-8"))
    songs = data.get("songs", [])
    ok_verified = sum(bool(song.get("verified")) for song in songs)
    ok_youtube = 0

    if len(songs) != 100:
        bad_counts.append(f"{entry['language']} {entry['decade']}: {len(songs)}")

    for song in songs:
        song_id = str(song.get("id") or "")
        if song_id in seen_ids:
            duplicate_ids.append(song_id)
        seen_ids.add(song_id)

        if song.get("verified"):
            peak = song.get("chartPeak")
            if not song.get("chartSource") or not isinstance(peak, int) or not 1 <= peak <= 10:
                bad_verified.append(song_id)

        vid = song.get("youtubeId")
        url = song.get("youtubeUrl")
        if isinstance(vid, str) and VIDEO_ID_RE.fullmatch(vid) and url == f"https://www.youtube.com/watch?v={vid}":
            ok_youtube += 1
        elif vid or url:
            bad_youtube.append(song_id)

    total += len(songs)
    verified += ok_verified
    youtube_complete += ok_youtube

    label = f"{entry['language']:8} {entry['decade']:6}"
    print(
        f"{label}  canciones={len(songs):3}  "
        f"ranking={ok_verified:3}/100  youtube={ok_youtube:3}/100"
    )

print("-" * 86)
print(
    f"TOTAL        canciones={total:4}  ranking={verified:4}/{total}  "
    f"youtube={youtube_complete:4}/{total}"
)

if bad_counts:
    print("\nERROR: listas que no tienen exactamente 100 canciones:")
    for item in bad_counts:
        print(" -", item)

if duplicate_ids:
    print("\nERROR: IDs de canciones duplicados:")
    for item in duplicate_ids:
        print(" -", item)

if bad_verified:
    print("\nADVERTENCIA: registros verified sin chartSource/Top10 completo:")
    for item in bad_verified:
        print(" -", item)
else:
    print("\nOK: ninguna entrada verified carece de chartSource/Top10.")

if bad_youtube:
    print("\nERROR: registros con youtubeId/youtubeUrl mal formados o inconsistentes:")
    for item in bad_youtube:
        print(" -", item)

missing_youtube = total - youtube_complete
if missing_youtube:
    print(f"\nYOUTUBE: faltan {missing_youtube} canciones por resolver con ACTUALIZAR_URLS_YOUTUBE.bat.")
else:
    print("\nYOUTUBE: OK, las 1.200 canciones tienen youtubeId + youtubeUrl estaticos.")

raise SystemExit(2 if (bad_counts or duplicate_ids or bad_youtube or total != 1200) else 0)
