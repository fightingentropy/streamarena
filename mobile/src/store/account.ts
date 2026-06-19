// The current account "scope" used to isolate per-account API caches, my-list,
// continue-watching and offline downloads. Auth sets it (user id, or the auth
// status string when signed out / loading); consumers outside React (the offline
// store) read it, and React consumers can subscribe.

let scope = "loading";
const listeners = new Set<() => void>();

export function setAccountScope(next: string): void {
  const value = next?.trim() || "anonymous";
  if (value === scope) return;
  scope = value;
  for (const l of Array.from(listeners)) {
    try {
      l();
    } catch {}
  }
}

export function getAccountScope(): string {
  return scope;
}

export function subscribeAccountScope(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
