import { For } from "solid-js";

import BrandWordmark from "../components/brand-wordmark.jsx";

// ─── Legal documents ─────────────────────────────────────────────────────────
// One component serves both /privacy and /terms; the doc is picked from the URL.

const DOCS = {
  "/privacy": {
    title: "Privacy Policy",
    updated: "June 2026",
    intro:
      "This Privacy Policy explains what information StreamArena collects, how we use it, and the choices you have. By using StreamArena you agree to the practices described here.",
    sections: [
      {
        heading: "Information We Collect",
        body: "When you create an account we store your email address and a securely hashed password. As you use the service we keep your viewing activity, watch progress, My List, and playback preferences so we can sync them across your devices.",
      },
      {
        heading: "How We Use Your Information",
        body: "We use your information to run the service: to sign you in, remember where you left off, show your Continue Watching and My List, apply your language and subtitle preferences, and keep the service reliable.",
      },
      {
        id: "cookies",
        heading: "Cookies",
        body: "StreamArena uses a small number of cookies. A session cookie keeps you signed in, and preference cookies remember your settings. We do not use third-party advertising cookies. You can clear cookies in your browser at any time, though doing so will sign you out.",
      },
      {
        heading: "Data Storage & Security",
        body: "Account data is kept separate from cache data, and passwords are protected with industry-standard hashing. We take reasonable measures to safeguard your information, but no online service can guarantee absolute security.",
      },
      {
        heading: "Your Choices",
        body: "You can update your details and preferences in Account settings, reset your password from the sign-in page, or request account deletion by contacting us.",
      },
      {
        heading: "Changes to This Policy",
        body: "We may update this policy from time to time. Material changes will be reflected by the “last updated” date above.",
      },
      {
        heading: "Contact",
        body: "Questions about privacy? Reach us through the Feedback link in the app.",
      },
    ],
  },
  "/terms": {
    title: "Terms of Use",
    updated: "June 2026",
    intro:
      "These Terms of Use govern your access to and use of StreamArena. By creating an account or using the service, you agree to these terms.",
    sections: [
      {
        heading: "Your Account",
        body: "You are responsible for keeping your password secure and for activity that happens under your account. Let us know right away if you believe your account has been used without your permission.",
      },
      {
        heading: "Acceptable Use",
        body: "Use StreamArena for personal, non-commercial enjoyment. Do not attempt to disrupt, scrape, reverse-engineer, or gain unauthorized access to the service, and do not share your credentials in ways that abuse the platform.",
      },
      {
        heading: "Content & Availability",
        body: "Titles, channels, and events on StreamArena change over time and may vary by region or be removed without notice. We do not guarantee that any particular content will be available at a given time.",
      },
      {
        heading: "Service “As Is”",
        body: "StreamArena is provided “as is” and “as available,” without warranties of any kind. We do not guarantee that the service will be uninterrupted or error-free.",
      },
      {
        heading: "Limitation of Liability",
        body: "To the fullest extent permitted by law, StreamArena is not liable for any indirect or consequential damages arising from your use of the service.",
      },
      {
        heading: "Changes to These Terms",
        body: "We may revise these terms from time to time. Continued use of the service after changes take effect means you accept the updated terms.",
      },
      {
        heading: "Contact",
        body: "Questions about these terms? Reach us through the Feedback link in the app.",
      },
    ],
  },
};

export default function LegalPage() {
  const path = window.location.pathname.replace(/\.html$/, "").replace(/\/$/, "");
  const doc = DOCS[path] || DOCS["/privacy"];

  return (
    <div class="help-page legal-page">
      <header class="help-header">
        <div class="help-header-inner">
          <a class="help-brand" href="/" aria-label="StreamArena home">
            <BrandWordmark class="brand-wordmark-arc--help" />
            <span class="help-brand-divider" aria-hidden="true"></span>
            <span class="help-brand-label">{doc.title}</span>
          </a>
          <a class="help-back" href="/">Back to StreamArena</a>
        </div>
      </header>

      <main class="legal-body">
        <h1>{doc.title}</h1>
        <p class="legal-updated">Last updated {doc.updated}</p>
        <p class="legal-intro">{doc.intro}</p>
        <For each={doc.sections}>
          {(section) => (
            <section id={section.id}>
              <h2>{section.heading}</h2>
              <p>{section.body}</p>
            </section>
          )}
        </For>
      </main>

      <footer class="help-footer legal-footer">
        <nav class="legal-footer-links">
          <a href="/help">Help Center</a>
          <a href="/privacy">Privacy Policy</a>
          <a href="/terms">Terms of Use</a>
          <a href="/">Back to StreamArena</a>
        </nav>
        <span>&copy; 2026 StreamArena</span>
      </footer>
    </div>
  );
}
