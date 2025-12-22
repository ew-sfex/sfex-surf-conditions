# SF Examiner Surf Conditions Map

Static Mapbox interactive hosted on GitHub Pages, with **hourly data updates** via GitHub Actions.

## What this repo does
- GitHub Actions runs an hourly Python job to fetch public data and build:
  - `site/data/beaches.geojson` (one feature per beach/spot with metrics + score)
  - `site/data/summary.json` (update timestamp + source health)
- GitHub Actions deploys the static site from `site/` to GitHub Pages.

## Data sources (v1: free/public)
- **NOAA NDBC** (waves + wind): we use the station real-time text feed:
  - Pattern: `https://www.ndbc.noaa.gov/data/realtime2/{station}.txt`
  - We parse fields commonly present on wave-capable buoys:
    - `WVHT` (m), `DPD` (s), `MWD` (deg), `WSPD` (m/s), `WDIR` (deg)
- **NOAA CO-OPS Tides & Currents** (tide curve / stage):
  - Base: `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter`
  - We request tide predictions in a small window around “now” and estimate rising/falling.

Attribution requirements vary; the UI should include an attribution line (NOAA, etc.).

## Configuration
### Mapbox token
No token is committed in source code.\n+\n+Add a GitHub Actions secret named `MAPBOX_PUBLIC_TOKEN` (repo → Settings → Secrets and variables → Actions), and the deploy workflow injects it into `site/config.js` at build time.

### Locations list
Edit `data/locations.csv` to add/remove surf spots, set their exposures, and (optionally) map them to sensors.

## Local preview
You can serve the `site/` folder locally:

```bash
python3 -m http.server --directory site 8000
```

Then open `http://localhost:8000`.

## GitHub Pages
Configure GitHub Pages to use **GitHub Actions** as the source (repo → Settings → Pages → Source: GitHub Actions).

## Embed snippet (SF Examiner CMS)
Once GitHub Pages is enabled, embed the interactive with an iframe. Example (adjust height as needed):

```html
<iframe
  src="YOUR_GITHUB_PAGES_URL_HERE"
  title="SF + Marin surf conditions map"
  style="width:100%; height:700px; border:0;"
  loading="lazy"
></iframe>
```

If your CMS allows responsive resizing, prefer using a wrapper with `min-height` and `height: 70vh` for better mobile behavior.


