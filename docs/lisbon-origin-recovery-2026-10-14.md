# Lisbon missing-segment recovery

Interstellar's Lisbon master and some opening fragments work, but later audio
and video fragments return HTTP 502 with the exact body `origin unavailable`.
The same requests failed from Oracle, from the MacBook, and in CineJoy's own
player. CineJoy also remained stuck seeking at 600 seconds. Its current master
matched the one our resolver found. Range headers, quality changes and a fresh
resolve did not restore the missing audio. This is a provider-origin fault;
working opening fragments alone do not prove that a title is seekable.

The media relay now distinguishes this explicit upstream response from a
transport outage. It returns a non-cacheable 424, without exposing upstream
URLs or error bodies. Inspection is bounded to 1 KiB and one second; other
errors retain their existing retry behavior.

The web player handles that fragment failure immediately, before hls.js's
fatal-error/retry cycle, and skips alternate delivery routes for the broken
source. Automatic recovery uses the existing ranked HLS alternatives, preserving
the current seek and pause state. Ordinary temporary 503s still retry in place.

iOS build 16 adds the same recovery to the device relay. It notifies the player
even if VLC silently retries, ignores late responses from an old session, and
does not refresh the same missing source. A newer seek made while the replacement
source list loads wins over the original target. No progress records are rewritten.

Regressions cover real decoded browser playback after a missing-segment seek,
paused recovery, transient errors, duplicate audio/video failure notifications,
stale callbacks, and native routing/store recovery. A missing provider origin
still requires a working alternative; this change cannot repair third-party
media storage. Miami and Lisbon retain their configured first/second priorities
when healthy.
