export function renderPlayerShell({
  defaultEpisodeThumbnail,
  handleLiveIframePlaybackError,
  liveIframeAllowPolicy,
  refs,
}) {
  return <><div data-solid-page-root="" class="solid-page-root">
    <main class="player-shell" tabindex="0" ref={refs.playerShell}>
      <video
        id="playerVideo"
        ref={refs.video}
        class="player-video"
        playsinline
        preload="metadata"
      ></video>
      <iframe
        id="liveEmbedFrame"
        ref={refs.liveEmbedFrame}
        class="live-embed-frame"
        title="Live stream player"
        allow={liveIframeAllowPolicy}
        allowfullscreen
        referrerpolicy="strict-origin-when-cross-origin"
        onError={handleLiveIframePlaybackError}
        hidden
      ></iframe>

      <div id="subtitleOverlay" ref={refs.subtitleOverlay} class="custom-subtitle-overlay" hidden></div>
      <div class="player-ui">
        <header class="top-row">
          <div class="top-row-left">
            <button
              id="goBack"
              ref={refs.goBack}
              class="icon-btn"
              type="button"
              aria-label="Back to browse"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M14.6 4.6 7.2 12l7.4 7.4-1.4 1.4L4.4 12l8.8-8.8Z"></path>
              </svg>
            </button>
          </div>
        </header>

        <section class="controls-panel">
          <div class="seek-row">
            <div class="seek-bar-wrap">
              <input
                id="seekBar"
                ref={refs.seekBar}
                class="seek-bar"
                type="range"
                min="0"
                max="1000"
                value="0"
                aria-label="Seek"
              />
              <div id="seekPreview" ref={refs.seekPreview} class="seek-preview" hidden>
                <canvas id="seekPreviewCanvas" ref={refs.seekPreviewCanvas} class="seek-preview-thumb" width="160" height="90"></canvas>
                <span id="seekPreviewTime" ref={refs.seekPreviewTime} class="seek-preview-time">00:00</span>
              </div>
            </div>
            <span id="durationText" ref={refs.durationText} class="duration" aria-label="Time remaining">00:00</span>
          </div>

          <div class="controls-row">
            <div class="controls-left">
              <div class="controls-cluster">
                <button
                  id="togglePlay"
                  ref={refs.togglePlay}
                  class="control-btn control-btn-main"
                  type="button"
                  aria-label="Pause"
                >
                  <svg class="icon-play" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M5 3.5v17L20 12 5 3.5Z"></path>
                  </svg>
                  <img
                    src="/assets/icons/player-controls/left-pause.svg"
                    class="control-icon-image icon-pause-asset"
                    alt=""
                  />
                </button>
                <button
                  id="rewind10"
                  ref={refs.rewind10}
                  class="control-btn"
                  type="button"
                  aria-label="Rewind 10 seconds"
                >
                  <img
                    src="/assets/icons/player-controls/left-rewind-10.svg"
                    class="control-icon-image"
                    alt=""
                  />
                </button>
                <button
                  id="forward10"
                  ref={refs.forward10}
                  class="control-btn"
                  type="button"
                  aria-label="Forward 10 seconds"
                >
                  <img
                    src="/assets/icons/player-controls/left-forward-10.svg"
                    class="control-icon-image"
                    alt=""
                  />
                </button>
                <div id="volumeControl" ref={refs.volumeControl} class="volume-control">
                  <div class="volume-slider-popover">
                    <input
                      id="volumeSlider"
                      ref={refs.volumeSlider}
                      class="volume-slider"
                      type="range"
                      min="0"
                      max="100"
                      value="100"
                      step="1"
                      aria-label="Volume"
                    />
                  </div>
                  <button
                    id="toggleMutePlayer"
                    ref={refs.toggleMutePlayer}
                    class="control-btn"
                    type="button"
                    aria-label="Mute"
                  >
                    <img
                      src="/assets/icons/player-controls/left-volume.svg"
                      class="control-icon-image icon-volume-on-asset"
                      alt=""
                    />
                    <svg class="icon-volume-off" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M14 5.2v13.6a1 1 0 0 1-1.68.74L7.6 15H5a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2h2.6l4.72-4.54A1 1 0 0 1 14 5.2Zm6.3 3.1a1 1 0 0 1 0 1.4L18.01 12l2.3 2.3a1 1 0 0 1-1.42 1.4L16.6 13.4l-2.3 2.3a1 1 0 0 1-1.4-1.42l2.3-2.28-2.3-2.3a1 1 0 0 1 1.4-1.4l2.3 2.3 2.29-2.3a1 1 0 0 1 1.41 0Z"></path>
                    </svg>
                  </button>
                </div>
              </div>
            </div>

            <p id="episodeLabel" ref={refs.episodeLabel} class="episode-label"></p>

            <div class="controls-right">
              <div class="controls-cluster">
                <div
                  id="sourceControl"
                  ref={refs.sourceControl}
                  class="speed-menu-wrap source-menu-wrap bottom-source-control"
                  hidden
                >
                  <button
                    id="toggleSource"
                    ref={refs.toggleSource}
                    class="control-btn source-btn bottom-server-btn"
                    type="button"
                    aria-label="Server"
                    aria-haspopup="listbox"
                    aria-controls="sourceMenu"
                    aria-expanded="false"
                  >
                    <svg class="bottom-server-icon" viewBox="0 0 24 24" aria-hidden="true">
                      <rect x="3.25" y="3.75" width="17.5" height="7" rx="1.8"></rect>
                      <rect x="3.25" y="13.25" width="17.5" height="7" rx="1.8"></rect>
                      <path d="M6.8 7.25h.01"></path>
                      <path d="M6.8 16.75h.01"></path>
                      <path d="M13.5 7.25h3.7"></path>
                      <path d="M13.5 16.75h3.7"></path>
                    </svg>
                  </button>
                  <div
                    id="sourceMenu"
                    ref={refs.sourceMenu}
                    class="speed-popover source-popover"
                    role="listbox"
                    aria-label="Server"
                  >
                    <p class="speed-popover-title source-popover-title">Server</p>
                    <div
                      id="sourceOptions"
                      ref={refs.sourceOptionsContainer}
                      class="audio-options source-options source-popover-options"
                      aria-label="Playback servers"
                    ></div>
                  </div>
                </div>
                <button
                  id="nextEpisode"
                  ref={refs.nextEpisode}
                  class="control-btn series-control-btn"
                  type="button"
                  aria-label="Next episode"
                  hidden
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 5.5v13l11-6.5-11-6.5Zm13 .2h3v12.6h-3z"></path>
                  </svg>
                </button>
                <div
                  id="episodesControl"
                  ref={refs.episodesControl}
                  class="speed-menu-wrap episodes-menu-wrap"
                  hidden
                >
                  <button
                    id="toggleEpisodes"
                    ref={refs.toggleEpisodes}
                    class="control-btn episodes-btn"
                    type="button"
                    aria-label="Episodes"
                    aria-haspopup="dialog"
                    aria-controls="episodesMenu"
                    aria-expanded="false"
                  >
                    <img
                      src="/assets/icons/player-controls/right-episodes.svg"
                      class="control-icon-image"
                      alt=""
                    />
                  </button>
                  <div
                    id="episodesMenu"
                    class="speed-popover episodes-popover"
                    role="dialog"
                    aria-label="Episodes"
                  >
                    <div class="episodes-popover-head">
                      <button
                        id="episodesBackToSeasons"
                        ref={refs.episodesBackToSeasons}
                        class="episodes-back-button"
                        type="button"
                        aria-label="Show seasons"
                        hidden
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path
                            d="M15 5 8 12l7 7"
                            fill="none"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          ></path>
                        </svg>
                      </button>
                      <div class="episodes-heading">
                        <p
                          id="episodesOverline"
                          ref={refs.episodesOverline}
                          class="episodes-overline"
                        >
                          Episodes
                        </p>
                        <h2
                          id="episodesPopoverTitle"
                          ref={refs.episodesPopoverTitle}
                          class="episodes-popover-title"
                        >
                          Episodes
                        </h2>
                      </div>
                    </div>
                    <div
                      id="episodesList"
                      ref={refs.episodesList}
                      class="episodes-list"
                      role="list"
                    ></div>
                  </div>
                </div>
                <div
                  id="liveStreamControl"
                  ref={refs.liveStreamControl}
                  class="speed-menu-wrap live-stream-menu-wrap"
                  hidden
                >
                  <button
                    id="toggleLiveStream"
                    ref={refs.toggleLiveStream}
                    class="control-btn live-stream-btn"
                    type="button"
                    aria-label="Live stream"
                    aria-haspopup="listbox"
                    aria-controls="liveStreamMenu"
                    aria-expanded="false"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M4 6.5h16v2H4v-2Zm0 4.5h10v2H4v-2Zm0 4.5h16v2H4v-2Zm13.8-5.4 3.8 2.4-3.8 2.4v-4.8Z"></path>
                    </svg>
                  </button>
                  <div
                    id="liveStreamMenu"
                    ref={refs.liveStreamMenu}
                    class="speed-popover live-stream-popover"
                    role="listbox"
                    aria-label="Live stream"
                  >
                    <p class="speed-popover-title live-stream-popover-title">Live stream</p>
                    <div
                      id="liveStreamOptions"
                      ref={refs.liveStreamOptionsContainer}
                      class="audio-options live-stream-options"
                    ></div>
                  </div>
                </div>
                <div id="audioControl" ref={refs.audioControl} class="speed-menu-wrap audio-menu-wrap">
                  <button
                    id="toggleAudio"
                    ref={refs.toggleAudio}
                    class="control-btn audio-btn"
                    type="button"
                    aria-label="Audio and subtitles"
                    aria-haspopup="listbox"
                    aria-controls="audioMenu"
                    aria-expanded="false"
                  >
                    <img
                      src="/assets/icons/player-controls/right-captions.svg"
                      class="control-icon-image"
                      alt=""
                    />
                    <span
                      id="audioStatusBadge"
                      ref={refs.audioStatusBadge}
                      class="control-badge audio-status-badge"
                      hidden
                    ></span>
                  </button>
                  <div
                    id="audioMenu"
                    ref={refs.audioMenu}
                    class="speed-popover audio-popover subtitles-popover"
                    role="dialog"
                    aria-label="Audio and subtitles"
                  >
                    <div class="audio-popover-grid">
                      <section
                        class="audio-popover-column audio-track-column"
                      >
                        <h3 class="audio-column-title">Audio</h3>
                        <div id="audioOptions" ref={refs.audioOptionsContainer} class="audio-options">
                          <button
                            class="audio-option"
                            type="button"
                            role="option"
                            data-lang="auto"
                            aria-selected="true"
                          >
                            Auto
                          </button>
                          <button
                            class="audio-option"
                            type="button"
                            role="option"
                            data-lang="en"
                            aria-selected="false"
                          >
                            English
                          </button>
                          <button
                            class="audio-option"
                            type="button"
                            role="option"
                            data-lang="fr"
                            aria-selected="false"
                          >
                            French
                          </button>
                          <button
                            class="audio-option"
                            type="button"
                            role="option"
                            data-lang="es"
                            aria-selected="false"
                          >
                            Spanish
                          </button>
                          <button
                            class="audio-option"
                            type="button"
                            role="option"
                            data-lang="de"
                            aria-selected="false"
                          >
                            German
                          </button>
                        </div>
                      </section>
                      <section
                        class="audio-popover-column audio-subtitle-column"
                      >
                        <div
                          class="audio-tab-list"
                          role="tablist"
                          aria-label="Subtitle menu tabs"
                        >
                          <button
                            id="audioTabSubtitles"
                            ref={refs.audioTabSubtitles}
                            class="audio-tab is-active"
                            type="button"
                            role="tab"
                            aria-selected="true"
                            aria-controls="subtitlePanel"
                          >
                            Subtitles
                          </button>
                        </div>
                        <section
                          id="subtitlePanel"
                          ref={refs.subtitlePanel}
                          class="audio-tab-panel"
                          role="tabpanel"
                          aria-labelledby="audioTabSubtitles"
                        >
                          <h3 class="audio-column-title">Subtitles</h3>
                          <div
                            id="subtitleOptions"
                            ref={refs.subtitleOptionsContainer}
                            class="audio-options subtitle-options"
                          >
                            <button
                              class="audio-option subtitle-option"
                              type="button"
                              role="option"
                              data-subtitle-lang="off"
                              aria-selected="true"
                            >
                              Off
                            </button>
                          </div>
                          <div
                            class="subtitle-sync"
                            role="group"
                            aria-label="Subtitle delay"
                          >
                            <div class="subtitle-sync-head">
                              <span class="subtitle-sync-label">
                                Subtitle delay
                              </span>
                              <button
                                id="subtitleSyncReset"
                                ref={refs.subtitleSyncReset}
                                class="subtitle-sync-reset"
                                type="button"
                                hidden
                              >
                                Reset
                              </button>
                            </div>
                            <div class="subtitle-sync-controls">
                              <button
                                id="subtitleSyncEarlier"
                                ref={refs.subtitleSyncEarlier}
                                class="subtitle-sync-btn"
                                type="button"
                                aria-label="Show subtitles earlier"
                                title="Show subtitles earlier"
                              >
                                −
                              </button>
                              <span
                                id="subtitleSyncValue"
                                ref={refs.subtitleSyncValue}
                                class="subtitle-sync-value"
                                aria-live="polite"
                              >
                                0s
                              </span>
                              <button
                                id="subtitleSyncLater"
                                ref={refs.subtitleSyncLater}
                                class="subtitle-sync-btn"
                                type="button"
                                aria-label="Delay subtitles (show later)"
                                title="Delay subtitles (show later)"
                              >
                                +
                              </button>
                            </div>
                          </div>
                        </section>
                      </section>
                    </div>
                  </div>
                </div>
                <div
                  id="hlsQualityControl"
                  ref={refs.hlsQualityControl}
                  class="speed-menu-wrap hls-quality-menu-wrap"
                  hidden
                >
                  <button
                    id="toggleHlsQuality"
                    ref={refs.toggleHlsQuality}
                    class="control-btn hls-quality-btn"
                    type="button"
                    aria-label="Quality"
                    aria-haspopup="listbox"
                    aria-controls="hlsQualityMenu"
                    aria-expanded="false"
                  >
                    <svg class="hls-quality-icon" viewBox="0 0 24 24" aria-hidden="true">
                      <rect x="2.75" y="5.25" width="18.5" height="13.5" rx="3"></rect>
                      <path d="M7 9.1v5.8"></path>
                      <path d="M10.6 9.1v5.8"></path>
                      <path d="M7 12h3.6"></path>
                      <path d="M13.3 9.1v5.8"></path>
                      <path d="M13.3 9.1h0.9a2.9 2.9 0 0 1 0 5.8h-0.9"></path>
                    </svg>
                  </button>
                  <div
                    id="hlsQualityMenu"
                    ref={refs.hlsQualityMenu}
                    class="speed-popover hls-quality-popover"
                    role="listbox"
                    aria-label="Quality"
                  >
                    <p class="speed-popover-title hls-quality-popover-title">Quality</p>
                    <div
                      id="hlsQualityOptions"
                      ref={refs.hlsQualityOptionsContainer}
                      class="audio-options hls-quality-options"
                    ></div>
                  </div>
                </div>
                <div id="speedControl" ref={refs.speedControl} class="speed-menu-wrap">
                  <button
                    id="toggleSpeed"
                    ref={refs.toggleSpeed}
                    class="control-btn speed-btn"
                    type="button"
                    aria-label="Playback speed"
                    aria-haspopup="listbox"
                    aria-controls="speedMenu"
                    aria-expanded="false"
                  >
                    <img
                      src="/assets/icons/player-controls/right-playback-speed.svg"
                      class="control-icon-image"
                      alt=""
                    />
                  </button>
                  <div
                    id="speedMenu"
                    class="speed-popover"
                    role="listbox"
                    aria-label="Playback speed"
                  >
                    <p class="speed-popover-title">Playback speed</p>
                    <div class="speed-options">
                      <button class="speed-option" type="button" role="option" data-rate="0.5" aria-selected="false">
                        <span class="speed-dot" aria-hidden="true"></span>
                        <span class="speed-label">0.5x</span>
                      </button>
                      <button class="speed-option" type="button" role="option" data-rate="0.75" aria-selected="false">
                        <span class="speed-dot" aria-hidden="true"></span>
                        <span class="speed-label">0.75x</span>
                      </button>
                      <button class="speed-option" type="button" role="option" data-rate="1" aria-selected="true">
                        <span class="speed-dot" aria-hidden="true"></span>
                        <span class="speed-label">1x (Normal)</span>
                      </button>
                      <button class="speed-option" type="button" role="option" data-rate="1.25" aria-selected="false">
                        <span class="speed-dot" aria-hidden="true"></span>
                        <span class="speed-label">1.25x</span>
                      </button>
                      <button class="speed-option" type="button" role="option" data-rate="1.5" aria-selected="false">
                        <span class="speed-dot" aria-hidden="true"></span>
                        <span class="speed-label">1.5x</span>
                      </button>
                      <button class="speed-option" type="button" role="option" data-rate="2" aria-selected="false">
                        <span class="speed-dot" aria-hidden="true"></span>
                        <span class="speed-label">2x</span>
                      </button>
                    </div>
                  </div>
                </div>
                <button
                  id="toggleFullscreen"
                  ref={refs.toggleFullscreen}
                  class="control-btn"
                  type="button"
                  aria-label="Fullscreen"
                  title="Fullscreen"
                >
                  <img
                    src="/assets/icons/player-controls/right-fullscreen.svg"
                    class="control-icon-image"
                    alt=""
                  />
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>

      <div id="autoPlayOverlay" ref={refs.autoPlayOverlay} class="autoplay-overlay" hidden>
        <div class="autoplay-card">
          <div class="autoplay-thumb-wrap">
            <img
              ref={refs.autoPlayThumb}
              class="autoplay-thumb"
              src={`/${defaultEpisodeThumbnail}`}
              alt="Next episode"
            />
            <div class="autoplay-countdown-ring-wrap">
              <svg class="autoplay-countdown-ring" viewBox="0 0 48 48">
                <circle class="autoplay-ring-track" cx="24" cy="24" r="20" />
                <circle
                  ref={refs.autoPlayProgressRing}
                  class="autoplay-ring-progress"
                  cx="24"
                  cy="24"
                  r="20"
                />
              </svg>
              <span ref={refs.autoPlayCountdownText} class="autoplay-countdown-text"></span>
            </div>
          </div>
          <div class="autoplay-info">
            <p class="autoplay-up-next">Next Episode</p>
            <p ref={refs.autoPlayTitle} class="autoplay-series-title"></p>
            <p ref={refs.autoPlayEpLabel} class="autoplay-ep-label"></p>
          </div>
          <div class="autoplay-actions">
            <button
              ref={refs.autoPlayBtn}
              class="autoplay-play-btn"
              type="button"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 3.5v17L20 12 5 3.5Z"></path>
              </svg>
              Play Now
            </button>
            <button
              ref={refs.autoPlayCancel}
              class="autoplay-cancel-btn"
              type="button"
              aria-label="Cancel auto-play"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M18.3 5.7a1 1 0 0 0-1.4 0L12 10.6 7.1 5.7a1 1 0 0 0-1.4 1.4L10.6 12l-4.9 4.9a1 1 0 1 0 1.4 1.4L12 13.4l4.9 4.9a1 1 0 0 0 1.4-1.4L13.4 12l4.9-4.9a1 1 0 0 0 0-1.4Z"></path>
              </svg>
            </button>
          </div>
        </div>
      </div>

      <div id="resolverOverlay" ref={refs.resolverOverlay} class="resolver-overlay" hidden>
        <div
          id="resolverLoader"
          ref={refs.resolverLoader}
          class="seek-loading-indicator resolver-loader"
          role="status"
          aria-live="polite"
          aria-label="Loading video"
        >
          <span class="seek-brand-spinner" aria-hidden="true"></span>
        </div>
        <div class="resolver-card" role="status" aria-live="polite">
          <h2
            id="resolverTitle"
            ref={refs.resolverTitle}
            class="resolver-title"
            hidden
          ></h2>
          <p id="resolverStatus" ref={refs.resolverStatus} class="resolver-status" hidden>
            Unable to resolve this stream.
          </p>
          <p
            id="resolverDetail"
            ref={refs.resolverDetail}
            class="resolver-detail"
            hidden
          ></p>
          <p
            id="resolverCountdown"
            ref={refs.resolverCountdown}
            class="resolver-countdown"
            hidden
          ></p>
          <div class="resolver-actions">
            <button
              id="resolverRetryButton"
              ref={refs.resolverRetryButton}
              class="resolver-action resolver-action-primary"
              type="button"
              hidden
            >
              Retry now
            </button>
            <button
              id="resolverAlternateButton"
              ref={refs.resolverAlternateButton}
              class="resolver-action"
              type="button"
              hidden
            >
              Try another source
            </button>
          </div>
        </div>
      </div>

      <div id="seekLoadingOverlay" ref={refs.seekLoadingOverlay} class="seek-loading-overlay" hidden>
        <div
          class="seek-loading-indicator"
          role="status"
          aria-live="polite"
          aria-label="Seeking"
        >
          <span class="seek-brand-spinner" aria-hidden="true"></span>
        </div>
      </div>
    </main>
  </div></>;
}
