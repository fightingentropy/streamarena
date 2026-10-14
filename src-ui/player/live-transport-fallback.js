// Delivery failures belong to a route, not necessarily to the live provider.
// Keep one ordered, bounded queue per resolution and invalidate async work when
// the viewer selects another source or leaves the player.
export function createLiveTransportFallbackController() {
  let generation = 0;
  let resolution = 0;
  let remaining = [];
  let knownSources = new Set();
  let recovery = null;
  let resolving = false;

  function reset() {
    generation += 1;
    resolution += 1;
    remaining = [];
    knownSources = new Set();
    recovery = null;
    resolving = false;
  }

  function beginResolution() {
    resolution += 1;
    remaining = [];
    knownSources = new Set();
    resolving = true;
    return resolution;
  }

  function setResolvedSources(request, primary, fallbacks = []) {
    if (request !== resolution) return false;
    const sources = [primary, ...(Array.isArray(fallbacks) ? fallbacks : [])]
      .filter((source) => typeof source === "string" && source.trim())
      .map((source) => source.trim());
    knownSources = new Set(sources.slice(0, 9));
    remaining = [...knownSources].filter((source) => source !== primary);
    return true;
  }

  function runRecovery(callback) {
    if (recovery) return recovery.promise;
    const operation = { generation, promise: null };
    const isCurrent = () => operation.generation === generation;
    operation.promise = Promise.resolve()
      .then(() => isCurrent() ? callback(isCurrent) : true)
      .finally(() => {
        if (recovery === operation) recovery = null;
      });
    recovery = operation;
    return operation.promise;
  }

  return {
    reset,
    beginResolution,
    setResolvedSources,
    isResolutionCurrent: (request) => request === resolution,
    finishResolution(request) {
      if (request === resolution) resolving = false;
    },
    isResolving: () => resolving,
    getGeneration: () => generation,
    isGenerationCurrent: (request) => request === generation,
    hasFallback: () => remaining.length > 0,
    hasDeliveryAlternatives: () => knownSources.size > 1,
    isKnownSource: (source) => knownSources.has(source),
    takeNext: () => remaining.shift() || "",
    isRecovering: () => recovery !== null,
    runRecovery,
  };
}
