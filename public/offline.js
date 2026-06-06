document.getElementById("retryButton")?.addEventListener("click", () => {
  if (window.history.length > 1) {
    window.location.reload();
    return;
  }
  window.location.href = "/";
});
