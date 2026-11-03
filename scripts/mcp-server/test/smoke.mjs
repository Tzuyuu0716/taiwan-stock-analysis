// Live smoke test: spawns the built server over stdio and calls the tools against
// real TDCC/TPEx/TWSE endpoints. Run after `npm run build`: `npm test`.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EMERGING = ["1260", "1271", "1293"]; // 興櫃 at time of writing; re-check if a test fails on marketType
const LISTED = "2330";

const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"] }));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  assert.ok(!r.isError, `${name} ${JSON.stringify(args)} errored: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text);
};

for (const ticker of [...EMERGING, LISTED]) {
  const d = await call("get_shareholding_distribution", { ticker, weeks: 3 });
  const expected = ticker === LISTED ? "TWSE" : "TPEx_Emerging";
  assert.equal(d.marketType, expected, `${ticker} marketType`);
  assert.equal(d.weekCount, 3, `${ticker} weeks: ${d.limitationNote}`);
  for (const w of d.weeks) {
    assert.ok(w.tiers.length === 15 && w.tiers.every((t) => t.range), `${ticker} ${w.date} tiers labelled`);
    assert.ok(w.bigHolderLevels.length > 0 && w.bigHolderLevels.every((l) => l >= 12), `${ticker} big tiers`);
    const pctSum = w.tiers.reduce((a, t) => a + t.pct, 0);
    assert.ok(Math.abs(pctSum - 100) < 0.5, `${ticker} ${w.date} pct sums to ~100 (${pctSum})`);
  }
  assert.ok(d.weeks[0].date > d.weeks[1].date, `${ticker} newest first`);
  console.log(ticker, d.marketLabel, d.weeks.map((w) => `${w.date} 大戶${w.bigHolderPct}% 人數${w.totalHolders}`).join(" | "));
}

// 興櫃: chip tools redirect; 上市: unchanged (returns data rows, no emerging note).
const flows = await call("get_institutional_flows", { ticker: EMERGING[0], days: 5 });
const margin = await call("get_margin_trading", { ticker: EMERGING[0], days: 5 });
for (const r of [flows, margin]) {
  assert.equal(r.rowCount, 0);
  assert.match(r.limitationNote, /get_shareholding_distribution/);
}
const listedFlows = await call("get_institutional_flows", { ticker: LISTED, days: 5 });
assert.ok(listedFlows.rowCount > 0 && !listedFlows.limitationNote, "上市三大法人行為不變");
const listedMargin = await call("get_margin_trading", { ticker: LISTED, days: 5 });
assert.ok(listedMargin.rowCount > 0 && !listedMargin.limitationNote, "上市融資融券行為不變");

// ETF: 0050 is not in the company list, only the ETF list.
const etf = await call("get_stock_market_type", { ticker: "0050" });
assert.equal(etf.marketType, "TWSE", "0050 is 上市 ETF");
const etfFlows = await call("get_institutional_flows", { ticker: "0050", days: 5 });
assert.ok(etfFlows.rowCount === 5, `0050 flows: ${etfFlows.limitationNote}`);

// OTC ETF: 00679B is in neither company list, found via the TPEx 3-institution table.
const otcEtf = await call("get_stock_market_type", { ticker: "00679B" });
assert.equal(otcEtf.marketType, "TPEx_OTC", "00679B is 上櫃 ETF");
const otcHits = await call("search_ticker_by_name", { name: "美債20年" });
assert.ok(otcHits.hits.some((h) => h.ticker === "00679B"), "search finds 00679B");

// OTC flows must add up: 外資 + 投信 + 自營 = 合計 (catches mis-picked TPEx columns).
for (const t of ["00679B", "6488"]) {
  const [r] = (await call("get_institutional_flows", { ticker: t })).rows;
  assert.equal(r.foreignNet + r.investmentTrustNet + r.dealerNet, r.totalNet, `${t} flows sum`);
}

// Cache: same days were fetched for 2330 above, so a different ticker needs no network.
const t0 = Date.now();
await call("get_margin_trading", { ticker: "0050", days: 5 });
await call("get_institutional_flows", { ticker: "2317", days: 5 });
assert.ok(Date.now() - t0 < 5000, `cached calls took ${Date.now() - t0}ms`);

// Daily price: reversed range is an error, not a silent empty result; past months are cached.
const bad = await client.callTool({
  name: "get_daily_price",
  arguments: { ticker: LISTED, start_date: "2026-11-03", end_date: "2026-07-01" },
});
assert.ok(bad.isError && /晚於/.test(bad.content[0].text), "reversed range errors");
const range = { ticker: LISTED, start_date: "2026-07-01", end_date: "2026-10-31" };
const p1 = await call("get_daily_price", range);
assert.ok(p1.rowCount > 60 && !p1.limitationNote, `daily price: ${p1.limitationNote}`);
const t1 = Date.now();
assert.equal((await call("get_daily_price", range)).rowCount, p1.rowCount);
assert.ok(Date.now() - t1 < 3000, `cached daily price took ${Date.now() - t1}ms`);

await client.close();
console.log("smoke OK");
