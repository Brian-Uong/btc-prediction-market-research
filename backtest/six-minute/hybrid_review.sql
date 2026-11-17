-- Counts are paired distinct six-minute rounds. Official settlement grades all three forecasts.
SELECT count(*) AS paired_captures, count(CASE WHEN result IN ('Up','Down') THEN 1 END) AS graded,
       sum(CASE WHEN result IN ('Up','Down') THEN direction=result END) AS hybrid_correct,
       sum(CASE WHEN result IN ('Up','Down') THEN (chart_up>=0.5)=(result='Up') END) AS chart_correct,
       sum(CASE WHEN result IN ('Up','Down') THEN (midpoint>=0.5)=(result='Up') END) AS midpoint_correct,
       round(avg(CASE WHEN result IN ('Up','Down') THEN (hybrid_up-(result='Up'))*(hybrid_up-(result='Up')) END),6) AS hybrid_brier,
       round(avg(CASE WHEN result IN ('Up','Down') THEN (chart_up-(result='Up'))*(chart_up-(result='Up')) END),6) AS chart_brier,
       round(avg(CASE WHEN result IN ('Up','Down') THEN (midpoint-(result='Up'))*(midpoint-(result='Up')) END),6) AS midpoint_brier,
       count(CASE WHEN paper_call IN ('Up','Down') AND result IN ('Up','Down') THEN 1 END) AS graded_entries,
       count(CASE WHEN paper_call=result THEN 1 END) AS wins,
       coalesce(round(sum(net_usd),4),0) AS net_usd
FROM six_minute_hybrid_grades;

-- Compare the two entry times on the identical opportunities that had a four-minute observation.
SELECT count(*) AS eligible_six_minute_signals,
       count(CASE WHEN alternative_net IS NOT NULL THEN 1 END) AS paired_graded,
       sum(CASE WHEN alternative_net IS NOT NULL THEN cheaper_entry END) AS four_minute_entries,
       round(sum(CASE WHEN alternative_net IS NOT NULL THEN six_net END),4) AS immediate_net,
       round(sum(alternative_net),4) AS alternative_net
FROM six_minute_hybrid_price_test;
