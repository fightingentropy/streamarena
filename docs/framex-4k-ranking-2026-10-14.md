# Miami first: FrameX and encoded 4K verification

Checked on 14 October 2026 from the Oracle London VM. The default order is now
Miami (2800), CineJoy Nebula (2600), Aether Lul (2200), Aether Link (2000),
CineJoy Lisbon (1400), then CineJoy Solara (1200). Admin overrides and learned
health can change this order; explicit source selections remain pinned.

## Encoded quality

Small fMP4 initialization files parsed by ffprobe confirm H.264 video dimensions:

- Interstellar: Miami 3832×1600 (cropped 4K width), Nebula 1920×1080.
- Oppenheimer: Miami 3840×2160, Nebula 1920×872 (cropped 1080p width).
- Game of Thrones S1E2: Miami 3840×2160, Nebula 1920×1080.

Miami keeps its complete adaptive ladder, including lower renditions. Choosing
Miami first does not force 4K or change the player's Auto quality policy. Encoded
raster dimensions establish resolution, not HDR, perceptual detail or whether
the upstream used an upscale. Availability remains title-specific.

Miami API discovery took 282–331 ms in these individual samples; discovery plus
manifest and initialization validation took 860–3057 ms. Nebula's isolated cold
one-shot Chromium discovery took 4235–4425 ms. These are neither browser startup
measurements nor a comparison against the warmed production CineJoy pool.

Detailed sanitized observations: [Miami and CineJoy samples](benchmarks/miami-cinejoy-4k-2026-10-14.json).

## Current FrameX sources

The current FrameX frontend and public provider catalog still expose Miami via
Movy/WeCollege, matching our existing integration. Boise also produces real 4K:
Interstellar 3832×1600, Inception 3840×2160 and Game of Thrones S1E1 3840×2160.
However, all three paired Boise/Miami requests returned byte-identical master
playlists from the same CDN, despite different opaque URLs. No independent
quality or delivery benefit was established, so Boise is not added as a duplicate.

Other current groups include VidLink, VidUp, VidFast, CineJoy and RiveStream.
Interstellar lookups through VidUp and VidFast failed upstream in this sample;
this is not proof of universal unavailability. RiveStream's PrimeVids dcloud
source encoded 1920×1080 in a bounded 64 KiB segment sample; its other options
advertised 720p or lower. No additional independent 4K source was established.
FrameX's provider-name quality labels alone do not verify a title's resolution.

Detailed sanitized observations: [FrameX catalog and paired checks](benchmarks/framex-sources-2026-10-14.json).

## Selection and fallback

The bounded preferred-family startup window now follows the current leading
ranked, healthy provider, rather than only CineJoy. The leading family has an eight-second cap; Miami's existing 4.5-second
per-source deadline is tighter. A failure starts backups immediately.
Health demotion and admin ranking can put another family first. Cached fallback
results cannot override the current preferred provider. No cache or database
flush is required.

The server controls this order for web and native clients, so this change requires
no iPhone rebuild. Existing iPhone Continue Watching entries can preserve their
saved HLS source; a fresh automatic play uses the current server ranking.

Regression tests cover the default order, successful slower preferred resolution,
immediate failure, the eight-second deadline, health demotion, explicit pins,
and stale fallback-cache rejection. Live release verification is reported
separately from source probes and local tests.
