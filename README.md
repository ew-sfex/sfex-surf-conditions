# SF Examiner Surf Conditions Map

Static, embeddable surf-conditions map for the San Francisco coastline + Marin, powered by **public NOAA data** and deployed on **GitHub Pages**.

## Live site
- GitHub Pages: `https://ew-sfex.github.io/sfex-surf-conditions/`

## How it works
- **Hourly GitHub Action** runs the Python ETL (`scripts/fetch_and_build.py`) to fetch NOAA data and generate `site/data/*`.
- The same workflow injects the Mapbox token into `site/config.js` and deploys `site/` to GitHub Pages.
- The frontend (`site/`) loads the latest `site/data/beaches.geojson` and renders points + popups.

## Data sources
- **NOAA NDBC** (waves + wind): real-time buoy observations from `realtime2/{station}.txt`
  - Fields used when available: `WVHT` (m), `DPD` (s), `MWD` (deg), `WSPD` (m/s), `WDIR` (deg)
- **NOAA CO-OPS** (tides): tide predictions via `api/prod/datagetter`

## Setup (one-time)
### 1) Mapbox token
Add a GitHub Actions secret:
- **Name**: `MAPBOX_PUBLIC_TOKEN`
- **Where**: Repo → Settings → Secrets and variables → Actions → New repository secret

The workflow injects it into `site/config.js` at deploy time. The token is **not** committed to the repo.

### 2) GitHub Pages
Repo → Settings → Pages:
- **Source**: GitHub Actions

## Editing surf locations
Edit `data/locations.csv` (this is the curated “source of truth” for points).
- Columns include lat/lon, basic exposure, and which NOAA stations to use.

## Local preview
This repo deploys via GitHub Actions, but you can still preview the UI locally:

```bash
python3 -m http.server --directory site 8000
```

Open `http://localhost:8000`.

## Embed (SF Examiner CMS)

```html
<iframe
  src="https://ew-sfex.github.io/sfex-surf-conditions/"
  title="SF + Marin surf conditions map"
  style="width:100%; height:700px; border:0;"
  loading="lazy"
></iframe>
```

## Troubleshooting
- **Blank basemap**: Mapbox token restrictions likely block `ew-sfex.github.io`.
- **Stale numbers**: wait for the next hourly action or manually run “Update surf data” in Actions.


