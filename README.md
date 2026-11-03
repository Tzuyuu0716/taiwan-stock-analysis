# taiwan-stock-analysis

台股進出場分析的 Claude Skill，搭配自建 MCP server，涵蓋**上市、上櫃、興櫃**三個市場層級。

- **Skill**（`SKILL.md` + `references/`）：告訴 Claude 如何依市場層級抓資料、計算技術指標（MA/KD/MACD/RSI、量價、支撐壓力）、整合籌碼面，並以「條件式」語法輸出摘要，不做買賣建議。
- **MCP server**（`scripts/mcp-server/`，TypeScript）：包裝 TWSE、TPEx、集保結算所（TDCC）公開資料，提供 Claude 可呼叫的工具。

## MCP 工具

| Tool | 用途 |
| --- | --- |
| `get_stock_market_type` | 判斷代號屬於上市 / 上櫃 / 興櫃 |
| `get_daily_price` | 日 K（上市可查區間；上櫃/興櫃僅最新一日） |
| `get_institutional_flows` | 三大法人買賣超（興櫃不適用，會導向股權分散表） |
| `get_margin_trading` | 融資融券餘額（興櫃不適用，會導向股權分散表） |
| `get_shareholding_distribution` | 集保戶股權分散表：各級距人數/比例、大戶（400 張以上）持股比例，三層級皆適用 |
| `get_company_profile` | 公司基本資料 |
| `search_ticker_by_name` | 用公司名稱查代號 |

各資料源、快取與限制（例如興櫃沒有歷史行情）見 [scripts/mcp-server/README.md](scripts/mcp-server/README.md)。

## 安裝

需要 Node.js 20 以上（開發時使用 Node 24）。

```bash
cd scripts/mcp-server
npm install
npm run build
npm test        # 選用：對真實資料源跑煙霧測試
claude mcp add taiwan-stock -- node "<absolute-path-to>/scripts/mcp-server/dist/index.js"
```

Skill 本身：把 `SKILL.md` 與 `references/` 放進 Claude Code 的 skills 目錄，或在 claude.ai 上傳 Releases 頁面的 skill zip。

## 資料來源與使用注意

- TWSE / TPEx OpenAPI、集保開放資料（`opendata.tdcc.com.tw`）皆為官方公開資料。
- `get_shareholding_distribution` 查詢歷史週次時，會逐週查詢集保網站的網頁查詢表單（非正式 API）。程式已加上請求間隔與快取，請避免大量或高頻查詢；網站改版時此功能可能失效，工具會回傳 `limitationNote` 說明。

## 免責聲明

本專案僅整理公開資料並計算技術指標，不構成任何投資建議。資料可能延遲或不完整，投資決策與風險請自行評估。

## License

[MIT](LICENSE)
