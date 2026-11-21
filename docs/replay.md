# Replaying the six-minute study

The six-minute comparison tests whether a chart, the market midpoint or a hybrid gives the best forecast at the same instant. January through November 2026 are monthly test blocks. Each block trains on earlier rounds with a seven-day gap before the test month. December 2025 seeds the first fit. Researchers explored this archive before freezing the hybrid, so future official settlements provide the prospective test.

## Inputs for a full historical rerun

Use a local copy of the November 16 research snapshot or equivalent market data you have permission to use. The public repository includes the model, analysis code and aggregate outputs. The original exchange records stay in the local snapshot. Later data downloads can contain revisions.

Place the following files in `backtest/six-minute/`.

| Input | Contents |
| --- | --- |
| `replay.csv.gz` | One record per settled ticker. Fields are ticker, expiry, target, y, btc, p_up, x_strike, x_open, x_momentum, bid_ticks, ask_ticks, status and target_source. Expiry is Unix seconds, y is one for an official Up result, and 10,000 ticks equal one dollar. |
| `candles.csv.gz` | Coinbase one-minute BTC-USD bars with start, open, high, low and close in that order. Start is in Unix seconds. |
| `hybrid-four-quotes.csv` | The alternate execution test uses ticker, bid and ask, in ticks, from the original candidates’ four-minute checkpoints. |

From the project root, use Python 3.11+ and Node.js 22+. An isolated Python environment is recommended. The first Node command regenerates `checkpoints.csv.gz` in the input folder. Use a working copy when preserving the original snapshot.

```sh
python -m pip install -r requirements.txt
node backtest/six-minute/rebuild_chart.mjs
python backtest/six-minute/walk_forward.py
python backtest/six-minute/study.py
python backtest/six-minute/hybrid_study.py
python backtest/six-minute/hybrid_price_test.py
```

Compare the JSON outputs respectively with `walk-results.json`, `snapshot-results.json`, `hybrid-results.json` and `hybrid-price-results.json` in the same directory. Optional earlier research in `backtest/study.py` uses the separate checkpoint extract `backtest/history.json` from the source package.

## What the results measure

The archive reconstructs 126,445 checkpoints from 61 consecutive completed candles per forecast. At six minutes, 96 rounds had no verified target and 189 had missing candles. A further 142 lacked an exact-time quote and 278 had an unusable book. Missing inputs remain in coverage counts. Only matched forecasts with valid inputs enter the head-to-head comparison.

The hybrid estimates Up probability using regularized logistic regression. Its paper entry buys one contract on the favored side when forecast confidence reaches 60%, all-in cost is at most $0.90 and estimated margin is at least $0.05. The historical cost uses a quadratic fee with multiplier one and conservative whole-cent rounding. The one-cent adverse-price stress turns the monthly hybrid’s −$6.36 into −$9.46.

The four-minute alternative is a separate exploratory strategy. Among 308 of the 310 candidates with usable data, buying immediately returned −$6.64. Waiting for chart agreement and a three-cent better all-in price led to 45 entries, 23 wins and −$6.02. The two policies compete for the same candidates.

## Prospective grading

The scheduled Worker writes to a D1 binding named `DB`. The current fresh-install schema is `schema.sql`. The local VS Code runner can reconstruct elapsed chart checkpoints using the currently available candles. The hosted journal retains the original capture, source timestamps and official outcome.

Use `forward_midpoint.sql` in `backtest/six-minute/` for the separately frozen chart-versus-midpoint comparison and `hybrid_review.sql` for the hybrid. A missing six-minute book or a pending settlement stays visible in coverage. Each model is compared on the same seconds-to-close and distinct round. The locked eight-minute entry, the separate six-minute $50 experiment and the hybrid each have their own paper rules.

## November 17 tracker cleanup

Open `round_decisions` in D1 Studio for the latest chart direction, the separately locked entry, official settlement and paper P&L. Its six-minute paper columns show the independent $50 experiment. Four backing tables hold the original checkpoints, locked entries, hybrid observations and $50 paper ledger.

The capped watcher, its agreement trial and its automatic recalibration were retired from new captures. Historical rows retain their original values. Use [historical matchup](../backtest/legacy_matchup.sql) to reconstruct the old standings and [chart accuracy](../backtest/chart_accuracy.sql) for checkpoint scores. The two frozen hybrid comparisons run directly against the captured records through [hybrid review](../backtest/six-minute/hybrid_review.sql).

On an existing November 17 journal, deploy the chart-only Worker first, then apply [the cleanup migration](../migrations/2026-11-17-chart-only.sql). Then apply the [round display migration](../migrations/2026-11-17-readable-rounds.sql). A journal that already has the chart-only cleanup needs only the display migration. For a new journal, use the root schema. Earlier upgrades under `migrations/historical/` document earlier versions.

## November 18 chart review

The live chart remains the direction displayed in `round_decisions`. This review covers 277 distinct officially settled rounds through November 18, 2026 at 11:30 p.m. Pacific. The 59 new rounds closed after the 8:45 a.m. Pacific review cutoff that day. The spot baseline predicts Up when the captured BTC price is at or above that round’s official target. Each comparison uses the same ticker and checkpoint. A lower Brier score means smaller probability errors.

| Minutes left | New chart | New spot | New Brier | Cumulative chart | Cumulative spot | Cumulative Brier |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 34/58 | 35/58 | .234475 | 188/273 | 194/273 | .189229 |
| 8 | 38/59 | 38/59 | .215701 | 206/277 | 202/277 | .166157 |
| 6 | 49/59 | 51/59 | .166175 | 227/276 | 230/276 | .139199 |
| 4 | 46/59 | 45/59 | .134346 | 234/277 | 233/277 | .104435 |

All scheduled rows arrived. Five chart inputs were unavailable because Coinbase rate-limited the requests, including one new ten-minute observation. Every eligible expired round through the cutoff had an official outcome. The next review counts new rounds strictly after expiry 1795073400 (the 11:30 p.m. close), then advances that boundary with each review. It checks older pending rounds separately.

The eight-minute ledger won 38/59 in the new sample for −$5.655 gross at recorded asks. Cumulatively it won 181/245. One losing call lacked an entry price and the 244 priced calls returned −$2.218 gross. All entries locked at eight minutes. The latest forecast scored 234/277. Among the 245 locked rounds, later updates corrected 41 misses and reversed 13 correct calls (11 and 3 in the new slice).

| Frozen six-minute comparison | New results | Cumulative results |
| --- | --- | --- |
| Chart vs. midpoint | 49 vs. 50 correct on 59 paired rounds. Brier .166175 vs. .170641. | 185 vs. 183 correct on 220 pairs. Brier .132399 vs. .131401. One historical observation lacked chart data. |
| Hybrid v1 | Hybrid, chart and midpoint got 50, 49 and 50 of 59 correct. Brier .169022, .166175 and .170641. | On 151 paired rounds across two Pacific days, correct counts were 123, 124 and 123. Brier was .143605, .141255 and .144348. The hybrid fixed two chart misses and reversed three correct calls. |
| Hybrid execution | Zero qualifying immediate candidates. | No immediate or delayed entries. Net and one-cent-worse P&L were both $0. |
| $50 filtered paper screen | Zero qualifying trades. | All 231 expected rows arrived. Two entries, both wins on the same day, earned $1.18 after modeled fees. Available $51.18, reserved $0. A one-cent worse fill leaves $1.16. |
| $0.50 cap-only reference | One loss of $0.49. | Three wins and two losses across three Pacific days, earning $0.78 net or $0.73 at one cent worse. |

### Refinements tested

These tests used the November 16 archive. Each January–November test month was forecast with coefficients fitted only on rounds ending at least seven days before that month. At six minutes there were 30,045 distinct walk-forward rounds across 320 UTC days. The exact live model was originally fitted using data through November 9. The monthly linear refit provides a time-ordered comparison over the full replay. The 732 rounds after the live model's original training cutoff also allow a comparison with its fixed coefficients. All of these are historical tests.

| Six-minute chart method | Walk-forward correct / 30,045 | Brier | Correct on 732 post-training rounds |
| --- | ---: | ---: | ---: |
| Exact live coefficients (retrospective across the full replay) | 24,172 | .137538 | 584 |
| Ordinary monthly linear refit | 24,183 | .136052 | 585 |
| Add the close relative to the last candle’s OHLC average | 24,177 | .136083 | 584 |
| Add that last-candle feature and include high-low ranges in volatility | 24,169 | .135899 | 584 |
| Apply a smoother curve to distance, opening move and momentum | 24,200 | .136266 | 584 |
| Spot side | 24,209 | — | 586 |

High-low volatility improved the six-minute Brier score by .000153 versus the ordinary refit. It corrected nine calls and reversed 23 correct ones. The smoother curve gained 17 correct calls at six minutes, but its Brier was worse than the ordinary refit at all four checkpoints. With the frozen $0.50 entry screen, the curve won 23 of 72 historical entries and lost $7.49 after modeled fees, or $8.21 at one cent worse on each entry. The ordinary refit lost $6.42 on 59 entries. The stress holds the original entries fixed and charges an extra cent per contract. These results support retaining the incumbent and continuing the existing forward comparisons.

Rerun these studies against the private input directory used above. Each prints aggregate JSON.

```sh
python backtest/six-minute/chart_candle_study.py backtest/six-minute
python backtest/six-minute/chart_curve_study.py backtest/six-minute
```

Monthly scores, paired changes, day-resampled intervals and the fixed chronological holdout are in the [candle study results](../backtest/six-minute/chart-candle-results.json) and [curve study results](../backtest/six-minute/chart-curve-results.json).

## November 20 capture reliability

The review through November 20 at 8:15 a.m. Pacific found 19 newly unavailable chart observations. Four rounds closing November 19 from 1:30 to 2:15 p.m. Pacific lost all four checkpoints. Three other rounds lost their ten-minute forecast. All scheduled journal rows exist. The recorded errors include missing numeric inputs, Coinbase HTTP 429 responses and one Worker subrequest-limit error. The generic numeric-input message does not identify which source field was absent at capture time.

A single scheduled invocation can attempt four checkpoints. Five attempts at three external requests per checkpoint allowed 60 fetches, above the 50-request limit. Capture now makes at most three attempts per checkpoint. A synthetic missing-candle regression exercised all four checkpoints with 36 fetches and 11 journal operations. A healthy replay made 12 fetches and 12 journal operations, including the hybrid write. Run `node backtest/capture_budget.test.mjs` to reproduce both paths. The existing 25-second eligibility deadline applies to every retry.

The settled sample contains 396 distinct rounds, including 91 new rounds after the November 19 8:30 a.m. cutoff. Chart correct counts at 10/8/6/4 minutes are 268/389, 295/396, 319/395 and 335/396. Brier scores are .192805, .164976, .137770 and .105567. Locked paper entries returned −$4.608 gross across 361 priced entries. The frozen $50 experiment remains at $51.18 after two winning entries on one day. Hybrid v1 scored 213/270 versus 216/270 for the chart and produced zero qualifying entries. The evidence supports retaining the incumbent and continuing the prospective comparisons.

The next review starts its new sample after expiry 1795191300 and advances from the latest verified cutoff thereafter. Check older pending settlements separately.

## November 21 capture review

Through November 21 at 8:30 a.m. Pacific, all calendar checkpoint rows arrived. Eight new ten-minute forecasts were unavailable after Coinbase HTTP 429 responses. Every new eight-, six- and four-minute chart capture arrived. The November 20 request-limit error has not recurred.

Retries now target eight and sixteen seconds after the scheduled checkpoint, allowing brief source throttling to clear. The maximum remains three attempts, and captures must finish within the original 25-second window. The synthetic regression covers healthy data, persistently missing candles, two early rate-limit responses followed by recovery at sixteen seconds, and responses arriving after the deadline. The four scenarios use fewer than 50 counted fetches and journal operations each. A persistent upstream failure can still prevent a forecast.

The cumulative sample is 493 distinct settled rounds, including 97 new rounds after expiry 1795191300. Chart correct counts at 10/8/6/4 minutes are 324/478, 373/493, 399/492 and 418/493, with Brier .195235/.163138/.136744/.108480. New correct counts are 56/89, 78/97, 80/97 and 83/97. Same-checkpoint spot-side correct counts are 329/478, 365/493, 399/492 and 415/493. Locked entries won 348/461, with 457 priced entries earning $0.765 gross before fees. The new 96 priced entries earned $5.373. All entries locked at eight minutes. Later updates corrected 69 misses and reversed 24 correct calls cumulatively, including 11 and 6 in the new sample.

The six-minute midpoint benchmark has 436 official paired grades. Chart/midpoint correct counts are 357/353 and Brier .132997/.134580. Both got 80/97 new calls correct. One contemporaneous book lacked an eligible executable Up ask, so its midpoint contributes to forecast scoring while the $50 ledger records an unavailable quote. Hybrid v1 scored 294/367 versus the chart's 296/367 and midpoint's 293/367. Brier was .139734/.136753/.140505 respectively. It generated zero immediate candidates and zero delayed entries. The $50 experiment remains at $51.18 with two wins on one day and no outstanding stake. The cap-only reference has five wins and four losses over five days, earning $0.82 net or $0.73 at one cent worse. The two new reference entries lost $1.00.

The incumbent remains supported by the existing evidence. The snapshot had one recently closed round awaiting official grading. Use expiry 1795278600 as the next new-sample boundary, advancing it with subsequent verified reviews and rechecking earlier pending rounds separately.
