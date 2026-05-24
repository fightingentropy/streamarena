#!/usr/bin/env bash
set -euo pipefail

APP="/Users/hermes/Developer/netflix"
cd "$APP"

FFMPEG="${FFMPEG:-/opt/homebrew/bin/ffmpeg}"
FFPROBE="${FFPROBE:-/opt/homebrew/bin/ffprobe}"
if [[ ! -x "$FFMPEG" ]]; then
  FFMPEG="$(command -v ffmpeg || true)"
fi
if [[ ! -x "$FFPROBE" ]]; then
  FFPROBE="$(command -v ffprobe || true)"
fi
if [[ -z "$FFMPEG" || -z "$FFPROBE" ]]; then
  echo "ffmpeg/ffprobe not found" >&2
  exit 1
fi

# Complete 1080p x265 BluRay source already cached via local torrent.
SRC="$APP/cache/local-torrents/9bb5a1b259c6a945eaf71ce162926514712296c7/Interstellar.2014.1080p.BluRay.DDP5.1.x265.10bit-GalaxyRG265.mkv"
OUT="$APP/assets/videos/interstellar-2014-1080p-hevc.mp4"
TMP="$APP/cache/interstellar-2014-1080p-hevc.part.mp4"
THUMB="$APP/assets/images/interstellar-2014-thumb.jpg"

if [[ ! -f "$SRC" ]]; then
  echo "Source file missing: $SRC" >&2
  exit 1
fi

echo "=== Source ==="
ls -lah "$SRC"
if ! "$FFPROBE" -hide_banner "$SRC" >/dev/null 2>&1; then
  echo "Source failed ffprobe validation" >&2
  exit 1
fi
"$FFPROBE" -hide_banner "$SRC" 2>&1 | head -20

if [[ -f "$OUT" ]]; then
  echo "Output already exists: $OUT"
  ls -lah "$OUT"
else
  echo "=== Optimizing to library MP4 (stream copy + faststart) ==="
  rm -f "$TMP"
  "$FFMPEG" -hide_banner -y -i "$SRC" \
    -map 0:v:0 -map 0:a:0 \
    -sn -dn \
    -c:v copy -c:a copy \
    -movflags +faststart \
    "$TMP"
  mv "$TMP" "$OUT"
  echo "=== Output ==="
  ls -lah "$OUT"
fi

if [[ ! -f "$THUMB" ]]; then
  echo "=== Extracting poster frame ==="
  "$FFMPEG" -hide_banner -y -ss 120 -i "$OUT" -frames:v 1 -update 1 -q:v 2 "$THUMB" || \
    "$FFMPEG" -hide_banner -y -ss 60 -i "$OUT" -frames:v 1 -update 1 -q:v 2 "$THUMB"
fi

echo "=== Cleanup stale partial Interstellar downloads ==="
find "$APP/cache/local-torrents" -name '*.download' \( -iname '*interstellar*' -o -path '*396f812a*' -o -path '*a11b0ed*' -o -path '*71fee293*' -o -path '*3aaf839*' \) -print -delete 2>/dev/null || true

# Remove corrupt/incomplete cached MP4 that cannot be played.
CORRUPT_MP4="$APP/cache/local-torrents/3aaf8394429cd3c0126a369de1e75a40a293aff7/Interstellar (2014) IMDB 8.6 #D-ChristopherNolan #SciFi AnneHathaway JessicaChastain MackenzieFoy MatthewMcConaughey/Interstellar.2014.PROPER.1080p.BluRay.x265-RARBG.mp4"
if [[ -f "$CORRUPT_MP4" ]] && ! "$FFPROBE" -hide_banner "$CORRUPT_MP4" >/dev/null 2>&1; then
  echo "Removing corrupt cached source: $CORRUPT_MP4"
  rm -f "$CORRUPT_MP4"
fi

echo "=== Done ==="
