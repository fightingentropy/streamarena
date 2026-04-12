import html from "solid-js/html";

export default function SettingsPage() {
  return html`<div data-solid-page-root="" style="display: contents">
    <main class="settings-page">
      <header class="settings-header">
        <div class="settings-header-brand">
          <a
            class="settings-logo-link"
            href="/"
            aria-label="Back to home"
          >
            <img
              src="assets/icons/netflix-n.svg"
              alt="Netflix"
              class="settings-logo"
            />
          </a>
          <div class="settings-header-copy">
            <p class="settings-header-label">Playback System</p>
            <a class="settings-back-link" href="/">Back to Browse</a>
          </div>
        </div>
        <p class="settings-header-note">
          Local defaults shape playback. Library and cache tools
          apply immediately when used.
        </p>
      </header>

      <section class="settings-hero" aria-labelledby="settingsTitle">
        <div class="settings-headline">
          <p class="settings-kicker">Defaults and Tools</p>
          <h1 id="settingsTitle">Settings</h1>
          <p class="settings-description">
            This page keeps playback behavior quiet and explicit:
            choose the default source bias, caption tone, avatar,
            and repair mode once, then leave the player clean.
          </p>
        </div>

        <aside class="settings-hero-panel" aria-label="Settings overview">
          <p class="settings-hero-panel-label">Overview</p>
          <div class="settings-overview-list">
            <article class="settings-overview-item">
              <span class="settings-overview-label">Playback</span>
              <strong>Quality, audio, remux</strong>
              <p>Default decisions for browser-first playback.</p>
            </article>
            <article class="settings-overview-item">
              <span class="settings-overview-label">Identity</span>
              <strong>Subtitles and avatar</strong>
              <p>Small visual defaults carried across the app shell.</p>
            </article>
            <article class="settings-overview-item">
              <span class="settings-overview-label">Maintenance</span>
              <strong>Library edit and cache reset</strong>
              <p>Immediate tools kept separate from the main save path.</p>
            </article>
          </div>
        </aside>
      </section>

      <div class="settings-layout">
        <section
          class="settings-card settings-card--main"
          aria-labelledby="settingsDefaultsTitle"
        >
          <div class="settings-card-intro">
            <p class="settings-card-kicker">Saved Preferences</p>
            <h2 id="settingsDefaultsTitle" class="settings-card-title">
              Default behavior
            </h2>
            <p class="settings-card-copy">
              These values persist locally and inform the next
              playback session unless a title-level override is
              chosen.
            </p>
          </div>

          <form id="qualityForm" class="quality-form">
            <h2 class="settings-section-title">Playback Quality</h2>
            <label class="quality-option">
              <input type="radio" name="quality" value="auto" />
              <span class="quality-option-label">Auto (Any Quality)</span>
              <small>Let the resolver choose the highest-ranked match.</small>
            </label>

            <label class="quality-option">
              <input type="radio" name="quality" value="2160p" />
              <span class="quality-option-label">4K (2160p)</span>
              <small>Prefer the highest-resolution releases available.</small>
            </label>

            <label class="quality-option">
              <input type="radio" name="quality" value="1080p" />
              <span class="quality-option-label">Full HD (1080p default)</span>
              <small>Balanced start time and image quality for browser playback.</small>
            </label>

            <label class="quality-option">
              <input type="radio" name="quality" value="720p" />
              <span class="quality-option-label">HD (720p)</span>
              <small>Lower bitrate for smoother starts on weaker sources.</small>
            </label>

            <section
              class="source-filter-section"
              aria-labelledby="defaultAudioTitle"
            >
              <h2 id="defaultAudioTitle" class="settings-section-title">
                Default Audio
              </h2>
              <p class="source-filter-help">
                Pick the audio language playback should prefer
                before any title-specific override.
              </p>

              <label class="source-language-filter" for="defaultAudioLanguage">
                <span class="source-filter-label">Preferred audio language</span>
                <select
                  id="defaultAudioLanguage"
                  name="defaultAudioLanguage"
                >
                  <option value="en">English (default)</option>
                  <option value="auto">Auto / source default</option>
                  <option value="ja">Japanese</option>
                  <option value="ko">Korean</option>
                  <option value="zh">Chinese</option>
                  <option value="fr">French</option>
                  <option value="es">Spanish</option>
                  <option value="de">German</option>
                  <option value="it">Italian</option>
                  <option value="pt">Portuguese</option>
                  <option value="nl">Dutch</option>
                  <option value="ro">Romanian</option>
                </select>
              </label>

              <p class="source-filter-note">
                Player audio selections for a specific movie still
                override this default.
              </p>
            </section>

            <section
              class="source-filter-section"
              aria-labelledby="sourceFilterTitle"
            >
              <h2 id="sourceFilterTitle" class="settings-section-title">
                Torrent Source Defaults
              </h2>
              <p class="source-filter-help">
                Keep browser-first torrent playback simple. Local
                files are not restricted by these source rules.
              </p>

              <div class="source-filter-stack">
                <label class="source-min-seeds" for="sourceMinSeeders">
                  <span class="source-filter-label">Minimum seeds</span>
                  <input
                    id="sourceMinSeeders"
                    name="sourceMinSeeders"
                    type="number"
                    min="0"
                    max="50000"
                    step="1"
                    value="0"
                  />
                </label>

                <label class="source-language-filter" for="sourceLanguage">
                  <span class="source-filter-label">Source language</span>
                  <select id="sourceLanguage" name="sourceLanguage">
                    <option value="en">English only (default)</option>
                    <option value="any">Any language</option>
                    <option value="fr">French</option>
                    <option value="es">Spanish</option>
                    <option value="de">German</option>
                    <option value="it">Italian</option>
                    <option value="pt">Portuguese</option>
                  </select>
                </label>

                <label class="source-language-filter" for="sourceAudioProfile">
                  <span class="source-filter-label">Source audio mix</span>
                  <select id="sourceAudioProfile" name="sourceAudioProfile">
                    <option value="single">
                      Prefer single-audio releases (default)
                    </option>
                    <option value="any">
                      Allow multi-audio / dubbed releases
                    </option>
                  </select>
                </label>
              </div>

              <p class="source-filter-note">
                Torrent sources stay MP4-only for the fastest
                browser start. Leave source language on English and
                source audio mix on single-audio to bias auto-play
                toward cleaner single-language releases.
              </p>
            </section>

            <section class="remux-mode-section" aria-labelledby="remuxModeTitle">
              <h2 id="remuxModeTitle" class="settings-section-title">
                Browser Remux
              </h2>
              <p class="remux-mode-help">
                Controls how aggressive browser remux should be
                when timing cleanup is needed.
              </p>
              <div
                class="remux-mode-options"
                role="radiogroup"
                aria-label="Browser remux video mode"
              >
                <label class="remux-mode-option">
                  <input
                    type="radio"
                    name="remuxVideoMode"
                    value="auto"
                  />
                  <span class="remux-mode-option-label">Auto (Recommended)</span>
                  <small>Uses copy for simple files and switches to normalize when stronger timestamp cleanup is needed.</small>
                </label>
                <label class="remux-mode-option">
                  <input
                    type="radio"
                    name="remuxVideoMode"
                    value="copy"
                  />
                  <span class="remux-mode-option-label">Copy (Fastest)</span>
                  <small>Lowest CPU usage, but problematic files can stay out of sync.</small>
                </label>
                <label class="remux-mode-option">
                  <input
                    type="radio"
                    name="remuxVideoMode"
                    value="normalize"
                  />
                  <span class="remux-mode-option-label">Normalize (Best Sync)</span>
                  <small>Rebuilds video timestamps for stronger sync correction.</small>
                </label>
              </div>
              <p class="remux-mode-note">
                Applies only to in-browser playback.
              </p>
            </section>

            <section
              class="subtitle-color-section"
              aria-labelledby="subtitleColorTitle"
            >
              <h2 id="subtitleColorTitle" class="settings-section-title">
                Subtitles
              </h2>
              <p class="subtitle-color-help">
                Pick the default caption color for browser
                playback.
              </p>
              <div class="subtitle-color-controls">
                <label class="subtitle-color-picker-label" for="subtitleColorInput">Color</label>
                <input
                  id="subtitleColorInput"
                  name="subtitleColor"
                  type="color"
                  value="#b8bcc3"
                />
                <button
                  id="subtitleColorReset"
                  class="subtitle-color-reset-btn"
                  type="button"
                >
                  Reset
                </button>
              </div>
              <p id="subtitleColorPreview" class="subtitle-color-preview">
                Sample subtitle preview text.
              </p>
            </section>

            <section class="avatar-style-section" aria-labelledby="avatarStyleTitle">
              <h2 id="avatarStyleTitle" class="settings-section-title">
                Appearance
              </h2>
              <p class="avatar-style-help">
                Choose the icon used in the top-right account menu.
              </p>

              <div class="avatar-style-preview-wrap">
                <span class="avatar-style-preview-label">Preview</span>
                <div
                  id="avatarStylePreview"
                  class="avatar-style-preview avatar-style-blue"
                  aria-hidden="true"
                ></div>
              </div>

              <div
                class="avatar-style-options"
                role="radiogroup"
                aria-label="Profile icon style"
              >
                <label class="avatar-style-option">
                  <input type="radio" name="avatarStyle" value="blue" />
                  <span class="avatar-style-swatch avatar-style-blue" aria-hidden="true"></span>
                  <span>Blue</span>
                </label>
                <label class="avatar-style-option">
                  <input type="radio" name="avatarStyle" value="crimson" />
                  <span class="avatar-style-swatch avatar-style-crimson" aria-hidden="true"></span>
                  <span>Crimson</span>
                </label>
                <label class="avatar-style-option">
                  <input type="radio" name="avatarStyle" value="emerald" />
                  <span class="avatar-style-swatch avatar-style-emerald" aria-hidden="true"></span>
                  <span>Emerald</span>
                </label>
                <label class="avatar-style-option">
                  <input type="radio" name="avatarStyle" value="violet" />
                  <span class="avatar-style-swatch avatar-style-violet" aria-hidden="true"></span>
                  <span>Violet</span>
                </label>
                <label class="avatar-style-option">
                  <input type="radio" name="avatarStyle" value="amber" />
                  <span class="avatar-style-swatch avatar-style-amber" aria-hidden="true"></span>
                  <span>Amber</span>
                </label>
                <label class="avatar-style-option avatar-style-option--custom">
                  <input type="radio" name="avatarStyle" value="custom" />
                  <span
                    id="avatarCustomThumb"
                    class="avatar-style-swatch avatar-style-custom-thumb"
                    aria-hidden="true"
                  ></span>
                  <span>Custom image</span>
                </label>
              </div>

              <div class="avatar-upload-controls">
                <label class="avatar-upload-btn" for="avatarImageInput">Choose from computer</label>
                <input
                  id="avatarImageInput"
                  type="file"
                  accept="image/*"
                />
                <span
                  id="avatarUploadHint"
                  class="avatar-upload-hint"
                >Center-cropped and resized before save.</span>
              </div>
            </section>

            <div class="settings-actions">
              <button id="saveQuality" class="save-btn" type="submit">
                Save Settings
              </button>
              <p
                id="saveStatus"
                class="save-status"
                role="status"
                aria-live="polite"
              ></p>
            </div>
          </form>
        </section>

        <aside class="settings-sidebar" aria-label="Tools">
          <div class="settings-sidebar-header">
            <p class="settings-sidebar-kicker">Immediate Actions</p>
            <h2 class="settings-sidebar-title">Tool rail</h2>
            <p class="settings-sidebar-copy">
              These actions bypass the main save button and update
              state the moment you trigger them.
            </p>
          </div>

          <section
            class="library-edit-section settings-tool-card"
            aria-labelledby="libraryEditTitle"
          >
            <div class="library-edit-header">
              <h2 id="libraryEditTitle" class="settings-section-title">
                Library Tools
              </h2>
              <label class="library-edit-toggle">
                <input id="libraryEditModeToggle" type="checkbox" />
                <span>Edit mode</span>
              </label>
            </div>
            <p class="library-edit-help">
              Enable edit mode to expose title edit actions across
              the app, then update metadata or remove entries.
            </p>
            <p
              id="libraryEditStatus"
              class="library-edit-status"
              role="status"
              aria-live="polite"
            ></p>
            <div
              id="libraryEditList"
              class="library-edit-list"
              role="list"
            ></div>
          </section>

          <section
            class="maintenance-section settings-tool-card"
            aria-labelledby="maintenanceTitle"
          >
            <h2 id="maintenanceTitle" class="settings-section-title">
              Maintenance
            </h2>
            <p class="maintenance-help">
              Clear cached stream, metadata, subtitle, and
              playback-session state when you want a hard reset.
            </p>
            <div class="maintenance-actions">
              <button
                id="clearAllCachesBtn"
                class="clear-cache-btn"
                type="button"
              >
                Clear Server Caches
              </button>
              <p
                id="cacheClearStatus"
                class="cache-clear-status"
                role="status"
                aria-live="polite"
              ></p>
            </div>
          </section>
        </aside>
      </div>
    </main>
  </div>`;
}
