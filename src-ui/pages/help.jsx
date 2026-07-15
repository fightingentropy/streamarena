import { createSignal, For, Show } from "solid-js";

import BrandWordmark from "../components/brand-wordmark.jsx";

// ─── Help content ────────────────────────────────────────────────────────────
// Topic categories and their guides. Plain data so the search can flatten and
// filter it; edit here to add/adjust articles.

const TOPICS = [
  {
    id: "getting-started",
    title: "Getting Started",
    icon: "M8 5v14l11-7z",
    articles: [
      {
        q: "How do I start watching something?",
        a: "From the Home page, hover over any title and press Play, or click it for more info and a synopsis. Use the search icon in the top bar to jump straight to a specific movie or show.",
      },
      {
        q: "What can I watch on StreamArena?",
        a: "Thousands of movies and shows on demand, plus Live TV channels and live Sports. Switch between the Home, Live, and Sports tabs in the top navigation.",
      },
      {
        q: "Which devices and browsers are supported?",
        a: "StreamArena runs in any modern browser — Chrome, Safari, Edge, or Firefox — on desktop, tablet, and phone. You can also install it like an app using your browser's “Install” or “Add to Home Screen” option.",
      },
    ],
  },
  {
    id: "playback",
    title: "Watching & Playback",
    icon: "M4 4h16v12H4zM2 20h20",
    articles: [
      {
        q: "A video won't play or keeps buffering",
        a: "Check your internet connection and refresh the page. If your connection is slow, lower the video quality from the player's settings (gear) menu. For a live stream that stalls, reload or switch to another source.",
      },
      {
        q: "How do I change the video quality?",
        a: "Open the settings (gear) menu during playback and pick a quality level. Auto adjusts automatically to your connection speed.",
      },
      {
        q: "Where did my Continue Watching row go?",
        a: "Titles you've partly watched appear in the Continue Watching row on Home. Once you finish a title it drops off the row automatically.",
      },
    ],
  },
  {
    id: "subtitles-audio",
    title: "Subtitles & Audio",
    icon: "M4 5h16v11H4zM7 20h10M8 9h8M8 12h5",
    articles: [
      {
        q: "How do I turn on subtitles?",
        a: "During playback, open the subtitles/audio menu and choose a subtitle track. You can set a default subtitle language and color under Account settings.",
      },
      {
        q: "How do I change the audio language?",
        a: "Use the audio menu in the player to switch tracks, or set a default audio language in Account settings so it's applied automatically.",
      },
      {
        q: "The subtitles are out of sync",
        a: "Use the subtitle offset control in the player to nudge the timing earlier or later until it lines up with the audio.",
      },
    ],
  },
  {
    id: "live-sports",
    title: "Live TV & Sports",
    icon: "M3 6h18v12H3zM8 21h8M12 3v3",
    articles: [
      {
        q: "How do I watch Live TV?",
        a: "Open the Live tab to see the available channels, then click a channel to start streaming right away.",
      },
      {
        q: "How do I watch a live match?",
        a: "Open the Sports tab for the schedule. Events with streams become playable 10 minutes before their scheduled start; upcoming ones show their start time.",
      },
      {
        q: "A live channel or match isn't loading",
        a: "Live sources occasionally go down for a moment. StreamArena automatically tries backup sources — if it keeps failing, reload the page or try again shortly.",
      },
    ],
  },
  {
    id: "account",
    title: "Account & Profile",
    icon: "M12 12a4 4 0 100-8 4 4 0 000 8zM4 21c0-4 3.6-6 8-6s8 2 8 6",
    articles: [
      {
        q: "How do I change my password?",
        a: "Open Account settings to update it, or use “Forgot password?” on the sign-in page to reset it by email.",
      },
      {
        q: "How do I change my profile picture?",
        a: "Go to Account settings and pick an avatar style, or upload your own image.",
      },
      {
        q: "How do I sign out?",
        a: "Click your avatar in the top-right corner and choose “Sign out”.",
      },
    ],
  },
  {
    id: "my-list",
    title: "My List & Saving",
    icon: "M5 4h11l-1 16-4.5-3L6 20zM18 4h1",
    articles: [
      {
        q: "How do I add something to My List?",
        a: "Open any title and click the + (My List) button. Everything you save shows up in the My List row, reachable from the top navigation.",
      },
      {
        q: "How do I remove a title from My List?",
        a: "Open the title again and click the ✓ button to remove it from your list.",
      },
    ],
  },
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    icon: "M13 2L3 14h7l-1 8 10-12h-7z",
    articles: [
      {
        q: "The site looks broken or won't load",
        a: "Refresh the page, then clear your browser cache if it persists. Make sure you're connected to the internet and on a supported browser.",
      },
      {
        q: "I didn't get my confirmation email",
        a: "Check your spam folder first. After signing in, you can resend the verification email from the banner at the top of the page.",
      },
      {
        q: "How do I report a problem?",
        a: "Use the Feedback link in the top navigation to send us a message — you can attach a screenshot to help us reproduce the issue.",
      },
    ],
  },
];

// Quick links shown under the search box.
const RECOMMENDED = [
  { label: "Fix buffering", topic: "playback", index: 0 },
  { label: "Turn on subtitles", topic: "subtitles-audio", index: 0 },
  { label: "Reset your password", topic: "account", index: 0 },
];

function articleKey(topicId, index) {
  return `${topicId}:${index}`;
}

export default function HelpPage() {
  const [query, setQuery] = createSignal("");
  const [openKey, setOpenKey] = createSignal(null);

  function toggle(key) {
    setOpenKey((prev) => (prev === key ? null : key));
  }

  // Flattened article list for searching.
  const allArticles = TOPICS.flatMap((topic) =>
    topic.articles.map((article, index) => ({
      ...article,
      topicId: topic.id,
      topicTitle: topic.title,
      key: articleKey(topic.id, index),
    })),
  );

  const results = () => {
    const q = query().trim().toLowerCase();
    if (!q) return null;
    return allArticles.filter(
      (a) =>
        a.q.toLowerCase().includes(q) ||
        a.a.toLowerCase().includes(q) ||
        a.topicTitle.toLowerCase().includes(q),
    );
  };

  function openRecommended(rec) {
    const key = articleKey(rec.topic, rec.index);
    setQuery("");
    setOpenKey(key);
    requestAnimationFrame(() => {
      document
        .getElementById(`article-${key}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  return (
    <div class="help-page">
      <header class="help-header">
        <div class="help-header-inner">
          <a class="help-brand" href="/" aria-label="StreamArena home">
            <BrandWordmark class="brand-wordmark-arc--help" />
            <span class="help-brand-divider" aria-hidden="true"></span>
            <span class="help-brand-label">Help Center</span>
          </a>
          <a class="help-back" href="/">Back to StreamArena</a>
        </div>
      </header>

      <section class="help-hero">
        <h1>How can we help?</h1>
        <div class="help-search">
          <svg viewBox="0 0 24 24" aria-hidden="true" class="help-search-icon">
            <path
              d="M21 21l-4.3-4.3M11 18a7 7 0 110-14 7 7 0 010 14z"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
          </svg>
          <input
            type="search"
            placeholder="Type a question, topic or issue"
            aria-label="Search help"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </div>
        <p class="help-recommended">
          <span>Recommended for you:</span>{" "}
          <For each={RECOMMENDED}>
            {(rec, i) => (
              <>
                <button
                  type="button"
                  class="help-reco-link"
                  onClick={() => openRecommended(rec)}
                >
                  {rec.label}
                </button>
                <Show when={i() < RECOMMENDED.length - 1}>{", "}</Show>
              </>
            )}
          </For>
        </p>
      </section>

      <main class="help-body">
        <Show
          when={results() !== null}
          fallback={
            <>
              <h2 class="help-section-title">Explore Topics</h2>
              <div class="help-topics">
                <For each={TOPICS}>
                  {(topic) => (
                    <section class="help-topic">
                      <h3 class="help-topic-title">
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path
                            d={topic.icon}
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.8"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          />
                        </svg>
                        {topic.title}
                      </h3>
                      <ul class="help-articles">
                        <For each={topic.articles}>
                          {(article, index) => {
                            const key = articleKey(topic.id, index());
                            return (
                              <li
                                id={`article-${key}`}
                                class="help-article"
                                classList={{ "is-open": openKey() === key }}
                              >
                                <button
                                  type="button"
                                  class="help-article-q"
                                  aria-expanded={openKey() === key}
                                  onClick={() => toggle(key)}
                                >
                                  <span>{article.q}</span>
                                  <span class="help-chevron" aria-hidden="true">
                                    +
                                  </span>
                                </button>
                                <Show when={openKey() === key}>
                                  <p class="help-article-a">{article.a}</p>
                                </Show>
                              </li>
                            );
                          }}
                        </For>
                      </ul>
                    </section>
                  )}
                </For>
              </div>
            </>
          }
        >
          <h2 class="help-section-title">
            {results().length} result{results().length === 1 ? "" : "s"}
            {" for "}
            <span class="help-query">“{query().trim()}”</span>
          </h2>
          <Show
            when={results().length > 0}
            fallback={
              <p class="help-empty">
                No results. Try different words, or browse the topics by clearing
                your search.
              </p>
            }
          >
            <ul class="help-articles help-articles--results">
              <For each={results()}>
                {(article) => (
                  <li
                    class="help-article"
                    classList={{ "is-open": openKey() === article.key }}
                  >
                    <button
                      type="button"
                      class="help-article-q"
                      aria-expanded={openKey() === article.key}
                      onClick={() => toggle(article.key)}
                    >
                      <span>
                        {article.q}
                        <span class="help-article-topic">{article.topicTitle}</span>
                      </span>
                      <span class="help-chevron" aria-hidden="true">
                        +
                      </span>
                    </button>
                    <Show when={openKey() === article.key}>
                      <p class="help-article-a">{article.a}</p>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>

        <section class="help-cta">
          <h2>Still need help?</h2>
          <p>
            Can't find what you're looking for? Send us a message with the
            Feedback link in the top navigation and we'll take a look.
          </p>
          <a class="help-cta-btn" href="/">Back to StreamArena</a>
        </section>
      </main>

      <footer class="help-footer">
        <BrandWordmark class="brand-wordmark-arc--help" />
        <span>&copy; 2026 StreamArena</span>
      </footer>
    </div>
  );
}
