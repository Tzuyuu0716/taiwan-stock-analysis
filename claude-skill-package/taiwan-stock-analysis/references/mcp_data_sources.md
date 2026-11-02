# 建議串接的 MCP / 資料源

台股（尤其興櫃）目前沒有現成的專用 MCP，所以採「雙軌」策略：一個自建 MCP 負責完整台股覆蓋，一個既有連接器負責輔助的國際化技術指標運算。

## 1. 自建 MCP Server（主力，必須）

這是唯一能完整涵蓋上市 + 上櫃 + 興櫃 + 台股特有籌碼面資料的方式。用 Claude Code 搭配 `mcp-builder` skill 建置，語言建議 TypeScript（或 Python/FastMCP 皆可）。

### 要包裝的資料源

| 資料源 | 涵蓋範圍 | 用途 |
|---|---|---|
| TWSE OpenAPI (`openapi.twse.com.tw`) | 上市 | 日K、成交量、三大法人買賣超、融資融券 |
| TPEx OpenAPI (`www.tpex.org.tw/openapi`) | 上櫃 | 同上，上櫃版本 |
| TPEx 興櫃資訊專區 | 興櫃 | 興櫃成交資訊、興櫃登錄基本資料（含興櫃日期、資本額、輔導券商） |
| 集保結算所 TDCC 股權分散表 | 上市/上櫃/興櫃 | 每週各持股級距人數與比例（興櫃主要籌碼來源）；開放資料僅最新一週，歷史週次需查網頁表單 |
| 公開資訊觀測站 MOPS | 上市/上櫃/興櫃 | 財報、月營收、重訊公告 |

### 建議的 MCP tool 設計（給 Claude Code 的實作方向）

- `get_stock_market_type(ticker)` — 回傳代號所屬市場別（上市/上櫃/興櫃），這是所有後續邏輯的第一步
- `get_daily_price(ticker, start_date, end_date)` — 依市場別自動路由到 TWSE 或 TPEx 端點
- `get_institutional_flows(ticker, days)` — 三大法人買賣超；興櫃回傳「不適用」說明並導向股權分散表
- `get_margin_trading(ticker, days)` — 融資融券餘額；興櫃同上
- `get_shareholding_distribution(ticker, weeks)` — 集保戶股權分散表（各級距人數/比例、大戶持股比例），三層級皆適用
- `get_company_profile(ticker)` — 基本資料、興櫃日期（若適用）、資本額
- `search_ticker_by_name(name)` — 用公司名稱查代號與市場別（因為使用者常常只記得公司名而不記得代號）

實作前请 Claude Code 先讀 `/mnt/skills/examples/mcp-builder/SKILL.md`（或你本地環境對應路徑）取得完整的 MCP 建置規範，包含 tool 命名、錯誤處理、輸出格式的最佳實踐。

## 2. Alpha Vantage MCP（輔助，選用）

- 目前在 MCP 連接器名錄中可以直接連接（directoryUuid: `0f1d77a7-9e03-438a-824d-d66c6dd0f0d5`）
- 提供 120+ 個技術指標運算工具（KD、MACD、RSI 等已內建，不用自己算）
- **限制**：對台股的覆蓋主要在有國際代號格式的上市股（例如 2330.TW 這類），**興櫃股票基本上查不到**，連上後建議先測試幾檔代號確認覆蓋範圍
- 用途：作為技術指標計算的交叉驗證，或處理你自建 MCP 還沒實作的進階指標

## 3. Interactive Brokers MCP（選用，僅在你有 IBKR 帳戶時）

- directoryUuid: `d445461d-2337-4e00-b285-b43d111d2912`
- 如果你本身有 IBKR 帳戶且該帳戶有開通台股報價權限，可以用來抓即時報價/持倉
- 這是券商帳戶層級的連接，權限範圍要注意，不建議作為主要資料源，比較適合做即時報價的補充

## 4. MT Newswires MCP（選用）

- directoryUuid: `441c79ad-8a68-4d73-9263-7cfcadd5d8cf`
- 即時財經新聞，可以用來抓消息面事件（法說會、重訊公告），輔助判斷「技術面訊號背後是否有基本面事件驅動」
- 台股中小型股/興櫃股的新聞覆蓋率可能有限，需實測

## 給 Claude Code 的建置優先順序建議

1. 先用 `mcp-builder` skill 建置 TWSE + TPEx 的自建 MCP server（這是完整支援三層級的關鍵，沒有這個興櫃就完全無法處理）
2. 接上 Alpha Vantage MCP 做技術指標交叉驗證（上市股適用）
3. 視需求再考慮 IBKR / MT Newswires
