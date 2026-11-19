"""Evaluate a prespecified asinh chart refit, using a private archive directory as input."""
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
HOLDOUT_START = 1789059600
INCUMBENT_FIT_END = 1794191400
FEATURES = ["strike_gap", "opening_move", "momentum"]


def design(frame, curved):
    values = frame[FEATURES].to_numpy()
    assert np.isfinite(values).all() and (np.abs(values) <= 8).all()
    if curved:
        values = np.arcsinh(values)
    return np.column_stack([np.ones(len(frame)), values])


def fit(frame, curved):
    x, y = design(frame, curved), frame.y.to_numpy()

    def objective(weights):
        z = x @ weights
        return (np.sum(np.logaddexp(0, z) - y * z) + 2.5 * (weights @ weights),
                x.T @ (expit(z) - y) + 5 * weights)

    result = minimize(objective, np.zeros(4), method="L-BFGS-B", jac=True)
    if not result.success:
        raise RuntimeError(result.message)
    return result.x


def forecasts(train, test):
    assert train.expiry.max() + EMBARGO < test.expiry.min()
    out = test.copy()
    for col, curved in [("linear", False), ("asinh", True)]:
        out[col] = expit(design(test, curved) @ fit(train, curved))
    return out


def paper(frame, column):
    rows = frame[frame.status == "paired"].sort_values("expiry")
    p, y = rows[column].to_numpy(), rows.y.to_numpy()
    bid, ask = rows[["bid_ticks", "ask_ticks"]].to_numpy(dtype=int).T
    assert ((0 < bid) & (bid <= ask) & (ask < 10000)).all()
    up = p >= .5
    mid = (bid + ask) / 20000
    estimated = np.where(up, (p + mid) / 2, 1 - (p + mid) / 2)
    ticks = np.where(up, ask, 10000 - bid)
    fee = (7 * ticks * (10000 - ticks) + 999999) // 1000000
    cost = (ticks + fee + 99) // 100
    eligible = (cost <= 50) & (estimated + 1e-12 >= cost / 100 + .05)
    hit = (up == y)[eligible]
    net = int(hit.sum()) - cost[eligible].sum() / 100
    days = np.unique(rows.expiry.to_numpy()[eligible] // DAY)
    return {"paired": len(rows), "entries": int(eligible.sum()), "wins": int(hit.sum()),
            "utc_entry_days": len(days),
            "net": round(float(net), 4), "one_cent_worse": round(float(net - .01 * hit.size), 4)}


def summarize(frame, intervals):
    assert frame.expiry.is_unique
    y = frame.y.to_numpy()
    scores, changes = {}, {}
    for model in ["chart_up", "linear", "asinh"]:
        p = frame[model].to_numpy()
        hit, brier = (p >= .5) == y, (p - y) ** 2
        scores[model] = {"correct": int(hit.sum()), "brier": round(float(brier.mean()), 6)}
        if model != "asinh":
            candidate = frame.asinh.to_numpy()
            movement = ((candidate >= .5) == y).astype(int) - hit.astype(int)
            difference = {"accuracy": movement, "brier": (candidate - y) ** 2 - brier}
            changes[model] = {"helped": int((movement > 0).sum()), "hurt": int((movement < 0).sum()),
                              "delta_brier": round(float(difference["brier"].mean()), 6)}
            if intervals:
                changes[model]["day_block_95"] = {
                    key: interval(value, frame.expiry.to_numpy()) for key, value in difference.items()
                }
    out = {"rounds": len(frame), "utc_days": int((frame.expiry // DAY).nunique()),
           "scores": scores, "asinh_minus_baseline": changes}
    if intervals and (frame.minutes_left == 6).all():
        out["six_minute_entry_replay"] = {name: paper(frame, name) for name in scores}
    return out


def run(folder):
    roster = pd.read_csv(folder / "replay.csv.gz")
    panel = pd.read_csv(folder / "checkpoints.csv.gz")
    assert roster.expiry.is_unique and roster.ticker.is_unique and roster.y.isin([0, 1]).all()
    assert not panel.duplicated(["expiry", "minutes_left"]).any()
    assert panel.expiry.isin(roster.expiry).all() and panel.chart_up.between(0, 1).all()
    panel = panel.merge(roster[["expiry", "y", "bid_ticks", "ask_ticks", "status"]],
                        on="expiry", validate="many_to_one").sort_values("expiry")
    panel["month"] = pd.to_datetime(panel.expiry, unit="s", utc=True).dt.strftime("%Y-%m")
    counts, monthly, held, post, weights = {}, {}, {}, {}, {}
    tested = set()
    for left in [10, 8, 6, 4]:
        rows = panel[panel.minutes_left == left]
        outputs, months = [], []
        for month in sorted(rows.month.unique())[1:]:
            start = int(pd.Timestamp(month + "-01", tz="UTC").timestamp())
            train = rows[rows.expiry < start - EMBARGO]
            sample = forecasts(train, rows[rows.month == month])
            outputs.append(sample)
            months.append({"month": month, "training_rounds": len(train), **summarize(sample, False)})
        walk = pd.concat(outputs)
        tested.update(walk.expiry)
        counts[left], monthly[left] = summarize(walk, True), months
        hold = forecasts(rows[rows.expiry < HOLDOUT_START - EMBARGO], rows[rows.expiry >= HOLDOUT_START])
        held[left] = summarize(hold, True)
        post[left] = summarize(walk[walk.expiry > INCUMBENT_FIT_END], True)
        weights[left] = {"training_rounds": len(rows), "last_training_expiry": int(rows.expiry.max()),
                         "intercept_and_asinh_weights": fit(rows, True).tolist()}
    return {"feature_order": FEATURES, "embargo_days": 7, "holdout_start": HOLDOUT_START,
            "incumbent_fit_end": INCUMBENT_FIT_END, "archive_rounds": len(roster),
            "distinct_walk_forward_rounds": len(tested), "walk_forward": counts,
            "fixed_holdout": held, "post_incumbent_training": post, "months": monthly,
            "archive_fit": weights}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    print(json.dumps(run(parser.parse_args().archive), indent=2, allow_nan=False))
