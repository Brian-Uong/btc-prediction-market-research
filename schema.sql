CREATE TABLE IF NOT EXISTS _checkpoint_data(
  round_pt TEXT NOT NULL, minutes_left INTEGER NOT NULL,
  lean TEXT, btc_lean TEXT, priority_at_capture TEXT,
  decision TEXT NOT NULL, btc_decision TEXT, probability REAL, btc_probability REAL,
  ask REAL, btc_ask REAL, btc REAL, target REAL, result TEXT, final_index REAL, gross_usd REAL,
  model_id TEXT, detail TEXT, raw_up REAL, midpoint REAL, up_ask REAL, down_ask REAL,
  six_trial_call TEXT, agreement_call TEXT, agreement_recheck_call TEXT, agreement_recheck_ask REAL,
  calibration_review TEXT, last_settle_check INTEGER NOT NULL DEFAULT 0,
  capped_recorded INTEGER NOT NULL DEFAULT 1, expiry INTEGER NOT NULL,
  btc_captured_at TEXT, btc_ticker TEXT, captured_at TEXT NOT NULL, ticker TEXT,
  research_version TEXT, research_btc_up REAL, research_capped_up REAL,
  locked_round_call TEXT,
  paper_entry_cents REAL,
  captured_at_pt TEXT GENERATED ALWAYS AS (
  CASE WHEN julianday(captured_at) IS NULL THEN captured_at ELSE
       (((CAST(strftime('%H',captured_at,CASE WHEN julianday(captured_at)>=julianday(strftime('%Y',captured_at)||'-03-08','weekday 0','+10 hours')
       AND julianday(captured_at)<julianday(strftime('%Y',captured_at)||'-11-01','weekday 0','+9 hours')
      THEN '-7 hours' ELSE '-8 hours' END) AS INTEGER)+11)%12)+1)||strftime(':%M:%S',captured_at)||
       CASE WHEN CAST(strftime('%H',captured_at,CASE WHEN julianday(captured_at)>=julianday(strftime('%Y',captured_at)||'-03-08','weekday 0','+10 hours')
       AND julianday(captured_at)<julianday(strftime('%Y',captured_at)||'-11-01','weekday 0','+9 hours')
      THEN '-7 hours' ELSE '-8 hours' END) AS INTEGER)<12 THEN 'am' ELSE 'pm' END END
) VIRTUAL,
  PRIMARY KEY(expiry DESC, minutes_left ASC)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS calls_pending_result ON _checkpoint_data(last_settle_check,expiry,ticker)
  WHERE result IS NULL AND ticker IS NOT NULL;
CREATE INDEX IF NOT EXISTS calls_review ON _checkpoint_data(expiry)
  WHERE minutes_left=8 AND calibration_review IS NOT NULL;
CREATE INDEX IF NOT EXISTS calls_validation ON _checkpoint_data(expiry)
  WHERE minutes_left=8 AND result IS NOT NULL AND raw_up IS NOT NULL;
CREATE INDEX IF NOT EXISTS calls_agreement ON _checkpoint_data(expiry)
  WHERE minutes_left=8 AND agreement_call IS NOT NULL AND result IS NOT NULL;

CREATE TABLE IF NOT EXISTS model_matchup(
  priority_model TEXT GENERATED ALWAYS AS (
    CASE WHEN btc_correct_leans>capped_correct_leans THEN 'BTC price model'
         WHEN capped_correct_leans>btc_correct_leans THEN 'Capped watcher' ELSE 'Tied' END
  ) VIRTUAL,
  btc_correct_leans INTEGER NOT NULL DEFAULT 0 CHECK(btc_correct_leans BETWEEN 0 AND paired_graded),
  capped_correct_leans INTEGER NOT NULL DEFAULT 0 CHECK(capped_correct_leans BETWEEN 0 AND paired_graded),
  paired_graded INTEGER NOT NULL DEFAULT 0 CHECK(paired_graded>=0),
  first_close_utc TEXT NOT NULL,
  singleton INTEGER PRIMARY KEY CHECK(singleton=1)
);
INSERT OR IGNORE INTO model_matchup(singleton,first_close_utc) VALUES(1,'2026-11-16T10:30:00Z');

CREATE TRIGGER IF NOT EXISTS save_checkpoint_priority AFTER INSERT ON _checkpoint_data
WHEN NEW.minutes_left IN (10,8,6,4)
 AND NEW.expiry>=(SELECT unixepoch(first_close_utc) FROM model_matchup WHERE singleton=1)
BEGIN
  UPDATE _checkpoint_data SET priority_at_capture=(SELECT priority_model FROM model_matchup WHERE singleton=1)
  WHERE expiry=NEW.expiry AND minutes_left=NEW.minutes_left;
END;
CREATE TRIGGER IF NOT EXISTS grade_model_matchup AFTER UPDATE OF result ON _checkpoint_data
WHEN OLD.result IS NOT NEW.result AND NEW.minutes_left IN (10,8,6,4)
 AND NEW.expiry>=(SELECT unixepoch(first_close_utc) FROM model_matchup WHERE singleton=1)
 AND NEW.lean IN ('Up','Down')
 AND NEW.btc_lean IN ('Up','Down') AND NEW.ticker=NEW.btc_ticker
BEGIN
  UPDATE model_matchup SET
    paired_graded=paired_graded+COALESCE(NEW.result IN ('Up','Down'),0)-COALESCE(OLD.result IN ('Up','Down'),0),
    btc_correct_leans=btc_correct_leans+COALESCE(NEW.btc_lean=NEW.result,0)-COALESCE(NEW.btc_lean=OLD.result,0),
    capped_correct_leans=capped_correct_leans+COALESCE(NEW.lean=NEW.result,0)-COALESCE(NEW.lean=OLD.result,0)
  WHERE singleton=1;
END;

CREATE TABLE IF NOT EXISTS _directional_rounds(
  expiry INTEGER PRIMARY KEY,
  ticker TEXT NOT NULL,
  minutes_left INTEGER NOT NULL CHECK(minutes_left IN (8,6,4)),
  captured_at TEXT NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('Up','Down')),
  confidence REAL NOT NULL CHECK(confidence BETWEEN 0.5 AND 1),
  entry_ask REAL CHECK(entry_ask>0 AND entry_ask<1)
);
CREATE TRIGGER IF NOT EXISTS record_chart_round_v1 AFTER INSERT ON _checkpoint_data
WHEN NEW.expiry>=1794853800 AND NEW.minutes_left IN (8,6,4)
  AND NEW.result IS NULL AND NEW.btc_lean IN ('Up','Down') AND NEW.btc_probability BETWEEN 0.5 AND 1
  AND NEW.btc_ticker IS NOT NULL AND NEW.ticker=NEW.btc_ticker
  AND unixepoch(NEW.btc_captured_at) BETWEEN NEW.expiry-60*NEW.minutes_left AND NEW.expiry-60*NEW.minutes_left+25
BEGIN
  INSERT INTO _directional_rounds(expiry,ticker,minutes_left,captured_at,side,confidence,entry_ask)
  VALUES(NEW.expiry,NEW.btc_ticker,NEW.minutes_left,NEW.btc_captured_at,NEW.btc_lean,NEW.btc_probability,
    CASE WHEN NEW.btc_ask>0 AND NEW.btc_ask<1 THEN NEW.btc_ask END)
  ON CONFLICT(expiry) DO NOTHING;
END;

CREATE TRIGGER IF NOT EXISTS show_checkpoint_lock AFTER INSERT ON _directional_rounds
BEGIN
  UPDATE _checkpoint_data SET locked_round_call=NEW.side, paper_entry_cents=ROUND(100*NEW.entry_ask,2) WHERE expiry=NEW.expiry AND minutes_left=NEW.minutes_left AND btc_ticker=NEW.ticker;
END;
CREATE TRIGGER IF NOT EXISTS correct_checkpoint_lock AFTER UPDATE ON _directional_rounds
BEGIN
  UPDATE _checkpoint_data SET locked_round_call=NULL, paper_entry_cents=NULL WHERE expiry=OLD.expiry AND minutes_left=OLD.minutes_left AND btc_ticker=OLD.ticker;
  UPDATE _checkpoint_data SET locked_round_call=NEW.side, paper_entry_cents=ROUND(100*NEW.entry_ask,2) WHERE expiry=NEW.expiry AND minutes_left=NEW.minutes_left AND btc_ticker=NEW.ticker;
END;
CREATE TRIGGER IF NOT EXISTS clear_checkpoint_lock AFTER DELETE ON _directional_rounds
BEGIN
  UPDATE _checkpoint_data SET locked_round_call=NULL, paper_entry_cents=NULL WHERE expiry=OLD.expiry AND minutes_left=OLD.minutes_left AND btc_ticker=OLD.ticker;
END;

CREATE VIEW IF NOT EXISTS round_decisions AS
WITH latest AS (
 SELECT expiry, MIN(minutes_left) AS minutes_left, MAX(COALESCE(ticker,btc_ticker)) AS market_ticker FROM _checkpoint_data GROUP BY expiry
)
SELECT c.round_pt,c.minutes_left,
 forecast.btc_lean AS round_call,
 CASE WHEN forecast.minutes_left IS NULL THEN NULL
      WHEN forecast.minutes_left<>c.minutes_left THEN 'Last valid'
      WHEN forecast.minutes_left=10 THEN 'Preview' ELSE 'Updated' END AS call_status,
 forecast.minutes_left AS call_at_min,
 ROUND(100*forecast.btc_probability,1) AS call_confidence_pct,
 d.side AS locked_round_call, d.minutes_left AS entry_at_min,
 ROUND(100*d.entry_ask,2) AS paper_entry_cents,
 CASE WHEN c.lean IS NOT NULL THEN c.lean||' · '||printf('%.1f%%',100*c.probability)
      WHEN c.capped_recorded=1 THEN 'No data' ELSE 'Not recorded' END AS capped_forecast,
 CASE WHEN c.btc_lean IS NOT NULL THEN c.btc_lean||' · '||printf('%.1f%%',100*c.btc_probability)
      WHEN c.btc_decision IS NOT NULL THEN 'No data' ELSE 'Not recorded' END AS btc_forecast,
 c.priority_at_capture AS priority_model,
 COALESCE(c.target,(SELECT h.target FROM _checkpoint_data h WHERE h.expiry=c.expiry AND h.target IS NOT NULL LIMIT 1)) AS price_to_beat,

 CASE WHEN settled.result IS NOT NULL THEN 'Settled' WHEN c.expiry<=unixepoch() THEN 'Closed' ELSE 'Open' END AS round_status,
 settled.result,
 CASE WHEN settled.result IN ('Up','Down') AND d.entry_ask IS NOT NULL
 THEN round((d.side=settled.result)-d.entry_ask,4) END AS gross_paper_usd,settled.final_index,
 CASE WHEN l.market_ticker GLOB 'KXBTC15M-*-??' THEN
   'https://kalshi.com/markets/kxbtc15m/btc-15-min/'||lower(substr(l.market_ticker,1,length(l.market_ticker)-3))
 END AS market_url
FROM latest l JOIN _checkpoint_data c USING(expiry,minutes_left)
LEFT JOIN _directional_rounds d ON d.expiry=c.expiry AND d.ticker=l.market_ticker
LEFT JOIN _checkpoint_data forecast ON forecast.expiry=c.expiry AND forecast.minutes_left=(
 SELECT p.minutes_left FROM _checkpoint_data p
 WHERE p.expiry=c.expiry AND p.expiry>=1794853800 AND p.minutes_left IN (10,8,6,4)
 AND p.btc_ticker=l.market_ticker AND p.btc_ticker=p.ticker AND p.btc_lean IN ('Up','Down')
 AND p.btc_probability BETWEEN 0.5 AND 1
 AND unixepoch(p.btc_captured_at) BETWEEN p.expiry-60*p.minutes_left AND p.expiry-60*p.minutes_left+25
 ORDER BY p.minutes_left ASC LIMIT 1)
LEFT JOIN _checkpoint_data settled ON settled.expiry=c.expiry AND settled.minutes_left=(
 SELECT h.minutes_left FROM _checkpoint_data h WHERE h.expiry=c.expiry AND h.result IN ('Up','Down') LIMIT 1)
ORDER BY c.expiry DESC;

CREATE VIEW IF NOT EXISTS accuracy_by_minute AS
WITH checkpoints(model,minutes_left) AS (
  VALUES ('Capped watcher',10),('Capped watcher',8),('Capped watcher',6),('Capped watcher',4),
         ('BTC price model',10),('BTC price model',8),('BTC price model',6),('BTC price model',4)
), observations AS (
  SELECT minutes_left,lean,btc_lean,result,
         CASE WHEN ticker=btc_ticker THEN result END AS btc_result
  FROM _checkpoint_data WHERE expiry>=(SELECT unixepoch(first_close_utc) FROM model_matchup WHERE singleton=1)
    AND minutes_left IN (10,8,6,4)
), directions AS (
  SELECT 'Capped watcher' AS model,minutes_left,lean,result FROM observations
  UNION ALL SELECT 'BTC price model',minutes_left,btc_lean,btc_result FROM observations
), tally AS (
  SELECT model,minutes_left,count(*) AS total_entries,
    COUNT(CASE WHEN result=lean THEN 1 END) AS correct_leans,
    COUNT(CASE WHEN result IN ('Up','Down') AND result<>lean THEN 1 END) AS wrong
  FROM directions WHERE lean IN ('Up','Down') GROUP BY model,minutes_left
)
SELECT c.model,c.minutes_left,COALESCE(t.total_entries,0) AS total_entries,
 COALESCE(t.correct_leans,0) AS correct_leans,COALESCE(t.wrong,0) AS wrong,

 COALESCE(ROUND(100.0*t.correct_leans/NULLIF(t.correct_leans+t.wrong,0),1),0.0) AS lean_accuracy_pct
FROM checkpoints c LEFT JOIN tally t ON t.model=c.model AND t.minutes_left=c.minutes_left
ORDER BY CASE c.model WHEN 'Capped watcher' THEN 0 ELSE 1 END,c.minutes_left DESC;


CREATE TRIGGER IF NOT EXISTS capture_nov16_model_trial AFTER INSERT ON _checkpoint_data
WHEN NEW.expiry BETWEEN unixepoch('2026-11-16T11:15:00Z') AND unixepoch('2026-11-16T16:00:00Z')
  AND NEW.minutes_left IN (10,8,6,4) AND NEW.result IS NULL AND NEW.ticker IS NOT NULL
  AND unixepoch(NEW.captured_at) BETWEEN NEW.expiry-60*NEW.minutes_left AND NEW.expiry-60*NEW.minutes_left+25
BEGIN
  UPDATE _checkpoint_data SET (research_version,research_btc_up,research_capped_up)=(
    SELECT 'nov16-overnight-v1',
      CASE WHEN btc_p IS NOT NULL AND NEW.btc>0 AND NEW.target>0 AND NEW.btc_ticker=NEW.ticker THEN
        1.0/(1.0+exp(-(0.98794301*ln(btc_p/(1.0-btc_p))+
           0.15889309*min(5.0,max(-5.0,10000.0*(NEW.btc/NEW.target-1.0)/(4.0*sqrt(NEW.minutes_left-0.5))))))) END,
      CASE WHEN capped_p IS NOT NULL THEN
        CASE WHEN NEW.midpoint BETWEEN 0 AND 1 AND NEW.up_ask>0 AND NEW.down_ask>0 THEN
          capped_p+0.46925391*(NEW.midpoint-capped_p)*max(0.0,1.0-max(0.0,NEW.up_ask+NEW.down_ask-1.0)/0.10)
        ELSE capped_p END END
    FROM (SELECT min(0.999999,max(0.000001,CASE NEW.btc_lean WHEN 'Up' THEN NEW.btc_probability
                   WHEN 'Down' THEN 1.0-NEW.btc_probability END)) AS btc_p,
                 CASE NEW.lean WHEN 'Up' THEN NEW.probability WHEN 'Down' THEN 1.0-NEW.probability END AS capped_p)
  ) WHERE expiry=NEW.expiry AND minutes_left=NEW.minutes_left;
END;

CREATE TABLE IF NOT EXISTS six_minute_paper (
  round_pt TEXT NOT NULL,
  paper_call TEXT NOT NULL,
  btc_side TEXT,
  btc_confidence REAL,
  estimated_win_probability REAL,
  ask_usd REAL,
  all_in_usd REAL,
  result TEXT,
  net_usd REAL GENERATED ALWAYS AS (
    CASE WHEN paper_call IN ('Up','Down') AND result IN ('Up','Down')
      THEN round((paper_call=result)-all_in_usd,4) END
  ) VIRTUAL,
  reason TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  ticker TEXT,
  expiry INTEGER PRIMARY KEY DESC
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS six_paper_entries ON six_minute_paper(expiry)
  WHERE paper_call IN ('Up','Down');
CREATE TRIGGER IF NOT EXISTS capture_six50_v1 AFTER INSERT ON _checkpoint_data
WHEN NEW.minutes_left=6 AND NEW.expiry>=1794866400 AND NEW.result IS NULL
BEGIN
 INSERT OR IGNORE INTO six_minute_paper
   (round_pt,paper_call,btc_side,btc_confidence,estimated_win_probability,ask_usd,all_in_usd,reason,captured_at,ticker,expiry)
 SELECT NEW.round_pt,CASE WHEN reason='Qualified' THEN NEW.btc_lean ELSE 'Pass' END,
   NEW.btc_lean,NEW.btc_probability,p_win,ask,cost,reason,NEW.captured_at,NEW.ticker,NEW.expiry
 FROM (
  SELECT *,CASE
   WHEN NOT valid OR valid IS NULL THEN 'No timely chart forecast'
   WHEN ask IS NULL OR p_win IS NULL THEN 'No fresh two-sided quote'
   WHEN cost>0.50 THEN 'Over 50 cents'
   WHEN p_win+1e-12<cost+0.05 THEN 'Estimated edge below 5 cents'
   WHEN cost>50.0+COALESCE((SELECT SUM(CASE WHEN result IN ('Up','Down') THEN net_usd ELSE -all_in_usd END)
         FROM six_minute_paper WHERE paper_call IN ('Up','Down')),0)+1e-12 THEN 'Paper balance too low'
   ELSE 'Qualified' END AS reason
  FROM (
   SELECT *,((ticks+(7*ticks*(10000-ticks)+999999)/1000000+99)/100)/100.0 AS cost
   FROM (
    SELECT NEW.ticker=NEW.btc_ticker AND NEW.btc_lean IN ('Up','Down') AND NEW.btc_probability BETWEEN .5 AND 1
         AND unixepoch(NEW.btc_captured_at) BETWEEN NEW.expiry-360 AND NEW.expiry-335 AS valid,
     CASE WHEN NEW.btc_ask>0 AND NEW.btc_ask<1 THEN NEW.btc_ask END AS ask,
     CASE WHEN NEW.btc_ask>0 AND NEW.btc_ask<1 THEN CAST(round(NEW.btc_ask*10000) AS INTEGER) END AS ticks,
     CASE WHEN NEW.midpoint>0 AND NEW.midpoint<1 AND NEW.btc_lean IN ('Up','Down')
          AND NEW.btc_probability BETWEEN .5 AND 1 THEN
        (NEW.btc_probability+CASE NEW.btc_lean WHEN 'Up' THEN NEW.midpoint ELSE 1-NEW.midpoint END)/2 END AS p_win
   )
  )
 );
END;
CREATE TRIGGER IF NOT EXISTS settle_six50_v1 AFTER UPDATE OF result ON _checkpoint_data
WHEN NEW.minutes_left=6 AND OLD.result IS NOT NEW.result
BEGIN
 UPDATE six_minute_paper SET result=CASE WHEN NEW.result IN ('Up','Down') THEN NEW.result END
 WHERE expiry=NEW.expiry AND ticker=NEW.ticker;
END;
CREATE TABLE IF NOT EXISTS six_minute_hybrid_v1 (
  expiry INTEGER PRIMARY KEY,
  ticker TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  quoted_at INTEGER NOT NULL,
  chart_up REAL NOT NULL,
  midpoint REAL NOT NULL,
  hybrid_up REAL NOT NULL CHECK(hybrid_up BETWEEN 0 AND 1),
  direction TEXT NOT NULL,
  paper_call TEXT NOT NULL,
  ask_usd REAL,
  all_in_usd REAL
);
CREATE VIEW IF NOT EXISTS six_minute_hybrid_grades AS
SELECT h.*,c.result,
  CASE WHEN c.result IN ('Up','Down') THEN h.direction=c.result END AS correct,
  CASE WHEN h.paper_call IN ('Up','Down') AND c.result IN ('Up','Down')
       THEN round((h.direction=c.result)-h.all_in_usd,4) END AS net_usd
FROM six_minute_hybrid_v1 h JOIN _checkpoint_data c
ON c.expiry=h.expiry AND c.minutes_left=6 AND c.ticker=h.ticker
AND c.btc_ticker=h.ticker AND c.btc_captured_at=h.captured_at;
-- Execution comparison only. Each row is the same existing six-minute candidate.
-- Use the fresh four-minute executable ask and require the chart to still agree.
CREATE VIEW IF NOT EXISTS six_minute_hybrid_price_test AS
WITH later AS (
  SELECT h.expiry,h.ticker,h.direction,h.all_in_usd AS six_cost,h.net_usd AS six_net,h.result,
         p.btc_lean AS four_direction,p.captured_at AS four_captured_at,
         CASE h.direction WHEN 'Up' THEN p.up_ask ELSE p.down_ask END AS four_ask
  FROM six_minute_hybrid_grades h LEFT JOIN _checkpoint_data p
    ON p.expiry=h.expiry AND p.ticker=h.ticker AND p.btc_ticker=h.ticker AND p.minutes_left=4
    AND unixepoch(p.captured_at) BETWEEN p.expiry-240 AND p.expiry-215
    AND unixepoch(p.btc_captured_at) BETWEEN p.expiry-240 AND p.expiry-215
  WHERE h.paper_call IN ('Up','Down')
), ticks AS (
  SELECT *,CAST(round(four_ask*10000) AS INTEGER) AS t FROM later
), costs AS (
  SELECT *,CASE WHEN t BETWEEN 1 AND 9999 THEN ((t+(7*t*(10000-t)+999999)/1000000+99)/100)/100.0 END AS four_cost FROM ticks
), decisions AS (
  SELECT *,CASE WHEN four_captured_at IS NULL OR four_direction IS NULL OR four_cost IS NULL THEN NULL
    ELSE four_direction=direction AND four_cost<=six_cost-.03+1e-12 END AS cheaper_entry
  FROM costs
)
SELECT expiry,ticker,direction,six_cost,six_net,result,four_captured_at,four_direction,
       four_ask,four_cost,cheaper_entry,
       CASE WHEN result IN ('Up','Down') AND cheaper_entry=1 THEN round((direction=result)-four_cost,4)
            WHEN result IN ('Up','Down') AND cheaper_entry=0 THEN 0 END AS alternative_net
FROM decisions;
