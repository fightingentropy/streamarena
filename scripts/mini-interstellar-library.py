#!/usr/bin/env python3
"""Add Interstellar to library.json on the Mac mini if missing."""
from __future__ import annotations

import json
import time
from pathlib import Path

APP = Path("/Users/hermes/Developer/netflix")
LIBRARY = APP / "assets" / "library.json"

entry = {
    "id": "local-movie-interstellar-2014",
    "title": "Interstellar",
    "tmdbId": "157336",
    "year": "2014",
    "src": "assets/videos/interstellar-2014-1080p-hevc.mp4",
    "thumb": "assets/images/interstellar-2014-thumb.jpg",
    "description": "The adventures of a group of explorers who make use of a newly discovered wormhole to surpass the limitations on human space travel and conquer the vast distances involved in an interstellar voyage.",
    "uploadedAt": int(time.time() * 1000),
}

data = json.loads(LIBRARY.read_text(encoding="utf-8"))
movies = data.setdefault("movies", [])
existing = next(
    (m for m in movies if str(m.get("tmdbId", "")).strip() == "157336"),
    None,
)
if existing:
    existing.update(entry)
    print("Updated existing Interstellar library entry")
else:
    movies.insert(0, entry)
    print("Inserted Interstellar library entry")

LIBRARY.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
