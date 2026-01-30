#!/usr/bin/env python3

from __future__ import annotations

import csv
import json
import math
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

import requests

NDBC_REALTIME2_BASE = "https://www.ndbc.noaa.gov/data/realtime2"
COOPS_DATAGETTER = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
OPEN_METEO = "https://api.open-meteo.com/v1/forecast"

APP_ID = "sfexaminer-surf-conditions"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def safe_float(v: str) -> Optional[float]:
    v = (v or "").strip()
    if v in ("", "MM"):
        return None
    try:
        return float(v)
    except ValueError:
        return None


def deg_diff(a: float, b: float) -> float:
    """Smallest absolute difference between bearings in degrees."""
    d = (a - b) % 360.0
    if d > 180.0:
        d -= 360.0
    return abs(d)


def m_to_ft(m: float) -> float:
    return m * 3.28084


def ms_to_mph(ms: float) -> float:
    return ms * 2.2369362920544


@dataclass(frozen=True)
class LocationRow:
    id: str
    name: str
    region: str
    lat: float
    lon: float
    primary_exposure: str
    offshore_wind_dir_deg: float
    tide_station: str
    ndbc_station: str
    notes: str


def read_locations_csv(path: str) -> List[LocationRow]:
    out: List[LocationRow] = []
    with open(path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for r in reader:
            out.append(
                LocationRow(
                    id=r["id"].strip(),
                    name=r["name"].strip(),
                    region=(r.get("region") or "").strip(),
                    lat=float(r["lat"]),
                    lon=float(r["lon"]),
                    primary_exposure=(r.get("primary_exposure") or "").strip(),
                    offshore_wind_dir_deg=float(r.get("offshore_wind_dir_deg") or 0.0),
                    tide_station=(r.get("tide_station") or "").strip(),
                    ndbc_station=(r.get("ndbc_station") or "").strip(),
                    notes=(r.get("notes") or "").strip(),
                )
            )
    return out


def fetch_text(url: str, timeout_s: int = 20) -> str:
    resp = requests.get(url, timeout=timeout_s, headers={"User-Agent": APP_ID})
    resp.raise_for_status()
    return resp.text


def fetch_open_meteo_wind_current(locations: List[LocationRow]) -> Tuple[Dict[str, Dict[str, Any]], Optional[str]]:
    """
    Fetch per-location wind using Open-Meteo (no key). This helps avoid "every beach has identical wind"
    when many points share the same offshore buoy.
    Returns mapping: location_id -> { windSpeedMph, windDirectionDeg, observedAt }
    """
    if not locations:
        return {}, None

    # Prefer a single multi-location request (fewer chances to hit timeouts).
    lats = ",".join([f"{l.lat:.6f}" for l in locations])
    lons = ",".join([f"{l.lon:.6f}" for l in locations])

    params = {
        "latitude": lats,
        "longitude": lons,
        "current_weather": "true",
        "windspeed_unit": "mph",
        "timezone": "UTC",
    }

    def do_request(timeout_s: int) -> Any:
        resp = requests.get(
            OPEN_METEO,
            params=params,
            timeout=timeout_s,
            headers={"User-Agent": APP_ID},
        )
        resp.raise_for_status()
        return resp.json()

    try:
        # Best-effort retries with shorter timeouts.
        last_err: Optional[Exception] = None
        payload: Any = None
        for timeout_s in (8, 12, 18):
            try:
                payload = do_request(timeout_s)
                last_err = None
                break
            except Exception as e:
                last_err = e
                payload = None
                continue

        if payload is None:
            raise last_err or RuntimeError("unknown_error")

        # Open-Meteo multi-location response returns a list of per-location objects.
        if isinstance(payload, dict):
            payload_list = [payload]
        elif isinstance(payload, list):
            payload_list = payload
        else:
            payload_list = []

        out: Dict[str, Dict[str, Any]] = {}
        for loc, obj in zip(locations, payload_list):
            if not isinstance(obj, dict):
                continue
            cur = obj.get("current_weather") or {}
            if not isinstance(cur, dict):
                continue
            ws = cur.get("windspeed")
            wd = cur.get("winddirection")
            t = cur.get("time")
            if ws is None or wd is None:
                continue
            out[loc.id] = {
                "windSpeedMph": float(ws),
                "windDirectionDeg": float(wd),
                "observedAt": t,
            }
        return out, None
    except Exception as e:
        return {}, f"open_meteo_error:{type(e).__name__}:{e}"


def parse_ndbc_realtime2_station(txt: str) -> Dict[str, Any]:
    """
    Parses NDBC realtime2 station text format:
    - Header lines begin with '#'
    - First non-header line after columns is latest observation
    """
    lines = [ln.strip() for ln in txt.splitlines() if ln.strip()]
    header_line = None
    data_line = None

    for ln in lines:
        if ln.startswith("#"):
            # The second header line typically contains column names.
            # Example: "#YY  MM DD hh mm WDIR WSPD GST ... WVHT DPD ... MWD"
            if "YY" in ln and "MM" in ln and "DD" in ln and "hh" in ln:
                header_line = ln.lstrip("#").strip()
        else:
            if header_line and data_line is None:
                data_line = ln
                break

    if not header_line or not data_line:
        raise ValueError("Unable to parse NDBC realtime2 format (missing header/data)")

    cols = header_line.split()
    vals = data_line.split()
    if len(vals) < len(cols):
        # Some feeds can have fewer trailing columns; pad with empty
        vals = vals + [""] * (len(cols) - len(vals))

    row = dict(zip(cols, vals))

    yy = int(row["YY"])
    mm = int(row["MM"])
    dd = int(row["DD"])
    hh = int(row["hh"])
    minute = int(row.get("mm", "0"))
    obs_time = datetime(yy, mm, dd, hh, minute, tzinfo=timezone.utc)

    return {
        "obs_time": obs_time,
        "WVHT_m": safe_float(row.get("WVHT", "")),
        "DPD_s": safe_float(row.get("DPD", "")),
        "MWD_deg": safe_float(row.get("MWD", "")),
        "WSPD_ms": safe_float(row.get("WSPD", "")),
        "WDIR_deg": safe_float(row.get("WDIR", "")),
        "raw": row,
    }


def fetch_ndbc_station_latest(station_id: str) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    if not station_id:
        return None, "no_station"
    url = f"{NDBC_REALTIME2_BASE}/{station_id}.txt"
    try:
        txt = fetch_text(url)
        parsed = parse_ndbc_realtime2_station(txt)
        return parsed, None
    except Exception as e:
        return None, f"ndbc_error:{type(e).__name__}:{e}"


def fetch_coops_predictions_series(
    station_id: str, begin: datetime, end: datetime
) -> Tuple[Optional[List[Tuple[datetime, float]]], Optional[str]]:
    """
    Fetch a tide prediction time series from CO-OPS.
    We try a few intervals to be robust.
    Returns list of (time_utc, height_ft).
    """
    if not station_id:
        return None, "no_station"

    def try_interval(interval: str) -> Optional[List[Tuple[datetime, float]]]:
        params = {
            "product": "predictions",
            "application": APP_ID,
            "begin_date": begin.strftime("%Y%m%d %H:%M"),
            "end_date": end.strftime("%Y%m%d %H:%M"),
            "datum": "MLLW",
            "station": station_id,
            "time_zone": "gmt",
            "units": "english",
            "interval": interval,
            "format": "json",
        }
        resp = requests.get(COOPS_DATAGETTER, params=params, timeout=20, headers={"User-Agent": APP_ID})
        resp.raise_for_status()
        payload = resp.json()
        preds = payload.get("predictions") or []
        out: List[Tuple[datetime, float]] = []
        for p in preds:
            t = datetime.strptime(p["t"], "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)
            v = float(p["v"])
            out.append((t, v))
        if not out:
            return None
        return out

    try:
        for interval in ("6", "30", "60"):
            series = try_interval(interval)
            if series:
                return series, None
        return None, "coops_no_predictions"
    except Exception as e:
        return None, f"coops_error:{type(e).__name__}:{e}"


def tide_now_and_trend(series: List[Tuple[datetime, float]], now: datetime) -> Tuple[Optional[float], Optional[str]]:
    if not series:
        return None, None
    # Find closest points around now
    series_sorted = sorted(series, key=lambda x: x[0])
    # Find index of last time <= now
    idx = None
    for i, (t, _) in enumerate(series_sorted):
        if t <= now:
            idx = i
        else:
            break
    if idx is None:
        # now is before first point
        h = series_sorted[0][1]
        return h, None
    h0 = series_sorted[idx][1]
    # Trend: compare to a point ahead (~1 hour if possible)
    look_ahead = now + timedelta(hours=1)
    future = None
    for t, h in series_sorted[idx:]:
        if t >= look_ahead:
            future = h
            break
    if future is None and idx + 1 < len(series_sorted):
        future = series_sorted[idx + 1][1]
    trend = None
    if future is not None:
        if future > h0:
            trend = "rising"
        elif future < h0:
            trend = "falling"
        else:
            trend = "steady"
    return h0, trend


def wind_suitability_score(offshore_dir_deg: float, wind_dir_from_deg: Optional[float], wind_speed_mph: Optional[float]) -> float:
    """
    Returns 0..1 score where 1 is best (light offshore), 0 is worst (strong onshore).
    wind_dir_from_deg: meteorological wind direction (FROM).
    """
    if wind_dir_from_deg is None or wind_speed_mph is None or offshore_dir_deg == 0:
        return 0.5  # unknown => neutral

    angle = deg_diff(wind_dir_from_deg, offshore_dir_deg)
    # Direction factor: offshore within 45°, cross within 90°, onshore beyond 135°
    if angle <= 45:
        dir_factor = 1.0
    elif angle <= 90:
        dir_factor = lerp(1.0, 0.6, (angle - 45) / 45)
    elif angle <= 135:
        dir_factor = lerp(0.6, 0.2, (angle - 90) / 45)
    else:
        dir_factor = lerp(0.2, 0.0, (angle - 135) / 45)

    # Speed factor: penalize above ~12 mph
    sp = wind_speed_mph
    if sp <= 5:
        speed_factor = 1.0
    elif sp <= 12:
        speed_factor = lerp(1.0, 0.6, (sp - 5) / 7)
    elif sp <= 20:
        speed_factor = lerp(0.6, 0.2, (sp - 12) / 8)
    else:
        speed_factor = 0.0

    return clamp(dir_factor * speed_factor, 0.0, 1.0)


def swell_score(wave_height_ft: Optional[float], period_s: Optional[float]) -> float:
    """
    0..50: combine size + period, clamped.
    """
    if wave_height_ft is None and period_s is None:
        return 0.0
    h = wave_height_ft or 0.0
    p = period_s or 0.0
    # Typical ranges: 0..15ft, 5..18s
    h_norm = clamp(h / 12.0, 0.0, 1.0)  # 12ft ~ max for score scaling
    p_norm = clamp((p - 6.0) / 10.0, 0.0, 1.0)
    combined = 0.6 * h_norm + 0.4 * p_norm
    return 50.0 * clamp(combined, 0.0, 1.0)


def tide_score(height_ft: Optional[float]) -> float:
    """
    0..20: default preference around mid tides (~2-5 ft MLLW, loosely).
    """
    if height_ft is None:
        return 10.0  # unknown => neutral
    # Score highest around 3.5ft, lower when very low or very high
    center = 3.5
    spread = 3.0
    z = abs(height_ft - center) / spread
    return 20.0 * clamp(1.0 - z, 0.0, 1.0)


def build_feature(
    loc: LocationRow,
    now: datetime,
    ndbc: Optional[Dict[str, Any]],
    tide_height_ft: Optional[float],
    tide_trend: Optional[str],
) -> Dict[str, Any]:
    wave_height_ft = None
    period_s = None
    wave_dir_deg = None
    wind_speed_mph = None
    wind_dir_deg = None
    obs_time = None

    if ndbc:
        obs_time = ndbc["obs_time"].isoformat()
        if ndbc.get("WVHT_m") is not None:
            wave_height_ft = m_to_ft(float(ndbc["WVHT_m"]))
        if ndbc.get("DPD_s") is not None:
            period_s = float(ndbc["DPD_s"])
        if ndbc.get("MWD_deg") is not None:
            wave_dir_deg = float(ndbc["MWD_deg"])
        if ndbc.get("WSPD_ms") is not None:
            wind_speed_mph = ms_to_mph(float(ndbc["WSPD_ms"]))
        if ndbc.get("WDIR_deg") is not None:
            wind_dir_deg = float(ndbc["WDIR_deg"])

    swell = swell_score(wave_height_ft, period_s)
    wind_suit = wind_suitability_score(loc.offshore_wind_dir_deg, wind_dir_deg, wind_speed_mph)
    wind = 30.0 * wind_suit
    tide = tide_score(tide_height_ft)
    quality = clamp(swell + wind + tide, 0.0, 100.0)

    props: Dict[str, Any] = {
        "id": loc.id,
        "name": loc.name,
        "region": loc.region,
        "primaryExposure": loc.primary_exposure,
        # Flattened properties (Mapbox expressions can't access nested objects reliably)
        "qualityScore": round(quality, 1),
        "ndbcStation": loc.ndbc_station or None,
        "tideStation": loc.tide_station or None,
        "swellScore": round(swell, 1),
        "windScore": round(wind, 1),
        "tideScore": round(tide, 1),
        "windSuitability": round(wind_suit, 3),
        "waveHeightFt": None if wave_height_ft is None else round(wave_height_ft, 2),
        "dominantPeriodS": None if period_s is None else round(period_s, 1),
        "waveDirectionDeg": None if wave_dir_deg is None else round(wave_dir_deg, 0),
        "windSpeedMph": None if wind_speed_mph is None else round(wind_speed_mph, 1),
        "windDirectionDeg": None if wind_dir_deg is None else round(wind_dir_deg, 0),
        "tideHeightFt": None if tide_height_ft is None else round(tide_height_ft, 2),
        "tideTrend": tide_trend,
        "components": {
            "swell": round(swell, 1),
            "wind": round(wind, 1),
            "tide": round(tide, 1),
        },
        "metrics": {
            "waveHeightFt": None if wave_height_ft is None else round(wave_height_ft, 2),
            "dominantPeriodS": None if period_s is None else round(period_s, 1),
            "waveDirectionDeg": None if wave_dir_deg is None else round(wave_dir_deg, 0),
            "windSpeedMph": None if wind_speed_mph is None else round(wind_speed_mph, 1),
            "windDirectionDeg": None if wind_dir_deg is None else round(wind_dir_deg, 0),
            "tideHeightFt": None if tide_height_ft is None else round(tide_height_ft, 2),
            "tideTrend": tide_trend,
        },
        "sources": {
            "ndbcStation": loc.ndbc_station or None,
            "tideStation": loc.tide_station or None,
        },
        "timestamps": {
            "generatedAt": now.isoformat(),
            "ndbcObservedAt": obs_time,
        },
        "notes": loc.notes or None,
    }

    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [loc.lon, loc.lat]},
        "properties": props,
    }


def ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def main() -> int:
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    locations_path = os.path.join(repo_root, "data", "locations.csv")
    # Site output folder used by the GitHub Pages deploy workflow.
    out_dir = os.path.join(repo_root, "site", "data")
    ensure_dir(out_dir)

    now = utc_now()
    locations = read_locations_csv(locations_path)

    # Per-location wind (Open-Meteo). Used to reduce identical wind across many beaches sharing a buoy.
    open_meteo_wind, open_meteo_err = fetch_open_meteo_wind_current(locations)

    ndbc_station_ids = sorted({l.ndbc_station for l in locations if l.ndbc_station})
    tide_station_ids = sorted({l.tide_station for l in locations if l.tide_station})

    ndbc_data: Dict[str, Dict[str, Any]] = {}
    ndbc_errors: Dict[str, str] = {}
    for sid in ndbc_station_ids:
        parsed, err = fetch_ndbc_station_latest(sid)
        if parsed:
            ndbc_data[sid] = parsed
        else:
            ndbc_errors[sid] = err or "unknown_error"

    tide_data: Dict[str, Tuple[Optional[float], Optional[str], Optional[str]]] = {}
    tide_errors: Dict[str, str] = {}
    begin = now - timedelta(hours=6)
    end = now + timedelta(hours=6)
    for tsid in tide_station_ids:
        series, err = fetch_coops_predictions_series(tsid, begin, end)
        if series:
            h, trend = tide_now_and_trend(series, now)
            tide_data[tsid] = (h, trend, None)
        else:
            tide_errors[tsid] = err or "unknown_error"
            tide_data[tsid] = (None, None, err or "unknown_error")

    features: List[Dict[str, Any]] = []
    for loc in locations:
        ndbc = ndbc_data.get(loc.ndbc_station) if loc.ndbc_station else None
        tide_height_ft, tide_trend, _ = tide_data.get(loc.tide_station, (None, None, None))
        feat = build_feature(loc, now, ndbc, tide_height_ft, tide_trend)

        # Override wind fields if Open-Meteo wind is available for this point.
        ow = open_meteo_wind.get(loc.id)
        if ow:
            feat["properties"]["windSpeedMph"] = round(float(ow["windSpeedMph"]), 1)
            feat["properties"]["windDirectionDeg"] = round(float(ow["windDirectionDeg"]), 0)
            feat["properties"]["metrics"]["windSpeedMph"] = round(float(ow["windSpeedMph"]), 1)
            feat["properties"]["metrics"]["windDirectionDeg"] = round(float(ow["windDirectionDeg"]), 0)
            feat["properties"]["timestamps"]["openMeteoWindObservedAt"] = ow.get("observedAt")
            feat["properties"]["sources"]["wind"] = "open-meteo"
            feat["properties"]["windSource"] = "open-meteo"
        else:
            feat["properties"]["sources"]["wind"] = "ndbc"
            feat["properties"]["windSource"] = "ndbc"

        # Recompute wind suitability + total score if wind changed.
        ws = feat["properties"].get("windSpeedMph")
        wd = feat["properties"].get("windDirectionDeg")
        wind_suit = wind_suitability_score(loc.offshore_wind_dir_deg, wd if isinstance(wd, (int, float)) else None, ws if isinstance(ws, (int, float)) else None)
        feat["properties"]["windSuitability"] = round(wind_suit, 3)
        wind_component = 30.0 * wind_suit
        feat["properties"]["windScore"] = round(wind_component, 1)
        feat["properties"]["components"]["wind"] = round(wind_component, 1)
        # Keep swell/tide from existing computed values
        swell_component = float(feat["properties"]["components"]["swell"])
        tide_component = float(feat["properties"]["components"]["tide"])
        feat["properties"]["qualityScore"] = round(clamp(swell_component + wind_component + tide_component, 0.0, 100.0), 1)

        features.append(feat)

    fc = {"type": "FeatureCollection", "features": features}

    beaches_geojson_path = os.path.join(out_dir, "beaches.geojson")
    summary_path = os.path.join(out_dir, "summary.json")
    history_path = os.path.join(out_dir, "history_72h.json")

    with open(beaches_geojson_path, "w", encoding="utf-8") as f:
        json.dump(fc, f, ensure_ascii=False, separators=(",", ":"))

    summary = {
        "generatedAt": now.isoformat(),
        "sources": {
            "ndbc": {
                "base": NDBC_REALTIME2_BASE,
                "stationsRequested": ndbc_station_ids,
                "stationsOK": sorted(list(ndbc_data.keys())),
                "stationsError": ndbc_errors,
            },
            "coops": {
                "base": COOPS_DATAGETTER,
                "stationsRequested": tide_station_ids,
                "stationsError": tide_errors,
            },
            "open_meteo": {
                "base": OPEN_METEO,
                "ok": open_meteo_err is None,
                "error": open_meteo_err,
            },
        },
    }
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    # Maintain a rolling 72-hour history for lightweight charting.
    history_cutoff = now - timedelta(hours=72)
    history: List[Dict[str, Any]] = []
    if os.path.exists(history_path):
        try:
            with open(history_path, "r", encoding="utf-8") as f:
                history = json.load(f) or []
        except Exception:
            history = []

    def parse_ts(ts: str) -> Optional[datetime]:
        try:
            parsed = datetime.fromisoformat(ts)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed
        except Exception:
            return None

    history = [
        entry
        for entry in history
        if isinstance(entry, dict)
        and isinstance(entry.get("generatedAt"), str)
        and (parse_ts(entry["generatedAt"]) or history_cutoff) >= history_cutoff
    ]

    history.append(
        {
            "generatedAt": now.isoformat(),
            "points": [
                {
                    "id": f["properties"].get("id"),
                    "qualityScore": f["properties"].get("qualityScore"),
                    "waveHeightFt": f["properties"].get("waveHeightFt"),
                    "dominantPeriodS": f["properties"].get("dominantPeriodS"),
                    "windSpeedMph": f["properties"].get("windSpeedMph"),
                    "windDirectionDeg": f["properties"].get("windDirectionDeg"),
                    "tideHeightFt": f["properties"].get("tideHeightFt"),
                    "tideTrend": f["properties"].get("tideTrend"),
                }
                for f in features
            ],
        }
    )

    with open(history_path, "w", encoding="utf-8") as f:
        json.dump(history, f, ensure_ascii=False, separators=(",", ":"))

    print(f"Wrote {beaches_geojson_path}")
    print(f"Wrote {summary_path}")
    if ndbc_errors and len(ndbc_data) == 0:
        # Hard fail only if *all* buoy data failed (map still works, but surf metrics are dead)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


