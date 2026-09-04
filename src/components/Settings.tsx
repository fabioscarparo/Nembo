"use client";

/**
 * The preferences that are not actions: sound, vibration, theme.
 *
 * Everything here is a thing you set once and forget, which is exactly what
 * the dock is bad at holding — a toggle in a row of icons has to be pressed
 * to reveal what it does, and a three-state theme becomes a cycle you step
 * through hoping to land on the one you wanted. Behind a panel each one can
 * carry its own name and show its own state.
 *
 * Same surface and same reveal as the legend, because they are the same kind
 * of thing: something the dock opens rather than something it does. The two
 * are mutually exclusive and dismissed by pressing anywhere else — that part
 * lives in RadarMap, which owns both open states.
 */
import { memo, useCallback, useMemo, useRef } from "react";
import { Mobile, Palette, Personalcard, VolumeHigh } from "reicon-react";

import { THEME_CYCLE, type ThemeChoice } from "@/lib/theme";
import SlidingTabs, { type TabOption } from "./SlidingTabs";

/** Where the source lives. Kept beside the mark so the two cannot disagree. */
const REPO = "https://github.com/fabioscarparo/Nembo";

/**
 * The GitHub mark, from reicon.dev's logo set.
 *
 * Inlined rather than imported: `reicon-react` carries 2674 glyphs but no
 * brand logos, and the set they do come from is published as raw SVG. Typed
 * to the same `size`/`className` shape as the icons around it so the row above
 * and the row below stay interchangeable.
 *
 * `currentColor` is what lets it inherit `text-muted` like the others; the
 * path is authored on a 16-unit grid, hence the viewBox.
 *
 * @see https://reicon.dev/logo/github
 */
function GithubMark({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8 0C3.58 0 0 3.58 0 8C0 11.54 2.29 14.53 5.47 15.59C5.87 15.66 6.02 15.42 6.02 15.21C6.02 15.02 6.01 14.39 6.01 13.72C4 14.09 3.48 13.23 3.32 12.78C3.23 12.55 2.84 11.84 2.5 11.65C2.22 11.5 1.82 11.13 2.49 11.12C3.12 11.11 3.57 11.7 3.72 11.94C4.44 13.15 5.59 12.81 6.05 12.6C6.12 12.08 6.33 11.73 6.56 11.53C4.78 11.33 2.92 10.64 2.92 7.58C2.92 6.71 3.23 5.99 3.74 5.43C3.66 5.23 3.38 4.41 3.82 3.31C3.82 3.31 4.49 3.1 6.02 4.13C6.66 3.95 7.34 3.86 8.02 3.86C8.7 3.86 9.38 3.95 10.02 4.13C11.55 3.09 12.22 3.31 12.22 3.31C12.66 4.41 12.38 5.23 12.3 5.43C12.81 5.99 13.12 6.7 13.12 7.58C13.12 10.65 11.25 11.33 9.47 11.53C9.76 11.78 10.01 12.26 10.01 13.01C10.01 14.08 10 14.94 10 15.21C10 15.42 10.15 15.67 10.55 15.59C13.71 14.53 16 11.53 16 8C16 3.58 12.42 0 8 0Z"
      />
    </svg>
  );
}

type Props = {
  /** Where it opens. Positioning belongs to the caller: the panel hangs off
   *  the button that opens it, and that button has moved once already — from
   *  the top corner to the timeline's row — so a panel that hardcodes its own
   *  corner stops following it. */
  place: string;
  /** Drives the reveal. The panel stays mounted when closed so the transition
   *  can run in reverse, and `inert` is what takes it out of reach. */
  open: boolean;
  /** Inverted on purpose: storage and the rest of the app speak in terms of
   *  being muted, and flipping the sense here would put the negation
   *  somewhere it could be forgotten. The switch shows `!muted`. */
  muted: boolean;
  onToggleSound: () => void;
  hapticsOn: boolean;
  onToggleHaptics: () => void;
  theme: ThemeChoice;
  /** Called with the chosen theme, including the current one — RadarMap is
   *  where that is turned into a no-op, because it owns the side effects. */
  onPickTheme: (choice: ThemeChoice) => void;
};

/** The visible names. "Sistema" rather than "Auto": it is what the OS is
 *  asking for, and the word should say whose choice it is following. */
const THEME_TABS: Record<ThemeChoice, string> = {
  system: "Sistema",
  light: "Chiaro",
  dark: "Scuro",
};

/**
 * Controlled throughout: it holds no preference of its own, only the two
 * "has this been touched yet" flags that keep the toggles from animating on
 * mount. The values and their setters belong to RadarMap, which is also what
 * writes them to storage.
 */
function Settings({
  place,
  open,
  muted,
  onToggleSound,
  hapticsOn,
  onToggleHaptics,
  theme,
  onPickTheme,
}: Props) {
  /* The thumb's keyframes must not run on mount — the "off" animation would
     play on every load for anyone who has muted, from a position the thumb
     was never in. The class arrives on the first interaction and stays. */
  const touchedSound = useRef(false);
  const touchedHaptics = useRef(false);

  const flipSound = useCallback(() => {
    touchedSound.current = true;
    onToggleSound();
  }, [onToggleSound]);

  const flipHaptics = useCallback(() => {
    touchedHaptics.current = true;
    onToggleHaptics();
  }, [onToggleHaptics]);

  const themes = useMemo<TabOption<ThemeChoice>[]>(
    () =>
      THEME_CYCLE.map((choice) => ({ value: choice, label: THEME_TABS[choice] })),
    [],
  );

  return (
    <div
      className={`dock-panel dock-surface w-64 rounded-2xl p-4 ${place}`}
      data-open={open}
      /* Closed, it leaves the tab order and the accessibility tree rather than
         merely going invisible — the same reason the legend does. */
      inert={!open}
      aria-hidden={!open}
      /* Named by its own heading rather than by a duplicate `aria-label`: the
         dock button that opens it is already called "Impostazioni", and two
         elements answering to one name is how a screen reader user ends up
         unable to tell the control from the thing it controls. */
      role="group"
      aria-labelledby="settings-title"
    >
      <div id="settings-title" className="text-fg text-[14px] font-medium">
        Impostazioni
      </div>

      {/* Icon, then name, then control. The icons are not decoration: three
          rows of bare text read as a list of words, and the glyph is what lets
          you find the one you came for without reading all of them. Muted, and
          sized to the label rather than to the control, so they sit under the
          words rather than competing with them. */}
      <div className="mt-3 flex items-center justify-between gap-3">
        <span
          id="settings-sound"
          className="text-fg-soft flex min-w-0 items-center gap-2 text-[13px]"
        >
          <VolumeHigh size={15} className="text-muted shrink-0" aria-hidden />
          Suoni
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={!muted}
          aria-labelledby="settings-sound"
          onClick={flipSound}
          className={`t-toggle${touchedSound.current ? " is-init" : ""}`}
          data-on={!muted}
        >
          <span className="t-toggle-thumb" />
        </button>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <span
          id="settings-haptics"
          className="text-fg-soft flex min-w-0 items-center gap-2 text-[13px]"
        >
          <Mobile size={15} className="text-muted shrink-0" aria-hidden />
          Vibrazione
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={hapticsOn}
          aria-labelledby="settings-haptics"
          onClick={flipHaptics}
          className={`t-toggle${touchedHaptics.current ? " is-init" : ""}`}
          data-on={hapticsOn}
        >
          <span className="t-toggle-thumb" />
        </button>
      </div>

      {/* In line with its label, like the switch above it. Two settings that
          stacked differently would read as two kinds of thing, and they are
          not — both are one choice with its name beside it. */}
      <div className="mt-3 flex items-center justify-between gap-3">
        <span
          id="settings-theme"
          className="text-fg-soft flex shrink-0 items-center gap-2 text-[13px]"
        >
          <Palette size={15} className="text-muted shrink-0" aria-hidden />
          Tema
        </span>
        <SlidingTabs
          options={themes}
          value={theme}
          onPick={onPickTheme}
          labelledBy="settings-theme"
          className="t-tabs-fill min-w-0 flex-1 text-[11px] font-medium"
        />
      </div>

      {/* `rel="noreferrer"` implies `noopener`. Without it the opened page
          receives a live `window.opener` handle and can navigate this one. */}
      <p className="panel-credit text-fg-soft text-[13px]">
        <Personalcard size={15} className="text-muted shrink-0" aria-hidden />
        <span>
          Creato da{" "}
          <a href="https://fscarparo.com" target="_blank" rel="noreferrer">
            Fabio Scarparo
          </a>
        </span>
      </p>

      <p className="panel-credit text-fg-soft text-[13px]">
        <GithubMark size={15} className="text-muted shrink-0" />
        <span>
          Repository{" "}
          <a href={REPO} target="_blank" rel="noreferrer">
            GitHub
          </a>
        </span>
      </p>
    </div>
  );
}

export default memo(Settings);
