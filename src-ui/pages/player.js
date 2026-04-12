import html from "solid-js/html";

export default function PlayerPage() {
  return html`<div data-solid-page-root="" style="display: contents">
    <main class="player-shell" tabindex="0">
      <video
        id="playerVideo"
        class="player-video"
        playsinline
        preload="metadata"
      ></video>

      <div id="subtitleOverlay" class="custom-subtitle-overlay" hidden></div>
      <div class="player-ui">
        <header class="top-row">
          <button
            id="goBack"
            class="icon-btn"
            type="button"
            aria-label="Back to browse"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M14.6 4.6 7.2 12l7.4 7.4-1.4 1.4L4.4 12l8.8-8.8Z"></path>
            </svg>
          </button>
        </header>

        <section class="controls-panel">
          <div class="seek-row">
            <div class="seek-bar-wrap">
              <input
                id="seekBar"
                class="seek-bar"
                type="range"
                min="0"
                max="1000"
                value="0"
                aria-label="Seek"
              />
              <div id="seekPreview" class="seek-preview" hidden>
                <canvas id="seekPreviewCanvas" class="seek-preview-thumb" width="160" height="90"></canvas>
                <span id="seekPreviewTime" class="seek-preview-time">00:00</span>
              </div>
            </div>
            <span id="durationText" class="duration">00:00</span>
          </div>

          <div class="controls-row">
            <div class="controls-left">
              <div class="controls-cluster">
                <button
                  id="togglePlay"
                  class="control-btn control-btn-main"
                  type="button"
                  aria-label="Pause"
                >
                  <svg class="icon-play" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M5 3.5v17L20 12 5 3.5Z"></path>
                  </svg>
                  <img
                    src="assets/icons/player-controls/left-pause.svg"
                    class="control-icon-image icon-pause-asset"
                    alt=""
                  />
                </button>
                <button
                  id="rewind10"
                  class="control-btn"
                  type="button"
                  aria-label="Rewind 10 seconds"
                >
                  <img
                    src="assets/icons/player-controls/left-rewind-10.svg"
                    class="control-icon-image"
                    alt=""
                  />
                </button>
                <button
                  id="forward10"
                  class="control-btn"
                  type="button"
                  aria-label="Forward 10 seconds"
                >
                  <img
                    src="assets/icons/player-controls/left-forward-10.svg"
                    class="control-icon-image"
                    alt=""
                  />
                </button>
                <div id="volumeControl" class="volume-control">
                  <div class="volume-slider-popover">
                    <input
                      id="volumeSlider"
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
                    class="control-btn"
                    type="button"
                    aria-label="Mute"
                  >
                    <img
                      src="assets/icons/player-controls/left-volume.svg"
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

            <p id="episodeLabel" class="episode-label">Title</p>

            <div class="controls-right">
              <div class="controls-cluster">
                <button
                  id="nextEpisode"
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
                  class="speed-menu-wrap episodes-menu-wrap"
                  hidden
                >
                  <button
                    id="toggleEpisodes"
                    class="control-btn episodes-btn"
                    type="button"
                    aria-label="Episodes"
                    aria-haspopup="dialog"
                    aria-controls="episodesMenu"
                    aria-expanded="false"
                  >
                    <img
                      src="assets/icons/player-controls/right-episodes.svg"
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
                      <p class="episodes-overline">Limited Series</p>
                      <h2
                        id="episodesPopoverTitle"
                        class="episodes-popover-title"
                      >
                        Episodes
                      </h2>
                    </div>
                    <div
                      id="episodesList"
                      class="episodes-list"
                      role="list"
                    ></div>
                  </div>
                </div>
                <div id="audioControl" class="speed-menu-wrap audio-menu-wrap">
                  <button
                    id="toggleAudio"
                    class="control-btn audio-btn"
                    type="button"
                    aria-label="Audio and subtitles"
                    aria-haspopup="listbox"
                    aria-controls="audioMenu"
                    aria-expanded="false"
                  >
                    <img
                      src="assets/icons/player-controls/right-captions.svg"
                      class="control-icon-image"
                      alt=""
                    />
                    <span
                      id="audioStatusBadge"
                      class="control-badge audio-status-badge"
                      hidden
                    ></span>
                  </button>
                  <div
                    id="audioMenu"
                    class="speed-popover audio-popover subtitles-popover"
                    role="dialog"
                    aria-label="Audio and subtitles"
                  >
                    <div class="audio-popover-grid">
                      <section
                        class="audio-popover-column audio-track-column"
                      >
                        <h3 class="audio-column-title">Audio</h3>
                        <div id="audioOptions" class="audio-options">
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
                            class="audio-tab is-active"
                            type="button"
                            role="tab"
                            aria-selected="true"
                            aria-controls="subtitlePanel"
                          >
                            Subtitles
                          </button>
                          <button
                            id="audioTabSources"
                            class="audio-tab"
                            type="button"
                            role="tab"
                            aria-selected="false"
                            aria-controls="sourcePanel"
                          >
                            Sources
                          </button>
                        </div>
                        <section
                          id="subtitlePanel"
                          class="audio-tab-panel"
                          role="tabpanel"
                          aria-labelledby="audioTabSubtitles"
                        >
                          <h3 class="audio-column-title">Subtitles</h3>
                          <div
                            id="subtitleOptions"
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
                        </section>
                        <section
                          id="sourcePanel"
                          class="audio-tab-panel audio-source-panel"
                          role="tabpanel"
                          aria-labelledby="audioTabSources"
                          hidden
                        >
                          <h3
                            id="sourceOptionsTitle"
                            class="audio-column-title audio-source-title"
                          >
                            Sources
                          </h3>
                          <div
                            id="sourceOptions"
                            class="audio-options source-options"
                            role="listbox"
                            aria-label="Playback sources"
                          ></div>
                        </section>
                      </section>
                    </div>
                  </div>
                </div>
                <div id="speedControl" class="speed-menu-wrap">
                  <button
                    id="toggleSpeed"
                    class="control-btn speed-btn"
                    type="button"
                    aria-label="Playback speed"
                    aria-haspopup="listbox"
                    aria-controls="speedMenu"
                    aria-expanded="false"
                  >
                    <img
                      src="assets/icons/player-controls/right-playback-speed.svg"
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
                      <button
                        class="speed-option"
                        type="button"
                        role="option"
                        data-rate="0.5"
                        aria-selected="false"
                      >
                        <span class="speed-dot" aria-hidden="true"></span>
                        <span class="speed-label">0.5x</span>
                      </button>
                      <button
                        class="speed-option"
                        type="button"
                        role="option"
                        data-rate="0.75"
                        aria-selected="false"
                      >
                        <span class="speed-dot" aria-hidden="true"></span>
                        <span class="speed-label">0.75x</span>
                      </button>
                      <button
                        class="speed-option"
                        type="button"
                        role="option"
                        data-rate="1"
                        aria-selected="true"
                      >
                        <span class="speed-dot" aria-hidden="true"></span>
                        <span class="speed-label">1x (Normal)</span>
                      </button>
                      <button
                        class="speed-option"
                        type="button"
                        role="option"
                        data-rate="1.25"
                        aria-selected="false"
                      >
                        <span class="speed-dot" aria-hidden="true"></span>
                        <span class="speed-label">1.25x</span>
                      </button>
                      <button
                        class="speed-option"
                        type="button"
                        role="option"
                        data-rate="1.5"
                        aria-selected="false"
                      >
                        <span class="speed-dot" aria-hidden="true"></span>
                        <span class="speed-label">1.5x</span>
                      </button>
                    </div>
                  </div>
                </div>
                <button
                  id="toggleFullscreen"
                  class="control-btn"
                  type="button"
                  aria-label="Fullscreen"
                >
                  <img
                    src="assets/icons/player-controls/right-fullscreen.svg"
                    class="control-icon-image"
                    alt=""
                  />
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>

      <div id="resolverOverlay" class="resolver-overlay" hidden>
        <div
          id="resolverLoader"
          class="seek-loading-indicator resolver-loader"
          role="status"
          aria-live="polite"
          aria-label="Loading video"
        >
          <span class="seek-netflix-spinner" aria-hidden="true"></span>
        </div>
        <div class="resolver-card" role="status" aria-live="polite">
          <p id="resolverStatus" class="resolver-status" hidden>
            Unable to resolve this stream.
          </p>
        </div>
      </div>

      <div id="seekLoadingOverlay" class="seek-loading-overlay" hidden>
        <div
          class="seek-loading-indicator"
          role="status"
          aria-live="polite"
          aria-label="Seeking"
        >
          <span class="seek-netflix-spinner" aria-hidden="true"></span>
        </div>
      </div>
    </main>
  </div>`;
}
