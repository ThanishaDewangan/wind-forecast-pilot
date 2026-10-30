import unittest
from datetime import date, time
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from backend.app.main import dashboard


class DashboardTests(unittest.IsolatedAsyncioTestCase):
    async def test_dashboard_uses_latest_forecast_at_or_before_cutoff(self):
        forecasts = [
            {
                "startTime": "2026-01-15T00:00:00Z",
                "publishTime": "2026-01-14T09:00:00Z",
                "generation": 100,
            },
            {
                "startTime": "2026-01-15T00:00:00Z",
                "publishTime": "2026-01-14T10:30:00Z",
                "generation": 130,
            },
            {
                "startTime": "2026-01-15T01:00:00Z",
                "publishTime": "2026-01-14T09:30:00Z",
                "generation": 200,
            },
        ]
        actuals = [
            {"startTime": "2026-01-15T00:00:00Z", "generation": 110},
            {"startTime": "2026-01-15T00:30:00Z", "generation": 90},
        ]
        with patch(
            "backend.app.main._fetch_dashboard_data",
            new=AsyncMock(return_value=(forecasts, actuals)),
        ):
            result = await dashboard(date(2026, 1, 15), time(10, 0))

        self.assertEqual(result["forecast_points"], 2)
        self.assertEqual(result["actual_points"], 2)
        self.assertEqual(result["matched_points"], 1)
        self.assertEqual(result["points"][0]["forecast_mw"], 100)
        self.assertEqual(result["points"][0]["error_mw"], -10)
        self.assertEqual(result["metrics"]["forecast_mean_mw"], 150)
        self.assertEqual(result["metrics"]["actual_mean_mw"], 100)
        self.assertEqual(result["metrics"]["mae_mw"], 10)
        self.assertEqual(result["metrics"]["rmse_mw"], 10)
        self.assertEqual(result["metrics"]["bias_mw"], -10)
        self.assertEqual(result["metrics"]["mape_percent"], 9.1)

    async def test_rejects_dates_outside_january_2026(self):
        with self.assertRaises(HTTPException) as raised:
            await dashboard(date(2026, 2, 1))

        self.assertEqual(raised.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
