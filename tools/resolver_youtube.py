from __future__ import annotations

import argparse
import json
import re
import sys
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    import yt_dlp
except ImportError:
    print("ERROR: falta yt-dlp. Ejecuta ACTUALIZAR_URLS_YOUTUBE.bat.")
    raise SystemExit(2)

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
MANIFEST = DATA / "catalogs.json"
REPORT = DATA / "youtube_resolution_report.json"
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")

BAD_TERMS = {
    "karaoke": -35,
    "reaction": -45,
    "tutorial": -40,
    "cover": -25,
    "tribute": -25,
    "instrumental": -20,
    "slowed": -30,
    "reverb": -25,
    "nightcore": -35,
    "8d audio": -30,
    "sped up": -30,
}
GOOD_TERMS = {
    "official": 12,
    "official audio": 8,
    "official video": 8,
    "vevo": 9,
    "topic": 8,
    "provided to youtube": 7,
    "remastered": 2,
    "lyrics": 1,
}


def normalize(value: Any) -> str:
    text = unicodedata.normalize("NFD", str(value or ""))
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    text = text.lower().replace("&", " and ")
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def tokens(value: Any) -> list[str]:
    return [t for t in normalize(value).split() if len(t) >= 3]


def score_entry(entry: dict[str, Any], song: dict[str, Any]) -> float:
    title = normalize(entry.get("title"))
    uploader = normalize(entry.get("uploader") or entry.get("channel") or entry.get("uploader_id"))
    song_title = normalize(song.get("title"))
    artist = normalize(song.get("artist"))
    s_title_tokens = tokens(song.get("title"))
    s_artist_tokens = tokens(song.get("artist"))

    score = 0.0

    if song_title and song_title in title:
        score += 34
    if artist and (artist in title or artist in uploader):
        score += 26

    for tok in s_title_tokens:
        if tok in title:
            score += 4.5
    for tok in s_artist_tokens:
        if tok in uploader:
            score += 5.0
        elif tok in title:
            score += 2.5

    combined = f"{title} {uploader}"
    for term, points in GOOD_TERMS.items():
        if term in combined:
            score += points

    original_title = normalize(song.get("title"))
    for term, points in BAD_TERMS.items():
        if term in title and term not in original_title:
            score += points

    # Los directos suelen ser versiones distintas del single original.
    if "live" in title and "live" not in original_title:
        score -= 12

    duration = entry.get("duration")
    try:
        duration = float(duration) if duration is not None else 0
    except (TypeError, ValueError):
        duration = 0

    if duration:
        if 75 <= duration <= 600:
            score += 6
        elif duration < 45:
            score -= 25
        elif duration > 1200:
            score -= 30

    if entry.get("live_status") == "is_live" or entry.get("is_live"):
        score -= 60

    availability = normalize(entry.get("availability"))
    if availability in {"private", "premium only", "subscriber only", "needs auth"}:
        score -= 100

    return score


def unique_candidates(entries: list[dict[str, Any]], song: dict[str, Any]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    ranked: list[dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        video_id = str(entry.get("id") or "")
        if not VIDEO_ID_RE.match(video_id) or video_id in seen:
            continue
        seen.add(video_id)
        ranked.append({
            "id": video_id,
            "title": entry.get("title") or "",
            "uploader": entry.get("uploader") or entry.get("channel") or "",
            "duration": entry.get("duration"),
            "score": round(score_entry(entry, song), 2),
        })
    ranked.sort(key=lambda item: item["score"], reverse=True)
    return ranked


def search_candidates(ydl: yt_dlp.YoutubeDL, song: dict[str, Any]) -> tuple[list[dict[str, Any]], str]:
    artist = str(song.get("artist") or "").strip()
    title = str(song.get("title") or "").strip()
    raw = str(song.get("youtubeQuery") or "").strip()

    queries = []
    if raw:
        queries.append(raw)
    queries.extend([
        f'{artist} - {title} official audio',
        f'{artist} - {title}',
    ])

    deduped = []
    seen = set()
    for q in queries:
        key = normalize(q)
        if key and key not in seen:
            seen.add(key)
            deduped.append(q)

    best: list[dict[str, Any]] = []
    best_query = deduped[0] if deduped else f"{artist} {title}"

    for q in deduped:
        try:
            info = ydl.extract_info(f"ytsearch5:{q}", download=False)
            entries = list((info or {}).get("entries") or [])
            ranked = unique_candidates(entries, song)
            if ranked and (not best or ranked[0]["score"] > best[0]["score"]):
                best = ranked
                best_query = q
            # Un resultado con coincidencia fuerte ya es suficiente.
            if best and best[0]["score"] >= 55:
                break
        except Exception as exc:  # yt-dlp ya imprime el detalle si corresponde
            print(f"    búsqueda falló: {type(exc).__name__}: {exc}")

    return best, best_query


def save_catalog(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def catalog_entries() -> list[dict[str, Any]]:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    return list(manifest.get("catalogs") or [])


def add_urls_to_existing_ids() -> int:
    changed = 0
    for entry in catalog_entries():
        path = ROOT / entry["path"]
        data = json.loads(path.read_text(encoding="utf-8"))
        dirty = False
        for song in data.get("songs", []):
            vid = song.get("youtubeId")
            if isinstance(vid, str) and VIDEO_ID_RE.match(vid):
                expected = f"https://www.youtube.com/watch?v={vid}"
                if song.get("youtubeUrl") != expected:
                    song["youtubeUrl"] = expected
                    dirty = True
                    changed += 1
        if dirty:
            save_catalog(path, data)
    return changed


def audit() -> tuple[int, int, list[str]]:
    total = 0
    resolved = 0
    missing: list[str] = []
    for entry in catalog_entries():
        path = ROOT / entry["path"]
        data = json.loads(path.read_text(encoding="utf-8"))
        for song in data.get("songs", []):
            total += 1
            vid = song.get("youtubeId")
            url = song.get("youtubeUrl")
            if isinstance(vid, str) and VIDEO_ID_RE.match(vid) and url == f"https://www.youtube.com/watch?v={vid}":
                resolved += 1
            else:
                missing.append(str(song.get("id") or "?"))
    return total, resolved, missing


def resolve(args: argparse.Namespace) -> int:
    add_urls_to_existing_ids()

    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "extract_flat": "in_playlist",
        "socket_timeout": 20,
        "retries": 2,
        "fragment_retries": 2,
        "playlistend": 5,
    }

    if args.verbose:
        opts["quiet"] = False
        opts["no_warnings"] = False

    report_rows: list[dict[str, Any]] = []
    processed = 0
    resolved_now = 0
    failed_now = 0

    with yt_dlp.YoutubeDL(opts) as ydl:
        for entry in catalog_entries():
            if args.language and entry.get("language") != args.language:
                continue
            if args.decade and entry.get("decade") != args.decade:
                continue

            path = ROOT / entry["path"]
            data = json.loads(path.read_text(encoding="utf-8"))
            dirty = False

            for song in data.get("songs", []):
                if args.song_id and song.get("id") != args.song_id:
                    continue

                current_id = song.get("youtubeId")
                if not args.force and isinstance(current_id, str) and VIDEO_ID_RE.match(current_id):
                    expected = f"https://www.youtube.com/watch?v={current_id}"
                    if song.get("youtubeUrl") != expected:
                        song["youtubeUrl"] = expected
                        dirty = True
                    continue

                if args.limit is not None and processed >= args.limit:
                    if dirty and not args.dry_run:
                        save_catalog(path, data)
                    total, done, missing = audit()
                    print(f"\nPausa solicitada por --limit: {done}/{total} con URL estática; faltan {len(missing)}.")
                    return 0

                processed += 1
                print(f"[{processed:04}] {song.get('id')}  {song.get('artist')} - {song.get('title')}")
                ranked, used_query = search_candidates(ydl, song)

                if ranked:
                    best = ranked[0]
                    alternatives = [item["id"] for item in ranked[1:4]]
                    song["youtubeId"] = best["id"]
                    song["youtubeUrl"] = f"https://www.youtube.com/watch?v={best['id']}"
                    if alternatives:
                        song["youtubeAlternatives"] = alternatives
                    else:
                        song.pop("youtubeAlternatives", None)
                    song["youtubeResolvedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
                    song["youtubeResolution"] = "yt-dlp static catalog"
                    song["youtubeResolutionScore"] = best["score"]
                    dirty = True
                    resolved_now += 1
                    print(f"    OK {best['id']}  score={best['score']}  {best['title']}")
                    report_rows.append({
                        "songId": song.get("id"),
                        "artist": song.get("artist"),
                        "title": song.get("title"),
                        "query": used_query,
                        "youtubeId": best["id"],
                        "youtubeUrl": song["youtubeUrl"],
                        "score": best["score"],
                        "candidateTitle": best["title"],
                        "candidateUploader": best["uploader"],
                        "status": "resolved",
                    })
                else:
                    failed_now += 1
                    print("    SIN RESULTADO; queda pendiente para reintento.")
                    report_rows.append({
                        "songId": song.get("id"),
                        "artist": song.get("artist"),
                        "title": song.get("title"),
                        "query": used_query,
                        "status": "failed",
                    })

                # Guardado incremental: si YouTube limita temporalmente, el trabajo hecho no se pierde.
                if dirty and not args.dry_run and (resolved_now % 10 == 0 or args.song_id):
                    save_catalog(path, data)
                    dirty = False

                if args.pause > 0:
                    time.sleep(args.pause)

            if dirty and not args.dry_run:
                save_catalog(path, data)

    if not args.dry_run:
        previous = []
        if REPORT.exists():
            try:
                previous = json.loads(REPORT.read_text(encoding="utf-8")).get("runs", [])
            except Exception:
                previous = []
        previous.append({
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "force": args.force,
            "language": args.language,
            "decade": args.decade,
            "songId": args.song_id,
            "processed": processed,
            "resolved": resolved_now,
            "failed": failed_now,
            "items": report_rows,
        })
        REPORT.write_text(json.dumps({"runs": previous[-10:]}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    total, done, missing = audit()
    print("\n" + "=" * 68)
    print(f"CATÁLOGO YOUTUBE: {done}/{total} canciones con youtubeId + youtubeUrl.")
    print(f"Resueltas en esta ejecución: {resolved_now}; sin resultado: {failed_now}.")
    if missing:
        print(f"Faltan {len(missing)}. Vuelve a ejecutar el .bat: el proceso reanuda solo lo pendiente.")
        return 1
    print("OK: las 1.200 canciones tienen URL directa almacenada en JSON.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Resuelve y guarda URLs directas de YouTube para CGO Music.")
    parser.add_argument("--force", action="store_true", help="Vuelve a resolver incluso canciones que ya tienen youtubeId.")
    parser.add_argument("--language", choices=["english", "spanish"], help="Limita la actualización a un idioma.")
    parser.add_argument("--decade", choices=["50s", "60s", "70s", "80s", "90s", "2000s"], help="Limita a una década.")
    parser.add_argument("--song-id", help="Repara una sola canción por su id, por ejemplo en-80s-001.")
    parser.add_argument("--limit", type=int, help="Procesa como máximo N canciones pendientes en esta ejecución.")
    parser.add_argument("--pause", type=float, default=0.15, help="Pausa entre búsquedas para evitar sobrecarga (segundos).")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    return resolve(args)


if __name__ == "__main__":
    raise SystemExit(main())
