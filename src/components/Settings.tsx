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

type Props = {
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
      className="dock-panel dock-surface absolute right-4 top-16 w-64 rounded-2xl p-4"
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
      <div id="settings-title" className="text-fg text-[13px] font-medium">
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
          className="text-fg-soft flex min-w-0 items-center gap-2 text-[12px]"
        >
          <VolumeHigh size={14} className="text-muted shrink-0" aria-hidden />
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
          className="text-fg-soft flex min-w-0 items-center gap-2 text-[12px]"
        >
          <Mobile size={14} className="text-muted shrink-0" aria-hidden />
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
          className="text-fg-soft flex shrink-0 items-center gap-2 text-[12px]"
        >
          <Palette size={14} className="text-muted shrink-0" aria-hidden />
          Tema
        </span>
        <SlidingTabs
          options={themes}
          value={theme}
          onPick={onPickTheme}
          labelledBy="settings-theme"
          className="t-tabs-fill min-w-0 flex-1 text-[10px] font-medium"
        />
      </div>

      {/* `rel="noreferrer"` implies `noopener`. Without it the opened page
          receives a live `window.opener` handle and can navigate this one. */}
      <p className="panel-credit text-fg-soft text-[12px]">
        <Personalcard size={14} className="text-muted shrink-0" aria-hidden />
        <span>
          Made by{" "}
          <a href="https://fscarparo.com" target="_blank" rel="noreferrer">
            Fabio Scarparo
          </a>
        </span>
      </p>
    </div>
  );
}

export default memo(Settings);
