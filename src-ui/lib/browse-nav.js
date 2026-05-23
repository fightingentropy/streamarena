/**
 * Shared browse navigation class helpers for top-nav links.
 */

/**
 * @param {"live"|""} activePage
 * @returns {string}
 */
export function liveNavClass(activePage) {
  return activePage === "live" ? "nav-mobile-primary is-active" : "nav-mobile-primary";
}

/**
 * @param {"sports"|""} activePage
 * @returns {string}
 */
export function sportsNavClass(activePage) {
  return activePage === "sports" ? "nav-mobile-primary is-active" : "nav-mobile-primary";
}

/**
 * @param {"sports"|""} activePage
 * @returns {string}
 */
export function sportsNavLinkClass(activePage) {
  return `optional ${sportsNavClass(activePage)}`.trim();
}
