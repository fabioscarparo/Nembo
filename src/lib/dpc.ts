/**
 * Radar-DPC V2 — Dipartimento della Protezione Civile.
 *
 * Two hosts, and both are CORS-open, so the browser talks to them directly
 * and Nembo needs no backend of its own:
 *
 *   radar-api…  reflects the caller's Origin back in access-control-allow-origin
 *   s3-prod…    answers access-control-allow-origin: *
 *
 * Verified 28/08/2026 against the live service. Older write-ups describe a
 * `/wide/` path prefix and an Origin header you had to spoof server-side —
 * both are gone in V2. If this ever starts failing on CORS, that is what
 * changed, and the answer is a proxy: `Origin` is a forbidden header name,
 * so no amount of fetch options will let the browser set it itself.
 */

export const DPC = {
  api: "https://radar-api.protezionecivile.it",
  tiles: "https://s3-prod-dpc-radar-webp-cache.s3.eu-south-1.amazonaws.com",
} as const;

/* ── Products ───────────────────────────────────────────────────
 * The three the app can honestly draw.
 *
 * The service publishes more. POH and VIL answer findLastProductByType and
 * then 403 at every tile — metadata with nothing behind it. TEMP and IR_108
 * do have tiles, and are still absent: both are diverging fields, where the
 * meaning sits in the middle of the scale (0 °C) or runs backwards (a colder
 * cloud top is a higher one). A sequential ramp would put the visual peak at
 * the wrong end and draw a confident picture of the wrong thing, so they need
 * their own palettes before they can be offered — see RAMPS in colormap.ts.
 */

export type ProductKey = "VMI" | "SRI" | "SRT1";

/** The order the dock lays the quantities out in. */
export const PRODUCT_CYCLE: readonly ProductKey[] = ["VMI", "SRI", "SRT1"];

/**
 * The chosen quantity, remembered.
 *
 * Theme and sound already survived a reload and this did not, which made the
 * dock's third control the only preference in the app that forgot itself:
 * anyone who wanted rain rate re-picked it on every visit. Kept here rather
 * than in a preferences module because that is where the other two live too —
 * beside the thing they are about.
 */
export const PRODUCT_STORAGE_KEY = "product";

/** The remembered quantity, or reflectivity for anyone who has never chosen. */
export function readProduct(): ProductKey {
  try {
    const stored = localStorage.getItem(PRODUCT_STORAGE_KEY);
    /* Anything unrecognised falls back rather than throwing: the key is
       shared with whatever a future version writes, and a value this build
       does not know should degrade to reflectivity, not to a blank map. */
    return PRODUCT_CYCLE.includes(stored as ProductKey)
      ? (stored as ProductKey)
      : "VMI";
  } catch {
    return "VMI";
  }
}

/** Best-effort: a private window that refuses storage still switches fine,
 *  it just forgets by the next visit. */
export function storeProduct(key: ProductKey): void {
  try {
    localStorage.setItem(PRODUCT_STORAGE_KEY, key);
  } catch {
    // Private mode with storage disabled — the choice just won't persist.
  }
}

/**
 * What the legend says about a product.
 *
 * It lives here, beside the unit and the thresholds, because the panel used
 * to hardcode reflectivity: the title, the explanation and the five band
 * labels all described dBZ, and the only thing keeping that honest was that
 * no other product could be selected. Making them selectable without moving
 * this would have left the panel confidently describing rain rate as
 * reflectivity. Icons stay in the component — this file has no business
 * importing React.
 */
export type Legend = {
  title: string;
  blurb: string;
  /** Five, rising. The last one should be `srcMax`, which the panel marks "+". */
  bands: { at: number; label: string }[];
  note: string;
};

/**
 * Everything the app needs to know about one quantity: how to address its
 * tiles, how to turn a byte back into a number, and what to say about it.
 *
 * `srcMin`/`srcMax` are the two that carry physics — the red channel spans
 * them linearly across 0…255, so getting them wrong misreports every pixel
 * rather than failing visibly.
 */
export type Product = {
  key: ProductKey;
  label: string;
  unit: string;
  /** The R channel spans 0…255 linearly across [srcMin, srcMax]. */
  srcMin: number;
  srcMax: number;
  /** Frame cadence in minutes. Tile paths are floored to this. */
  stepMinutes: number;
  legend: Legend;
};

/** The table. Everything about a quantity lives in its entry, so adding one
 *  is an edit here rather than a hunt through the components. */
export const PRODUCTS: Record<ProductKey, Product> = {
  VMI: {
    key: "VMI",
    label: "Vertical Maximum Intensity",
    unit: "dBZ",
    srcMin: 0,
    srcMax: 60,
    stepMinutes: 5,
    legend: {
      title: "Riflettività radar",
      blurb:
        "Indica la quantità e la concentrazione di idrometeore presenti nell’atmosfera sopra l’area osservata, non la quantità di pioggia che raggiungerà il suolo.",
      bands: [
        { at: 20, label: "Debole" },
        { at: 30, label: "Moderata" },
        { at: 40, label: "Intensa" },
        { at: 50, label: "Forte" },
        { at: 60, label: "Molto forte" },
      ],
      note: "Valori superiori a 45 dBZ sono generalmente associati a precipitazioni intense, con possibile presenza di grandine.",
    },
  },
  SRI: {
    key: "SRI",
    label: "Intensità di pioggia",
    unit: "mm/h",
    srcMin: 0,
    srcMax: 100,
    stepMinutes: 5,
    legend: {
      title: "Intensità di pioggia",
      blurb:
        "Quanta pioggia cadrebbe in un’ora se l’intensità osservata in questo istante restasse costante. È una stima al suolo, non un accumulo già avvenuto.",
      bands: [
        { at: 1, label: "Debole" },
        { at: 5, label: "Moderata" },
        { at: 15, label: "Intensa" },
        { at: 40, label: "Forte" },
        { at: 100, label: "Nubifragio" },
      ],
      note: "Sopra i 30 mm/h la precipitazione è convenzionalmente classificata come rovescio violento.",
    },
  },
  SRT1: {
    key: "SRT1",
    label: "Pioggia in un’ora",
    unit: "mm",
    srcMin: 0,
    srcMax: 200,
    stepMinutes: 5,
    legend: {
      title: "Pioggia accumulata in un’ora",
      blurb:
        "La pioggia stimata al suolo nell’ora precedente ogni istante. A differenza dell’intensità, è una quantità già caduta.",
      bands: [
        { at: 3, label: "Debole" },
        { at: 8, label: "Moderata" },
        { at: 20, label: "Intensa" },
        { at: 50, label: "Forte" },
        { at: 200, label: "Eccezionale" },
      ],
      note: "Intorno ai 30 mm in un’ora si entra nella soglia in cui scattano le allerte di protezione civile.",
    },
  },
};

/* ── Coverage ───────────────────────────────────────────────
 * Which tile coordinates the service actually publishes, transcribed from the
 * `allowedTiles` sets in the DPC viewer's own bundle.
 *
 * Without this the obvious thing happens: a rectangular grid is requested,
 * the corners outside the radar's footprint answer 403 — the bucket denies
 * listing, so a missing object cannot answer 404 — and every load fills the
 * console with red for tiles that were never supposed to exist. Errors that
 * are expected are worse than useless: they train you to ignore the console,
 * and the one real failure hides among them.
 *
 * Entries are a single "z/x/y", or "z/x0/y-z/x1/y" for a run along one row.
 */
const COVERAGE: Partial<Record<ProductKey, readonly string[]>> = {
  VMI: [
    /* Corrected against the service: the DPC declares 66/44 and the whole
       68-70 run at y=50, and all three answer 403 at every instant tried,
       a day apart. Twenty-seven tiles exist of the thirty they list. */
    "7/67/44-7/69/44", "7/66/45-7/69/45", "7/66/46-7/69/46",
    "7/66/47-7/70/47", "7/66/48-7/70/48", "7/66/49-7/70/49",
    "7/69/50",
    "6/33/22-6/34/22", "6/33/23-6/35/23", "6/33/24-6/35/24",
    /* The DPC declares this row as 34-35; 35/25 answers 403 at every instant
       tried, including a day back, so it is transcribed as the one tile that
       exists. Their own viewer eats the error. */
    "6/34/25",
    "5/16/11-5/17/11", "5/16/12-5/17/12",
    "4/8/5", "4/8/6",
    "3/4/2", "3/4/3",
  ],
  /* Probed against the service rather than transcribed: every z7 coordinate
     asked for at two instants an hour apart, and only the ones that answered
     both times kept. The DPC's own declaration was wrong here — it lists the
     whole 67-70 run at y=49 and a 68-70 run at y=50, and 69/49 is a hole in
     the middle of a row while nothing at y=50 exists at all. */
  SRI: [
    "7/67/44-7/69/44", "7/66/45-7/69/45", "7/66/46-7/69/46",
    "7/66/47-7/70/47", "7/66/48-7/70/48", "7/66/49-7/68/49", "7/70/49",
    "6/33/22-6/34/22", "6/33/23-6/35/23", "6/33/24-6/35/24",
    "6/34/25",
    "5/16/11-5/17/11", "5/16/12-5/17/12",
    "4/8/5", "4/8/6",
    "3/4/2", "3/4/3",
  ],
  /* Same probe. SRT1 publishes 66/44, which SRI does not. */
  SRT1: [
    "7/66/44-7/69/44", "7/66/45-7/69/45", "7/66/46-7/69/46",
    "7/66/47-7/70/47", "7/66/48-7/70/48", "7/66/49-7/68/49", "7/70/49",
    "6/33/22-6/34/22", "6/33/23-6/35/23", "6/33/24-6/35/24",
    "6/34/25",
    "5/16/11-5/17/11", "5/16/12-5/17/12",
    "4/8/5", "4/8/6",
    "3/4/2", "3/4/3",
  ],
};

/** Parsed once: "z/x/y" → true, for every coordinate in every run. */
const coverageSets = new Map<ProductKey, Set<string>>();

/**
 * The parsed coverage for a product, expanded from its run notation and kept.
 *
 * Built on first use rather than at module load: only one product's table is
 * ever consulted in a session, and parsing the others would be work done for
 * nobody. Null means the product has no transcribed coverage, which callers
 * read as "assume everything is published".
 */
function coverageSet(key: ProductKey): Set<string> | null {
  const ranges = COVERAGE[key];
  if (!ranges) return null;

  const cached = coverageSets.get(key);
  if (cached) return cached;

  const set = new Set<string>();
  for (const entry of ranges) {
    const [from, to] = entry.split("-");
    const [z, x0, y] = from.split("/").map(Number);
    const x1 = to ? Number(to.split("/")[1]) : x0;
    for (let x = x0; x <= x1; x++) set.add(`${z}/${x}/${y}`);
  }
  coverageSets.set(key, set);
  return set;
}

/**
 * Whether the service publishes this tile at all. Products with no transcribed
 * coverage are assumed to publish everything, so an unlisted one degrades to
 * the old behaviour rather than disappearing.
 */
export function hasTile(
  key: ProductKey,
  z: number,
  x: number,
  y: number,
): boolean {
  const set = coverageSet(key);
  return set ? set.has(`${z}/${x}/${y}`) : true;
}

/* ── Last available frame ───────────────────────────────────── */

export type LastProduct = {
  productType: string;
  /** Epoch ms, already aligned to the product's cadence. */
  time: number;
  /** ISO-8601 duration, e.g. "PT5M". */
  period: string;
};

/**
 * The newest frame the service has published. Returns null rather than
 * throwing: a radar with no current frame should still render its archive.
 */
export async function fetchLastProduct(
  key: ProductKey,
  signal?: AbortSignal,
): Promise<LastProduct | null> {
  try {
    const res = await fetch(
      `${DPC.api}/findLastProductByType?type=${key}&lang=it`,
      { signal },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const last = data?.lastProducts?.[0];
    return typeof last?.time === "number" ? (last as LastProduct) : null;
  } catch {
    return null;
  }
}

/* ── Tile URLs ──────────────────────────────────────────────── */

/**
 * Path is UTC and floored to the product cadence:
 *   {bucket}/{TYPE}/{YYYY}/{MM}/{DD}/{HHMM}/{z}/{x}/{y}/{type}.webp
 *
 * Ask for an unaligned minute and you get a 403, not the nearest frame.
 */
export function tileUrl(
  product: Product,
  time: number,
  z: number,
  x: number,
  y: number,
): string {
  const step = product.stepMinutes * 60_000;
  const d = new Date(Math.floor(time / step) * step);

  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hhmm =
    String(d.getUTCHours()).padStart(2, "0") +
    String(d.getUTCMinutes()).padStart(2, "0");

  const file = product.key.toLowerCase() + ".webp";
  return `${DPC.tiles}/${product.key}/${yyyy}/${mm}/${dd}/${hhmm}/${z}/${x}/${y}/${file}`;
}

/* ── Decoding ───────────────────────────────────────────────── */

/**
 * A tile is a lossy WebP whose RED channel carries the value and whose alpha
 * is a binary no-data mask (only 0 and 255 ever appear). Green and blue drift
 * a little from red because WebP subsamples chroma — read them and you get
 * noise, so read red alone, exactly as the DPC's own shader does.
 *
 * Being lossy, red is an approximation: one step is (srcMax - srcMin) / 255,
 * about 0.24 dBZ for VMI, and compression adds a little on top. Fine to
 * render, not a number to quote to two decimals.
 */
export function decodeValue(product: Product, red: number): number {
  return product.srcMin + (red / 255) * (product.srcMax - product.srcMin);
}
