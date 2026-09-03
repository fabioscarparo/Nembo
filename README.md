<p align="center">
  <img src="assets/nembo.png" alt="Nembo" width="110">
</p>

<h1 align="center">Nembo</h1>

<p align="center">
  <strong>Radar meteorologico italiano con nowcasting a 30 minuti,<br>
  basato sui dati radar del Dipartimento della Protezione Civile.</strong>
</p>

<p align="center">
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=fff"></a>
  <a href="https://react.dev/"><img alt="React" src="https://img.shields.io/badge/React-61DAFB?logo=react&logoColor=000"></a>
  <a href="https://nextjs.org/"><img alt="Next.js" src="https://img.shields.io/badge/Next.js-000?logo=nextdotjs&logoColor=fff"></a>
  <a href="https://maplibre.org/"><img alt="MapLibre" src="https://img.shields.io/badge/MapLibre-295DAA?logo=maplibre&logoColor=fff"></a>
  <a href="https://radar.protezionecivile.it/"><img alt="DPC Radar" src="https://img.shields.io/badge/Data-DPC_Radar-333"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/License-MIT-333"></a>
</p>


Nembo nasce con un obiettivo semplice: rendere immediatamente leggibile l'evoluzione della precipitazione sul territorio italiano, mostrando non solo ciò che il radar sta osservando in questo momento, ma anche come quella precipitazione si sta muovendo e dove potrebbe trovarsi nei prossimi trenta minuti.

Il **Dipartimento della Protezione Civile (DPC)** aggiorna le osservazioni radar ogni cinque minuti. Nembo utilizza queste osservazioni per costruire una timeline continua di un'ora, con un fotogramma al minuto: trenta minuti di storia, il presente e trenta minuti di previsione.

I fotogrammi intermedi non sono semplici interpolazioni grafiche. La precipitazione osservata viene trasportata nel tempo seguendo il movimento effettivamente misurato dal radar. In questo modo, la previsione rappresenta un **nowcasting basato sull'advection dell'eco radar**, anziché una semplice animazione dei dati.

Nembo è un'applicazione statica e non utilizza un backend proprietario: l'elaborazione del moto e la generazione della previsione avvengono direttamente nel browser.

---

## Funzionalità

Nembo permette di esplorare la precipitazione attraverso tre diverse grandezze fisiche:

- **Riflettività**, espressa in dBZ.
- **Intensità di pioggia**, espressa in mm/h.
- **Pioggia accumulata nell'ultima ora**, espressa in mm.

La visualizzazione si adatta alla grandezza selezionata, mostrando una legenda contestuale e una scala cromatica dedicata.

La **timeline di un'ora** consente di scorrere liberamente tra le osservazioni passate, il presente e la previsione. La riproduzione può essere avviata in loop oppure controllata rapidamente tramite tastiera, utilizzando la barra spaziatrice per play e pausa.

La previsione si estende fino a **30 minuti nel futuro** e viene calcolata a partire dal moto osservato della precipitazione. Quando il movimento non può essere stimato con sufficiente affidabilità, Nembo ricorre al vento di trascinamento come alternativa.

È inoltre possibile utilizzare la **geolocalizzazione** per centrare la mappa sulla propria posizione e visualizzare il nome del luogo e le condizioni meteorologiche attuali.

L'interfaccia supporta **tema chiaro, scuro e sistema**, oltre alla possibilità di disattivare suoni e feedback aptici.

---

## Come funziona

### I dati radar

Il DPC pubblica le osservazioni radar come tile WebP su griglia Web Mercator. Nembo utilizza un mosaico di **1280 × 1792 pixel** sull'Italia, con una risoluzione di circa **900 metri per pixel**.

Le immagini non contengono una visualizzazione cromatica pre-renderizzata: ogni pixel conserva direttamente il dato radar. Il **canale rosso** codifica linearmente il valore fisico (per la riflettività, da `0 → 0 dBZ` a `255 → 60 dBZ`) mentre il **canale alfa** distingue i dati validi dalle aree prive di osservazione. I canali verde e blu vengono ignorati, poiché il sottocampionamento della crominanza introdotto da WebP ne rende il contenuto non rappresentativo del segnale.

Lavorare sul dato grezzo offre due vantaggi fondamentali. Da un lato, Nembo può costruire dinamicamente la propria **palette cromatica** a partire dai token CSS del tema, senza perdere precisione a causa della quantizzazione in bande di colore. Dall'altro, la stima del movimento viene effettuata direttamente sui **valori di riflettività**, evitando che il calcolo debba inseguire una palette: valori diversi ridotti allo stesso colore rimangono distinguibili e i passaggi di soglia non introducono falsi movimenti.

### La previsione

Nembo stima il movimento della precipitazione confrontando due osservazioni radar distanti trenta minuti e ricostruendo il campo di moto in tre passaggi.

Le osservazioni vengono prima **ridotte di un fattore otto**, conservando il valore massimo di ogni cella. In questo modo i nuclei di precipitazione più intensi non vengono diluiti dalla media e rimangono sufficientemente caratterizzati per essere inseguiti. Su questa griglia viene quindi eseguito un **block matching**: ogni blocco cerca lo spostamento che meglio sovrappone le due osservazioni. I risultati vengono aggregati in un vettore di consenso, pesato in base alla quantità di eco che sostiene ciascuna stima. Se non emerge un accordo sufficiente, il moto viene considerato non misurabile.

Il vettore di consenso descrive però soltanto il trasporto generale. Per catturare le variazioni locali, Nembo calcola un **optical flow Lucas-Kanade**, ottenendo un vettore per ogni cella. Dove l'eco è insufficiente, il flusso ottico può produrre stime arbitrarie, per questo ogni vettore viene vincolato al moto di consenso, limitandone lo scostamento senza eliminarne la direzione locale. Il campo risultante può quindi deformarsi dove i dati lo giustificano, mantenendo un comportamento coerente altrove. Le osservazioni vengono infine trasportate lungo questo campo con passi temporali di cinque minuti. Le traiettorie vengono integrate seguendo il flusso, anziché applicare una semplice traslazione lineare, la precipitazione può così ruotare, allungarsi e comprimersi durante il movimento.

Quando le osservazioni non consentono di ricostruire un consenso affidabile, Nembo utilizza come fallback il **vento in quota**, calcolato come media pesata sulla massa tra 850 e 500 hPa. Se anche questo dato non è disponibile, la previsione viene dichiarata assente anziché mostrare artificialmente il presente come futuro.

L'intero processo richiede circa **120 ms** e viene eseguito in un **Web Worker**, mantenendo l'interfaccia reattiva durante la ricostruzione del campo di moto.


---

## Cosa può e non può prevedere

Nembo è un sistema di **nowcasting basato sul movimento della precipitazione osservata**. Questo comporta una conseguenza fondamentale: l'applicazione può trasportare nel futuro ciò che il radar sta già osservando, ma non può prevedere fenomeni che ancora non sono presenti nei dati.

Una cella temporalesca che si formerà tra venti minuti, ad esempio, non è presente nell'osservazione attuale e quindi non può essere generata dalla previsione.

Allo stesso modo, Nembo non è un modello meteorologico numerico: non simula l'atmosfera e non considera direttamente instabilità, orografia o altri processi fisici responsabili della formazione e dell'evoluzione delle precipitazioni.

L'obiettivo è più circoscritto: **stimare dove si sposterà ciò che il radar sta già osservando nell'orizzonte immediato dei successivi 30 minuti**.

---

## Struttura del progetto

Il progetto è organizzato separando la logica di acquisizione ed elaborazione dei dati dai componenti responsabili dell'interfaccia.

```text
src/lib/
  grid.ts            geometria del dominio (zoom, tile, conversioni lat/lon)
  flow.ts            stima del moto: consenso + flusso ottico denso
  motion.worker.ts   stessa stima, eseguita fuori dal main thread
  nowcast.ts         osservazioni, cache, warp, rendering dei fotogrammi
  dpc.ts             contratto del servizio DPC, prodotti, copertura dei tile
  tiles.ts           fetch e decodifica dei tile
  colormap.ts        costruzione della palette dai token CSS
  wind.ts            vento di trascinamento da Open-Meteo
  place.ts           geocodifica inversa e condizioni attuali
  visibility.ts      timer che si fermano quando la pagina non è visibile
  basemap.ts         stile CARTO con fallback locale
  theme.ts
  sound.ts
  haptics.ts         preferenze e feedback dell'utente

src/components/
  RadarMap.tsx       componente principale, mappa e interfaccia
  Timeline.tsx       timeline, righello e riproduzione
  Dock.tsx           selettore grandezza, legenda e impostazioni
  Settings.tsx       pannello delle preferenze
  Legend.tsx         scala dei colori
  PlacePill.tsx      luogo e condizioni attuali
  SlidingTabs.tsx    controllo a schede condiviso
```

---

## Fonti dei dati

| Fonte | Utilizzo |
|---|---|
| [Dipartimento della Protezione Civile](https://radar.protezionecivile.it/) | Dati radar, con attribuzione mostrata all'interno dell'applicazione |
| [Open-Meteo](https://open-meteo.com) | Vento in quota e condizioni meteorologiche attuali |
| [BigDataCloud](https://www.bigdatacloud.com) | Geocodifica inversa |
| [CARTO](https://carto.com) | Mappa di base, Positron / Dark Matter, basata su OpenStreetMap |

---

## Nota

Nembo è un **progetto personale attualmente in sviluppo**.

L'applicazione utilizza i dati radar del Dipartimento della Protezione Civile, ma **non è affiliata, approvata o sviluppata dal Dipartimento della Protezione Civile**.