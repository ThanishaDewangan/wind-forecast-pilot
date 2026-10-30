import { useEffect, useMemo, useState } from "react";
import "./App.css";

type Point = {
  start_time: string;
  interval: string;
  forecast_mw: number | null;
  actual_mw: number | null;
  error_mw: number | null;
  publish_time: string | null;
};

type DashboardData = {
  delivery_date: string;
  cutoff_time: string;
  decision_at: string;
  latest_publish_time: string | null;
  forecast_points: number;
  actual_points: number;
  matched_points: number;
  points: Point[];
  metrics: {
    forecast_mean_mw: number | null;
    actual_mean_mw: number | null;
    mae_mw: number | null;
    rmse_mw: number | null;
    bias_mw: number | null;
    mape_percent: number | null;
  };
};

const numberFormat = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat("en-GB", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});

function formatNumber(value: number | null, digits = false) {
  if (value === null) return "—";
  return digits ? oneDecimal.format(value) : numberFormat.format(value);
}

function formatLongDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/London",
  }).format(new Date(`${value}T12:00:00Z`));
}

function formatPublishTime(value: string | null) {
  if (!value) return "No eligible forecast vintage";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
    timeZoneName: "short",
  }).format(new Date(value));
}

function shortDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "Europe/London",
  }).format(new Date(`${value}T12:00:00Z`));
}

function WindChart({ points }: { points: Point[] }) {
  const width = 900;
  const height = 270;
  const margin = { top: 20, right: 20, bottom: 34, left: 58 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;
  const values = points.flatMap((point) =>
    [point.actual_mw, point.forecast_mw].filter(
      (value): value is number => value !== null,
    ),
  );
  const maxValue = values.length ? Math.ceil(Math.max(...values) / 5000) * 5000 : 10000;
  const x = (index: number) =>
    margin.left + (points.length <= 1 ? 0 : (index / (points.length - 1)) * chartWidth);
  const y = (value: number) => margin.top + chartHeight - (value / maxValue) * chartHeight;
  const makePath = (key: "actual_mw" | "forecast_mw") => {
    let active = false;
    return points.reduce((path, point, index) => {
      const value = point[key];
      if (value === null) {
        active = false;
        return path;
      }
      const command = active ? "L" : "M";
      active = true;
      return `${path} ${command} ${x(index).toFixed(1)} ${y(value).toFixed(1)}`;
    }, "");
  };
  const yTicks = [0, 0.25, 0.5, 0.75, 1];
  const xTicks = [0, 8, 16, 24, 32, 40, 47].filter((index) => index < points.length);

  if (points.length === 0) {
    return (
      <div className="chart-empty">
        <span className="empty-mark">∅</span>
        <p>No matched interval data for this cutoff.</p>
        <span>Choose a later decision time or check data availability.</span>
      </div>
    );
  }

  return (
    <div className="chart-wrap">
      <svg
        className="wind-chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Wind generation forecast and actual generation over the delivery day"
      >
        {yTicks.map((fraction) => {
          const value = maxValue * fraction;
          const yPos = y(value);
          return (
            <g key={fraction}>
              <line
                x1={margin.left}
                x2={width - margin.right}
                y1={yPos}
                y2={yPos}
                className="chart-grid"
              />
              <text x={margin.left - 10} y={yPos + 4} textAnchor="end" className="chart-label">
                {formatNumber(value)}
              </text>
            </g>
          );
        })}
        {xTicks.map((index) => (
          <text
            key={index}
            x={x(index)}
            y={height - 8}
            textAnchor="middle"
            className="chart-label"
          >
            {points[index]?.interval}
          </text>
        ))}
        <path d={makePath("forecast_mw")} className="chart-line chart-forecast" />
        <path d={makePath("actual_mw")} className="chart-line chart-actual" />
        {points.map((point, index) =>
          point.forecast_mw !== null ? (
            <circle
              key={`forecast-${point.start_time}`}
              cx={x(index)}
              cy={y(point.forecast_mw)}
              r="2.5"
              className="chart-dot chart-forecast-dot"
            >
              <title>{`${point.interval} · Forecast ${formatNumber(point.forecast_mw)} MW`}</title>
            </circle>
          ) : null,
        )}
      </svg>
    </div>
  );
}

function MetricCard({
  label,
  value,
  unit,
  note,
  emphasis = false,
}: {
  label: string;
  value: string;
  unit: string;
  note: string;
  emphasis?: boolean;
}) {
  return (
    <article className={`metric-card${emphasis ? " metric-emphasis" : ""}`}>
      <span className="metric-label">{label}</span>
      <div className="metric-value">
        {value}
        <span>{unit}</span>
      </div>
      <span className="metric-note">{note}</span>
    </article>
  );
}

function App() {
  const [deliveryDate, setDeliveryDate] = useState("2026-01-15");
  const [cutoffTime, setCutoffTime] = useState("10:00");
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [showAllIntervals, setShowAllIntervals] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setLoading(true);
      setData(null);
      setShowAllIntervals(false);
      setError("");
      try {
        const query = new URLSearchParams({
          delivery_date: deliveryDate,
          cutoff_time: cutoffTime,
        });
        const response = await fetch(`/api/dashboard?${query}`, {
          signal: controller.signal,
        });
        const result = await response.json();
        if (!response.ok) {
          throw new Error(result.detail ?? "Unable to load Elexon data.");
        }
        setData(result as DashboardData);
      } catch (reason) {
        if (reason instanceof Error && reason.name !== "AbortError") {
          setData(null);
          setError(reason.message);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [deliveryDate, cutoffTime, refreshKey]);

  const matchedPoints = useMemo(
    () => data?.points.filter((point) => point.error_mw !== null) ?? [],
    [data],
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 36 36">
              <path d="M7 25.5 18 7l11 18.5H7Z" />
              <path d="M18 7v18.5M7 25.5h22M12 17.5h12" />
            </svg>
          </div>
          <div>
            <div className="brand-name">northstar</div>
            <div className="brand-caption">ENERGY INTELLIGENCE</div>
          </div>
        </div>

        <div className="nav-section">WORKSPACE</div>
        <div className="nav-item nav-item-active">
          <span className="nav-icon">◫</span>
          <span>Wind outlook</span>
          <span className="nav-indicator" />
        </div>
        <div className="sidebar-bottom">
          <div className="source-card">
            <span className="source-status" />
            <div>
              <b>Elexon BMRS</b>
              <span>Historical data source</span>
            </div>
            <span className="source-chevron">›</span>
          </div>
          <div className="user-profile">
            <div className="avatar">GB</div>
            <div>
              <b>Grid operations</b>
              <span>Day-ahead desk</span>
            </div>
            <span className="profile-menu">•••</span>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>Analytics</span>
            <span className="crumb-slash">/</span>
            <strong>Wind outlook</strong>
          </div>
          <div className="topbar-right">
            <span className="environment-pill"><span /> PILOT ENVIRONMENT</span>
            <span className="topbar-date">JANUARY 2026</span>
          </div>
        </header>

        <div className="page-container">
          <section className="page-heading">
            <div>
              <div className="eyebrow"><span className="eyebrow-line" /> DAY-AHEAD PROCUREMENT</div>
              <h1>Wind generation outlook</h1>
              <p className="page-subtitle">
                See what the forecast said at the buying cutoff — and how it compared to outturn. This wind-only pilot does not calculate net procurement without consumer demand data.
              </p>
            </div>
            <div className="data-badge">
              <span className="data-badge-icon">↗</span>
              <div>
                <b>GB national</b>
                <span>Wind generation · MW</span>
              </div>
            </div>
          </section>

          <section className="control-strip" aria-label="Forecast selection">
            <div className="control-group">
              <label htmlFor="delivery-date">DELIVERY DATE</label>
              <div className="input-shell">
                <span className="input-icon">▦</span>
                <input
                  id="delivery-date"
                  type="date"
                  min="2026-01-01"
                  max="2026-01-31"
                  value={deliveryDate}
                  onChange={(event) => setDeliveryDate(event.target.value)}
                />
              </div>
            </div>
            <span className="control-divider" />
            <div className="control-group">
              <label htmlFor="cutoff-time">DECISION CUTOFF</label>
              <div className="input-shell cutoff-input">
                <span className="input-icon">◷</span>
                <input
                  id="cutoff-time"
                  type="time"
                  value={cutoffTime}
                  onChange={(event) => setCutoffTime(event.target.value)}
                />
                <span className="timezone-label">UK TIME</span>
              </div>
            </div>
            <div className="control-context">
              <span className="context-dot" />
              <span>Forecasts published after cutoff are excluded</span>
            </div>
            <button
              className="refresh-button"
              type="button"
              onClick={() => setRefreshKey((current) => current + 1)}
              aria-label="Refresh data"
              title="Change a selection to reload the data"
              disabled={loading}
            >
              <span className={loading ? "refresh-icon spinning" : "refresh-icon"}>↻</span>
            </button>
          </section>

          {error && (
            <div className="error-banner" role="alert">
              <span className="error-mark">!</span>
              <div>
                <b>Could not load forecast data</b>
                <span>{error}</span>
              </div>
            </div>
          )}

          <section className="forecast-banner">
            <div className="forecast-banner-left">
              <div className="forecast-symbol">
                <svg viewBox="0 0 40 40" aria-hidden="true">
                  <path d="M8 13h18c3.5 0 3.5-5 0-5-1.6 0-2.7.8-3.1 2" />
                  <path d="M5 20h25c4 0 4 6 0 6-1.6 0-2.5-.8-3-1.8M10 28h10" />
                </svg>
              </div>
              <div className="forecast-copy">
                <div className="forecast-title-line">
                  <h2>Decision-time forecast</h2>
                  <span className="latest-tag">LATEST AVAILABLE</span>
                </div>
                <p>
                  {data
                    ? `${formatLongDate(data.delivery_date)} · Cutoff ${data.cutoff_time} UK time`
                    : "Selected delivery day · UK local time"}
                </p>
              </div>
            </div>
            <div className="forecast-banner-right">
              <span className="published-label">LATEST PUBLISH INCLUDED</span>
              <strong>{loading ? "Loading…" : formatPublishTime(data?.latest_publish_time ?? null)}</strong>
              <span className="vintage-count">
                {data?.forecast_points ?? "—"} forecast intervals selected
              </span>
            </div>
          </section>

          <section className="metrics-grid" aria-label="Forecast accuracy metrics">
            <MetricCard
              label="FORECAST MEAN"
              value={formatNumber(data?.metrics.forecast_mean_mw ?? null)}
              unit="MW"
              note="Selected as-of forecast"
            />
            <MetricCard
              label="ACTUAL MEAN"
              value={formatNumber(data?.metrics.actual_mean_mw ?? null)}
              unit="MW"
              note="Elexon wind outturn"
            />
            <MetricCard
              label="MEAN ABSOLUTE ERROR"
              value={formatNumber(data?.metrics.mae_mw ?? null)}
              unit="MW"
              note={`Across ${data?.matched_points ?? 0} matched intervals`}
              emphasis
            />
            <MetricCard
              label="ROOT MEAN SQUARE ERROR"
              value={formatNumber(data?.metrics.rmse_mw ?? null)}
              unit="MW"
              note="Penalises larger misses"
            />
            <MetricCard
              label="MEAN BIAS"
              value={formatNumber(data?.metrics.bias_mw ?? null, true)}
              unit="MW"
              note="Forecast minus actual"
            />
            <MetricCard
              label="MEAN ABSOLUTE PERCENT ERROR"
              value={formatNumber(data?.metrics.mape_percent ?? null, true)}
              unit="%"
              note="Zero-outturn intervals excluded"
            />
          </section>

          <section className="panel chart-panel">
            <div className="panel-heading">
              <div>
                <h2>Forecast vs. actual generation</h2>
                <p>National wind output across the delivery day</p>
              </div>
              <div className="legend">
                <span><i className="legend-dot forecast-dot" /> Forecast at cutoff</span>
                <span><i className="legend-dot actual-dot" /> Actual outturn</span>
              </div>
            </div>
            {loading ? (
              <div className="chart-loading"><span className="loading-spinner" /> Loading Elexon data…</div>
            ) : (
              <WindChart points={data?.points ?? []} />
            )}
            <div className="chart-footnote">
              <span>MW</span>
              <span>
                {data?.matched_points ?? 0} of {data?.actual_points ?? 0} actual intervals matched · accuracy uses exact timestamp matches
              </span>
            </div>
          </section>

          <section className="panel interval-panel">
            <div className="panel-heading interval-heading">
              <div>
                <h2>Interval detail</h2>
                <p>Forecast vintage, outturn and error at each matched delivery time</p>
              </div>
              <div className="table-actions">
                <span className="match-count">{data?.matched_points ?? 0} MATCHED</span>
                {(data?.points.length ?? 0) > 16 && (
                  <button
                    className="table-toggle"
                    type="button"
                    onClick={() => setShowAllIntervals((shown) => !shown)}
                  >
                    {showAllIntervals ? "Show fewer" : "Show all intervals"}
                  </button>
                )}
              </div>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>DELIVERY (UK)</th>
                    <th>FORECAST</th>
                    <th>ACTUAL</th>
                    <th>ERROR</th>
                    <th>VINTAGE PUBLISHED (UK)</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.points ?? []).slice(0, showAllIntervals ? undefined : 16).map((point) => (
                    <tr key={point.start_time}>
                      <td className="time-cell">{point.interval}</td>
                      <td>{formatNumber(point.forecast_mw)}</td>
                      <td>{formatNumber(point.actual_mw)}</td>
                      <td className={point.error_mw === null ? "" : point.error_mw > 0 ? "error-positive" : "error-negative"}>
                        {point.error_mw === null
                          ? "—"
                          : `${point.error_mw > 0 ? "+" : ""}${formatNumber(point.error_mw)}`}
                      </td>
                      <td className="publish-cell">
                        {point.publish_time
                          ? new Intl.DateTimeFormat("en-GB", {
                              hour: "2-digit",
                              minute: "2-digit",
                              timeZone: "Europe/London",
                            }).format(new Date(point.publish_time))
                          : "No forecast"}
                      </td>
                    </tr>
                  ))}
                  {!loading && (data?.points.length ?? 0) === 0 && (
                    <tr><td className="no-rows" colSpan={5}>No intervals available for the selected cutoff.</td></tr>
                  )}
                  {loading && (
                    <tr><td className="no-rows" colSpan={5}>Retrieving historical wind data from Elexon…</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="table-footer">
              <span>Showing {Math.min(data?.points.length ?? 0, showAllIntervals ? data?.points.length ?? 0 : 16)} of {data?.points.length ?? 0} intervals</span>
              <span>All times in UK local time · Error = forecast − actual</span>
            </div>
          </section>

          <footer className="page-footer">
            <span>Data: Elexon BMRS · FUELHH (WIND) &amp; WINDFOR</span>
            <span>January 2026 pilot <i /> Values in MW</span>
          </footer>
        </div>
      </main>
    </div>
  );
}

export default App;
