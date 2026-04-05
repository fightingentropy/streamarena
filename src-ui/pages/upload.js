import html from "solid-js/html";

export default function UploadPage() {
  return html`<div data-solid-page-root="" style="display: contents">
    <main class="upload-page">
      <header class="upload-topbar">
        <a class="back-link" href="/">Back to Browse</a>
        <p class="upload-topbar-label">Library Ingestion</p>
      </header>

      <section class="upload-hero" aria-labelledby="uploadPageTitle">
        <div class="upload-hero-copy">
          <p class="upload-kicker">Local Media</p>
          <h1 id="uploadPageTitle">Upload Local Media</h1>
          <p class="upload-hero-description">
            Bring a local movie, episode, or course lesson into the
            library. Drop an <code>.mp4</code> or <code>.mkv</code>,
            review the file, then set the metadata once before it
            lands in the catalog.
          </p>
        </div>

        <aside class="upload-hero-panel" aria-label="Upload overview">
          <div class="upload-hero-row">
            <span>Containers</span>
            <strong>MP4 / MKV</strong>
          </div>
          <div class="upload-hero-row">
            <span>Fallback</span>
            <strong>AAC audio repair</strong>
          </div>
          <div class="upload-hero-row">
            <span>Targets</span>
            <strong>Movie, episode, course</strong>
          </div>
        </aside>
      </section>

      <div class="upload-shell">
        <aside class="upload-sidebar">
          <section id="uploadSeriesContext" class="upload-context" hidden>
            <h2 id="uploadSeriesContextTitle">Adding episode upload</h2>
            <p id="uploadSeriesContextMeta">
              This upload is linked to an existing series/course.
            </p>
          </section>

          <section class="upload-note-card">
            <p class="upload-note-kicker">Workflow</p>
            <h2 class="upload-note-title">Browser-first ingest</h2>
            <ul class="upload-note-list">
              <li>Choose the source file first.</li>
              <li>Review the preview and processing plan.</li>
              <li>Classify the title and add metadata once.</li>
            </ul>
          </section>

          <div
            id="compatibilityActions"
            class="compatibility-actions"
            hidden
          >
            <label class="compatibility-toggle">
              <input
                id="transcodeAudioToAac"
                name="transcodeAudioToAac"
                type="checkbox"
                checked
              />
              <span>
                Audio not browser-compatible? Fast-fix by
                transcoding audio to <code>AAC</code> while keeping
                original video codec, including H.265/HEVC.
              </span>
            </label>
          </div>

          <div class="upload-status-stack">
            <div
              id="uploadProgressWrap"
              class="upload-progress"
              hidden
              aria-live="polite"
            >
              <div class="upload-progress-label">
                <span id="uploadProgressText">Uploading... 0%</span>
                <span id="uploadProgressBytes">0 B / 0 B</span>
              </div>
              <div class="upload-progress-track" role="presentation">
                <div
                  id="uploadProgressBar"
                  class="upload-progress-bar"
                  style="width: 0%"
                ></div>
              </div>
            </div>

            <div
              id="processingTimeline"
              class="processing-timeline"
              hidden
              aria-live="polite"
            ></div>

            <p id="status" class="status" aria-live="polite"></p>
          </div>
        </aside>

        <section class="upload-panel">
          <div class="upload-workspace-intro">
            <p class="upload-section-kicker">Source File</p>
            <h2 class="upload-section-title">Choose the asset</h2>
            <p class="upload-section-copy">
              Start with the local file. Once the preview is ready,
              the metadata form stays below in the same workspace.
            </p>
          </div>

          <label id="dropZone" class="drop-zone" for="fileInput">
            <input
              id="fileInput"
              type="file"
              accept=".mp4,.mkv"
              hidden
            />
            <strong>Drag and drop a file here</strong>
            <span>or click to browse</span>
          </label>

          <section id="selectedMediaCard" class="selected-media" hidden>
            <div class="selected-media-thumb-wrap">
              <img
                id="selectedMediaThumb"
                class="selected-media-thumb"
                alt="Selected video thumbnail"
              />
            </div>
            <div class="selected-media-body">
              <p class="selected-media-kicker">Selected Asset</p>
              <h2 id="selectedMediaName" class="selected-media-name">
                Selected file
              </h2>
              <p id="selectedMediaMeta" class="selected-media-meta">
                File details
              </p>
              <p id="selectedMediaPlan" class="selected-media-plan">
                Processing plan
              </p>
              <button
                id="changeFileButton"
                type="button"
                class="change-file-btn"
              >
                Choose another file
              </button>
            </div>
          </section>

          <form id="uploadForm" class="metadata-form" autocomplete="off">
            <input name="tmdbId" type="hidden" />
            <input name="seriesId" type="hidden" />

            <section class="upload-form-section">
              <div class="upload-form-head">
                <p class="upload-section-kicker">Classification</p>
                <h2 class="upload-section-title">Type and routing</h2>
              </div>

              <fieldset class="content-type-fieldset">
                <legend>Content Type</legend>
                <div class="content-type-grid">
                  <label class="content-type-option">
                    <input type="radio" name="contentType" value="movie" checked />
                    <span>Movie</span>
                  </label>
                  <label class="content-type-option">
                    <input type="radio" name="contentType" value="episode" />
                    <span>Series Episode</span>
                  </label>
                  <label class="content-type-option">
                    <input type="radio" name="contentType" value="course" />
                    <span>Course Lesson</span>
                  </label>
                </div>
              </fieldset>

              <div class="grid">
                <label class="upload-field movie-only">
                  <span>Title</span>
                  <input
                    name="title"
                    type="text"
                    placeholder="Movie title"
                  />
                </label>
                <label class="upload-field movie-only">
                  <span>Year</span>
                  <input
                    name="year"
                    type="text"
                    inputmode="numeric"
                    placeholder="2024"
                  />
                </label>
                <label class="upload-field episode-only" hidden>
                  <span id="seriesTitleFieldLabel">Series Title</span>
                  <input
                    name="seriesTitle"
                    type="text"
                    placeholder="Series name"
                    data-series-placeholder="Series name"
                    data-course-placeholder="Course title"
                  />
                </label>
                <label class="upload-field episode-only" hidden>
                  <span id="seasonNumberFieldLabel">Season</span>
                  <input
                    name="seasonNumber"
                    type="number"
                    min="1"
                    value="1"
                  />
                </label>
                <label class="upload-field episode-only" hidden>
                  <span id="episodeNumberFieldLabel">Episode</span>
                  <input
                    name="episodeNumber"
                    type="number"
                    min="1"
                    value="1"
                  />
                </label>
                <label class="upload-field episode-only" hidden>
                  <span id="episodeTitleFieldLabel">Episode Title</span>
                  <input
                    name="episodeTitle"
                    type="text"
                    placeholder="Episode title"
                    data-series-placeholder="Episode title"
                    data-course-placeholder="Lesson title"
                  />
                </label>
              </div>
            </section>

            <section class="upload-form-section">
              <div class="upload-form-head">
                <p class="upload-section-kicker">Metadata</p>
                <h2 class="upload-section-title">Poster and description</h2>
              </div>

              <label class="upload-field">
                <span>Thumbnail</span>
                <input
                  name="thumb"
                  type="text"
                  placeholder="assets/images/thumbnail.jpg"
                />
                <small class="field-hint">
                  In series/course upload mode this is prefilled from
                  the course thumbnail. You can override it.
                </small>
              </label>

              <label class="upload-field">
                <span>Description</span>
                <textarea
                  name="description"
                  rows="4"
                  placeholder="Optional"
                ></textarea>
              </label>
            </section>

            <div class="upload-actions">
              <button id="submitButton" type="submit" disabled>
                Add to Library
              </button>
            </div>
          </form>
        </section>
      </div>
    </main>
  </div>`;
}
