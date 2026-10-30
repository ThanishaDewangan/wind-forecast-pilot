# Wind Decision Desk

A pilot dashboard for reviewing Great Britain wind generation forecasts and comparing the forecast available at a day-ahead decision cutoff with Elexon outturns. The data scope is January 2026 and the Elexon BMRS `WINDFOR` and `FUELHH` datasets only.

## What it does

- Select a January 2026 delivery date and a UK local decision cutoff (default 10:00).
- Select the latest wind forecast published at or before that cutoff for each delivery interval.
- Compare forecasts to actual wind generation and calculate MAE, RMSE, mean bias, and MAPE on exact timestamp matches; the average generation KPIs use all available values for each series.
- Show data coverage and the publication time of the selected forecast for each interval.

The cutoff is an explicit pilot assumption because the product brief does not set a trading-team decision time. It can be changed in the interface. The backend requests a 48-hour forecast-publication lookback and then selects the newest eligible forecast for each interval at or before the cutoff. Forecast points without an exact matching actual timestamp are not used in error metrics; no interpolation or synthetic data is used.

This pilot is intentionally wind-only. It does not calculate the net amount the utility must procure because consumer-demand data is outside the agreed Elexon-only data scope.

## Start the application

### Docker (recommended)

From the repository root:

```powershell
docker compose up --build
```

Open [http://localhost:8000](http://localhost:8000). Docker builds the React app and serves it with the Python API in one container. The application fetches live historical data from Elexon when a delivery date is requested; internet access is required.

### Local development

Requires Node.js 20+ and Python 3.11+.

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r backend\requirements.txt
uvicorn backend.app.main:app --reload --port 8000
```

In another terminal:

```powershell
cd frontend
npm install
npm run dev
```

Open the Vite URL (normally [http://localhost:5173](http://localhost:5173)). Vite proxies `/api` requests to `http://localhost:8000`.

## API

- `GET /api/health` — service health
- `GET /api/dashboard?delivery_date=2026-01-15&cutoff_time=10:00` — actuals, as-of forecast, and accuracy metrics

The backend queries Elexon `FUELHH` for `fuelType=WIND` and `WINDFOR` for forecast publish times, then filters forecast vintages against the selected UK-local cutoff. Errors from the upstream API are returned as explicit API errors rather than being replaced with sample values.

## Architecture

The React/Vite dashboard calls the FastAPI `/api/dashboard` route. FastAPI requests forecast vintages and wind outturn from Elexon in parallel, applies the UK-local cutoff per delivery interval, joins by exact `startTime`, and returns both series and accuracy metrics. The multi-stage Docker image builds the frontend once and serves its static assets and API from the same Python process.

## Tests

```powershell
python -m unittest discover -s backend\tests -v
cd frontend
npm run build
npm audit
```

## Repository layout

| Path | Purpose |
|---|---|
| `README.md` | Setup, architecture, deployment, data, metric, and video handoff notes |
| `.gitignore` | Excludes local environments, dependencies, and generated build output from Git |
| `.dockerignore` | Excludes local dependencies and build output from the Docker context |
| `backend/app/__init__.py` | Python package marker |
| `backend/app/main.py` | FastAPI routes, Elexon client calls, forecast-vintage selection, and metrics |
| `backend/tests/test_dashboard.py` | Tests for as-of vintage selection, accuracy metrics, and date scope |
| `backend/requirements.txt` | Python dependencies |
| `frontend/src/` | React dashboard and global/component styles |
| `frontend/src/App.tsx` | Dashboard, controls, chart, metrics, and interval table |
| `frontend/src/App.css` | Dashboard component styling |
| `frontend/src/index.css` | Global styles and typography |
| `frontend/src/main.tsx` | React entry point |
| `frontend/index.html` | Browser document shell |
| `frontend/package.json` | Frontend dependencies and scripts |
| `frontend/package-lock.json` | Reproducible frontend dependency versions |
| `frontend/tsconfig.json` | TypeScript compiler settings |
| `frontend/vite.config.ts` | Vite development server and API proxy |
| `Dockerfile` | Multi-stage frontend build and Python runtime image |
| `docker-compose.yml` | Local container runner |
| `Procfile` | Heroku web process command |
| `heroku.yml` | Heroku Container Registry build configuration |

## Deployment

**Live pilot:** [https://wind-forecast-pilot.onrender.com/](https://wind-forecast-pilot.onrender.com/)

The app is deployed on Render as a Docker web service. The live homepage and API health endpoint were verified after deployment. Render's free web services may spin down after inactivity, so the first request after a quiet period can take longer to respond.

The app is also packaged with Heroku container configuration. To deploy to Heroku instead, create and verify a Heroku app, authenticate with the Heroku CLI, then run from the repository root:

```powershell
heroku container:login
heroku container:push web --app YOUR_HEROKU_APP
heroku container:release web --app YOUR_HEROKU_APP
heroku open --app YOUR_HEROKU_APP
```

The server honors the platform-provided `PORT`. Heroku requires account verification/payment information to create an app.

**Source repository:** [https://github.com/ThanishaDewangan/wind-forecast-pilot](https://github.com/ThanishaDewangan/wind-forecast-pilot)

## Video demo (required handoff)

No YouTube account, screen recorder, or upload credentials are available in this environment, so an unlisted video cannot be created or uploaded here. Record a single video of no more than 10 minutes and upload it as **Unlisted**. Suggested structure:

1. **Client pitch (up to 5 minutes):** introduce the day-ahead wind procurement problem; choose a January delivery date and cutoff; show the latest eligible forecast, forecast-versus-outturn chart, and quantified errors; explain that only information published by the decision time is used.
2. **Technical review (up to 5 minutes):** show the React/Vite frontend, FastAPI routes and Elexon integration, container build, timestamp matching and metric definitions; explain API error handling, the January-only scope, and how to run with Docker.

Add the YouTube URL here after uploading: **Unlisted video:** Not uploaded yet.

## Data sources and metric definitions

- [Elexon FUELHH stream](https://bmrs.elexon.co.uk/api-documentation/endpoint/datasets/FUELHH/stream) — actual national generation by fuel type. Wind rows only.
- [Elexon WINDFOR stream](https://bmrs.elexon.co.uk/api-documentation/endpoint/datasets/WINDFOR/stream) — national wind forecast vintages and their publication times.

All generation values are shown in MW. For exact timestamp matches, MAE is the mean absolute forecast error, RMSE is the square root of mean squared error, bias is the mean signed error, and MAPE is the mean absolute percentage error. Error is forecast minus actual; positive bias means forecasts were higher than outturn. MAPE excludes matched intervals with zero actual generation. Average-generation KPIs use all available values per series, while accuracy scores use only exact timestamp matches. The app is an analysis aid, not a trading recommendation.

## AI tools

GitHub Copilot (AI) was used to assist with implementation. Elexon API documentation and live API responses were checked to verify query parameters and response shapes.
