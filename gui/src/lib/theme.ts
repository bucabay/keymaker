const THEME_KEY = "keymaker.theme";

export type Theme = "dark" | "light";

/**
 * The app opens dark, as it always has. A choice made in Settings survives a
 * restart, because a preference that resets is not a preference.
 */
export function loadTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Not remembering is a small loss; failing to render is not.
  }
}
