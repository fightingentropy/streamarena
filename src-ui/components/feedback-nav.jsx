import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";

// Shared "Feedback" nav item + modal, dropped into the top-nav of the browse
// pages (home, live, sports). Renders a fragment: the nav link sits inline with
// the other links, the modal is a fixed-position overlay so its DOM location in
// the nav doesn't matter. Submissions POST to /api/feedback and surface in the
// admin dashboard.
const MAX_LENGTH = 4000;

export default function FeedbackNav() {
  const [open, setOpen] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [status, setStatus] = createSignal("idle"); // idle | submitting | sent | error
  const [error, setError] = createSignal("");
  let textareaEl;
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
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text.slice(0, MAX_LENGTH) }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || `Request failed (${response.status})`);
      }
      setStatus("sent");
      setMessage("");
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
                  disabled={status() === "submitting" || !message().trim()}
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
