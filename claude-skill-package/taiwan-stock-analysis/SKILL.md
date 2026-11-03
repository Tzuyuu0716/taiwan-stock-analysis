---
name: taiwan-stock-analysis
description: Analyze Taiwan stock entry/exit timing across all three market tiers — 上市 (TWSE-listed), 上櫃 (TPEx-listed), and 興櫃 (emerging/registered). Covers technical indicators (MA/KD/MACD/RSI), volume-price analysis, support/resistance levels, and Taiwan-specific chip data (三大法人買賣超, 融資融券, 集保股權分散表). Use this skill whenever the user gives a Taiwan stock code or name and asks about buy/sell timing, entry/exit points, support/resistance, or wants a technical + chip synthesis. Trigger on 進場, 出場, 支撐, 壓力, 買點, 賣點, 興櫃, 上市櫃, 三大法人, 融資融券, 股權分散, 大戶持股, or any 4-digit Taiwan stock code (e.g. 2330, 6488) paired with a timing question.
---

# 台股進出場分析 Skill

## 目的

針對指定的台股代號，判斷目前所在市場層級（上市/上櫃/興櫃），抓取對應資料源，計算技術指標與籌碼面數據，產出「目前技術位置」的客觀陳述，**不做出「應該買/賣」的操作建議**——這是資訊整理工具，不是投資顧問。

## 資料來源說明（重要，請先確認環境）

本 skill 的資料抓取邏輯預設有一個台股專用 MCP connector（工具名稱如 `get_stock_market_type`、`get_daily_price` 等，詳見 `references/mcp_data_sources.md`）。使用前請先確認目前環境：

1. **若已連接台股 MCP connector**：直接呼叫對應 tool 取得資料，照下方工作流程執行。
2. **若沒有連接任何台股 MCP connector**（例如在 claude.ai 網頁/App 上，且未設定遠端 MCP server）：
   - 若你有網頁擷取類工具（web fetch / 程式碼執行環境且可對外連線），可以直接查詢 TWSE OpenAPI（`openapi.twse.com.tw`）與 TPEx OpenAPI（`www.tpex.org.tw/openapi`）的公開端點；興櫃籌碼可查集保開放資料（`opendata.tdcc.com.tw/getOD.ashx?id=1-5`，僅最新一週股權分散表），端點清單見 `references/mcp_data_sources.md`。
   - 若完全無法取得即時資料，**明確告知使用者「目前沒有資料來源可查詢台股即時資訊，以下分析僅能依你提供的數字或既有知識進行，可能不是最新資料」**，不要假裝有資料、不要用記憶中的舊價格當作即時報價呈現。
   - 這條規則不能省略：本 skill 的核心原則就是不編造資料，資料來源不明時必須明講。

## 工作流程

1. **辨識市場層級**：先確認代號屬於上市、上櫃、還是興櫃。三者資料特性、流動性、漲跌幅限制都不同，處理邏輯不能共用一套假設。細節見 `references/market_types.md`。

2. **抓取資料**：依市場層級選擇對應資料源（見 `references/mcp_data_sources.md`）：
   - 上市 → TWSE 資料源
   - 上櫃 → TPEx 資料源
   - 興櫃 → TPEx 興櫃專區資料源（注意資料稀疏度問題）

   需要抓取：
   - 近期日 K（收盤價、成交量、最高最低）
     - 興櫃為議價交易，沒有開盤/收盤價（`open`/`close` 為 null），均線、乖離率一律改用 `average`（成交均價）計算，並在輸出中註明
   - 上市/上櫃：三大法人買賣超（外資/投信/自營商）、融資融券餘額變化
   - 興櫃：**改用 `get_shareholding_distribution`**（集保戶股權分散表，建議 weeks=4~8）。興櫃依法不得融資融券，也不在三大法人買賣超統計範圍內，`get_institutional_flows` / `get_margin_trading` 對興櫃只會回傳說明
   - 任何層級都可加查股權分散表，作為週頻籌碼的輔助觀察

3. **資料充分度檢查**（興櫃股票尤其重要）：
   - 近 20 個交易日內若有效成交天數 < 10 天，或單日成交量常態性極低 → 標記「資料不足，訊號可信度低」，並在輸出中明確提示，不要用上市股同等的信心程度呈現訊號。

4. **計算技術指標**：詳見 `references/indicator_logic.md`，包含：
   - 均線排列（5/20/60 日）與乖離率
   - KD、MACD、RSI
   - 量價關係（是否量價背離）
   - 支撐/壓力位（近期高低點 + 成交量密集區）

5. **整合籌碼面訊號**：
   - 上市/上櫃：三大法人連續買超/賣超天數、融資融券餘額變化方向（若無資料則略過，不要假裝有）
   - 興櫃：大戶（400 張以上）持股比例的逐週變化、總股東人數變化（人數減少且大戶比例上升 = 籌碼趨於集中，反之為分散）。若 `limitationNote` 顯示只取得最新一週，只陳述當週水準，不要推論趨勢

6. **產出格式**（務必包含以下區塊）：
   - 市場層級 + 資料截至時間
   - 技術面摘要（客觀陳述，例如「5日均線上穿20日均線」而非「建議買進」）
   - 籌碼面摘要
   - 支撐/壓力參考價位
   - **條件式進出場摘要**（見下方「摘要功能設計原則」與 `references/summary_template.md`）
   - 資料可信度註記（尤其興櫃）
   - 免責聲明：「以上僅為公開資料整理與技術指標計算結果，不構成投資建議，投資風險請自行評估」

7. **產出摘要區塊**：在完整分析之後，額外附上一段濃縮摘要，把支撐/壓力、乖離率、停損停利參考點整理成「條件式」語句，格式與禁用詞規則見 `references/summary_template.md`。這個摘要**不是**「建議買在哪裡、賣在哪裡」，而是「如果採用某規則，對應數字是多少」，決策權留給使用者。

## 摘要功能設計原則（重要）

摘要區塊必須用**條件式語法**，把數字算出來但不下判斷：

✅ 正確：「近20日支撐位約240元；若採『跌破支撐3%停損』規則，對應參考點約233元；近期壓力位約在270元（成交量密集區）」

❌ 禁止：「建議250元買進，跌破240元停損」「現在是好買點」「建議賣出」

這條界線是硬性規則，不因為使用者要求「更直接」「幫我抓一個明確的價格」而放寬——遇到這種要求，摘要功能一樣輸出條件式數字，並附註這不是投資建議。詳細模板見 `references/summary_template.md`。

## 重要原則

- 絕不使用「建議買進」「建議賣出」「進場訊號出現」這類直接指令式語言，改用「目前技術面呈現 XX 型態」這類客觀描述。
- 興櫃股票沒有漲跌幅限制，「%漲跌濾網」類的邏輯在興櫃上會失真，必須獨立處理（見 references）。
- 資料時間戳一定要標註，避免使用者誤以為是即時報價。
- 如果 MCP 或 API 查詢失敗、資料不完整，要明確告知使用者「哪一段資料缺失」，不要用預設值假裝完整。

## 延伸閱讀

- `references/market_types.md` — 上市/上櫃/興櫃差異與判斷邏輯
- `references/mcp_data_sources.md` — 建議串接的 MCP / API 清單與設定方式
- `references/indicator_logic.md` — 技術指標與進出場訊號計算細節
- `references/summary_template.md` — 條件式進出場摘要的輸出模板與禁用詞規則
