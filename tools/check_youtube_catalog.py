from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "data" / "catalogs.json"
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


def main() -> int:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    total = complete = 0
    missing: list[str] = []
    for entry in manifest.get("catalogs", []):
        data = json.loads((ROOT / entry["path"]).read_text(encoding="utf-8"))
        for song in data.get("songs", []):
            total += 1
            vid = song.get("youtubeId")
            url = song.get("youtubeUrl")
            ok = (
                isinstance(vid, str)
                and VIDEO_ID_RE.fullmatch(vid) is not None
                and url == f"https://www.youtube.com/watch?v={vid}"
            )
            if ok:
                complete += 1
            else:
                missing.append(str(song.get("id") or "?"))

    print(f"CGO Music YouTube: {complete}/{total} URLs estaticas completas.")
    if missing:
        print(f"Faltan: {len(missing)}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
