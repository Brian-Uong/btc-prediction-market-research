"""Six-minute chart research. Run with the private archive path as the only argument."""
import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.optimize import minimize
from scipy.special import expit

from walk_forward import interval

DAY = 86400
EMBARGO = 7 * DAY
HOLDOUT_START = 1789059600  # Same fixed roster boundary as study.py.
INCUMBENT_TRAIN_END = 1794191400
CHART = ["strike_gap", "opening_move", "momentum"]
MODELS = {
    "refit": CHART,
    "last_candle": [*CHART, "close_vs_candle"],
    "range_vol_and_last_candle": [
        "range_strike_gap", "range_opening_move", "range_momentum", "range_close_vs_candle"
    ],
}


def read_panel(folder):
    roster = pd.read_csv(folder / "replay.csv.gz")
    panel = pd.read_csv(folder / "checkpoints.csv.gz").query("minutes_left == 6")
    bars = pd.read_csv(folder / "candles.csv.gz").set_index("start").sort_index()
    assert roster.ticker.is_unique and roster.expiry.is_unique and roster.y.isin([0, 1]).all()
    assert panel.expiry.is_unique and bars.index.is_unique
    rows = panel.merge(roster[["expiry", "y", "target", "btc", "p_up"]], on="expiry",
                       validate="one_to_one").sort_values("expiry").reset_index(drop=True)
    assert len(rows) == len(panel) and (rows.target > 0).all()
    # Reindex on the minute grid so an absent bar cannot shorten a feature window.
    bars = bars.reindex(range(int(bars.index.min()), int(bars.index.max()) + 60, 60))
    squared_move = bars.close.diff().pow(2)
    close_variance = (squared_move.rolling(12).mean() + squared_move.rolling(60).mean()) / 2
    # High-low variance approximates one-minute dollar variance under continuous diffusion.
    squared_range = (bars.high - bars.low).pow(2) / (4 * np.log(2))
    range_variance = (squared_range.rolling(12).mean() + squared_range.rolling(60).mean()) / 2
    last = rows.expiry.to_numpy() - 7 * 60  # At six minutes left, this bar just closed.
    close = bars.close.loc[last].to_numpy()
    typical_price = bars[["open", "high", "low", "close"]].mean(axis=1, skipna=False)
    anchor = typical_price.loc[rows.expiry.to_numpy() - 16 * 60].to_numpy()
    last_typical = typical_price.loc[last].to_numpy()
    previous = bars.close.loc[last - 3 * 60].to_numpy()
    close_vol = np.sqrt(close_variance.loc[last].to_numpy())
    pooled_vol = np.sqrt((close_variance.loc[last] + range_variance.loc[last]).to_numpy() / 2)

    def predictors(vol):
        return np.clip(np.column_stack([
            (close - rows.target) / (vol * np.sqrt(5.5)),
            (close - anchor) / (vol * np.sqrt(5.5)),
            (close - previous) / (vol * np.sqrt(3)),
            (close - last_typical) / vol,
        ]), -8, 8)

    ordinary = predictors(close_vol)
    np.testing.assert_allclose(rows[CHART], ordinary[:, :3], rtol=1e-7, atol=1e-8)
    np.testing.assert_allclose(rows.btc, close)
    np.testing.assert_allclose(rows.chart_up, rows.p_up, atol=1e-10, rtol=0)
    rows["close_vs_candle"] = ordinary[:, 3]
    rows[MODELS["range_vol_and_last_candle"]] = predictors(pooled_vol)
    assert np.isfinite(rows[list(dict.fromkeys(sum(MODELS.values(), [])))].to_numpy()).all()
    rows["month"] = pd.to_datetime(rows.expiry, unit="s", utc=True).dt.strftime("%Y-%m")
    return rows


def matrix(rows, columns):
    return np.column_stack([np.ones(len(rows)), rows[columns].to_numpy()])


def fit(rows, columns):
    x = matrix(rows, columns)
    y = rows.y.to_numpy()

    def objective(weights):
        z = x @ weights
        return (np.sum(np.logaddexp(0, z) - y * z) + 2.5 * weights @ weights,
                x.T @ (expit(z) - y) + 5 * weights)

    result = minimize(objective, np.zeros(x.shape[1]), jac=True, method="L-BFGS-B",
                      options={"ftol": 1e-12, "maxiter": 300})
    if not result.success:
        raise RuntimeError(result.message)
    return result.x


def forecast(train, test):
    assert train.expiry.max() + EMBARGO < test.expiry.min()
    result = test[["expiry", "month", "y"]].copy()
    result["incumbent"] = test.chart_up
    result["spot_up"] = test.btc >= test.target
    for name, columns in MODELS.items():
        result[name] = expit(matrix(test, columns) @ fit(train, columns))
    return result


def summarize(frame, intervals):
    y = frame.y.to_numpy()
    out = {"rounds": len(frame), "utc_days": int((frame.expiry // DAY).nunique()),
           "spot_correct": int((frame.spot_up == y).sum()), "models": {}}
    models = ["incumbent", *MODELS]
    for name in models:
        p = frame[name].to_numpy()
        hit = (p >= .5) == y
        loss = (p - y)**2
        result = {"correct": int(hit.sum()), "brier": round(float(loss.mean()), 6)}
        out["models"][name] = result
        if name not in ("incumbent", "refit"):
            for baseline in ("incumbent", "refit"):
                other = frame[baseline].to_numpy()
                other_hit = (other >= .5) == y
                gain = loss - (other - y)**2
                accuracy_change = hit.astype(int) - other_hit.astype(int)
                result[baseline + "_comparison"] = {
                    "flipped_help": int((accuracy_change == 1).sum()),
                    "flipped_hurt": int((accuracy_change == -1).sum()),
                    "accuracy_change": round(float(accuracy_change.mean()), 6),
                    "brier_change": round(float(gain.mean()), 6),
                }
                if intervals:
                    result[baseline + "_comparison"].update(
                        accuracy_change_day_95=interval(accuracy_change, frame.expiry.to_numpy()),
                        brier_change_day_95=interval(gain, frame.expiry.to_numpy()))
    return out


def study(folder):
    panel = read_panel(folder)
    folds = []
    monthly = []
    for month in sorted(panel.month.unique())[1:]:
        boundary = int(pd.Timestamp(month + "-01", tz="UTC").timestamp())
        train = panel[panel.expiry < boundary - EMBARGO]
        test = panel[panel.month == month]
        predictions = forecast(train, test)
        folds.append(predictions)
        monthly.append({"month": month, "train_rounds": len(train),
                        **summarize(predictions, intervals=False)})
    walk = pd.concat(folds)
    assert walk.expiry.is_unique
    train = panel[panel.expiry < HOLDOUT_START - EMBARGO]
    holdout = forecast(train, panel[panel.expiry >= HOLDOUT_START])
    post_fit = walk[walk.expiry > INCUMBENT_TRAIN_END]
    return {
        "eligible_six_minute_rounds": len(panel), "first_expiry": int(panel.expiry.min()),
        "last_expiry": int(panel.expiry.max()), "embargo_days": 7, "features": MODELS,
        "walk_forward": summarize(walk, intervals=True), "monthly_folds": monthly,
        "fixed_last_fifth": {"cutoff": HOLDOUT_START, "train_rounds": len(train),
                             **summarize(holdout, intervals=True)},
        "after_incumbent_training": summarize(post_fit, intervals=True),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    print(json.dumps(study(parser.parse_args().archive), indent=2, allow_nan=False))
