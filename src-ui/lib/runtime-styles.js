const runtimeRules = new Map();
let runtimeSheet = null;

function getWritableStyleSheet() {
  if (runtimeSheet) {
    return runtimeSheet;
  }

  for (const sheet of Array.from(document.styleSheets || [])) {
    try {
      void sheet.cssRules;
      runtimeSheet = sheet;
      return runtimeSheet;
    } catch {
      // Cross-origin stylesheets are not writable. Keep looking.
    }
  }

  return null;
}

function splitPriority(value) {
  const raw = String(value || "").trim();
  if (raw.toLowerCase().endsWith("!important")) {
    return {
      value: raw.slice(0, -"!important".length).trim(),
      priority: "important",
    };
  }
  return { value: raw, priority: "" };
}

export function setRuntimeStyleRule(selector, declarations) {
  const safeSelector = String(selector || "").trim();
  if (!safeSelector || !declarations || typeof declarations !== "object") {
    return false;
  }

  const sheet = getWritableStyleSheet();
  if (!sheet) {
    return false;
  }

  let rule = runtimeRules.get(safeSelector);
  if (!rule) {
    try {
      const index = sheet.cssRules.length;
      sheet.insertRule(`${safeSelector} {}`, index);
      rule = sheet.cssRules[index];
      runtimeRules.set(safeSelector, rule);
    } catch {
      return false;
    }
  }

  if (!rule?.style) {
    return false;
  }

  Object.entries(declarations).forEach(([property, value]) => {
    const safeProperty = String(property || "").trim();
    if (!safeProperty) {
      return;
    }
    const parsed = splitPriority(value);
    rule.style.setProperty(safeProperty, parsed.value, parsed.priority);
  });
  return true;
}
