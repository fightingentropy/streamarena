import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";

// Shared "Feedback" nav item + modal, dropped into the top-nav of the browse
// pages (home, live, sports). Renders a fragment: the nav link sits inline with
// the other links, the modal is a fixed-position overlay so its DOM location in
// the nav doesn't matter. Submissions POST to /api/feedback and surface in the
// admin dashboard.
const MAX_LENGTH = 4000;
// Downscale attachments before upload so payloads stay well under the API's
// JSON body limit (and we strip EXIF as a side effect). Bug screenshots stay
// legible at this size.
const MAX_IMAGE_DIM = 1920;
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

// Load a File into something drawable on a canvas. Prefers createImageBitmap
// (decodes off the main thread) and falls back to an <img> + object URL.
function loadImage(file) {
  if (window.createImageBitmap) {
    return createImageBitmap(file);
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Couldn’t read that image."));
    };
    img.src = url;
  });
}

// Re-encode an image file to a downscaled data URL. WebP keeps screenshots
// crisp and small; falls back to JPEG where WebP encoding isn't supported.
async function processImageFile(file) {
  if (!file.type.startsWith("image/")) {
    throw new Error("Please choose an image file.");
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error("That image is too large (max 25 MB).");
  }
  const source = await loadImage(file);
  const sw = source.naturalWidth || source.width;
  const sh = source.naturalHeight || source.height;
  if (!sw || !sh) {
    throw new Error("Couldn’t read that image.");
  }
  const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(source, 0, 0, w, h);
  source.close?.();
  let dataUrl = canvas.toDataURL("image/webp", 0.85);
  if (!dataUrl.startsWith("data:image/webp")) {
    dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  }
  return dataUrl;
}

export default function FeedbackNav() {
  const [open, setOpen] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [image, setImage] = createSignal(""); // data URL of the attached screenshot
  const [imageBusy, setImageBusy] = createSignal(false);
  const [status, setStatus] = createSignal("idle"); // idle | submitting | sent | error
  const [error, setError] = createSignal("");
  let textareaEl;
  let fileEl;
  let closeTimer = 0;

  function openModal(event) {
    event?.preventDefault();
    clearTimeout(closeTimer);
    setError("");
    setStatus("idle");
    setOpen(true);
  }

  function closeModal() {
    clearTimeout(closeTimer);
    setOpen(false);
    setImage("");
    setImageBusy(false);
  }

  async function onPickFile(event) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = ""; // let the user re-pick the same file
    if (!file) return;
    setError("");
    setImageBusy(true);
    try {
      setImage(await processImageFile(file));
    } catch (err) {
      setImage("");
      setError(err.message || "Couldn’t process that image.");
    } finally {
      setImageBusy(false);
    }
  }

  async function submit() {
    const text = message().trim();
    if (!text) {
      setError("Please write some feedback first.");
      textareaEl?.focus();
      return;
    }
    setStatus("submitting");
    setError("");
    try {
      const body = { message: text.slice(0, MAX_LENGTH) };
      if (image()) body.image = image();
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || `Request failed (${response.status})`);
      }
      setStatus("sent");
      setMessage("");
      setImage("");
      closeTimer = setTimeout(closeModal, 1400);
    } catch (err) {
      setStatus("error");
      setError(err.message || "Couldn’t send feedback. Try again.");
    }
  }

  function onKeyDown(event) {
    if (event.key === "Escape") {
      closeModal();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  }

  // Lock background scroll and focus the textarea while the modal is open.
  createEffect(() => {
    if (open()) {
      document.body.classList.add("modal-open");
      queueMicrotask(() => textareaEl?.focus());
    } else {
      document.body.classList.remove("modal-open");
    }
  });

  onCleanup(() => {
    clearTimeout(closeTimer);
    document.body.classList.remove("modal-open");
  });

  return (
    <>
      <a href="#" class="nav-feedback-link" onClick={openModal}>
        Feedback
      </a>
      <Show when={open()}>
        <Portal mount={document.body}>
        <div
          class="feedback-overlay"
          role="presentation"
          onClick={closeModal}
          onKeyDown={onKeyDown}
        >
          <div
            class="feedback-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="feedbackModalTitle"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              class="feedback-close"
              type="button"
              aria-label="Close feedback"
              onClick={closeModal}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M6 6l12 12M18 6L6 18"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                />
              </svg>
            </button>
            <Show
              when={status() !== "sent"}
              fallback={
                <div class="feedback-sent">
                  <div class="feedback-sent-mark" aria-hidden="true">
                    <svg viewBox="0 0 24 24">
                      <path
                        d="M5 13l4 4L19 7"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2.2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                    </svg>
                  </div>
                  <h2 class="feedback-title">Thanks for the feedback!</h2>
                  <p class="feedback-sub">We read every message.</p>
                </div>
              }
            >
              <h2 id="feedbackModalTitle" class="feedback-title">
                Send feedback
              </h2>
              <p class="feedback-sub">
                Found a bug or have an idea? Let us know — it goes straight to the team.
              </p>
              <textarea
                ref={(el) => (textareaEl = el)}
                class="feedback-textarea"
                placeholder="What’s on your mind?"
                maxlength={MAX_LENGTH}
                rows={6}
                value={message()}
                disabled={status() === "submitting"}
                onInput={(event) => setMessage(event.currentTarget.value)}
                onKeyDown={onKeyDown}
              />
              <div class="feedback-attach">
                <input
                  ref={(el) => (fileEl = el)}
                  class="feedback-file-input"
                  type="file"
                  accept="image/*"
                  tabindex="-1"
                  aria-hidden="true"
                  onChange={onPickFile}
                />
                <Show
                  when={image()}
                  fallback={
                    <button
                      class="feedback-attach-btn"
                      type="button"
                      onClick={() => fileEl?.click()}
                      disabled={status() === "submitting" || imageBusy()}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path
                          d="M21 15l-5-5L5 21M3 16V5a2 2 0 0 1 2-2h11M16 3l5 5M14 3h7v7"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.8"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        />
                      </svg>
                      {imageBusy() ? "Processing…" : "Attach screenshot"}
                    </button>
                  }
                >
                  <div class="feedback-thumb">
                    <img src={image()} alt="Attachment preview" />
                    <button
                      class="feedback-thumb-remove"
                      type="button"
                      aria-label="Remove attachment"
                      onClick={() => setImage("")}
                      disabled={status() === "submitting"}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path
                          d="M6 6l12 12M18 6L6 18"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                        />
                      </svg>
                    </button>
                  </div>
                </Show>
              </div>
              <Show when={error()}>
                <div class="feedback-error">{error()}</div>
              </Show>
              <div class="feedback-actions">
                <button
                  class="feedback-btn"
                  type="button"
                  onClick={closeModal}
                  disabled={status() === "submitting"}
                >
                  Cancel
                </button>
                <button
                  class="feedback-btn is-primary"
                  type="button"
                  onClick={submit}
                  disabled={status() === "submitting" || imageBusy() || !message().trim()}
                >
                  {status() === "submitting" ? "Sending…" : "Submit"}
                </button>
              </div>
            </Show>
          </div>
        </div>
        </Portal>
      </Show>
    </>
  );
}
