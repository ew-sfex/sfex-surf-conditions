// Mapbox token is injected at deploy time into site/config.js as:
//   window.SFEX_SURF_MAPBOX_TOKEN = "pk...."
// This keeps the token out of the git repo while still allowing a static site.
const MAPBOX_TOKEN = window.SFEX_SURF_MAPBOX_TOKEN || "";

const DATA_GEOJSON_URL = "./data/beaches.geojson";
const DATA_SUMMARY_URL = "./data/summary.json";

const SOURCE_ID = "beaches";
const LAYER_ID = "beach-points";

const METRIC_STYLES = {
  qualityScore: {
    stops: [35, 55, 75],
    colors: ["#e2554f", "#f0c24b", "#2fb95c", "#1bb7a6"],
    defaultValue: 0,
    legend: {
      title: "Quality score (0-100)",
      note: "Blend of swell (50), wind (30), and tide (20).",
      items: [
        { label: "Poor (0-35)", color: "#e2554f" },
        { label: "Fair (35-55)", color: "#f0c24b" },
        { label: "Good (55-75)", color: "#2fb95c" },
        { label: "Great (75+)", color: "#1bb7a6" },
      ],
    },
  },
  waveHeightFt: {
    stops: [1, 3, 5, 8, 12],
    colors: ["#5b2b7a", "#2f4ba0", "#1e88a8", "#2fb95c", "#f0c24b", "#e2554f"],
    defaultValue: 0,
    legend: {
      title: "Wave height (ft)",
      items: [
        { label: "< 1 ft", color: "#5b2b7a" },
        { label: "1-3 ft", color: "#2f4ba0" },
        { label: "3-5 ft", color: "#1e88a8" },
        { label: "5-8 ft", color: "#2fb95c" },
        { label: "8-12 ft", color: "#f0c24b" },
        { label: "12+ ft", color: "#e2554f" },
      ],
    },
  },
  windSuitability: {
    stops: [0.2, 0.5, 0.8],
    colors: ["#e2554f", "#f0c24b", "#2fb95c", "#1bb7a6"],
    defaultValue: 0.5,
    legend: {
      title: "Wind suitability",
      note: "1 = light offshore, 0 = strong onshore.",
      items: [
        { label: "Poor (0-0.2)", color: "#e2554f" },
        { label: "OK (0.2-0.5)", color: "#f0c24b" },
        { label: "Good (0.5-0.8)", color: "#2fb95c" },
        { label: "Great (0.8+)", color: "#1bb7a6" },
      ],
    },
  },
  tideHeightFt: {
    stops: [1, 3, 5, 7],
    colors: ["#2f4ba0", "#1e88a8", "#2fb95c", "#f0c24b", "#e2554f"],
    defaultValue: 0,
    legend: {
      title: "Tide height (ft)",
      items: [
        { label: "< 1 ft", color: "#2f4ba0" },
        { label: "1-3 ft", color: "#1e88a8" },
        { label: "3-5 ft", color: "#2fb95c" },
        { label: "5-7 ft", color: "#f0c24b" },
        { label: "7+ ft", color: "#e2554f" },
      ],
    },
  },
};

function $(id) {
  return document.getElementById(id);
}

function fmtMaybe(v, suffix = "") {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${v}${suffix}`;
}

function qualityColorExpression(metric) {
  const m = metric || "qualityScore";
  const style = METRIC_STYLES[m] || METRIC_STYLES.qualityScore;
  const expr = ["step", ["coalesce", ["get", m], style.defaultValue], style.colors[0]];
  style.stops.forEach((stop, idx) => {
    expr.push(stop, style.colors[idx + 1]);
  });
  return expr;
}

function renderLegend(metric) {
  const legendEl = document.getElementById("legend");
  if (!legendEl) return;
  const m = metric || "qualityScore";
  const style = METRIC_STYLES[m] || METRIC_STYLES.qualityScore;
  const title = style.legend?.title || "Legend";
  const note = style.legend?.note;
  const items = style.legend?.items || [];

  const rows = items
    .map(
      (item) => `
        <div class="legend-item">
          <span class="legend-swatch" style="background:${item.color};"></span>
          <span class="legend-label">${item.label}</span>
        </div>
      `
    )
    .join("");

  legendEl.innerHTML = `
    <div class="legend-title">${title}</div>
    ${note ? `<div class="legend-note">${note}</div>` : ""}
    <div class="legend-items">${rows}</div>
  `;
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
  // Mapbox flattens properties; nested objects are unreliable. Use a flattened field.
  const windSrc = p?.windSource || "—";

  return `
    <div class="popup">
      <div class="popup-title">${p.name || "Unknown"}</div>
      ${p.region ? `<div class="popup-subtitle">${p.region}</div>` : ""}

      <div class="popup-section">
        <div class="popup-section-title">Quality</div>
        <div class="popup-row"><span>Score</span><span>${fmtMaybe(p.qualityScore)} / 100</span></div>
      </div>

      <div class="popup-section">
        <div class="popup-section-title">Waves</div>
        <div class="popup-row"><span>Height</span><span>${fmtMaybe(p.waveHeightFt, " ft")}</span></div>
        <div class="popup-row"><span>Period</span><span>${fmtMaybe(p.dominantPeriodS, " s")}</span></div>
        <div class="popup-row"><span>Direction</span><span>${fmtMaybe(p.waveDirectionDeg, "°")}</span></div>
      </div>

      <div class="popup-section">
        <div class="popup-section-title">Wind</div>
        <div class="popup-row"><span>Speed</span><span>${fmtMaybe(p.windSpeedMph, " mph")}</span></div>
        <div class="popup-row"><span>Direction</span><span>${fmtMaybe(p.windDirectionDeg, "°")}</span></div>
      </div>

      <div class="popup-section">
        <div class="popup-section-title">Tide</div>
        <div class="popup-row">
          <span>Height</span>
          <span>${fmtMaybe(p.tideHeightFt, " ft")} ${p.tideTrend ? `(${p.tideTrend})` : ""}</span>
        </div>
      </div>

      <div class="popup-section popup-section-meta">
        <div class="popup-section-title">Sources</div>
        <div class="popup-row"><span>NDBC buoy</span><span>${ndbc}</span></div>
        <div class="popup-row"><span>Tide station</span><span>${tide}</span></div>
        <div class="popup-row"><span>Wind source</span><span>${windSrc}</span></div>
        <div class="popup-row">
          <span>Generated</span>
          <span>${p?.timestamps?.generatedAt ? new Date(p.timestamps.generatedAt).toUTCString() : "—"}</span>
        </div>
        <div class="popup-row">
          <span>Buoy obs</span>
          <span>${p?.timestamps?.ndbcObservedAt ? new Date(p.timestamps.ndbcObservedAt).toUTCString() : "—"}</span>
        </div>
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

function computeFeatureBounds(featureCollection) {
  const b = new mapboxgl.LngLatBounds();
  const feats = (featureCollection && featureCollection.features) || [];
  for (const f of feats) {
    const c = f?.geometry?.coordinates;
    if (!c || c.length < 2) continue;
    b.extend(c);
  }
  return b;
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
  renderLegend(metricSelect?.value);

  let beachesGeojson = null;
  let activePopup = null;
  let activePopupLocationId = null;

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

    // Initial framing: fit all points on load (including the southern extent).
    const fb = computeFeatureBounds(beachesGeojson);
    if (!fb.isEmpty()) {
      map.fitBounds(fb, { padding: 40, duration: 0, maxZoom: 10.2 });
    } else {
      map.jumpTo({ center: [-122.46, 37.80], zoom: 10.1 });
    }
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

    metricSelect.addEventListener("change", () => {
      applyMetricStyle(metricSelect.value);
      renderLegend(metricSelect.value);
    });

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
      if (activePopupLocationId && p?.id && activePopupLocationId === p.id) {
        tooltip.style.display = "none";
        return;
      }
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

      if (activePopup) {
        activePopup.remove();
        activePopup = null;
      }
      activePopupLocationId = p?.id || null;
      tooltip.style.display = "none";

      activePopup = new mapboxgl.Popup({ closeButton: true, maxWidth: "320px" })
        .setLngLat(coords)
        .setHTML(buildPopupHtml(p))
        .addTo(map);

      activePopup.on("close", () => {
        activePopupLocationId = null;
        activePopup = null;
      });
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


