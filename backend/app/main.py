from __future__ import annotations

import asyncio
import logging
import os
from datetime import date, datetime, time, timedelta, timezone
from math import isfinite
from pathlib import Path
from statistics import mean
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles


UK_TIMEZONE = ZoneInfo("Europe/London")
ELEXON_API = os.getenv(
    "ELEXON_API_BASE_URL", "https://data.elexon.co.uk/bmrs/api/v1"
).rstrip("/")
APP_ROOT = Path(__file__).resolve().parents[2]
STATIC_ROOT = APP_ROOT / "static"
logger = logging.getLogger(__name__)

app = FastAPI(title="Wind Decision Desk API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["GET"],
    allow_headers=["*"],
)


def parse_datetime(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Elexon timestamps must include a timezone.")
    return parsed.astimezone(timezone.utc)


def records_from_payload(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if isinstance(payload, dict) and isinstance(payload.get("data"), list):
        return [row for row in payload["data"] if isinstance(row, dict)]
    raise HTTPException(
        status_code=502, detail="Elexon returned an unexpected data format."
    )


async def fetch_dataset(path: str, params: dict[str, str]) -> list[dict[str, Any]]:
    url = f"{ELEXON_API}/{path}"
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(url, params=params)
            response.raise_for_status()
            return records_from_payload(response.json())
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Elexon returned HTTP {exc.response.status_code} for {path}.",
        ) from exc
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach the Elexon {path} endpoint.",
        ) from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=502, detail="Elexon returned invalid JSON."
        ) from exc


def utc_query_time(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


def rounded(value: float | None, digits: int = 1) -> float | None:
    return round(value, digits) if value is not None else None


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/dashboard")
async def dashboard(
    delivery_date: date = Query(),
    cutoff_time: time = Query(default=time(10, 0)),
) -> dict[str, Any]:
    if delivery_date.year != 2026 or delivery_date.month != 1:
        raise HTTPException(
            status_code=400, detail="Delivery date must be in January 2026."
        )
    if cutoff_time.tzinfo is not None:
        raise HTTPException(
            status_code=400, detail="Cutoff time must be a UK-local wall-clock time."
        )

    decision_at_local = datetime.combine(delivery_date - timedelta(days=1), cutoff_time)
    decision_at_local = decision_at_local.replace(tzinfo=UK_TIMEZONE)
    delivery_start_local = datetime.combine(delivery_date, time.min).replace(
        tzinfo=UK_TIMEZONE
    )
    delivery_end_local = datetime.combine(
        delivery_date + timedelta(days=1), time.min
    ).replace(tzinfo=UK_TIMEZONE)

    # Include earlier day-ahead vintages; the cutoff below remains authoritative.
    publish_from_local = decision_at_local - timedelta(days=2)
    forecast_records, actual_records = await _fetch_dashboard_data(
        delivery_date,
        publish_from_local,
        decision_at_local,
    )

    forecasts_by_start: dict[datetime, tuple[datetime, float]] = {}
    for row in forecast_records:
        if row.get("generation") is None or not row.get("startTime") or not row.get(
            "publishTime"
        ):
            continue
        try:
            target_time = parse_datetime(str(row["startTime"]))
            publish_time = parse_datetime(str(row["publishTime"]))
            generation = float(row["generation"])
        except (TypeError, ValueError):
            logger.warning("Skipping a WINDFOR record with invalid fields.")
            continue
        if not isfinite(generation):
            logger.warning("Skipping a WINDFOR record with non-finite generation.")
            continue
        if not (delivery_start_local <= target_time < delivery_end_local):
            continue
        if publish_time > decision_at_local.astimezone(timezone.utc):
            continue
        existing = forecasts_by_start.get(target_time)
        if existing is None or publish_time > existing[0]:
            forecasts_by_start[target_time] = (publish_time, generation)

    actuals_by_start: dict[datetime, float] = {}
    for row in actual_records:
        if row.get("generation") is None or not row.get("startTime"):
            continue
        try:
            target_time = parse_datetime(str(row["startTime"]))
            generation = float(row["generation"])
        except (TypeError, ValueError):
            logger.warning("Skipping a FUELHH record with invalid fields.")
            continue
        if not isfinite(generation):
            logger.warning("Skipping a FUELHH record with non-finite generation.")
            continue
        if delivery_start_local <= target_time < delivery_end_local:
            actuals_by_start[target_time] = generation

    interval_times = sorted(set(actuals_by_start) | set(forecasts_by_start))
    points = []
    matched_errors = []
    matched_actual_values = []
    for target_time in interval_times:
        actual = actuals_by_start.get(target_time)
        forecast_entry = forecasts_by_start.get(target_time)
        forecast = forecast_entry[1] if forecast_entry else None
        error = forecast - actual if forecast is not None and actual is not None else None
        if error is not None:
            matched_errors.append(error)
            matched_actual_values.append(actual)
        points.append(
            {
                "start_time": target_time.isoformat(),
                "interval": target_time.astimezone(UK_TIMEZONE).strftime("%H:%M"),
                "forecast_mw": rounded(forecast),
                "actual_mw": rounded(actual),
                "error_mw": rounded(error),
                "publish_time": (
                    forecast_entry[0].isoformat() if forecast_entry else None
                ),
            }
        )

    mae = mean(abs(error) for error in matched_errors) if matched_errors else None
    rmse = (
        (mean(error**2 for error in matched_errors)) ** 0.5
        if matched_errors
        else None
    )
    bias = mean(matched_errors) if matched_errors else None
    nonzero_actual_errors = [
        abs(error / actual) * 100
        for error, actual in zip(matched_errors, matched_actual_values)
        if actual != 0
    ]
    latest_publish = max(
        (item[0] for item in forecasts_by_start.values()), default=None
    )

    return {
        "delivery_date": delivery_date.isoformat(),
        "cutoff_time": cutoff_time.strftime("%H:%M"),
        "decision_at": decision_at_local.isoformat(),
        "latest_publish_time": latest_publish.isoformat() if latest_publish else None,
        "forecast_points": len(forecasts_by_start),
        "actual_points": len(actuals_by_start),
        "matched_points": len(matched_errors),
        "points": points,
        "metrics": {
            "forecast_mean_mw": rounded(
                mean(value for _, value in forecasts_by_start.values())
                if forecasts_by_start
                else None
            ),
            "actual_mean_mw": rounded(
                mean(actuals_by_start.values()) if actuals_by_start else None
            ),
            "mae_mw": rounded(mae),
            "rmse_mw": rounded(rmse),
            "bias_mw": rounded(bias),
            "mape_percent": rounded(
                mean(nonzero_actual_errors) if nonzero_actual_errors else None
            ),
        },
    }


async def _fetch_dashboard_data(
    delivery_date: date,
    publish_from_local: datetime,
    decision_at_local: datetime,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    forecast_task = fetch_dataset(
        "datasets/WINDFOR/stream",
        {
            "publishDateTimeFrom": utc_query_time(publish_from_local),
            "publishDateTimeTo": utc_query_time(decision_at_local),
        },
    )
    actual_task = fetch_dataset(
        "datasets/FUELHH/stream",
        {
            "settlementDateFrom": delivery_date.isoformat(),
            "settlementDateTo": delivery_date.isoformat(),
            "fuelType": "WIND",
        },
    )
    return tuple(await asyncio.gather(forecast_task, actual_task))


if STATIC_ROOT.is_dir():
    app.mount("/assets", StaticFiles(directory=STATIC_ROOT / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def frontend(full_path: str) -> FileResponse:
        requested = (STATIC_ROOT / full_path).resolve()
        if requested.is_relative_to(STATIC_ROOT.resolve()) and requested.is_file():
            return FileResponse(requested)
        return FileResponse(STATIC_ROOT / "index.html")
