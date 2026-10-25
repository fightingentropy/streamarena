# FrameX source check (2026-10-25)

FrameX (`framextv.cc`, API `api.framextv.tech/api/stream?type&id&provider`) lists 19
providers; 9 were available. Each FrameX id was mapped to its upstream from FrameX's
own alias table and the referers on its returned sources. One sample title
(Interstellar, TMDB 157336) was probed from the source's own CDN with `ffprobe`. Labels
were not trusted.

| FrameX id | Upstream | Decoded video | Decision |
| --- | --- | --- | --- |
| royal_champion | hexa.su (`dragonballzfans.xyz` CDN) | H.264 1920x1080 | Not added. Hexa serves its lookup only after a Cap proof-of-work CAPTCHA (`cap.hexa.su/.../challenge` and `/redeem`). We do not automate CAPTCHAs. |
| root_rider | vidzee (`core.vidzee.wtf`, `fastcloud.live`) | H.264 1920x1080 | **Added as `vidzee`** (rank 2300). |
| titan | films365 (direct MP4) | Mostly 854x480 or lower; 1080p only on some older films | Rejected: mostly SD. See below. |
| executioner | vidrock.to (`syntheticeclipse.site`) | H.264 1920x1080 | Not added. Probe took 10.4 s. The retired `vidrock.net` AES lookup now returns empty URLs, and inspecting the new player page was not permitted in this pass. |
| giant | meowtv (`hscow.com`) | H.264 1280x720 | Rejected: 720p. |
| bowler | RiveStream | Same CDNs as vidzee and meowtv | Not added; it duplicates vidzee and meowtv (see the 2026-10-14 notes). |
| battle_copter | vidapi (`nextgencloudfabric.com` referer) | 1080p ladder | Duplicate of Aether Link's media path. |
| super_barbarian | CineJoy | not found for the sample | Already integrated. |
| skeleton_king | vidstuck / thugtv | not sampled | FrameX reported it over budget during this check. |

FrameX marked miner (Movy, our Miami), headhunter (VidLink), hog_rider (VidUp),
lavahound (VidFast), valkyrie and druid as unavailable.

## Vidzee

- Lookup: `GET https://core.vidzee.wtf/streams/movie/{tmdb}` or
  `/streams/tv/{tmdb}/{season}/{episode}`, with `?s=dcloud&e=1` (also `ipcloud`).
  Response: `{"c": base64}`.
- `c` is RC4 with the first 2048 keystream bytes dropped. The 32-byte key is a constant
  in the WASM module of the player's `streams-*.js` chunk. The module checks that the
  page's hostname is on an allow list but does not use it in the key. The plaintext is
  `{"language","url","headers"}`.
- Media: `dcloud` returns a single MPEG-TS VOD media playlist with no resolution
  ladder, so the resolver reads the first segment's SPS; `ipcloud` returns a master
  playlist that must advertise a full-HD rendition. Segments on
  `nexcloud.live` carry no extension and are labelled `audio/ogg`. The playlist and
  segments return 403/404 without the `https://player.vidzee.wtf/` referer, and CORS is
  limited to that origin.
- Live resolver timings, including the segment SPS check: Interstellar 1.2 s,
  Spirited Away 1.1 s, Slow Horses S1E1 0.6 s.

## films365 (rejected)

`www.films365.org` maps TMDB ids to its own UUIDs through a Next.js server action
(`searchData`). Its movie and TV pages server-render a `videoUrl` on
`xstreamx.films365.org`. That MP4 needs no referer and supports range requests, but
sends no CORS headers.

The encoded dimensions of 20 titles were read from the MP4 `stsd` sample entry (first
64 KB). Two cases were cross-checked with ffprobe. There is one file per title, mirrored
from goojara.to, with no quality variants.

| Title | Encoded | | Title | Encoded |
| --- | --- | --- | --- | --- |
| Interstellar | 1920x1080 | | Slow Horses S1E1 | 854x426 |
| Spirited Away | 1920x1024 | | Game of Thrones S1E1 | 1280x720 |
| Dune: Part Two | 1920x804 | | Breaking Bad S1E1 | 854x480 |
| Inception | 1920x800 | | Severance S1E1 | 854x356 |
| The Dark Knight | 1920x800 | | The Bear S1E1 | 854x480 |
| Parasite | 1920x800 | | The Last of Us S1E1 | 854x480 |
| Oppenheimer | 854x480 | | Shogun S1E1 | 854x480 |
| Sinners | 854x354 | | The Office S2E1 | 854x480 |
| Superman (2025) | 854x480 | | Andor S1E1 | 854x480 |
| Weapons | 854x356 | | Stranger Things S1E1 | 854x426 |

All are AVC. Slow Horses S1-S5 (episodes 1, 3 and 6) are all 854x426. S6E1 is HEVC
960x480, and S6E6 was still pending and returned 404. FrameX labels this source "1080p"
even for the 480p Oppenheimer and Slow Horses files.

Under the full-HD policy, films365 would only add sources for older films that Miami and
CineJoy already cover. That does not justify the extra plumbing: a non-HLS result type in
the web and iPhone players, plus either browser-direct MP4 or a wider remote-remux host
policy (`media.rs` `is_allowed_remote_transcode_url`).
