// Routes a ticker to the right market (TWSE / TPEx OTC / TPEx Emerging) and
// dispatches to the matching client. This is the "get_stock_market_type" logic
// described in SKILL.md — every other tool depends on it, and it is never
// assumed from a prior call, since a ticker's market can change over time
// (興櫃 -> 上櫃 -> 上市 transitions).
import * as twse from "./twseClient.js";
import * as tpex from "./tpexClient.js";
import * as tdcc from "./tdccClient.js";
import { parseIsoDate } from "./dateUtils.js";
import type {
  CompanyProfile,
  DailyPriceRow,
  InstitutionalFlowRow,
  MarginTradingRow,
  MarketType,
  TickerSearchHit,
} from "./types.js";

export async function determineMarketType(ticker: string): Promise<MarketType> {
  if (await twse.isTwseTicker(ticker)) return "TWSE";
  if (await tpex.isOtcTicker(ticker)) return "TPEx_OTC";
  if (await tpex.isEmergingTicker(ticker)) return "TPEx_Emerging";
  return "unknown";
}

export interface DailyPriceResult {
  marketType: MarketType;
  rows: DailyPriceRow[];
  limitationNote?: string;
  /** 興櫃 only: latest last-trade price, kept apart from rows so it is never mixed into close. */
  latestQuote?: tpex.EmergingLatestQuote | null;
}

export async function routeDailyPrice(
  ticker: string,
  startDate: string,
  endDate: string
): Promise<DailyPriceResult> {
  // Throw (-> isError) rather than silently returning 0 rows, which reads as "no trading".
  if (parseIsoDate(startDate) > parseIsoDate(endDate)) {
    throw new Error(`start_date (${startDate}) 晚於 end_date (${endDate})，請對調後再查詢。`);
  }
  const marketType = await determineMarketType(ticker);
  if (marketType === "TWSE") {
    return { marketType, ...(await twse.getDailyPrice(ticker, startDate, endDate)) };
  }
  if (marketType === "TPEx_OTC") {
    return { marketType, ...(await tpex.getDailyPriceOtc(ticker, startDate, endDate)) };
  }
  if (marketType === "TPEx_Emerging") {
    const [result, latestQuote] = await Promise.all([
      tpex.getDailyPriceEmerging(ticker, startDate, endDate),
      tpex.getLatestQuoteEmerging(ticker).catch(() => null), // nice-to-have; never fail the call over it
    ]);
    const note =
      "興櫃為議價交易，沒有開盤價與收盤價（open/close 為 null），均線等指標請以 average（成交均價）計算。" +
      "latestQuote.lastPrice 是最新一天的最後一筆成交價，僅供參考現價，不是正式收盤價，請勿混入均線計算。";
    return { marketType, rows: result.rows, latestQuote, limitationNote: [note, result.limitationNote].filter(Boolean).join(" ") };
  }
  return { marketType, rows: [] };
}

export interface InstitutionalFlowResult {
  marketType: MarketType;
  rows: InstitutionalFlowRow[];
  limitationNote?: string;
}

export async function routeInstitutionalFlows(
  ticker: string,
  days: number
): Promise<InstitutionalFlowResult> {
  const marketType = await determineMarketType(ticker);
  if (marketType === "TWSE") {
    return { marketType, ...(await twse.getInstitutionalFlows(ticker, days)) };
  }
  if (marketType === "TPEx_OTC") {
    return { marketType, ...(await tpex.getInstitutionalFlowsOtc(ticker, days)) };
  }
  if (marketType === "TPEx_Emerging") {
    // 興櫃不在三大法人買賣超統計範圍：櫃買中心三大法人報表只列在「上櫃」選單下
    // https://www.tpex.org.tw/web/stock/3insti/3insti_summary/3itrdsum.php?l=zh-tw
    // 且 OpenAPI tpex_3insti_daily_trading 實測不含任何興櫃代號（官方未見明文排除，依統計範圍與實際涵蓋判斷）。
    return { marketType, rows: [], limitationNote: EMERGING_CHIP_NOTE };
  }
  return { marketType, rows: [] };
}

const EMERGING_CHIP_NOTE =
  "興櫃不適用三大法人與融資融券制度：興櫃股票依法不得融資融券，櫃買中心的三大法人買賣超統計也不涵蓋興櫃。" +
  "請改用 get_shareholding_distribution 觀察集保股權分散（大戶持股比例、股東人數）變化。";

export interface MarginTradingResult {
  marketType: MarketType;
  rows: MarginTradingRow[];
  limitationNote?: string;
}

export async function routeMarginTrading(ticker: string, days: number): Promise<MarginTradingResult> {
  const marketType = await determineMarketType(ticker);
  if (marketType === "TWSE") {
    return { marketType, ...(await twse.getMarginTrading(ticker, days)) };
  }
  if (marketType === "TPEx_OTC") {
    return { marketType, ...(await tpex.getMarginTradingOtc(ticker, days)) };
  }
  if (marketType === "TPEx_Emerging") {
    // 興櫃股票不得融資融券：
    // - 有價證券得為融資融券標準 第 2 條（上櫃股票須「非屬…興櫃股票」才具資格）
    //   https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=G0400009&flno=2
    // - 證券商辦理有價證券買賣融資融券業務操作辦法（「…及興櫃股票，其融資比率為零」）
    //   https://twse-regulation.twse.com.tw/m/LawContent.aspx?FID=FL007121
    // - 櫃買中心興櫃交易制度比較表（信用交易：不可以）
    //   https://www.tpex.org.tw/web/emergingstock/trading_rule/psb.php?l=zh-tw
    return { marketType, rows: [], limitationNote: EMERGING_CHIP_NOTE };
  }
  return { marketType, rows: [] };
}

export interface ShareholdingDistributionResult extends tdcc.DistributionResult {
  marketType: MarketType;
}

/** TDCC data covers all three tiers, so no per-market branching beyond labelling. */
export async function routeShareholdingDistribution(
  ticker: string,
  weeks: number
): Promise<ShareholdingDistributionResult> {
  const marketType = await determineMarketType(ticker);
  if (marketType === "unknown") return { marketType, weeks: [] };
  return { marketType, ...(await tdcc.getShareholdingDistribution(ticker, weeks)) };
}

export async function routeCompanyProfile(
  ticker: string
): Promise<{ marketType: MarketType; profile: CompanyProfile | null }> {
  const marketType = await determineMarketType(ticker);
  if (marketType === "TWSE") return { marketType, profile: await twse.getCompanyProfile(ticker) };
  if (marketType === "TPEx_OTC")
    return { marketType, profile: await tpex.getCompanyProfileOtc(ticker) };
  if (marketType === "TPEx_Emerging")
    return { marketType, profile: await tpex.getCompanyProfileEmerging(ticker) };
  return { marketType, profile: null };
}

export async function routeSearchByName(name: string): Promise<TickerSearchHit[]> {
  const [twseHits, otcHits, emergingHits] = await Promise.all([
    twse.searchByName(name),
    tpex.searchByNameOtc(name),
    tpex.searchByNameEmerging(name),
  ]);
  return [...twseHits, ...otcHits, ...emergingHits];
}
