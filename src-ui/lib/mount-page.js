import { render } from "solid-js/web";

export function mountPage(Page, options = {}) {
  document.body.className = options.bodyClass || "";
  render(Page, document.body);
}
