import assert from 'node:assert/strict';
import {dispatch} from '../worker.mjs';

const realNow = Date.now;
const realTimeout = globalThis.setTimeout;
const realFetch = globalThis.fetch;
try {
  for (const broken of [true, false]) {
    let time = 1795192200 + 4 * 60;
    let fetches = 0, dbCalls = 0;
    const writes = [];
    Date.now = () => time * 1000;
    globalThis.setTimeout = (callback, ms) => { time += ms / 1000; callback(); return 0; };
    globalThis.fetch = async url => {
      fetches++;
      const at = Math.floor(time / 60) * 60;
      const expiry = Math.floor(at / 900) * 900 + 900;
      const market = {
        ticker: 'SYNTHETIC', status: 'active', floor_strike: 50000,
        close_time: new Date(expiry * 1000).toISOString(),
        open_time: new Date((expiry - 900) * 1000).toISOString(),
        yes_bid_dollars: '.50', yes_ask_dollars: '.52', no_ask_dollars: '.50',
        yes_ask_size_fp: '1', yes_bid_size_fp: '1'
      };
      const isCandles = String(url).includes('coinbase');
      const candles = broken ? [] : Array.from({length: 61}, (_, i) => ({
        start: at - (61 - i) * 60, open: 50000+i, high: 50002+i, low: 49999+i, close: 50001+i
      }));
      const body = isCandles ? {candles} : new URL(url).pathname.endsWith('/markets') ? {markets:[market]} : {market};
      return new Response(JSON.stringify(body), {headers:{date:new Date(at * 1000).toUTCString()}});
    };
    const DB = {
      prepare(sql) {
        return {
          bind(...args) { return {...this, args}; },
          async first() { dbCalls++; return null; },
          async run() { dbCalls++; writes.push({sql, args:this.args}); }
        };
      },
      async batch(statements) { dbCalls += statements.length; writes.push(...statements); }
    };
    await dispatch(time, {DB}, undefined, async ms => {time += ms / 1000;}, () => time);
    assert.ok(fetches + dbCalls < 50);
    if (broken) {
      assert.equal(fetches,36);
      assert.equal(writes.length,4);
      assert.deepEqual(writes.map(w=>w.args[1]),[10,8,6,4]);
      assert.ok(writes.every(w=>w.args[4]==='missing numeric input'));
    } else {
      assert.equal(fetches,12);
      assert.equal(writes.length,5); // Four checkpoints plus the six-minute hybrid.
    }
    console.log({broken,fetches,dbCalls,writes:writes.length});
  }
} finally {
  Date.now = realNow;
  globalThis.setTimeout = realTimeout;
  globalThis.fetch = realFetch;
}
