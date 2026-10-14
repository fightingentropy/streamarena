# Native Continue Watching source ranking

Native version **1.0.1**, build **15**.

Continue Watching cards, their Resume action, and the Home featured Resume
button now open without the previous provider's source hash. The backend chooses
the current highest-ranked healthy source, currently Miami first with CineJoy
Nebula as backup. The title and canonical season/episode identity are preserved;
the player loads its existing saved watch position independently of the provider.
No stored progress, account data, or provider metadata is rewritten by this change.
Explicit source changes inside the player and ready offline downloads retain
their existing behavior.

## Verification

- TypeScript and Expo lint passed; all **87 mobile tests** passed.
- New integration regressions run the production resume lookup, source routing
  and player store for movies and TV. Both progress-first and video-first loads
  requested the current default source, retained the canonical episode, and
  applied the existing 613.25-second resume point exactly once.
- An iOS simulator used local account/media fixtures, with every account request
  and progress write confined to loopback. Tapping the movie Continue Watching
  card resumed at 0:42 and advanced. The TV card retained S2 E6, resumed at 1:15,
  and reported progress at 1:25. Both resolver requests omitted sourceHash; the
  fixture would reject a request that reused the old provider.
- Release builds for device and simulator succeeded. The signed device bundle
  passed strict codesign validation and was installed over Wi-Fi on the paired
  iPhone. Device inventory confirmed version 1.0.1/build 15, and launch succeeded.
  Physical-screen playback was not observed.

The simulator was returned to the production-configured Release app after the
fixture check. The app backend, web frontend and Oracle services need no redeploy.
