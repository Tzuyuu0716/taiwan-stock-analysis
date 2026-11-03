#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { pruneDiskCache } from "./cache.js";
import { UpstreamError } from "./httpClient.js";
import { MARKET_LABEL } from "./types.js";
import {
  determineMarketType,
  routeCompanyProfile,
  routeDailyPrice,
  routeInstitutionalFlows,
  routeMarginTrading,
  routeSearchByName,
  routeShareholdingDistribution,
} from "./marketRouter.js";

const server = new McpServer({ name: "taiwan-stock-mcp", version: "0.1.0" });

function textResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof UpstreamError
    ? `上游資料源請求失敗（${err.url}）：${err.message}`
    : err instanceof Error
      ? err.message
      : String(err);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

server.registerTool(
  "get_stock_market_type",
  {
    title: "查詢台股市場層級",
    description:
      "判斷台股代號屬於上市(TWSE)、上櫃(TPEx)、還是興櫃(TPEx Emerging)。這是所有其他台股工具呼叫前的第一步，" +
      "因為三個市場層級的資料源、漲跌幅限制、流動性特性都不同。狀態會隨時間變動（例如興櫃轉上櫃），不要沿用先前查詢結果。",
    inputSchema: { ticker: z.string().describe("台股代號，例如 2330 或 6488") },
  },
  async ({ ticker }) => {
    try {
      const marketType = await determineMarketType(ticker);
      return textResult({ ticker, marketType, marketLabel: MARKET_LABEL[marketType] });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "get_daily_price",
  {
    title: "查詢台股日K資料",
    description:
      "依市場層級自動路由到 TWSE 或 TPEx 資料源，取得指定期間的日成交資訊（開高低收、成交量）。" +
      "上市、上櫃皆可取得歷史區間（逐月抓取，過去月份會快取，單次最多 45 秒，未抓完的月份列在 limitationNote，再查一次即可補齊）；" +
      "成交量單位為股。興櫃沒有歷史行情端點，只會回傳最新一筆報價並附上限制說明。",
    inputSchema: {
      ticker: z.string().describe("台股代號"),
      start_date: z.string().describe("起始日期 YYYY-MM-DD（興櫃會忽略此參數）"),
      end_date: z.string().describe("結束日期 YYYY-MM-DD"),
    },
  },
  async ({ ticker, start_date, end_date }) => {
    try {
      const result = await routeDailyPrice(ticker, start_date, end_date);
      return textResult({
        ticker,
        marketType: result.marketType,
        marketLabel: MARKET_LABEL[result.marketType],
        rows: result.rows,
        rowCount: result.rows.length,
        limitationNote: result.limitationNote,
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "get_institutional_flows",
  {
    title: "查詢三大法人買賣超",
    description:
      "取得外資、投信、自營商買賣超股數。興櫃不適用三大法人統計，會回傳空 rows 與說明，請改用 get_shareholding_distribution。" +
      "上市、上櫃皆可取得每日歷史序列：逐日抓取（上市約 2 秒/天、上櫃約 1 秒/天，已收盤日會快取），" +
      "單次最多 45 秒，未抓完的天數會列在 limitationNote，再查一次即可補齊。",
    inputSchema: {
      ticker: z.string().describe("台股代號"),
      days: z.number().int().positive().max(20).default(10).describe("欲查詢的交易日數量（預設 10、上限 20）"),
    },
  },
  async ({ ticker, days }) => {
    try {
      const result = await routeInstitutionalFlows(ticker, days);
      return textResult({
        ticker,
        marketType: result.marketType,
        marketLabel: MARKET_LABEL[result.marketType],
        rows: result.rows,
        rowCount: result.rows.length,
        limitationNote: result.limitationNote,
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "get_margin_trading",
  {
    title: "查詢融資融券餘額",
    description:
      "取得融資餘額、融券餘額變化。興櫃股票依法不得融資融券，會回傳空 rows 與說明，請改用 get_shareholding_distribution。" +
      "上市、上櫃皆可取得每日歷史序列：逐日抓取（上市約 2 秒/天、上櫃約 1 秒/天，已收盤日會快取），" +
      "單次最多 45 秒，未抓完的天數會列在 limitationNote，再查一次即可補齊。",
    inputSchema: {
      ticker: z.string().describe("台股代號"),
      days: z.number().int().positive().max(20).default(10).describe("欲查詢的交易日數量（預設 10、上限 20）"),
    },
  },
  async ({ ticker, days }) => {
    try {
      const result = await routeMarginTrading(ticker, days);
      return textResult({
        ticker,
        marketType: result.marketType,
        marketLabel: MARKET_LABEL[result.marketType],
        unit: "張",
        rows: result.rows,
        rowCount: result.rows.length,
        limitationNote: result.limitationNote,
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "get_shareholding_distribution",
  {
    title: "查詢集保戶股權分散表",
    description:
      "取得集保結算所每週股權分散表：各持股級距的人數、股數、占集保庫存比例，以及大戶（持股 400 張以上，" +
      "依集保官方級距定義對應）的人數與持股比例。上市、上櫃、興櫃皆適用，是興櫃股票主要的籌碼觀察工具。" +
      "最新一週來自集保開放資料；weeks > 1 時其餘週次逐週查詢集保網頁（約可回溯一年，較慢），失敗時附 limitationNote。",
    inputSchema: {
      ticker: z.string().describe("台股代號"),
      weeks: z.number().int().positive().max(26).default(4).describe("欲查詢的週數（上限 26，週數越多越慢）"),
    },
  },
  async ({ ticker, weeks }) => {
    try {
      const result = await routeShareholdingDistribution(ticker, weeks);
      return textResult({
        ticker,
        marketType: result.marketType,
        marketLabel: MARKET_LABEL[result.marketType],
        bigHolderDefinition: "持股超過 400,000 股（400 張）的集保級距合計",
        weeks: result.weeks,
        weekCount: result.weeks.length,
        limitationNote: result.limitationNote,
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "get_company_profile",
  {
    title: "查詢公司基本資料",
    description:
      "取得公司基本資料：名稱、市場層級、上市/上櫃/興櫃日期、成立日期、產業別、董事長、總經理、實收資本額。",
    inputSchema: { ticker: z.string().describe("台股代號") },
  },
  async ({ ticker }) => {
    try {
      const { marketType, profile } = await routeCompanyProfile(ticker);
      if (!profile) {
        return textResult({
          ticker,
          marketType,
          marketLabel: MARKET_LABEL[marketType],
          profile: null,
          note: "查無此代號的公司基本資料。",
        });
      }
      return textResult({ marketType, marketLabel: MARKET_LABEL[marketType], profile });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "search_ticker_by_name",
  {
    title: "用公司名稱查詢代號",
    description:
      "使用者常常只記得公司名稱而非代號（例如只記得「台積電」而不記得「2330」）。此工具同時搜尋上市、上櫃、興櫃三個名單，" +
      "回傳符合的代號與所屬市場層級。",
    inputSchema: { name: z.string().describe("公司名稱或簡稱的部分字串") },
  },
  async ({ name }) => {
    try {
      const hits = await routeSearchByName(name);
      return textResult({ query: name, hits, hitCount: hits.length });
    } catch (err) {
      return errorResult(err);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Fire-and-forget: a failed cleanup must never block or crash the server.
  pruneDiskCache(90).catch((err) => console.error("cache prune failed:", err));
}

main().catch((err) => {
  console.error("Fatal error starting taiwan-stock-mcp:", err);
  process.exit(1);
});
