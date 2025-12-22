// Mapbox token is injected at deploy time into site/config.js as:
//   window.SFEX_SURF_MAPBOX_TOKEN = "pk...."
// This keeps the token out of the git repo while still allowing a static site.
const MAPBOX_TOKEN = window.SFEX_SURF_MAPBOX_TOKEN || "";

const DATA_GEOJSON_URL = "./data/beaches.geojson";
const DATA_SUMMARY_URL = "./data/summary.json";

const SOURCE_ID = "beaches";
const LAYER_ID = "beach-points";

function $(id) {
  return document.getElementById(id);
}

function fmtMaybe(v, suffix = "") {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${v}${suffix}`;
}

function qualityColorExpression(metric) {
  const m = metric || "qualityScore";

  if (m === "waveHeightFt") {
    return [
      "step",
      ["coalesce", ["get", "waveHeightFt"], 0],
      "#5b2b7a",
      1,
      "#2f4ba0",
      3,
      "#1e88a8",
      5,
      "#2fb95c",
      8,
      "#f0c24b",
      12,
      "#e2554f",
    ];
  }

  if (m === "windSuitability") {
    return [
      "step",
      ["coalesce", ["get", "windSuitability"], 0.5],
      "#e2554f",
      0.2,
      "#f0c24b",
      0.5,
      "#2fb95c",
      0.8,
      "#1bb7a6",
    ];
  }

  if (m === "tideHeightFt") {
    return [
      "step",
      ["coalesce", ["get", "tideHeightFt"], 0],
      "#2f4ba0",
      1,
      "#1e88a8",
      3,
      "#2fb95c",
      5,
      "#f0c24b",
      7,
      "#e2554f",
    ];
  }

  return [
    "step",
    ["coalesce", ["get", "qualityScore"], 0],
    "#e2554f",
    35,
    "#f0c24b",
    55,
    "#2fb95c",
    75,
    "#1bb7a6",
  ];
}

function buildTooltipHtml(p) {
  return `
    <div class="name">${p.name || "Unknown"}</div>
    <div class="row"><span class="label">Quality</span><span>${fmtMaybe(p.qualityScore)}</span></div>
    <div class="row"><span class="label">Wave</span><span>${fmtMaybe(p.waveHeightFt, " ft")}</span></div>
    <div class="row"><span class="label">Period</span><span>${fmtMaybe(p.dominantPeriodS, " s")}</span></div>
    <div class="row"><span class="label">Wind</span><span>${fmtMaybe(p.windSpeedMph, " mph")}</span></div>
    <div class="row"><span class="label">Tide</span><span>${fmtMaybe(p.tideHeightFt, " ft")} ${p.tideTrend ? `(${p.tideTrend})` : ""}</span></div>
  `;
}

function buildPopupHtml(p) {
  const ndbc = p?.sources?.ndbcStation || p?.ndbcStation || "—";
  const tide = p?.sources?.tideStation || p?.tideStation || "—";

  return `
    <div style="min-width:240px; font-family:inherit; color:#111;">
      <div style="font-weight:800; font-size:14px; margin-bottom:6px;">${p.name || "Unknown"}</div>
      <div style="font-size:12px; color:#333; margin-bottom:10px;">${p.region || ""}</div>

      <div style="font-size:12px; line-height:1.4;">
        <div><b>Quality score:</b> ${fmtMaybe(p.qualityScore)} / 100</div>
        <div><b>Wave height:</b> ${fmtMaybe(p.waveHeightFt, " ft")}</div>
        <div><b>Period:</b> ${fmtMaybe(p.dominantPeriodS, " s")}</div>
        <div><b>Wave dir:</b> ${fmtMaybe(p.waveDirectionDeg, "°")}</div>
        <div><b>Wind:</b> ${fmtMaybe(p.windSpeedMph, " mph")} from ${fmtMaybe(p.windDirectionDeg, "°")}</div>
        <div><b>Tide:</b> ${fmtMaybe(p.tideHeightFt, " ft")} ${p.tideTrend ? `(${p.tideTrend})` : ""}</div>
      </div>

      <div style="margin-top:10px; font-size:11px; color:#444;">
        <div><b>NDBC buoy:</b> ${ndbc}</div>
        <div><b>Tide station:</b> ${tide}</div>
        <div><b>Generated:</b> ${p?.timestamps?.generatedAt ? new Date(p.timestamps.generatedAt).toUTCString() : "—"}</div>
        <div><b>Buoy obs:</b> ${p?.timestamps?.ndbcObservedAt ? new Date(p.timestamps.ndbcObservedAt).toUTCString() : "—"}</div>
      </div>
    </div>
  `;
}

async function fetchJson(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`Fetch failed ${r.status} for ${url}`);
  return await r.json();
}

function showErrorBanner(msg) {
  const mapEl = document.getElementById("map");
  const div = document.createElement("div");
  div.className = "errorBanner";
  div.textContent = msg;
  mapEl.appendChild(div);
}

const MAP_STYLE = "mapbox://styles/mapbox/light-v11";

// Hand-tuned coverage bounds (SF peninsula + Marin surf coast, with a small buffer).
// This avoids the “centered in the Pacific” look from fitBounds on coastal points.
// Hard bounds: keep panning focused on SF peninsula + Marin surf coast.
// West edge intentionally trimmed so we don't open on a giant slab of Pacific.
const COVERAGE_SW = [-122.64, 37.50];
const COVERAGE_NE = [-122.33, 37.99];
const COVERAGE_BOUNDS = new mapboxgl.LngLatBounds(COVERAGE_SW, COVERAGE_NE);

function bufferedBounds(sw, ne, bufferLon, bufferLat) {
  return new mapboxgl.LngLatBounds(
    [sw[0] - bufferLon, sw[1] - bufferLat],
    [ne[0] + bufferLon, ne[1] + bufferLat]
  );
}

async function main() {
  if (!MAPBOX_TOKEN) {
    showErrorBanner(
      "Mapbox token not configured. Ask an editor/dev to set the GitHub Actions secret MAPBOX_PUBLIC_TOKEN and redeploy."
    );
    return;
  }

  mapboxgl.accessToken = MAPBOX_TOKEN;

  const map = new mapboxgl.Map({
    container: "map",
    style: MAP_STYLE,
    center: [-122.58, 37.84],
    zoom: 9.4,
    attributionControl: true,
  });

  map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "top-right");

  const tooltip = document.createElement("div");
  tooltip.className = "tooltip";
  tooltip.style.display = "none";
  document.querySelector(".map").appendChild(tooltip);

  const statusEl = $("status");
  const metricSelect = $("metricSelect");

  let beachesGeojson = null;

  async function loadDataAndRefreshSource() {
    try {
      const summary = await fetchJson(`${DATA_SUMMARY_URL}?t=${Date.now()}`);
      if (summary?.generatedAt) {
        statusEl.textContent = `Updated: ${new Date(summary.generatedAt).toLocaleString()}`;
      } else {
        statusEl.textContent = "Updated: —";
      }
    } catch {
      statusEl.textContent = "Updated: —";
    }

    beachesGeojson = await fetchJson(`${DATA_GEOJSON_URL}?t=${Date.now()}`);
    const src = map.getSource(SOURCE_ID);
    if (src) src.setData(beachesGeojson);
  }

  function applyMetricStyle(metric) {
    if (!map.getLayer(LAYER_ID)) return;
    map.setPaintProperty(LAYER_ID, "circle-color", qualityColorExpression(metric));
  }

  map.on("load", async () => {
    await loadDataAndRefreshSource();

    // Initial framing: a deterministic center/zoom that prioritizes the coastline
    // (fitBounds tends to over-emphasize open-ocean when points hug the coast).
    // Bias the initial view eastward so the coastline reads better.
    map.jumpTo({ center: [-122.46, 37.80], zoom: 10.1 });
    // Note: LngLatBounds#pad is not available in all Mapbox GL JS versions.
    map.setMaxBounds(bufferedBounds(COVERAGE_SW, COVERAGE_NE, 0.015, 0.02));
    map.setMinZoom(9.0);
    map.setMaxZoom(13.5);

    map.addSource(SOURCE_ID, { type: "geojson", data: beachesGeojson });

    map.addLayer({
      id: LAYER_ID,
      type: "circle",
      source: SOURCE_ID,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 4, 10, 7, 12, 10],
        "circle-color": qualityColorExpression(metricSelect.value),
        "circle-stroke-width": 1,
        "circle-stroke-color": "rgba(255,255,255,0.35)",
        "circle-opacity": 0.92,
      },
    });

    metricSelect.addEventListener("change", () => applyMetricStyle(metricSelect.value));

    map.on("mouseenter", LAYER_ID, () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", LAYER_ID, () => {
      map.getCanvas().style.cursor = "";
      tooltip.style.display = "none";
    });

    map.on("mousemove", LAYER_ID, (e) => {
      const f = e.features && e.features[0];
      if (!f) return;
      const p = f.properties || {};
      const props = { ...p };
      ["qualityScore", "waveHeightFt", "dominantPeriodS", "windSpeedMph", "tideHeightFt", "windSuitability"].forEach(
        (k) => {
          if (props[k] !== undefined && props[k] !== null && props[k] !== "") {
            const n = Number(props[k]);
            if (!Number.isNaN(n)) props[k] = n;
          }
        }
      );
      tooltip.innerHTML = buildTooltipHtml(props);
      tooltip.style.display = "block";
      tooltip.style.left = `${e.point.x}px`;
      tooltip.style.top = `${e.point.y}px`;
    });

    map.on("click", LAYER_ID, (e) => {
      const f = e.features && e.features[0];
      if (!f) return;
      const coords = f.geometry.coordinates.slice();
      const p = f.properties || {};

      new mapboxgl.Popup({ closeButton: true, maxWidth: "320px" })
        .setLngLat(coords)
        .setHTML(buildPopupHtml(p))
        .addTo(map);
    });

    setInterval(() => {
      loadDataAndRefreshSource().catch(() => {});
    }, 5 * 60 * 1000);
  });
}

main().catch((e) => {
  console.error(e);
  showErrorBanner(`Failed to initialize: ${e?.message || e}`);
});


