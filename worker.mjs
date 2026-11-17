const KALSHI = 'https://external-api.kalshi.com/trade-api/v2/markets';
const COINBASE = 'https://api.coinbase.com/api/v3/brokerage/market/products/BTC-USD/candles';
const COEFFICIENTS = {
  4: [-0.12030338482416617, 0.8506103310625822, -0.5183379631391526, 0.96039323079072, 0.13174907670712124],
  6: [-0.1968882952074821, 0.5432710617232901, -0.3500470785742486, 1.0759603126121873, 0.037074594818400954],
  8: [-0.1588046004555575, 0.5837931397505581, -0.33057397509174513, 1.0335930201912877, 0.02791935455560988],
  10: [-0.12950981985708304, 0.5291733453484132, -0.2710396904068699, 1.1451825598617165, -0.07172644322755699]
};
// One gross dollar at settlement. A 90-cent ask leaves 10 cents per winning contract.
const MAX_ASK = .90;
const PAYOUT_POLICY = 'min-win-10c';
const SIX_MINUTE_MODEL = 'six-minute-observation-v1';
const PRICE_FITS = {
  4: [0.011011155242991047, 0.601241178168646, 1.2298532960925468, 0.1284393899582682],
  6: [-0.10536618028479769, 0.5217297593621257, 1.0631894272600717, 0.01319105439953532],
  8: [-0.0815501766346952, 0.5458106427186011, 1.0613944278179865, 0.01394421187136076],
  10: [-0.05795932192494235, 0.5800192589964934, 1.0549556857672477, -0.052563642881360464]
};
const ORIGINAL = {model_id:'original',intercept:0,slope:1,weight:0};
const REVIEW_SIZE = 384;
const ptDate = new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',month:'short',day:'numeric',year:'numeric'});
const ptTime = new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',hour:'numeric',minute:'2-digit',hour12:true});
const clock = t => ptDate.format(t*1000)+' · '+ptTime.format(t*1000).replace(/\s/g,'').toLowerCase();
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
const bound = (n,low,high) => Math.min(high,Math.max(low,n));
const logistic = x => 1/(1+Math.exp(-x));
const logit = p => Math.log(p/(1-p));
const now = () => Date.now()/1000;
const epoch = s => Date.parse(s)/1000;
function number(input) {
  const n = Number(input);
  if (input==null || input==='' || !Number.isFinite(n)) throw Error('missing numeric input');
  return n;
}
async function data(url,params={}) {
  const u=new URL(url);
  for(const [k,v] of Object.entries(params)) u.searchParams.set(k,v);
  const r=await fetch(u,{cache:'no-store',signal:AbortSignal.timeout(7500),headers:{Accept:'application/json'}});
  if(!r.ok) throw Error(u.hostname+' returned '+r.status);
  return {body:await r.json(),date:epoch(r.headers.get('date'))};
}
// Six-minute prospective research model. Frozen after the November 16 archive.
const HYBRID_WEIGHTS = [-0.006079281207743095, 0.9156343909747083, 0.08597076452869983, 0.17997634937783197, 0.017422264741965527, 0.09122220704985028];
const FIRST_HYBRID_EXPIRY = 1794938400;

export function hybridProbability(inputs, midpoint, spread) {
  const market = bound(logit(midpoint), -6, 6);
  const features = [1, market, ...inputs.slice(1).map(Math.asinh), market * Math.min(10 * spread, 1)];
  return logistic(features.reduce((sum, x, i) => sum + x * HYBRID_WEIGHTS[i], 0));
}

export function hybridEntry(p, upAsk, downAsk) {
  const direction = p >= 0.5 ? 'Up' : 'Down';
  const ask = direction === 'Up' ? upAsk : downAsk;
  if (!(ask > 0 && ask < 1)) return {direction, ask:null, cost:null, call:'No quote'};
  const ticks = Math.round(ask * 10000);
  const feeTicks = Math.ceil(7 * ticks * (10000 - ticks) / 1000000);
  const cost = Math.ceil((ticks + feeTicks) / 100) / 100;
  const confidence = Math.max(p, 1-p);
  const eligible = confidence >= .60 && cost <= .90 && confidence + 1e-12 >= cost + .05;
  return {direction, ask, cost, call:eligible ? direction : 'Pass'};
}

export function model(candles,at,target,bid,ask,left) {
  const bars=new Map(candles.map(b=>[Number(b.start),b]));
  const prices=[];
  for(let t=at-61*60;t<at;t+=60) prices.push(number(bars.get(t)?.close));
  const btc=prices[60];
  const vol=Math.sqrt(prices.slice(1).reduce((sum,p,i)=>sum+(p-prices[i])**2,0)/60);
  if(!(vol>0)) throw Error('missing volatility');
  const opening=bars.get(at-(15-left)*60-60);
  const anchor=['open','high','low','close'].reduce((s,k)=>s+number(opening?.[k]),0)/4;
  const recent=prices.slice(-13);
  const recentVariance=recent.slice(1).reduce((s,v,i)=>s+(v-recent[i])**2,0)/12;
  const fastVol=Math.sqrt((vol**2+recentVariance)/2);
  const fastHorizon=fastVol*Math.sqrt(left-.5);
  const inputs=[1,bound((btc-target)/fastHorizon,-8,8),bound((btc-anchor)/fastHorizon,-8,8),
    bound((btc-prices[57])/(fastVol*Math.sqrt(3)),-8,8)];
  const price_up=logistic(inputs.reduce((s,v,i)=>s+PRICE_FITS[left][i]*v,0));
  if(!(bid>0 && bid<=ask && ask<1)) return {btc,price_up,midpoint:null,raw_up:null};
  const horizon=vol*Math.sqrt(left-.5);
  const midpoint=(bid+ask)/2;
  const features=[logit(midpoint),bound((btc-target)/horizon,-8,8),bound((btc-anchor)/horizon,-8,8),bound((btc-prices[57])/(vol*Math.sqrt(3)),-8,8)];
  const [intercept,...weights]=COEFFICIENTS[left];
  const raw_up=logistic(features.reduce((s,v,i)=>s+weights[i]*v,intercept));
  return {btc,midpoint,raw_up,price_up,hybrid_up:left===6 ? hybridProbability(inputs,midpoint,ask-bid) : null};
}
export function decision(row,config) {
  const adjusted = config.intercept===0 && config.slope===1 ? row.raw_up :
    logistic(config.intercept+config.slope*logit(bound(row.raw_up,1e-12,1-1e-12)));
  const p=(1-config.weight)*adjusted+config.weight*row.midpoint;
  const lean=p>=.5?'Up':'Down', conf=Math.max(p,1-p);
  const ask=lean==='Up'?row.up_ask:row.down_ask;
  return {p,lean,probability:conf,ask,decision:ask!=null && ask<=MAX_ASK && conf>=.9 && conf>ask+1e-12?lean:'Pass'};
}
async function latestReview(env) {
  const row=await env.DB.prepare(
    'SELECT expiry,calibration_review FROM _checkpoint_data WHERE minutes_left=8 '+
    'AND calibration_review IS NOT NULL ORDER BY expiry DESC LIMIT 1'
  ).first();
  if(!row) return null;
  const {model_id,intercept,slope,weight}=JSON.parse(row.calibration_review);
  return {end_expiry:row.expiry,model_id,intercept,slope,weight};
}
function offer(price,size) { const p=Number(price); return p>0 && p<1 && Number(size)>=1?p:null; }
function sixMinuteTrial(signal,priorLean) {
  if(!priorLean) return null;
  if(signal.ask==null) return 'No data';
  return signal.lean===priorLean ? signal.decision : 'Pass';
}
function agreementSignal(d,priceUp) {
  if(d.decision!=='Pass' || d.ask==null || d.ask>MAX_ASK || !Number.isFinite(priceUp)) return null;
  const btcProbability=d.lean==='Up'?priceUp:1-priceUp;
  const lowerEstimate=Math.min(d.probability,btcProbability);
  return lowerEstimate>=.85 && lowerEstimate-d.ask>=.03-1e-12 ? d.lean : null;
}
async function agreementQualified(env,expiry) {
  const {results}=await env.DB.prepare(
    'SELECT agreement_call,ask,result,agreement_recheck_call,agreement_recheck_ask FROM _checkpoint_data '+
    'WHERE minutes_left=8 AND agreement_call IS NOT NULL AND result IS NOT NULL AND expiry<? '+
    'ORDER BY expiry DESC LIMIT 24'
  ).bind(expiry).all();
  if(results.length!==24) return false;
  for(let i=0;i<24;i+=12){
    let wins=0,recheckWins=0,gross=0,recheckGross=0;
    for(const row of results.slice(i,i+12)){
      if(!['Pass','Up','Down'].includes(row.agreement_recheck_call)) return false;
      const hit=Number(row.result===row.agreement_call);
      wins+=hit; gross+=hit-row.ask;
      if(row.agreement_recheck_call!=='Pass'){
        if(row.agreement_recheck_ask==null) return false;
        const fallbackHit=Number(row.result===row.agreement_recheck_call);
        recheckWins+=fallbackHit; recheckGross+=fallbackHit-row.agreement_recheck_ask;
      }
    }
    if(wins<10 || wins<=recheckWins || gross<=Math.max(0,recheckGross)+1e-9) return false;
  }
  return true;
}
async function capture(at,left,env) {
  const expiry=at+60*left;
  if(await env.DB.prepare('SELECT 1 FROM _checkpoint_data WHERE expiry=? AND minutes_left=?').bind(expiry,left).first()) return;
  if(left===8 && await env.DB.prepare('SELECT 1 FROM _checkpoint_data WHERE expiry=? AND minutes_left=5').bind(expiry).first()) return;
  let primary, challenger;
  if(left===4 || left===6){
    const prior=await env.DB.prepare(
      'SELECT minutes_left,lean,decision,agreement_call,agreement_recheck_call,btc_lean,btc_decision '+
      'FROM _checkpoint_data WHERE expiry=? AND minutes_left IN (5,8) ORDER BY minutes_left DESC LIMIT 1'
    ).bind(expiry).first();
    primary=prior;
    if(prior) challenger={minutes_left:prior.minutes_left,lean:prior.btc_lean,decision:prior.btc_decision};
  }
  const priorPass=prior=>prior?.minutes_left===8 && prior.decision==='Pass' ? prior.lean : null;
  const entered=prior=>['Up','Down'].includes(prior?.decision);
  const compareRecheck=left===4 && primary?.agreement_call!=null && primary.agreement_recheck_call==null;
  const comparison=()=>env.DB.prepare('UPDATE _checkpoint_data SET agreement_recheck_call=?,agreement_recheck_ask=? WHERE expiry=? AND minutes_left=8 AND agreement_recheck_call IS NULL');
  const config=(left===8 && await latestReview(env)) || ORIGINAL;
  const insert=env.DB.prepare('INSERT OR IGNORE INTO _checkpoint_data(expiry,minutes_left,round_pt,captured_at,ticker,decision,lean,probability,ask,btc,target,model_id,raw_up,midpoint,up_ask,down_ask,agreement_call,six_trial_call,detail,btc_captured_at,btc_ticker,btc_lean,btc_probability,btc_ask,btc_decision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  let reason='Scheduler arrived outside the 25-second checkpoint';
  for(let attempt=0;attempt<5 && now()<=at+25;attempt++){
    try{
      const [listed,bars]=await Promise.all([
        data(KALSHI,{series_ticker:'KXBTC15M',status:'open',limit:10}),
        data(COINBASE,{start:at-65*60,end:at,granularity:'ONE_MINUTE'})
      ]);
      const listedMarket=listed.body.markets.find(m=>epoch(m.close_time)===expiry);
      if(!listedMarket) throw Error('matching open market unavailable');
      // An active listing supplies the official target even if the order book is unavailable.
      const quoted=await data(KALSHI+'/'+encodeURIComponent(listedMarket.ticker)).catch(()=>null);
      const captured=now(), m=quoted?.body.market ?? listedMarket;
      if(!(captured>=at && captured<=at+25)) throw Error('outside checkpoint');
      if(m.status!=='active'||m.result||m.ticker!==listedMarket.ticker||epoch(m.close_time)!==expiry||epoch(m.open_time)!==expiry-900) throw Error('ineligible market');
      const target=number(m.floor_strike);
      if(target<=0) throw Error('missing price to beat');
      const fresh=quoted!=null && quoted.date>=at && captured>=quoted.date && captured-quoted.date<=12;
      const bid=fresh ? Number(m.yes_bid_dollars) : null;
      const ask=fresh ? Number(m.yes_ask_dollars) : null;
      const row=model(bars.body.candles,at,target,bid,ask,left);
      const crossed=bid>0 && ask>0 && bid>ask;
      row.up_ask=fresh && !crossed ? offer(m.yes_ask_dollars,m.yes_ask_size_fp) : null;
      row.down_ask=fresh && !crossed ? offer(m.no_ask_dollars,m.yes_bid_size_fp) : null;
      const d=row.raw_up==null ? {lean:null,probability:null,ask:null,decision:'No data'} : decision(row,config);
      const independent=decision({...row,raw_up:row.price_up},ORIGINAL);
      function checkpointCall(signal,prior) {
        if(!signal.lean) return 'No data';
        if(left===10 || (left===4 && entered(prior))) return 'Watch';
        return signal.ask==null ? 'No data' : signal.decision;
      }
      let call=checkpointCall(d,primary), trialCall=checkpointCall(independent,challenger);
      let modelId=config.model_id;
      if(left===10) modelId='ten-minute watch';
      if(left===6){
        modelId=SIX_MINUTE_MODEL;
        call=d.lean ? 'Watch' : 'No data';
        trialCall=sixMinuteTrial(independent,priorPass(challenger)) ?? 'Watch';
      }
      if(left===4) modelId='four-minute-regular-v1';
      const capturedAt=new Date(captured*1000).toISOString();
      const writes=[];
      const agreement=left===8?agreementSignal(d,row.price_up):null;
      if(agreement && await agreementQualified(env,expiry)){
        call=agreement;
        modelId+='|agreement-85';
      }
      // Keep the original same-side comparison used by the eight-minute agreement trial.
      if(compareRecheck) writes.push(comparison().bind(sixMinuteTrial(d,primary.lean) ?? 'No data',d.ask,expiry));
      if(left===8) modelId='eight-minute-'+modelId;
      if(left===8 || left===4) modelId+='|'+PAYOUT_POLICY;
      const detail=call==='No data' ? (row.raw_up==null?'No fresh two-sided quote':'No executable ask') : null;
      writes.push(insert.bind(expiry,left,clock(expiry),capturedAt,
        m.ticker,call,d.lean,d.probability,d.ask,row.btc,target,modelId,
        row.raw_up,row.midpoint,row.up_ask,row.down_ask,agreement,left===6?sixMinuteTrial(d,priorPass(primary)):null,detail,
        capturedAt,m.ticker,independent.lean,independent.probability,independent.ask,trialCall));
      if (left===6 && expiry>=FIRST_HYBRID_EXPIRY && Number.isFinite(row.hybrid_up)) {
        const entry = hybridEntry(row.hybrid_up, row.up_ask, row.down_ask);
        const archive = env.DB.prepare(
          'INSERT OR IGNORE INTO six_minute_hybrid_v1 ' +
          '(expiry,ticker,captured_at,quoted_at,chart_up,midpoint,hybrid_up,direction,paper_call,ask_usd,all_in_usd) ' +
          'SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM _checkpoint_data ' +
          'WHERE expiry=? AND minutes_left=6 AND ticker=? AND btc_ticker=ticker AND btc_captured_at=? AND result IS NULL)'
        );
        writes.push(archive.bind(expiry,m.ticker,capturedAt,quoted.date,row.price_up,row.midpoint,
          row.hybrid_up,entry.direction,entry.call,entry.ask,entry.cost,expiry,m.ticker,capturedAt));
      }
      await env.DB.batch(writes);
      return;
    }catch(e){ reason=String(e.message).slice(0,180); if(now()<at+24) await sleep(650); }
  }
  const capturedAt=new Date().toISOString();
  const missed=[env.DB.prepare("INSERT OR IGNORE INTO _checkpoint_data(expiry,minutes_left,round_pt,captured_at,decision,detail,model_id,btc_captured_at,btc_decision) VALUES(?,?,?,?,'No data',?,?,?,'No data')")
    .bind(expiry,left,clock(expiry),capturedAt,reason,left===6?SIX_MINUTE_MODEL:null,capturedAt)];
  if(compareRecheck) missed.push(comparison().bind('No data',null,expiry));
  await env.DB.batch(missed);
}
async function settle(env) {
  const rows=await env.DB.prepare(
    'SELECT expiry,ticker FROM _checkpoint_data WHERE result IS NULL '+
    'AND ticker IS NOT NULL AND expiry<=? GROUP BY expiry,ticker ORDER BY MIN(last_settle_check),expiry LIMIT 8'
  ).bind(Math.floor(now())).all();
  for(const row of rows.results) {
    await env.DB.prepare('UPDATE _checkpoint_data SET last_settle_check=? WHERE expiry=? AND ticker=? AND result IS NULL')
      .bind(Math.floor(now()),row.expiry,row.ticker).run();
    try {
      const m=(await data(KALSHI+'/'+encodeURIComponent(row.ticker))).body.market;
      if(m.ticker!==row.ticker||!['finalized','settled'].includes(m.status)||!['yes','no'].includes(m.result)) continue;
      const result=m.result==='yes'?'Up':'Down';
      const final=number(m.expiration_value);
      await env.DB.prepare("UPDATE _checkpoint_data SET result=?,final_index=?,gross_usd=CASE WHEN decision IN ('Up','Down') THEN round((decision=?)-ask,4) ELSE NULL END WHERE expiry=? AND ticker=? AND result IS NULL")
        .bind(result,final,result,row.expiry,row.ticker).run();
    } catch(e){console.warn('Settlement retry',row.ticker,String(e.message));}
  }
}
export function fit(rows) {
  let intercept=0,slope=1;
  const logs=rows.map(r=>[logit(bound(r.raw_up,1e-12,1-1e-12)),Number(r.result==='Up')]);
  for(let step=0;step<80;step++){
    let a=0,b=0;
    for(let i=0;i<logs.length;i++){
      const [x,y]=logs[i],res=logistic(intercept+slope*x)-y;
      a+=res;b+=res*x;
    }
    intercept=bound(intercept-.25*(a/logs.length+.02*intercept),-.5,.5);
    slope=bound(slope-.25*(b/logs.length+.02*(slope-1)),.65,1.5);
  }
  return {model_id:'recalibrated',intercept,slope,weight:0};
}
export function evaluate(rows,config) {
  let brier=0,hits=0,entries=0,wins=0,gross=0;
  for(const row of rows){
    const d=decision(row,config),y=Number(row.result==='Up'),hit=Number(row.result===d.lean);
    brier+=(d.p-y)**2;hits+=hit;
    if(d.decision!=='Pass'){entries++;wins+=hit;gross+=hit-d.ask;}
  }
  return {brier:brier/rows.length,accuracy:hits/rows.length,entries,wins,hit_rate:entries?wins/entries:0,gross:Math.round(gross*10000)/10000};
}
export function select(train,test,current) {
  const end=test[test.length-1].expiry;
  const candidates=[ORIGINAL,fit(train),{...ORIGINAL,model_id:'market-blend',weight:.5}];
  const baseline=evaluate(test,current);
  const market=evaluate(test,{...ORIGINAL,weight:1});
  const accepted=[];
  const metrics={current:baseline,market};
  for(const cfg of candidates){
    const r=evaluate(test,cfg);metrics[cfg.model_id]=r;
    if(r.brier+.001<=baseline.brier && r.accuracy>=baseline.accuracy &&
       r.entries>=Math.max(25,.8*baseline.entries) && r.hit_rate>=Math.max(.9,baseline.hit_rate) &&
       r.gross>0 && r.gross>=baseline.gross && r.brier<market.brier && r.accuracy>=market.accuracy)
      accepted.push(cfg);
  }
  accepted.sort((a,b)=>metrics[a.model_id].brier-metrics[b.model_id].brier || a.model_id.localeCompare(b.model_id));
  const chosen={...(accepted[0] || current)};
  if(chosen.model_id==='recalibrated') chosen.model_id='cal-'+end;
  return {chosen,metrics};
}
async function review(env) {
  const previous=await latestReview(env);
  const filter='minutes_left=8 AND result IS NOT NULL AND raw_up IS NOT NULL';
  let last=previous?.end_expiry;
  if (!last) {
    const initial=await env.DB.prepare('SELECT expiry FROM _checkpoint_data WHERE '+filter+' ORDER BY expiry LIMIT 1 OFFSET 383').first();
    if(!initial) return;
    last=initial.expiry;
  }
  // Check just one indexed key before loading a full block.
  const complete=await env.DB.prepare('SELECT expiry FROM _checkpoint_data WHERE '+filter+' AND expiry>? ORDER BY expiry LIMIT 1 OFFSET 383').bind(last).first();
  if(!complete) return;
  const cols='expiry,raw_up,midpoint,up_ask,down_ask,result';
  const read='SELECT '+cols+' FROM _checkpoint_data WHERE '+filter;
  const [training,validation]=await env.DB.batch([
    env.DB.prepare(read+' AND expiry<=? ORDER BY expiry DESC LIMIT 2048').bind(last),
    env.DB.prepare(read+' AND expiry>? AND expiry<=? ORDER BY expiry LIMIT 384').bind(last,complete.expiry)
  ]);
  const train=training.results.reverse(),test=validation.results;
  if(train.length<REVIEW_SIZE || test.length!==REVIEW_SIZE) return;
  const {chosen,metrics}=select(train,test,previous || ORIGINAL);
  const {model_id,intercept,slope,weight}=chosen;
  const record=JSON.stringify({model_id,intercept,slope,weight,train_end:last,metrics});
  await env.DB.prepare(
    'UPDATE _checkpoint_data SET calibration_review=? WHERE expiry=? AND minutes_left=8 '+
    'AND calibration_review IS NULL'
  ).bind(record,complete.expiry).run();
}
// Cron dispatch can arrive partway through a minute. Start one minute
// early and fetch at the original checkpoint, keeping the 25-second cutoff.
export async function dispatch(at,env,observe=capture,pause=sleep,readTime=now) {
  const offset=Math.floor(at/60)%15;
  if(offset===2){await settle(env);await review(env);return;}
  if(![4,6,8,9].includes(offset)) return; // 8/9 also cover a four-minute checkpoint during cron propagation.
  const roundStart=at-offset*60;
  for(const left of [10,8,6,4]){
    const checkpoint=roundStart+(15-left)*60;
    if(checkpoint<at) continue;
    const ms=Math.max(0,Math.ceil((checkpoint+0.25-readTime())*1000));
    if(ms>0) await pause(ms);
    await observe(checkpoint,left,env);
  }
}
export const run=dispatch;
export default {
  async scheduled(event,env){await run(Math.floor(event.scheduledTime/60000)*60,env);},
  async fetch(){return new Response('Private paper watcher. Results are available in Cloudflare D1 Studio.',{status:404});}
};
