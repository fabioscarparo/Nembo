<p align="center">
  <img src="assets/nembo.png" alt="Nembo" width="110">
</p>

<h1 align="center">Nembo</h1>

<p align="center">
  <strong>Sleek, minimal and curated Italian weather radar with 30-minute<br>
  nowcasting, built from data provided by the Italian Civil Protection Department.</strong>
</p>

<p align="center">
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=fff"></a>
  <a href="https://react.dev/"><img alt="React" src="https://img.shields.io/badge/React-61DAFB?logo=react&logoColor=000"></a>
  <a href="https://nextjs.org/"><img alt="Next.js" src="https://img.shields.io/badge/Next.js-000?logo=nextdotjs&logoColor=fff"></a>
  <a href="https://maplibre.org/"><img alt="MapLibre" src="https://img.shields.io/badge/MapLibre-295DAA?logo=maplibre&logoColor=fff"></a>
  <a href="https://radar.protezionecivile.it/"><img alt="DPC Radar" src="https://img.shields.io/badge/Data-DPC_Radar-333"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/License-MIT-333"></a>
</p>


Nembo was built with a simple goal: to make the evolution of precipitation over Italy immediately legible, showing not only what the radar is observing right now, but also how that precipitation is moving and where it might be in the next thirty minutes.

The **Italian Civil Protection Department (DPC)** updates its radar observations every five minutes. Nembo uses those observations to build a continuous one-hour timeline at one frame per minute: thirty minutes of history, the present, and thirty minutes of forecast.

The intermediate frames are not graphical interpolations. Observed precipitation is carried forward in time along the motion actually measured by the radar. The forecast is therefore **nowcasting based on advection of the radar echo**, rather than a simple animation of the data.

Nembo is a static application with no backend of its own: motion estimation and forecast generation both happen directly in the browser.

---

## Features

Nembo lets you explore precipitation through three different physical quantities:

- **Reflectivity**, in dBZ.
- **Rain rate**, in mm/h.
- **Rainfall accumulated over the last hour**, in mm.

The display adapts to the selected quantity, with a contextual legend and a dedicated colour scale.

The **one-hour timeline** allows you to move freely between past observations, the present and the forecast. Playback can run on a loop or be controlled quickly from the keyboard, using the space bar for play and pause.

The forecast extends **30 minutes into the future** and is computed from the observed motion of the precipitation. When that motion cannot be estimated reliably, Nembo falls back on the steering wind.

**Geolocation** can also be used to centre the map on your position and show the place name and current weather conditions.

The interface supports **light, dark and system themes**, along with the option to turn off sound and haptic feedback.

---

## How it works

### The radar data

The DPC publishes radar observations as WebP tiles on a Web Mercator grid. Nembo uses a **1280 × 1792 pixel** mosaic over Italy, at a resolution of roughly **900 metres per pixel**.

The images contain no pre-rendered colour view: every pixel holds the radar value itself. The **red channel** encodes the physical value linearly (for reflectivity, from `0 → 0 dBZ` to `255 → 60 dBZ`) while the **alpha channel** separates valid data from areas with no observation. The green and blue channels are ignored, since the chroma subsampling introduced by WebP makes their content unrepresentative of the signal.

Working on the raw data offers two fundamental advantages. First, Nembo can build its own **colour palette** dynamically from the theme's CSS tokens, without losing precision to quantisation into colour bands. Second, motion is estimated directly on **reflectivity values**, so the computation never has to chase a palette: different values flattened to the same colour stay distinguishable, and threshold crossings introduce no false motion.

### The forecast

Nembo estimates the motion of precipitation by comparing two radar observations thirty minutes apart, reconstructing the motion field in three steps.

The observations are first **reduced by a factor of eight**, keeping the maximum value of each cell. This keeps the most intense precipitation cores from being diluted by averaging, leaving them distinct enough to be tracked. **Block matching** then runs on this grid: each block looks for the displacement that best overlaps the two observations. The results are aggregated into a consensus vector, weighted by how much echo supports each estimate. If no sufficient agreement emerges, the motion is treated as unmeasurable.

The consensus vector, however, describes only the overall transport. To capture local variation, Nembo computes a **Lucas-Kanade optical flow**, obtaining one vector per cell. Where echo is insufficient, optical flow can produce arbitrary estimates, which is why each vector is constrained toward the consensus motion, limiting how far it may depart from it without erasing its local direction. The resulting field can therefore deform where the data justify it, while staying coherent elsewhere. The observations are finally transported along this field in five-minute steps. Trajectories are integrated by following the flow rather than applying a simple linear translation, so precipitation can rotate, stretch and compress as it moves.

When the observations do not allow a reliable consensus to be reconstructed, Nembo falls back on the **steering wind**, computed as a mass-weighted mean between 850 and 500 hPa. If that too is unavailable, the forecast is declared absent rather than artificially presenting the present as the future.

The whole process takes about **120 ms** and runs in a **Web Worker**, keeping the interface responsive while the motion field is reconstructed.


---

## What it can and cannot forecast

Nembo is a nowcasting system **based on the motion of observed precipitation**. This carries one fundamental consequence: the application can carry into the future what the radar is already observing, but it cannot forecast phenomena that are not yet present in the data.

A storm cell that will form twenty minutes from now, for example, is not present in the current observation and therefore cannot be generated by the forecast.

In the same way, Nembo is not a numerical weather model: it does not simulate the atmosphere and does not directly account for instability, orography or the other physical processes responsible for the formation and evolution of precipitation.

The goal is a narrower one: **to estimate where what the radar is already observing will move within the immediate horizon of the next 30 minutes**.

---

## Project structure

The project is organised by separating data acquisition and processing from the components responsible for the interface.

```text
src/lib/
  grid.ts            domain geometry (zoom, tiles, lat/lon conversions)
  flow.ts            motion estimation: consensus + dense optical flow
  motion.worker.ts   the same estimation, run off the main thread
  nowcast.ts         observations, cache, warping, frame rendering
  dpc.ts             DPC service contract, products, tile coverage
  tiles.ts           tile fetching and decoding
  colormap.ts        palette built from the CSS tokens
  wind.ts            steering wind from Open-Meteo
  place.ts           reverse geocoding and current conditions
  visibility.ts      timers that stop when the page is not visible
  basemap.ts         CARTO style with a local fallback
  theme.ts
  sound.ts
  haptics.ts         user preferences and feedback

src/components/
  RadarMap.tsx       main component, map and interface
  Timeline.tsx       timeline, ruler and playback
  Dock.tsx           quantity selector, legend and settings
  Settings.tsx       preferences panel
  Legend.tsx         colour scale
  PlacePill.tsx      place and current conditions
  SlidingTabs.tsx    shared tab control
```

---

## Data sources

| Source | Used for |
|---|---|
| [Italian Civil Protection Department](https://radar.protezionecivile.it/) | Radar data, with attribution shown inside the application |
| [Open-Meteo](https://open-meteo.com) | Steering wind and current weather conditions |
| [BigDataCloud](https://www.bigdatacloud.com) | Reverse geocoding |
| [CARTO](https://carto.com) | Base map, Positron / Dark Matter, based on OpenStreetMap |

---

## Note

Nembo is a **personal project currently in development**.

The application uses radar data from the Italian Civil Protection Department, but is **not affiliated with, endorsed by, or developed by the Civil Protection Department**.
