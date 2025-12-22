# SF Examiner Surf Conditions Map

This repository powers an embeddable surf-conditions map for **San Francisco + Marin**. It’s designed for newsroom publishing: a single static URL (GitHub Pages) that editors can drop into a story as an iframe.

The map renders a curated set of beach/spot points and colors them by a simple “quality score.” Each point exposes a popup with the underlying metrics (waves, wind, tide) plus timestamps so readers can see when the numbers were last updated.

Data comes from public sources (primarily NOAA buoy observations for waves and NOAA tide predictions). Updates are generated automatically on a schedule via GitHub Actions and deployed to GitHub Pages.

Because this is a regional model, some nearby spots can share the same underlying sensor readings at a given moment; the intent is to provide a consistent, explainable snapshot of conditions, not a hyper-local nowcast at every break.


