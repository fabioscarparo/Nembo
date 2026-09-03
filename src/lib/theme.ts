/**
 * Same three-state cycle and the same storage key as fscarparo.com, so a
 * visitor arriving from the portfolio finds the radar already in the theme
 * they chose — the two are different origins, so nothing is actually shared,
 * but the behaviour matches and the key is ready if they ever sit on one
 * domain.
 *
 * The portfolio's circular view-transition reveal is deliberately not ported
 * yet: it depends on ::view-transition rules that are not in this globals.css,
 * and a half-copied reveal over a live map would tear.
 */

export type ThemeChoice = "system" | "light" | "dark";

/** Shared with fscarparo.com, so the two agree if they ever share an origin. */
export const THEME_KEY = "theme";

/** The order the settings panel lays them out in. */
export const THEME_CYCLE: readonly ThemeChoice[] = ["system", "light", "dark"];

/**
 * The stored choice, or "system" for anyone who has never expressed one.
 *
 * Anything unrecognised also reads as "system": the key is shared with the
 * portfolio and a value written by a future version of either project should
 * degrade to the default rather than throw.
 */
export function readTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

/** What the operating system is currently asking for. */
export function prefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * Resolves a choice to a concrete appearance, puts it on the document, and
 * remembers it.
 *
 * The class is the single source of truth for everything downstream — the
 * stylesheet, the palette builder that reads its tokens, and the basemap
 * swap — so this is deliberately the only place that writes it. Storage is
 * best-effort: a private window that refuses it still gets the right colours
 * for the session.
 */
export function applyTheme(choice: ThemeChoice): void {
  const dark = choice === "dark" || (choice === "system" && prefersDark());
  document.documentElement.classList.toggle("dark", dark);
  paintChrome();
  try {
    localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Private mode with storage disabled — the choice just won't persist.
  }
}

/**
 * Repaints the browser and OS chrome to match the page behind it.
 *
 * Installed to the home screen there is no browser UI to hide the seam: the
 * status bar sits directly against the map, and a bar left on the colour the
 * document shipped with reads as a stripe of the wrong theme across the top.
 *
 * The colour is read back out of `--bg` rather than repeated here, because the
 * class has already been toggled by the time this runs and the stylesheet is
 * the only thing that should own what each theme looks like. A `media`
 * attribute would not do: it can only follow the operating system, and the
 * whole point of the settings panel is that the visitor may have chosen the
 * theme the operating system did not ask for.
 */
function paintChrome(): void {
  const bg = getComputedStyle(document.documentElement)
    .getPropertyValue("--bg")
    .trim();
  /* Empty only if the stylesheet has not parsed. Leaving the tag alone beats
     writing an empty colour, which browsers treat as "no preference" and
     resolve to their own default rather than to the theme. */
  if (!bg) return;
  for (const meta of document.querySelectorAll<HTMLMetaElement>(
    'meta[name="theme-color"]',
  )) {
    meta.content = bg;
  }
}

/* A cycling helper and a set of button labels lived here, for when the theme
   was one dock button stepped through three states. The settings panel names
   all three and lets you pick, so there is no cycle to advance and no label to
   read out — THEME_CYCLE is now just the order they appear in. */
