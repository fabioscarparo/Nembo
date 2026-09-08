/**
 * Colour is the whole point of this project.
 *
 * The DPC's own viewer paints VMI with the rainbow scale every radar site in
 * the world uses: seven hues, no ordering you can read at a glance, and the
 * eye lands on the yellow-green midrange instead of on the cell that matters.
 * Because the tiles carry the *value* rather than a picture (see decodeValue
 * in dpc.ts), the palette is ours to choose.
 *
 * What this builds is a 256-entry lookup table — one RGBA per possible red
 * byte — that a fragment shader samples as a 256×1 texture, or a 2D canvas
 * walks per pixel. Stops read their colour from CSS custom properties, so the
 * ramp lives in globals.css next to every other token and follows the theme;
 * the thresholds stay here, in code, because 45 dBZ means something and
 * #e0952a does not.
 */

import type { Product, ProductKey } from "./dpc";
import { decodeValue } from "./dpc";

/** One anchor of a ramp: a physical value, the token that colours it, and how
 *  opaque it is there. */
export type Stop = {
  /** Physical value, in the product's own unit. */
  at: number;
  /** CSS custom property holding the colour. */
  token: string;
  /** 0…1. Low stops stay translucent so the map reads through them. */
  alpha: number;
};

/* ── Ramps ──────────────────────────────────────────────────────
 * These are the Protezione Civile's own colours, transcribed from the
 * fragment shader their viewer ships unminified. Starting from the palette
 * everyone recognises is the right default: a monochrome ramp encodes
 * intensity as lightness alone, and nine steps of lightness discriminate far
 * worse than hue does — real information was going missing in the middle of
 * the scale.
 *
 * The colours live in globals.css, so recolouring later is an edit to the
 * tokens rather than to this file. The thresholds stay here, because they
 * carry meteorology.
 *
 * One inherited quirk worth keeping: their VMI ramp normalises against 0–100
 * dBZ while the data itself tops out at 60. Red therefore sits past anything
 * the radar can report, and 60 dBZ lands on orange rather than on the end of
 * the scale. Matching it is deliberate — the app should agree with the
 * official viewer about what a given cell looks like.
 */

export const RAMPS: Partial<Record<ProductKey, Stop[]>> = {
  VMI: [
    { at: 0, token: "--ramp-1", alpha: 0 },
    { at: 10, token: "--ramp-2", alpha: 0 },
    { at: 20, token: "--ramp-3", alpha: 0.4 },
    { at: 30, token: "--ramp-4", alpha: 0.8 },
    { at: 40, token: "--ramp-5", alpha: 0.8 },
    { at: 50, token: "--ramp-6", alpha: 0.8 },
    { at: 100, token: "--ramp-7", alpha: 0.8 },
  ],
  /* mm/h, spaced log-ish because rain rate is: drizzle to cloudburst spans
     three decades. */
  SRI: [
    { at: 0.2, token: "--ramp-1", alpha: 0 },
    { at: 1, token: "--ramp-2", alpha: 0.35 },
    { at: 5, token: "--ramp-3", alpha: 0.6 },
    { at: 15, token: "--ramp-4", alpha: 0.8 },
    { at: 35, token: "--ramp-5", alpha: 0.8 },
    { at: 60, token: "--ramp-6", alpha: 0.8 },
    { at: 100, token: "--ramp-7", alpha: 0.8 },
  ],
  /* mm in an hour. 30 is roughly where civil-protection warnings begin. */
  SRT1: [
    { at: 1, token: "--ramp-1", alpha: 0 },
    { at: 3, token: "--ramp-2", alpha: 0.35 },
    { at: 8, token: "--ramp-3", alpha: 0.6 },
    { at: 20, token: "--ramp-4", alpha: 0.8 },
    { at: 40, token: "--ramp-5", alpha: 0.8 },
    { at: 80, token: "--ramp-6", alpha: 0.8 },
    { at: 200, token: "--ramp-7", alpha: 0.8 },
  ],
};

/* TEMP and IR_108 are deliberately absent. Both are diverging fields — a
   sequential ramp would put the visual peak at one end of a scale whose
   meaning sits in the middle (0 °C) or is inverted (colder cloud top = higher
   cloud). They need their own ramps, and pretending otherwise would draw a
   confident picture of the wrong thing. */

/* ── CSS colour resolution ──────────────────────────────────── */

let probe: CanvasRenderingContext2D | null = null;

/**
 * Any colour the browser can parse, resolved to RGB — hex, rgb(), oklch(),
 * color-mix(), whatever ends up in the stylesheet. Painting one pixel and
 * reading it back is shorter than a parser and cannot fall behind CSS.
 */
function toRgb(css: string): [number, number, number] {
  if (!probe) {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    probe = c.getContext("2d", { willReadFrequently: true });
  }
  if (!probe) return [0, 0, 0];
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = "#000";
  probe.fillStyle = css;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

/** One ramp stop, resolved from its custom property to RGB. */
function readToken(token: string): [number, number, number] {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(token)
    .trim();
  return toRgb(raw || "#000");
}

/* ── Grading ────────────────────────────────────────────────
 * The DPC's shader does not use its palette raw — it pushes saturation, adds
 * a little contrast and lifts the gamma before drawing. Skipping this leaves
 * the ramp noticeably duller than the official viewer's, so it is reproduced
 * here with their constants.
 */

/** Chroma multiplier around the luma. Above 1, so colours pull away from grey. */
const SATURATION = 1.3;
/** Expansion around mid-grey: the ends separate, the middle barely moves. */
const CONTRAST = 1.08;
/** Applied as `v ** (1 / GAMMA)`. Under 1, so it lifts rather than darkens. */
const GAMMA = 0.92;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** GLSL smoothstep on an already-normalised factor. */
function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/**
 * Saturation, contrast and gamma, in that order, on normalised RGB.
 *
 * Reproduces what the DPC's own fragment shader does to its palette before
 * drawing. The order matters and is theirs: saturating after a contrast lift
 * would push the strong end out of gamut and flatten the top of the scale,
 * which is exactly where the reading matters most.
 */
function grade([r, g, b]: [number, number, number]): [number, number, number] {
  // Rec. 601 luma, the same weights the shader uses.
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  const out: [number, number, number] = [r, g, b];
  for (let i = 0; i < 3; i++) {
    let v = luma + (out[i] - luma) * SATURATION;
    v = (v - 0.5) * CONTRAST + 0.5;
    out[i] = clamp01(v) ** (1 / GAMMA);
  }
  return out;
}

/* ── LUT ────────────────────────────────────────────────────── */

/**
 * 256 RGBA entries, indexed by the tile's red byte. Straight (not
 * premultiplied) alpha: the shader premultiplies when it blends two frames,
 * and doing it twice darkens the crossfade.
 *
 * Interpolation is smoothstepped and the result graded with the DPC's own
 * constants, so a given dBZ resolves to the colour their viewer draws for it.
 *
 * An earlier version quantised the value into 5 dBZ bands first, to answer a
 * request for crisper edges. It did look sharper, but every pixel then sat a
 * band away from the reference: side by side with the official radar it was
 * visibly a different picture. Agreeing with the source matters more than
 * looking tidy — this is an instrument before it is a graphic.
 */
/**
 * The alpha byte the palette gives a value, on its own.
 *
 * Split out of buildLut because paintFloor needs the same answer without the
 * colours: the crop has to agree with what will actually be drawn, and two
 * copies of this interpolation would eventually disagree.
 */
function alphaByte(stops: Stop[], v: number): number {
  if (v < stops[0].at) return 0;
  const hi = stops.findIndex((s) => s.at > v);
  if (hi === -1) return Math.round(stops[stops.length - 1].alpha * 255);
  const lo = hi - 1;
  const span = stops[hi].at - stops[lo].at;
  const t = span > 0 ? (v - stops[lo].at) / span : 0;
  const f = smoothstep(t);
  return Math.round((stops[lo].alpha + (stops[hi].alpha - stops[lo].alpha) * f) * 255);
}

/**
 * The smallest byte value this product's palette puts any pixel down for.
 *
 * signalBox crops to this, and renderField draws only the crop, so it has to
 * be the palette's own answer: a byte below it is transparent by
 * construction, and a byte above it is echo that would otherwise be cut off
 * at the rectangle's edge.
 *
 * Per product, necessarily — that was the bug. A byte spans each product's
 * own range, so one shared threshold is not one threshold: 21 means 4.9 dBZ
 * against VMI's 0-60, but 8.2 mm/h against SRI's 0-100 and 16.5 mm against
 * SRT1's 0-200. Rain rate and accumulation were being cropped to their
 * heaviest cores, and a field of ordinary rain produced no box at all.
 */
export function paintFloor(product: Product): number {
  const stops = RAMPS[product.key];
  if (!stops?.length) return 1;
  for (let i = 1; i < 256; i++) {
    if (alphaByte(stops, decodeValue(product, i)) > 0) return i;
  }
  /* Nothing in this palette is ever visible — crop to nothing rather than to
     everything. */
  return 255;
}

export function buildLut(product: Product, stops: Stop[]): Uint8Array {
  const lut = new Uint8Array(256 * 4);
  const colors = stops.map((s) => readToken(s.token));

  for (let i = 0; i < 256; i++) {
    const v = decodeValue(product, i);
    const o = i * 4;

    // Below the first stop is signal too weak to be worth a pixel.
    if (v < stops[0].at) continue;

    let hi = stops.findIndex((s) => s.at > v);
    if (hi === -1) {
      const last = stops.length - 1;
      lut[o] = colors[last][0];
      lut[o + 1] = colors[last][1];
      lut[o + 2] = colors[last][2];
      lut[o + 3] = alphaByte(stops, v);
      continue;
    }

    const lo = hi - 1;
    const span = stops[hi].at - stops[lo].at;
    const t = span > 0 ? (v - stops[lo].at) / span : 0;
    const f = smoothstep(t);

    const rgb: [number, number, number] = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      rgb[c] = (colors[lo][c] + (colors[hi][c] - colors[lo][c]) * f) / 255;
    }

    const [r, g, b] = grade(rgb);
    lut[o] = Math.round(r * 255);
    lut[o + 1] = Math.round(g * 255);
    lut[o + 2] = Math.round(b * 255);
    lut[o + 3] = alphaByte(stops, v);
  }

  return lut;
}

/* ── Theme ──────────────────────────────────────────────────── */

/**
 * The theme toggle writes a class onto <html> and emits nothing, so the only
 * way to hear about it is to watch the attribute — plus the media query, for
 * the visitor still on "system" when the OS flips at sunset.
 *
 * The callback fires after the class has landed. Rebuild the LUT and re-upload
 * the 256×1 texture; never re-fetch the tiles, whose decoded values did not
 * change. Returns its own teardown.
 */
export function watchTheme(onChange: () => void): () => void {
  const observer = new MutationObserver((records) => {
    if (records.some((r) => r.attributeName === "class")) onChange();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });

  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", onChange);

  return () => {
    observer.disconnect();
    media.removeEventListener("change", onChange);
  };
}
