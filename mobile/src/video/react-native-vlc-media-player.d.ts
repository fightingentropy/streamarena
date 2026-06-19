// Minimal ambient types for react-native-vlc-media-player (ships JS only). Covers the
// surface VlcVideo.tsx uses; event payloads are loosely typed (the native bridge sends
// plain dictionaries — currentTime/duration in ms, position 0..1).
declare module "react-native-vlc-media-player" {
  import type { Component } from "react";
  import type { ViewProps } from "react-native";

  export interface VLCPlayerSource {
    uri: string;
    initOptions?: string[];
    type?: string;
    isNetwork?: boolean;
    autoplay?: boolean;
  }

  export interface VLCPlayerProps extends ViewProps {
    source: VLCPlayerSource;
    paused?: boolean;
    autoplay?: boolean;
    muted?: boolean;
    rate?: number;
    volume?: number;
    videoAspectRatio?: string;
    resizeMode?: string;
    onLoad?: (event: { duration?: number; videoSize?: { width: number; height: number } }) => void;
    onProgress?: (event: { currentTime?: number; duration?: number; position?: number }) => void;
    onBuffering?: (event: unknown) => void;
    onPlaying?: (event: { duration?: number; seekable?: boolean }) => void;
    onPaused?: (event: unknown) => void;
    onStopped?: () => void;
    onEnd?: (event: { currentTime?: number; duration?: number; position?: number }) => void;
    onError?: (event: unknown) => void;
    onOpen?: (event: unknown) => void;
    onLoadStart?: (event: unknown) => void;
  }

  export class VLCPlayer extends Component<VLCPlayerProps> {
    seek(pos: number): void;
    resume(isResume: boolean): void;
  }

  export class VlCPlayerView extends Component<Record<string, unknown>> {}
}
