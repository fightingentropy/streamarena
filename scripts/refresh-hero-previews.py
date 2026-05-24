#!/usr/bin/env python3
"""Refresh cached home-hero preview videos for popular TMDB movies."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


TMDB_API_BASE = "https://api.themoviedb.org/3"
PREVIEW_DIR = Path("assets/videos/hero-previews")
MANIFEST_PATH = Path("assets/hero-previews.json")
DEFAULT_LIMIT = 10
MIN_PREVIEW_BYTES = 100 * 1024
YTDLP_FORMAT = (
    "bv*[height<=720][ext=mp4]+ba[ext=m4a]/"
    "b[height<=720][ext=mp4]/"
    "best[height<=720]/best"
)


def log(message: str) -> None:
    print(f"{utc_now()} {message}", flush=True)


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def script_default_app_dir() -> Path:
    script_path = Path(__file__).resolve()
    if script_path.parent.name == "bin":
        return script_path.parents[1]
    return script_path.parents[1]


def load_env_file(path: Path) -> None:
    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key or key in os.environ:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        os.environ[key] = value


def load_runtime_env(app_dir: Path) -> None:
    load_env_file(Path.home() / ".config/netflix/env")
    load_env_file(app_dir / ".env")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--app-dir",
        default=os.environ.get("NETFLIX_APP_DIR") or os.environ.get("REMOTE_APP"),
        help="Runtime app directory. Defaults to this repo/app root.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=int(os.environ.get("HERO_PREVIEW_LIMIT", DEFAULT_LIMIT)),
        help=f"Number of popular title previews to keep. Default: {DEFAULT_LIMIT}.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-download existing previews.",
    )
    parser.add_argument(
        "--no-bootstrap-ytdlp",
        action="store_true",
        help="Do not install or upgrade yt-dlp with pip if it is missing.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Fetch TMDB metadata and print the planned manifest without downloading.",
    )
    return parser.parse_args()


def fetch_json(path: str, params: dict[str, str], timeout: int = 25) -> dict:
    query = urllib.parse.urlencode(params)
    url = f"{TMDB_API_BASE}{path}?{query}"
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "fightingentropy-netflix-hero-previews/1.0",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = response.read().decode("utf-8")
    parsed = json.loads(payload)
    return parsed if isinstance(parsed, dict) else {}


def slugify(value: str, fallback: str = "preview") -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug[:80] or fallback


def score_video(video: dict) -> int:
    site = str(video.get("site") or "").strip().lower()
    key = str(video.get("key") or "").strip()
    if site != "youtube" or not key:
        return -1
    video_type = str(video.get("type") or "").strip().lower()
    name = str(video.get("name") or "").strip().lower()
    score = 0
    if video_type == "trailer":
        score += 50
    if video.get("official"):
        score += 20
    if "official trailer" in name:
        score += 15
    if "trailer" in name:
        score += 8
    if video_type == "teaser":
        score += 4
    if str(video.get("iso_639_1") or "").strip().lower() == "en":
        score += 3
    return score


def select_preview_video(details: dict) -> Optional[dict]:
    videos = details.get("videos")
    results = videos.get("results") if isinstance(videos, dict) else []
    candidates = [video for video in results if isinstance(video, dict) and score_video(video) >= 0]
    if not candidates:
        return None
    return sorted(candidates, key=score_video, reverse=True)[0]


def ensure_ytdlp(bootstrap: bool) -> None:
    probe = subprocess.run(
        [sys.executable, "-m", "yt_dlp", "--version"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if probe.returncode == 0:
        return
    if not bootstrap:
        raise RuntimeError("yt-dlp is not installed and bootstrap is disabled")
    log("yt_dlp=installing")
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "--user", "--upgrade", "yt-dlp"],
        check=True,
    )


def remove_temp_downloads(preview_dir: Path, stem: str) -> None:
    for path in preview_dir.glob(f".{stem}.download*"):
        if path.is_file():
            path.unlink()


def download_preview(source_url: str, output_path: Path, force: bool) -> bool:
    if (
        not force
        and output_path.is_file()
        and output_path.stat().st_size >= MIN_PREVIEW_BYTES
    ):
        return False

    preview_dir = output_path.parent
    preview_dir.mkdir(parents=True, exist_ok=True)
    remove_temp_downloads(preview_dir, output_path.stem)
    temp_template = preview_dir / f".{output_path.stem}.download.%(ext)s"
    command = [
        sys.executable,
        "-m",
        "yt_dlp",
        "--no-playlist",
        "--quiet",
        "--no-warnings",
        "--format",
        YTDLP_FORMAT,
        "--merge-output-format",
        "mp4",
        "--remux-video",
        "mp4",
        "--output",
        str(temp_template),
        source_url,
    ]
    subprocess.run(command, check=True)
    downloaded = sorted(preview_dir.glob(f".{output_path.stem}.download.*"))
    mp4_candidates = [path for path in downloaded if path.suffix.lower() == ".mp4"]
    selected = mp4_candidates[0] if mp4_candidates else (downloaded[0] if downloaded else None)
    if not selected or not selected.is_file():
        raise RuntimeError(f"yt-dlp did not produce a preview file for {source_url}")
    if selected.stat().st_size < MIN_PREVIEW_BYTES:
        selected.unlink(missing_ok=True)
        raise RuntimeError(f"downloaded preview is too small for {source_url}")
    if output_path.exists():
        output_path.unlink()
    selected.replace(output_path)
    remove_temp_downloads(preview_dir, output_path.stem)
    return True


def write_manifest(app_dir: Path, payload: dict) -> None:
    manifest_path = app_dir / MANIFEST_PATH
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=str(manifest_path.parent),
        delete=False,
    ) as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")
        temp_name = handle.name
    Path(temp_name).replace(manifest_path)


def cleanup_previews(preview_dir: Path, keep_names: set[str]) -> None:
    if not preview_dir.is_dir():
        return
    for path in preview_dir.iterdir():
        if path.name in keep_names:
            continue
        if path.is_file() and (path.suffix.lower() == ".mp4" or path.name.startswith(".")):
            path.unlink()


def build_preview_plan(api_key: str, limit: int) -> list[dict]:
    popular = fetch_json(
        "/movie/popular",
        {
            "api_key": api_key,
            "language": "en-US",
            "page": "1",
        },
    )
    results = popular.get("results") if isinstance(popular.get("results"), list) else []
    plan: list[dict] = []
    for item in results:
        if not isinstance(item, dict) or len(plan) >= limit:
            break
        tmdb_id = str(item.get("id") or "").strip()
        title = str(item.get("title") or item.get("name") or "").strip()
        if not tmdb_id or not title:
            continue
        details = fetch_json(
            f"/movie/{urllib.parse.quote(tmdb_id)}",
            {
                "api_key": api_key,
                "language": "en-US",
                "append_to_response": "videos",
            },
        )
        video = select_preview_video(details)
        if not video:
            log(f"skip tmdb_id={tmdb_id} title={title!r} reason=no_preview_video")
            continue
        key = str(video.get("key") or "").strip()
        file_name = f"{tmdb_id}-{slugify(title)}.mp4"
        plan.append(
            {
                "tmdbId": tmdb_id,
                "title": title,
                "fileName": file_name,
                "src": f"assets/videos/hero-previews/{file_name}",
                "sourceUrl": f"https://www.youtube.com/watch?v={urllib.parse.quote(key)}",
                "videoKey": key,
            }
        )
        time.sleep(0.15)
    return plan


def main() -> int:
    args = parse_args()
    app_dir = Path(args.app_dir).expanduser().resolve() if args.app_dir else script_default_app_dir()
    load_runtime_env(app_dir)
    api_key = os.environ.get("TMDB_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("TMDB_API_KEY is required to refresh hero previews")

    limit = max(1, min(int(args.limit or DEFAULT_LIMIT), 20))
    preview_dir = app_dir / PREVIEW_DIR
    log(f"refresh begin app_dir={app_dir} limit={limit} dry_run={args.dry_run}")
    plan = build_preview_plan(api_key, limit)
    if args.dry_run:
        print(json.dumps({"updatedAt": utc_now(), "entries": plan}, indent=2, sort_keys=True))
        return 0

    ensure_ytdlp(bootstrap=not args.no_bootstrap_ytdlp)
    entries = []
    for item in plan:
        output_path = preview_dir / item["fileName"]
        try:
            downloaded = download_preview(item["sourceUrl"], output_path, force=args.force)
            log(
                f"preview {'downloaded' if downloaded else 'kept'} "
                f"tmdb_id={item['tmdbId']} title={item['title']!r} file={item['fileName']}"
            )
            entry = {
                "tmdbId": item["tmdbId"],
                "title": item["title"],
                "src": item["src"],
                "sourceUrl": item["sourceUrl"],
                "videoKey": item["videoKey"],
                "updatedAt": utc_now(),
            }
            entries.append(entry)
        except Exception as error:  # noqa: BLE001 - launchd logs need the failing title.
            log(
                f"preview failed tmdb_id={item['tmdbId']} "
                f"title={item['title']!r} error={error}"
            )

    if not entries:
        raise RuntimeError("no hero previews were refreshed")

    keep_names = {Path(entry["src"]).name for entry in entries}
    cleanup_previews(preview_dir, keep_names)
    manifest = {
        "updatedAt": utc_now(),
        "rotation": "daily",
        "entries": entries,
    }
    write_manifest(app_dir, manifest)
    log(f"refresh complete entries={len(entries)} manifest={app_dir / MANIFEST_PATH}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001 - keep launchd failures readable.
        log(f"refresh error={exc}")
        raise
