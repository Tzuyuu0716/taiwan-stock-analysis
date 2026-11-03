# taiwan-stock-mcp

MCP server for the [`taiwan-stock-analysis`](../../SKILL.md) skill. Wraps TWSE
(上市) and TPEx (上櫃/興櫃) public data so Claude can look up market tier,
daily price history, 三大法人買賣超, 融資融券餘額, TDCC 集保戶股權分散表, company profile, and
ticker-by-name search — the data sources `references/mcp_data_sources.md`
calls for.

## Tools

| Tool | Purpose |
|---|---|
| `get_stock_market_type` | Resolve a ticker to 上市/上櫃/興櫃 — call this first |
| `get_daily_price` | Daily OHLCV for a date range |
| `get_institutional_flows` | 外資/投信/自營商買賣超 |
| `get_margin_trading` | 融資融券餘額 |
| `get_shareholding_distribution` | 集保戶股權分散表：各級距人數/比例、大戶（400 張以上）持股比例；上市/上櫃/興櫃皆適用 |
| `get_company_profile` | Company name, listing date, industry, capital, etc. |
| `search_ticker_by_name` | Look up a ticker from a company name |

## Data sources for history

| Data | 上市 (TWSE) | 上櫃 (TPEx) |
|---|---|---|
| Daily price (per ticker, per month) | `rwd/zh/afterTrading/STOCK_DAY` | `www/zh-tw/afterTrading/tradingStock` |
| 三大法人 (whole market, per day) | `rwd/zh/fund/T86` (`selectType=ALLBUT0999`) | `www/zh-tw/insti/dailyTrade` |
| 融資融券 (whole market, per day, 單位：張) | `rwd/zh/marginTrading/MI_MARGN` | `www/zh-tw/margin/balance` |

TPEx's OpenAPI (`www.tpex.org.tw/openapi/v1/*`) ignores any date parameter and only
serves the latest day, so history comes from the TPEx website's JSON endpoints
(`?response=json`). Column mappings were checked against the OpenAPI snapshot for
the same day and against accounting identities (外資+投信+自營=合計;
前日餘額+買進−賣出−償還=今日餘額) on every row. Note `TWT93U` is *not* 融資融券 — it
is 信用額度總量管制餘額表 (融券 + 借券賣出).

興櫃 has no history endpoint, so `get_daily_price` returns the latest quote only,
with a `limitationNote`. ETFs: TWSE's are in `opendata/t187ap47_L`; TPEx publishes
no ETF list, so `00`-prefixed codes are looked up in `tpex_3insti_daily_trading`.

## Caching, rate limits, partial results

- Closed trading days and past months are cached on disk in
  `~/.cache/taiwan-stock-mcp/` (~100 KB per trading day). Files older than 90 days
  are deleted at startup. Delete the directory to clear it.
- Requests are spaced 2 s apart for TWSE (it bans IPs above ~3 requests / 5 s) and
  1 s for TPEx, shared across server processes via a lock file in the cache dir.
  15 s timeout, 2 retries.
- Each call stops after 45 s (MCP clients drop calls at ~60 s) and returns what it
  got; missing days/months are listed in `limitationNote`, and calling again fills
  them in from cache. Cold: ~2.5 s per day on TWSE, ~1.2 s on TPEx.

## 興櫃 chip data

興櫃 is outside both the margin-trading and the 三大法人 regimes, so for 興櫃 tickers
`get_institutional_flows` / `get_margin_trading` return empty `rows` plus a
`limitationNote` pointing to `get_shareholding_distribution`. Sources (also cited in `src/marketRouter.ts`):

- 融資融券: [有價證券得為融資融券標準 §2](https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=G0400009&flno=2),
  [證券商辦理有價證券買賣融資融券業務操作辦法](https://twse-regulation.twse.com.tw/m/LawContent.aspx?FID=FL007121)
  (「…及興櫃股票，其融資比率為零」)
- 三大法人: TPEx files these reports under 上櫃 only
  ([3insti summary](https://www.tpex.org.tw/web/stock/3insti/3insti_summary/3itrdsum.php?l=zh-tw)),
  and `tpex_3insti_daily_trading` contains no 興櫃 codes. No explicit official
  exclusion text was found; this is based on scope and actual coverage.

## Known limitation: TDCC distribution history

- Latest week: open data CSV `opendata.tdcc.com.tw/getOD.ashx?id=1-5` (whole
  market, one week only, no date parameter).
- Older weeks (`weeks > 1`): scraped from the web form
  `www.tdcc.com.tw/portal/zh/smWeb/qryStock` (~1 year of weekly dates). No
  captcha, but a single-use CSRF token, so each week costs a GET + POST; requests
  are spaced 500 ms apart and cached. If the form fails or changes, the tool
  returns the weeks it got plus a `limitationNote`.
- Big-holder tiers are derived from TDCC's own range labels (lower bound above
  400,000 shares), not hardcoded tier numbers.

## Build

```bash
npm install
npm run build
npm test   # live smoke test against real TDCC/TPEx/TWSE endpoints
```

## Register with Claude Code

```bash
claude mcp add taiwan-stock -- node "<absolute-path-to>/scripts/mcp-server/dist/index.js"
```

Or add directly to your MCP config (`.claude.json` / `.mcp.json`):

```json
{
  "mcpServers": {
    "taiwan-stock": {
      "command": "node",
      "args": ["<absolute-path-to>/scripts/mcp-server/dist/index.js"]
    }
  }
}
```

Rebuild (`npm run build`) after editing `src/`; the server runs the compiled
`dist/index.js`, not the TypeScript source.
