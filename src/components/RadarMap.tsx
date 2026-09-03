"use client";

/**
 * The application. Everything else on screen is something this mounts.
 *
 * It owns the MapLibre instance and every piece of state the radar needs, and
 * its job is to keep four independent clocks in step without letting any of
 * them block the others:
 *
 *   the service    which frame is newest, polled once a minute
 *   the estimate   the motion field, rebuilt whenever that frame changes
 *   the timeline   which instant you are looking at, moved by hand or by the
 *                  loop, held as an absolute time rather than an index
 *   the camera     where you are, and whether you have said we may know
 *
 * The one rule that shapes the rest: nothing that costs work runs when the
 * page is not being looked at. Every timer here goes through
 * useVisibleInterval — see lib/visibility.ts for what leaving them running
 * was costing, and for why the initial fetch and the refresh are deliberately
 * the same code path rather than two.
 *
 * Painting is a queue of one, not a queue. A drag emits a value every few
 * milliseconds and a frame costs tens of milliseconds to build, so requests
 * overwrite each other and the renderer picks up wherever the thumb has got
 * to — see `paint`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Location } from "reicon-react";
import {
  MapLibreMap,
  Marker,
  setWorkerUrl,
  type ImageSource,
  type StyleSpecification,
} from "maplibre-gl";

import {
  PRODUCTS,
  type ProductKey,
  fetchLastProduct,
  readProduct,
  storeProduct,
} from "@/lib/dpc";
import { RAMPS, buildLut, watchTheme } from "@/lib/colormap";
import { lutEpoch, setLut } from "@/lib/tiles";
import {
  COMPOSITE_BOUNDS,
  DOMAIN,
  HISTORY_MIN,
  HORIZON_MIN,
  STEP_MS,
  type Sequence,
  buildSequence,
  fieldAt,
  renderField,
} from "@/lib/nowcast";
import { type Steering, fetchSteering } from "@/lib/wind";
import { usePageVisible, useVisibleInterval } from "@/lib/visibility";
import { firstLabelLayer, resolveStyle } from "@/lib/basemap";
import { readMuted, setMuted, useSound } from "@/lib/sound";
import { readHaptics, setHaptics, useHaptics } from "@/lib/haptics";
import { type ThemeChoice, applyTheme, readTheme } from "@/lib/theme";
import { type Place, lookupPlace } from "@/lib/place";
import Dock from "./Dock";
import Legend from "./Legend";
import Settings from "./Settings";
import PlacePill from "./PlacePill";
import Timeline from "./Timeline";

/** Ids for the one source and layer this component adds to the basemap.
 *  Named constants because `setStyle` discards both, and the code that puts
 *  them back has to agree with the code that looks for them. */
const RADAR_SOURCE = "radar";
const RADAR_LAYER = "radar";

/* A transparent pixel to stand the image source up with. MapLibre needs a
   source before it will take an image, and updateImage() supplies the real
   frames afterwards without a network request. */
const BLANK =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** Italy plus enough sea to see a front arrive. */
const HOME = { center: [12.5, 42.2] as [number, number], zoom: 5 };

/**
 * The radar layer's opacity, from the stylesheet rather than from here.
 *
 * It lives with the ramp because the two are one decision: the stops carry
 * their own alpha, so this stays at 1 and pulling it back would wash the
 * scale out twice. The guard is for a token that is missing or zero, which
 * would otherwise render an invisible radar with nothing to explain it.
 */
function radarOpacity(): number {
  const n = Number(
    getComputedStyle(document.documentElement)
      .getPropertyValue("--radar-opacity")
      .trim(),
  );
  return Number.isFinite(n) && n > 0 ? n : 0.85;
}

/**
 * Whether the dark basemap is the one to load.
 *
 * Reads the class rather than the media query or the stored choice: the boot
 * script in layout.tsx has already resolved "system" against the OS by the
 * time anything here runs, so the class is the only place all three states
 * have been reduced to one answer.
 */
function isDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

export default function RadarMap() {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const pin = useRef<Marker | null>(null);


  /* Which quantity is on screen. Reflectivity to open on, because it is the
     one every radar shows and the one the timeline's copy assumes; the other
     two are a tap away in the dock.
  
     Synced after mount rather than read during render, for the same reason as
     the mute flag and the theme: a static export renders this on the server,
     where reading storage throws and the two passes would disagree. */
  const [product, setProduct] = useState<ProductKey>("VMI");
  useEffect(() => setProduct(readProduct()), []);

  const [latest, setLatest] = useState<number | null>(null);
  /* null means "follow live". Holding an absolute time rather than an index
     means a new observation arriving mid-scrub shifts the timeline under you
     without moving what you are looking at. */
  const [selected, setSelected] = useState<number | null>(null);
  const [sequence, setSequence] = useState<Sequence | null>(null);
  /* The steering flow, for the frames the radar cannot measure its own motion
     from. Null until it arrives, and null forever if it cannot — the radar
     works without it, it just goes back to having no forecast on quiet days. */
  const [steering, setSteering] = useState<Steering | null>(null);
  const [stale, setStale] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locationDenied, setLocationDenied] = useState(false);
  const [locationAvailable, setLocationAvailable] = useState(true);
  const [position, setPosition] = useState<[number, number] | null>(null);
  const [mapReady, setMapReady] = useState(false);
  /* One at a time. Both hang off the dock at the same corner, so opening one
     while the other is up would stack two panels on the same pixels. */
  const [legendOpen, setLegendOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [place, setPlace] = useState<Place | null>(null);
  /* Counts style loads. State rather than a ref, and deliberately a counter
     rather than a flag: the paint effect has to re-run when the style becomes
     ready, and again after every theme swap, and a ref flipping to true wakes
     nothing. map.isStyleLoaded() is no good either — it reports false while
     sources settle, long after `style.load`. */
  const [styleEpoch, setStyleEpoch] = useState(0);

  /* Every timer below is gated on this. See lib/visibility.ts for what it
     was costing to leave them running. */
  const visible = usePageVisible();

  const sound = useSound();
  /* Starts unmuted and syncs after mount rather than reading storage during
     render: a static export renders this on the server, where the read throws
     and the two passes would disagree. */
  const [muted, setMutedState] = useState(false);
  useEffect(() => setMutedState(readMuted()), []);

  /* Same contract as the mute flag: default on, synced after mount because a
     static export renders this where storage throws. */
  const haptics = useHaptics();
  const [hapticsOn, setHapticsState] = useState(true);
  useEffect(() => setHapticsState(readHaptics()), []);

  /* Same three-state cycle as the portfolio: system, light, dark. Synced
     after mount for the same reason as the mute flag — a static export
     renders this on the server, where reading storage throws. */
  const [theme, setThemeState] = useState<ThemeChoice>("system");
  useEffect(() => setThemeState(readTheme()), []);

  const pickTheme = useCallback(
    (next: ThemeChoice) => {
      if (next === theme) return;
      applyTheme(next);
      setThemeState(next);
      haptics.tap();
      sound.slide();
    },
    [theme, haptics, sound],
  );

  /* One handler for the button and the space bar, so the two cannot drift into
     making different sounds for the same action.

     The next state is derived from the closure rather than from an updater:
     React may run an updater twice for one dispatch, and a sound fired inside
     would play twice for one press — the same trap `pickProduct` documents. */
  const togglePlay = useCallback(() => {
    const next = !playing;
    haptics.tap();
    if (next) sound.notification();
    else sound.pop();
    setPlaying(next);
  }, [playing, haptics, sound]);

  const toggleLegend = useCallback(() => {
    haptics.tap();
    setLegendOpen((v) => !v);
    setSettingsOpen(false);
  }, [haptics]);

  const toggleSettings = useCallback(() => {
    haptics.tap();
    setSettingsOpen((v) => !v);
    setLegendOpen(false);
  }, [haptics]);

  /* Dismissed by pressing anywhere else, which on a map is most of the screen.
   *
   * Bound only while something is open, so the common case costs no listener
   * at all. The dock is excluded along with the panels: without that, pressing
   * the gear while its panel is up would close it here and reopen it in the
   * button's own handler, and the panel would appear never to shut.
   *
   * `pointerdown` rather than `click`, so a panel is out of the way before a
   * drag on the map underneath it begins rather than after it ends. Escape
   * comes along for the ride — anything dismissed by clicking away is expected
   * to answer to it too. */
  useEffect(() => {
    if (!legendOpen && !settingsOpen) return;

    const dismiss = () => {
      setLegendOpen(false);
      setSettingsOpen(false);
    };

    const onPointerDown = (e: PointerEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest(".dock-panel") || el?.closest(".dock-pill")) return;
      dismiss();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [legendOpen, settingsOpen]);

  /* The guard and the side effects sit outside the updater deliberately.
     React may invoke an updater more than once for a single dispatch — it does
     in StrictMode — so a write to storage or a click of the tick placed in
     there happens twice for one press. An updater has to be a pure function of
     the previous state; this reads `product` from the closure instead, which
     is safe because the callback is rebuilt whenever it changes. */
  const pickProduct = useCallback(
    (next: ProductKey) => {
      if (next === product) return;
      storeProduct(next);
      haptics.tap();
      sound.slide();
      setProduct(next);
    },
    [product, haptics, sound],
  );

  const toggleHaptics = useCallback(() => {
    const next = !hapticsOn;
    setHaptics(next);
    setHapticsState(next);
    /* Turning it on demonstrates itself — you feel what you just enabled.
       Turning it off has nothing to add, and buzzing to confirm silence would
       be the one thing the setting exists to stop. */
    if (next) haptics.tap();
    /* Reads the state out loud: rising for on, falling for off. */
    if (next) sound.toggleOn();
    else sound.toggleOff();
  }, [hapticsOn, haptics, sound]);

  const toggleSound = useCallback(() => {
    const next = !muted;
    setMuted(next);
    setMutedState(next);
    haptics.tap();
    /* Only one direction can be heard: `setMuted` has already silenced
       playback by the time the muting sound would play. */
    if (!next) sound.toggleOn();
  }, [muted, haptics, sound]);

  /* The marker's DOM node is created once and handed to MapLibre, which owns
     its placement; React renders the icon into it through a portal, so the
     pin stays part of the component tree. */
  const pinEl = useMemo(
    () => (typeof document === "undefined" ? null : document.createElement("div")),
    [],
  );

  /* Mirrors the table's own version, so anything drawn from the palette —
     the legend's scale — knows to resample after a rebuild. */
  const [paletteEpoch, setPaletteEpoch] = useState(0);

  const refreshPalette = useCallback(() => {
    const stops = RAMPS[product];
    if (stops) setLut(buildLut(PRODUCTS[product], stops));
    setPaletteEpoch(lutEpoch());
  }, [product]);

  /**
   * Idempotent: adds the radar source and layer if the current style lacks
   * them. Called after every style load, because setStyle() discards every
   * source and layer the style did not declare — the radar included.
   */
  const applyRadar = useCallback((m: MapLibreMap, style?: StyleSpecification) => {
    if (m.getLayer(RADAR_LAYER)) return;

    m.addSource(RADAR_SOURCE, {
      type: "image",
      url: BLANK,
      coordinates: COMPOSITE_BOUNDS,
    });

    m.addLayer(
      {
        id: RADAR_LAYER,
        type: "raster",
        source: RADAR_SOURCE,
        paint: {
          "raster-opacity": radarOpacity(),
          "raster-resampling": "linear",
          /* MapLibre's default 300 ms cross-fade is tuned for panning between
             zooms. On a timeline it smears every frame into the next. */
          "raster-fade-duration": 0,
        },
      },
      /* Under the place names: precipitation over a city should not erase its
         label — that is the moment you most want to know which city it is. */
      style ? firstLabelLayer(style) : undefined,
    );
  }, []);

  /* Declared before the map so it runs first on mount: the palette has to
     exist before the first tile is painted, or the LUT of zeroes would paint
     a transparent frame that then sits there until something else changes.
     Keeping it out of the map effect also means switching product repaints
     rather than rebuilding the entire map. */
  useEffect(() => {
    refreshPalette();
  }, [refreshPalette]);

  /* ── Map ─────────────────────────────────────────────────── */

  useEffect(() => {
    if (!container.current || map.current) return;
    let cancelled = false;
    let created: MapLibreMap | null = null;

    /* Must precede the first Map. MapLibre would otherwise resolve its worker
       against its own bundled chunk URL, which Turbopack has renamed — the
       fetch 404s, the worker never starts, and every source stays unloaded
       while the map reports no error at all. */
    setWorkerUrl("/maplibre-gl-worker.mjs");

    (async () => {
      const style = await resolveStyle(isDark());
      if (cancelled || !container.current) return;

      const m = new MapLibreMap({
        container: container.current,
        style,
        ...HOME,
        minZoom: 3,
        maxZoom: 9,
        attributionControl: false,
        /* The data is a flat raster in Web Mercator; a tilt or a rotation
           would misplace precipitation against the coastline. */
        dragRotate: false,
        pitchWithRotate: false,
        touchZoomRotate: false,
      });
      m.touchZoomRotate.enable({ around: "center" });
      m.touchZoomRotate.disableRotation();

      if (pinEl) {
        // Centred: a dot marks the spot it sits on, where a teardrop
        // marked the point beneath its tip.
        pin.current = new Marker({ element: pinEl, anchor: "center" });
      }

      m.on("style.load", () => {
        applyRadar(m, m.getStyle());
        setStyleEpoch((n) => n + 1);
      });

      /* Locate on arrival, so the map opens on the weather over your head
         rather than on the country. A permission already refused is not asked
         again — a prompt that reappears every visit is how people learn to
         dismiss it without reading. */
      void (async () => {
        try {
          const perm = await navigator.permissions?.query({ name: "geolocation" });
          if (perm?.state === "denied") {
            setLocationDenied(true);
            return;
          }
        } catch {
          // No Permissions API: let the prompt decide.
        }
        if (!cancelled) autoStart.current?.();
      })();

      created = m;
      map.current = m;
      setMapReady(true);

      /* Closes a race: the style can finish parsing between the constructor
         and the handler attached to it a few lines up. */
      if (m.isStyleLoaded()) {
        applyRadar(m, m.getStyle());
        setStyleEpoch((n) => n + 1);
      }
    })();

    return () => {
      cancelled = true;
      setMapReady(false);
      setStyleEpoch(0);
      pin.current?.remove();
      pin.current = null;
      created?.remove();
      map.current = null;
    };
  }, [applyRadar, pinEl]);

  /* ── Newest observation ──────────────────────────────────── */

  /* The expensive one, and so the one that matters most to stop: a new answer
     here pulls twenty-seven tiles and rebuilds the motion field.
  
     The service publishes every five minutes. Polling a little faster lands
     the new observation without a visible gap, for one 87-byte response a
     minute — while anyone is there to see it. `product` as the reset key is
     what makes switching quantity reload at once instead of waiting out the
     rest of the current minute. */
  useVisibleInterval(
    (signal) => {
      void fetchLastProduct(product, signal).then((last) => {
        if (signal.aborted) return;
        if (!last) {
          setStale(true);
          return;
        }
        setStale(false);
        setLatest(last.time);
      });
    },
    60_000,
    visible,
    product,
  );

  /* ── Steering flow ───────────────────────────────────────── */

  /* The model publishes hourly and this reads the current hour out of it, so
     there is nothing new to see for most of an hour. Half of one keeps the
     reading from going stale across the boundary without polling a forecast
     that has not moved.
  
     A failed fetch leaves the previous field in place rather than clearing it:
     an hour-old wind is a far better fallback than none, and none means the
     forecast goes back to "non disponibile" on the next quiet day. */
  useVisibleInterval(
    (signal) => {
      void fetchSteering(
        DOMAIN.lon0,
        DOMAIN.lat0,
        DOMAIN.lon1,
        DOMAIN.lat1,
        signal,
      ).then((s) => {
        if (s && !signal.aborted) setSteering(s);
      });
    },
    1_800_000,
    visible,
  );

  /* ── Motion field ────────────────────────────────────────── */

  useEffect(() => {
    if (latest === null) return;
    const controller = new AbortController();
    let cancelled = false;

    buildSequence(product, latest, steering, controller.signal)
      .then((s) => {
        if (!cancelled) setSequence(s);
      })
      /* A missing baseline is the usual cause and it fixes itself on the next
         publication. The radar keeps working without motion; it just stops
         moving between observations. */
      .catch(() => {
        if (!cancelled) setSequence(null);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
    /* Rebuilt when the steering flow arrives too: a sequence that fell back to
       "none" before the wind landed should become a forecast once it has. The
       observations it needs are already cached, so this costs arithmetic
       rather than another round of tiles. */
  }, [latest, product, steering]);

  /* ── Timeline ────────────────────────────────────────────── */

  /* A frame a minute, half an hour either side of now — the window 3BMeteo
     shows from this same feed, and about as far as advection stays honest.
     The extra frames are not extra data: they are the observations carried
     along the measured flow to meet each minute. */
  const frames = useMemo(() => {
    if (latest === null) return [];
    const start = latest - HISTORY_MIN * STEP_MS;
    const count = HISTORY_MIN + HORIZON_MIN;
    return Array.from({ length: count + 1 }, (_, i) => start + i * STEP_MS);
  }, [latest]);

  const observedCount = HISTORY_MIN + 1;

  /* Defaults to now, not to the end of the axis — the newest measurement is
     the honest place to open, and the future is somewhere you choose to go. */
  const displayed =
    selected !== null && frames.includes(selected) ? selected : latest;

  /* ── Painting ────────────────────────────────────────────── */

  /* The frame the map should be showing, and whether a render is already
     under way. Refs rather than state: this is a queue of one, and re-running
     React for it would be the tail wagging the dog. */
  const wanted = useRef<{ time: number; seq: Sequence } | null>(null);
  const painting = useRef(false);

  /**
   * Renders the newest requested frame, and only that one.
   *
   * A drag emits a value every few milliseconds and each frame costs tens of
   * milliseconds to build, so starting a render per step queues thirty pieces
   * of work to draw pictures nobody will see — which is exactly what made the
   * slider stutter. Here later requests overwrite the pending one, so when a
   * render finishes it picks up wherever the thumb has got to and skips
   * everything in between.
   *
   * The frame is yielded to the browser before each render, not after: the
   * heavy loops are synchronous once the observations are cached, so without
   * a gap in front of them the thumb and the ticks never get painted.
   */
  const paint = useCallback(
    async (m: MapLibreMap) => {
      if (painting.current) return;
      painting.current = true;
      try {
        while (wanted.current) {
          await new Promise<void>((r) => requestAnimationFrame(() => r()));

          const next = wanted.current;
          if (!next) break;
          wanted.current = null;

          const field = await fieldAt(next.seq, next.time);
          if (!field || map.current !== m) continue;

          /* Only when it is actually missing. `getStyle()` serialises every
             layer in the basemap, and passing it as an argument meant paying
             for that on every frame to call a function that returns
             immediately. */
          if (!m.getLayer(RADAR_LAYER)) applyRadar(m, m.getStyle());
          const painted = await renderField(field);
          if (map.current !== m) continue;

          const src = m.getSource(RADAR_SOURCE) as ImageSource | undefined;
          if (!src) continue;

          if (painted) {
            /* Coordinates travel with the image: the crop moves and resizes
               as the weather does, and the source is told where it belongs. */
            src.updateImage(painted);
          } else {
            // Nothing to draw. A single transparent pixel clears the layer.
            src.updateImage({ url: BLANK });
          }
        }
      } finally {
        painting.current = false;
      }
    },
    [applyRadar],
  );

  useEffect(() => {
    const m = map.current;
    if (!m || !sequence || displayed === null || !mapReady || styleEpoch === 0) {
      return;
    }
    wanted.current = { time: displayed, seq: sequence };
    void paint(m);
  }, [displayed, sequence, mapReady, styleEpoch, paint]);

  /* ── Theme ───────────────────────────────────────────────── */

  useEffect(() => {
    return watchTheme(() => {
      refreshPalette();

      const m = map.current;
      if (!m) return;

      /* Positron and Dark Matter are separate styles, so a theme change is a
         style swap rather than a paint-property edit. Every source and layer
         goes with it — the `style.load` handler puts the radar back, and
         bumping the token makes the next paint repaint it in the new palette. */
      resolveStyle(isDark()).then((style) => {
        if (map.current !== m) return;
        /* setStyle drops every source and layer; `style.load` puts the radar
           back and bumps the epoch, which repaints the frame in the new
           palette without recomputing any motion. */
        m.setStyle(style);
      });
    });
  }, [refreshPalette]);

  /* ── Place ───────────────────────────────────────────────── */

  /* Rounded to a kilometre before it is looked up, so the pill re-fetches
     only when you have actually gone somewhere — and so a metre-accurate fix
     never leaves the browser. */
  const coarse = position
    ? `${position[0].toFixed(2)},${position[1].toFixed(2)}`
    : null;

  /* Conditions drift; the name does not. Refreshed on the same quarter-hour
     cadence Open-Meteo publishes on, and immediately when you have actually
     moved — `coarse` is the reset key, so a new kilometre square looks itself
     up at once rather than waiting out the quarter hour. */
  useVisibleInterval(
    (signal) => {
      if (!coarse) return;
      const [lon, lat] = coarse.split(",").map(Number);
      void lookupPlace(lon, lat, signal).then((p) => {
        if (!signal.aborted) setPlace(p);
      });
    },
    900_000,
    visible,
    coarse,
  );

  /* ── Playback ────────────────────────────────────────────── */

  useEffect(() => {
    if (!playing || !visible || frames.length < 2) return;

    const step = Number(
      getComputedStyle(document.documentElement)
        .getPropertyValue("--frame-dur")
        .trim()
        .replace("ms", ""),
    );
    /* The token drops to zero under prefers-reduced-motion, which is a
       request not to animate rather than to animate infinitely fast. */
    if (!Number.isFinite(step) || step <= 0) {
      setPlaying(false);
      return;
    }

    const id = window.setInterval(() => {
      setSelected((current) => {
        const at = current === null ? frames.indexOf(latest ?? 0) : frames.indexOf(current);
        const next = at + 1;
        // Wraps to the start of the window rather than stopping: a loop is
        // the whole point, and the jump back reads as the loop restarting.
        return frames[next >= frames.length || next < 1 ? 0 : next];
      });
    }, step);

    return () => window.clearInterval(id);
    /* `visible` pauses it rather than stopping it: come back and the loop is
       still running, from where it was, which is what someone who left it
       playing expects. */
  }, [playing, visible, frames, latest]);

  /* Space toggles the loop, the way it does in every player.
   *
   * Skipped when a button or the slider has focus: the browser already sends
   * a click to a focused button on space, and handling it here as well would
   * toggle twice and land back where it started. `preventDefault` stops the
   * page scrolling, which is what space does otherwise. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (
        tag === "BUTTON" ||
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        el?.isContentEditable
      ) {
        return;
      }
      e.preventDefault();
      togglePlay();
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* Where the focus came from, recorded on the root element.
   *
   * MapLibre gives its canvas `tabindex="0"` so the map can be panned with
   * the arrow keys, and the canvas fills the viewport. Click the map, press
   * space, and Chrome switches to keyboard modality, decides the canvas is
   * `:focus-visible` and paints its focus ring around the whole thing — which
   * does not read as "the map has focus", it reads as a blue border round the
   * page.
   *
   * `:focus-visible` alone cannot tell the two cases apart, because it
   * re-evaluates on the keypress rather than remembering that the focus was
   * given by a mouse. So the modality is tracked here: a pointer press marks
   * the root, Tab clears it, and the stylesheet hides the canvas ring only
   * while the mark is set. Someone who tabs to the map still sees it. */
  useEffect(() => {
    const root = document.documentElement;
    const byPointer = () => root.setAttribute("data-focus", "pointer");
    const byKey = (e: KeyboardEvent) => {
      if (e.key === "Tab") root.removeAttribute("data-focus");
    };

    // Capture, so the mark is set before anything downstream moves focus.
    window.addEventListener("pointerdown", byPointer, true);
    window.addEventListener("keydown", byKey, true);
    return () => {
      window.removeEventListener("pointerdown", byPointer, true);
      window.removeEventListener("keydown", byKey, true);
      root.removeAttribute("data-focus");
    };
  }, []);

  /* ── Position ────────────────────────────────────────────── */

  useEffect(() => {
    const m = map.current;
    if (!mapReady || !m || !pin.current || !position) return;
    pin.current.setLngLat(position).addTo(m);
  }, [position, mapReady]);

  /* Our own watch rather than MapLibre's GeolocateControl.
   *
   * The control re-centres the camera on every position update, and
   * `watchPosition` delivers a second fix about a second in — right as the
   * first flight is landing. Measured, that produced three chained
   * animations settling at zoom 7.905, then 7.998, then 8: the small jump at
   * the end of the zoom. Since the pin is ours anyway, the control was only
   * contributing camera behaviour we did not want.
   *
   * So: fly once, on the first fix. Later fixes move the marker and leave the
   * camera alone — which is also the right behaviour for a radar, where
   * having the map twitch under you while you read a front is worse than
   * being a hundred metres off.
   */
  const autoStart = useRef<(() => boolean) | null>(null);
  const watch = useRef<number | null>(null);
  const flown = useRef(false);

  const startWatching = useCallback(() => {
    if (watch.current !== null) return true;
    if (!navigator.geolocation) {
      setLocationAvailable(false);
      return false;
    }

    setLocating(true);
    watch.current = navigator.geolocation.watchPosition(
      (fix) => {
        setLocating(false);
        setLocationDenied(false);
        const at: [number, number] = [fix.coords.longitude, fix.coords.latitude];
        setPosition(at);

        if (!flown.current) {
          flown.current = true;
          /* No `essential`, so a visitor who asked for reduced motion gets an
             instant jump instead of a flight. */
          map.current?.flyTo({ center: at, zoom: 8, duration: 1400 });
        }
      },
      (err) => {
        setLocating(false);
        if (err.code === err.PERMISSION_DENIED) setLocationDenied(true);
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    );
    return true;
  }, []);

  useEffect(() => {
    autoStart.current = startWatching;
  }, [startWatching]);

  useEffect(() => {
    return () => {
      if (watch.current !== null) navigator.geolocation?.clearWatch(watch.current);
      watch.current = null;
    };
  }, []);

  /**
   * The button. With a position in hand it recentres; without one it starts
   * over — the watch may have been refused, or begun somewhere with no fix,
   * and pressing the button again is exactly how someone says "try now".
   */
  const locate = useCallback(() => {
    const m = map.current;

    haptics.tap();
    /* Fired on the press, not on the fix. The permission prompt can sit there
       for a minute or never be answered, and a sound arriving then belongs to
       nothing the visitor is still doing. This one confirms the press. */
    sound.success();

    if (position && m) {
      m.flyTo({ center: position, zoom: 8, duration: 900 });
      return;
    }

    if (watch.current !== null) {
      navigator.geolocation?.clearWatch(watch.current);
      watch.current = null;
    }
    flown.current = false;
    startWatching();
  }, [startWatching, position, haptics, sound]);

  return (
    <>
      <div ref={container} className="absolute inset-0" />
      {/* One row, so the two pills divide the width instead of competing for
          it. Transparent to pointers between them, or the strip would eat
          drags on the map along the whole top edge. */}
      <div className="pointer-events-none absolute inset-x-0 top-4 flex items-start gap-2 px-4">
        <PlacePill place={place} />
        {stale && <Notice />}
        <Dock
          product={product}
          onPickProduct={pickProduct}
          legendOpen={legendOpen}
          onToggleLegend={toggleLegend}
          settingsOpen={settingsOpen}
          onToggleSettings={toggleSettings}
        />
      </div>

      <Legend product={product} open={legendOpen} paletteEpoch={paletteEpoch} />
      <Settings
        open={settingsOpen}
        muted={muted}
        onToggleSound={toggleSound}
        hapticsOn={hapticsOn}
        onToggleHaptics={toggleHaptics}
        theme={theme}
        onPickTheme={pickTheme}
      />

      {pinEl &&
        position &&
        createPortal(
          <span className="relative flex h-4 w-4 items-center justify-center">
            <span className="pin-halo pointer-events-none absolute" />
            <span className="pin-dot relative" />
          </span>,
          pinEl,
        )}

      {displayed !== null && frames.length > 1 && (
        <Timeline
          frames={frames}
          observedCount={observedCount}
          value={displayed}
          onChange={(t) => {
            // Scrubbing by hand takes over from the loop.
            setPlaying(false);
            setSelected(t);
          }}
          playing={playing}
          onTogglePlay={togglePlay}
          forecastSource={sequence?.source ?? "none"}
          trailing={
            /* Beside the timeline rather than up with the settings: finding
               yourself is an action you take on the map, like scrubbing, not
               a preference you set once. Same pill and same diameter as the
               play button at the other end, so the row reads as one control
               strip with the slider between its two ends. */
            <button
              type="button"
              onClick={locate}
              disabled={!locationAvailable}
              className="dock-surface dock-btn dock-btn-lg shrink-0 rounded-full disabled:cursor-default disabled:opacity-40"
              aria-label={
                !locationAvailable
                  ? "Geolocalizzazione non disponibile"
                  : locationDenied
                    ? "Posizione non disponibile"
                    : "Mostra la mia posizione"
              }
              aria-busy={locating}
            >
              <Location
                size={16}
                className={
                  locating
                    ? "animate-pulse"
                    : locationDenied
                      ? "opacity-40"
                      : undefined
                }
              />
            </button>
          }
        />
      )}
    </>
  );
}

/**
 * Shown only when the service has nothing to give. Everything else a header
 * could say — which product, which minute — the timeline says better.
 */
function Notice() {
  return (
    /* A member of the pill row rather than a layer over it.
    
       It was absolutely positioned, first at `top-4` — where it sat on the
       place pill and the dock — and then at `top-16`, which is exactly where
       both panels open. Neither position was free, because a notice about the
       service being down can coexist with anything: with the panels, which
       someone can open at any time, and with the timeline, which keeps its
       last frames when a later poll fails rather than blanking. In the row it
       cannot overlap anything, because flex will not let it. */
    <div className="dock-surface dock-pill text-muted pointer-events-none mx-auto min-w-0 shrink px-3 py-1.5 text-center text-[13px] font-medium">
      Dati radar non disponibili
    </div>
  );
}
