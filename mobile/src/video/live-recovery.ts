export const LIVE_HEALTHY_PLAYBACK_SECONDS = 6;

// Tokenized live-channel playlists can expire while an otherwise healthy stream
// is already playing. A channel with no alternate source gets one fresh resolve,
// but only after real playback proved the source healthy; this avoids looping a
// dead source during initial startup.
export function shouldRefreshSingleLiveSource(
  sourceCount: number,
  position: number,
  refreshAlreadyAttempted: boolean,
): boolean {
  return (
    sourceCount === 1
    && Number.isFinite(position)
    && position > LIVE_HEALTHY_PLAYBACK_SECONDS
    && !refreshAlreadyAttempted
  );
}
