const OVERFLOW_LINK_SELECTOR = "a.optional:not(.nav-mobile-primary)";

export function wireBrowseNavMore() {
  const nav = document.querySelector(".top-nav nav");
  if (!nav || nav.querySelector(".nav-more-menu")) {
    return;
  }

  const overflowLinks = [...nav.querySelectorAll(OVERFLOW_LINK_SELECTOR)];
  if (overflowLinks.length === 0) {
    return;
  }

  const menu = document.createElement("div");
  menu.className = "nav-more-menu";

  const toggleButton = document.createElement("button");
  toggleButton.type = "button";
  toggleButton.className = "nav-more-btn";
  toggleButton.setAttribute("aria-label", "Browse menu");
  toggleButton.setAttribute("aria-haspopup", "menu");
  toggleButton.setAttribute("aria-expanded", "false");
  toggleButton.setAttribute("aria-controls", "browseNavMorePanel");
  toggleButton.textContent = "Browse";

  const panel = document.createElement("div");
  panel.id = "browseNavMorePanel";
  panel.className = "nav-more-panel";
  panel.setAttribute("role", "menu");
  panel.hidden = true;

  for (const sourceLink of overflowLinks) {
    const item = document.createElement("a");
    item.className = "nav-more-item";
    item.href = sourceLink.getAttribute("href") || "#";
    item.textContent = sourceLink.textContent?.trim() || "Link";
    item.setAttribute("role", "menuitem");
    if (sourceLink.classList.contains("is-active")) {
      item.classList.add("is-active");
      item.setAttribute("aria-current", "page");
    }
    if (sourceLink.id) {
      item.id = `navMore-${sourceLink.id}`;
    }
    const sourceHref = sourceLink.getAttribute("href") || "#";
    if (sourceHref === "#") {
      item.addEventListener("click", (event) => {
        event.preventDefault();
        sourceLink.click();
      });
    }
    panel.append(item);
  }

  const closeMenu = () => {
    menu.removeAttribute("data-open");
    toggleButton.setAttribute("aria-expanded", "false");
    panel.hidden = true;
  };

  const openMenu = () => {
    menu.setAttribute("data-open", "true");
    toggleButton.setAttribute("aria-expanded", "true");
    panel.hidden = false;
  };

  toggleButton.addEventListener("click", (event) => {
    event.stopPropagation();
    if (menu.hasAttribute("data-open")) {
      closeMenu();
      return;
    }
    openMenu();
  });

  panel.addEventListener("click", (event) => {
    event.stopPropagation();
    closeMenu();
  });

  document.addEventListener(
    "click",
    (event) => {
      if (!menu.contains(event.target)) {
        closeMenu();
      }
    },
    true,
  );

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeMenu();
    }
  });

  menu.append(toggleButton, panel);
  nav.append(menu);
}
