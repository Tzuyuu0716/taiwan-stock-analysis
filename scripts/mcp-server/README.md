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

## Known limitation: TPEx history

TWSE exposes classic per-ticker, per-date-range endpoints (`www.twse.com.tw/rwd/zh/...`),
so `get_daily_price` / `get_institutional_flows` / `get_margin_trading` return full
history for 上市 stocks.

TPEx's public OpenAPI (`www.tpex.org.tw/openapi/v1/*`) has **no historical
per-ticker endpoint** — every endpoint always returns the latest whole-market
snapshot regardless of any date parameter (verified by comparing responses with
and without `date=`). So for 上櫃 tickers those three tools, and `get_daily_price`
for 興櫃, can only ever return the single most recent trading day, with a
`limitationNote` explaining why. This is an upstream API constraint, not a bug — see the module comment at
the top of `src/tpexClient.ts`.

## 興櫃 chip data

興櫃 is outside both the margin-trading and the 三大法人 regimes, so for 興櫃 tickers
`get_institutional_flows` / `get_margin_trading` return empty `rows` plus a
`limitationNote` pointing to `get_shareholding_distribution`. 上市/上櫃 behavior is
unchanged. Sources (also cited in `src/marketRouter.ts`):

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
