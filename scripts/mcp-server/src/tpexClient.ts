// TPEx (上櫃/興櫃) data client.
//
// Unlike TWSE, TPEx's public OpenAPI endpoints (www.tpex.org.tw/openapi/v1/*) do
// NOT accept a date parameter for per-ticker history — every endpoint always
// returns the latest available trading day for the whole market, ignoring any
// `date=` query string (verified empirically: identical payload with/without it).
// There is no documented historical per-ticker endpoint. So daily
// price/institutional-flow/margin lookups here can only ever return the single
// most recent session, never a date range. Callers must surface that limitation
// rather than pretend a range was honored.
import { getOrFetch } from "./cache.js";
import { fetchJson, parseTwNumber, pickByPattern } from "./httpClient.js";
import { rocToIso } from "./dateUtils.js";
import type {
  CompanyProfile,
  DailyPriceRow,
  InstitutionalFlowRow,
  MarginTradingRow,
  MarketType,
  TickerSearchHit,
} from "./types.js";

const OPEN_BASE = "https://www.tpex.org.tw/openapi/v1";
const LIST_TTL_MS = 12 * 60 * 60 * 1000;
const SNAPSHOT_TTL_MS = 10 * 60 * 1000; // whole-market snapshots refresh a few times/hour

interface RawCompanyEn {
  SecuritiesCompanyCode: string;
  CompanyName: string;
  CompanyAbbreviation?: string;
  DateOfListing?: string;
  DateOfIncorporation?: string;
  SecuritiesIndustryCode?: string;
  Chairman?: string;
  GeneralManager?: string;
  "Paidin.Capital.NTDollars"?: string;
}

function isoFromCompact(s: string | undefined): string | null {
  if (!s || s.trim() === "") return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length !== 8) return null;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

async function fetchOtcCompanyList(): Promise<RawCompanyEn[]> {
  return getOrFetch("tpex:otcCompanyList", LIST_TTL_MS, () =>
    fetchJson<RawCompanyEn[]>(`${OPEN_BASE}/mopsfin_t187ap03_O`)
  );
}

async function fetchEmergingCompanyList(): Promise<RawCompanyEn[]> {
  return getOrFetch("tpex:emergingCompanyList", LIST_TTL_MS, () =>
    fetchJson<RawCompanyEn[]>(`${OPEN_BASE}/mopsfin_t187ap03_R`)
  );
}

function toProfile(row: RawCompanyEn, marketType: MarketType): CompanyProfile {
  return {
    ticker: row.SecuritiesCompanyCode,
    name: row.CompanyName,
    shortName: row.CompanyAbbreviation ?? null,
    marketType,
    listedDate: isoFromCompact(row.DateOfListing),
    incorporationDate: isoFromCompact(row.DateOfIncorporation),
    industry: row.SecuritiesIndustryCode ?? null,
    chairman: row.Chairman ?? null,
    generalManager: row.GeneralManager ?? null,
    capital: parseTwNumber(row["Paidin.Capital.NTDollars"]),
  };
}

type InstiRow = Record<string, string>;

function fetchOtc3insti(): Promise<InstiRow[]> {
  return getOrFetch("tpex:otc3insti", SNAPSHOT_TTL_MS, () =>
    fetchJson<InstiRow[]>(`${OPEN_BASE}/tpex_3insti_daily_trading`, { retries: 1 })
  );
}

/**
 * OTC ETFs (00679B etc.) are not in the company list and TPEx publishes no ETF
 * list. The 3-institution table (~880 rows, no warrants) includes them, so it
 * doubles as the ETF list. ponytail: an ETF with zero institutional trades that
 * day is missing from it; fall back to tpex_mainboard_daily_close_quotes (5MB) if that bites.
 */
async function findOtcEtf(ticker: string): Promise<InstiRow | undefined> {
  if (!ticker.startsWith("00")) return undefined;
  return (await fetchOtc3insti()).find((r) => r.SecuritiesCompanyCode === ticker);
}

export async function isOtcTicker(ticker: string): Promise<boolean> {
  const list = await fetchOtcCompanyList();
  return list.some((c) => c.SecuritiesCompanyCode === ticker) || !!(await findOtcEtf(ticker));
}

export async function isEmergingTicker(ticker: string): Promise<boolean> {
  const list = await fetchEmergingCompanyList();
  return list.some((c) => c.SecuritiesCompanyCode === ticker);
}

export async function getCompanyProfileOtc(ticker: string): Promise<CompanyProfile | null> {
  const list = await fetchOtcCompanyList();
  const row = list.find((c) => c.SecuritiesCompanyCode === ticker);
  if (row) return toProfile(row, "TPEx_OTC");
  const etf = await findOtcEtf(ticker);
  if (!etf) return null;
  return {
    ticker,
    name: etf.CompanyName,
    shortName: etf.CompanyName,
    marketType: "TPEx_OTC",
    listedDate: null,
    incorporationDate: null,
    industry: "ETF",
    chairman: null,
    generalManager: null,
    capital: null,
  };
}

export async function getCompanyProfileEmerging(ticker: string): Promise<CompanyProfile | null> {
  const list = await fetchEmergingCompanyList();
  const row = list.find((c) => c.SecuritiesCompanyCode === ticker);
  return row ? toProfile(row, "TPEx_Emerging") : null;
}

export async function searchByNameOtc(query: string): Promise<TickerSearchHit[]> {
  const [list, insti] = await Promise.all([fetchOtcCompanyList(), fetchOtc3insti()]);
  const q = query.trim();
  return [
    ...list
      .filter((c) => c.CompanyName.includes(q) || (c.CompanyAbbreviation ?? "").includes(q))
      .map((c) => ({
        ticker: c.SecuritiesCompanyCode,
        name: c.CompanyAbbreviation || c.CompanyName,
        marketType: "TPEx_OTC" as const,
      })),
    ...insti
      .filter((r) => r.SecuritiesCompanyCode.startsWith("00") && r.CompanyName.includes(q))
      .map((r) => ({ ticker: r.SecuritiesCompanyCode, name: r.CompanyName, marketType: "TPEx_OTC" as const })),
  ];
}

export async function searchByNameEmerging(query: string): Promise<TickerSearchHit[]> {
  const list = await fetchEmergingCompanyList();
  const q = query.trim();
  return list
    .filter((c) => c.CompanyName.includes(q) || (c.CompanyAbbreviation ?? "").includes(q))
    .map((c) => ({
      ticker: c.SecuritiesCompanyCode,
      name: c.CompanyAbbreviation || c.CompanyName,
      marketType: "TPEx_Emerging" as const,
    }));
}

interface OtcQuoteRow {
  Date: string;
  SecuritiesCompanyCode: string;
  Close?: string;
  Open?: string;
  High?: string;
  Low?: string;
  Average?: string;
  TradingShares?: string;
  TransactionNumber?: string;
}

/** Latest OTC session only — see module-level note on TPEx's snapshot-only API. */
export async function getLatestDailyPriceOtc(ticker: string): Promise<DailyPriceRow | null> {
  const list = await getOrFetch("tpex:otcDailyClose", SNAPSHOT_TTL_MS, () =>
    fetchJson<OtcQuoteRow[]>(`${OPEN_BASE}/tpex_mainboard_daily_close_quotes`)
  );
  const row = list.find((r) => r.SecuritiesCompanyCode === ticker);
  if (!row) return null;
  return {
    date: rocToIso(row.Date),
    open: parseTwNumber(row.Open),
    high: parseTwNumber(row.High),
    low: parseTwNumber(row.Low),
    close: parseTwNumber(row.Close),
    average: parseTwNumber(row.Average),
    volume: parseTwNumber(row.TradingShares),
    transactionCount: parseTwNumber(row.TransactionNumber),
  };
}

interface EsbQuoteRow {
  Date: string;
  SecuritiesCompanyCode: string;
  LatestPrice?: string;
  Highest?: string;
  Lowest?: string;
  Average?: string;
  TransactionVolume?: string;
}

/**
 * Latest emerging-board (興櫃) quote only. There is no Open field: 興櫃 trades by
 * negotiated quote (議價), not a centralized auction, so "open/close" as a concept
 * doesn't apply the way it does on TWSE/TPEx mainboard.
 */
export async function getLatestDailyPriceEmerging(ticker: string): Promise<DailyPriceRow | null> {
  const list = await getOrFetch("tpex:esbLatest", SNAPSHOT_TTL_MS, () =>
    fetchJson<EsbQuoteRow[]>(`${OPEN_BASE}/tpex_esb_latest_statistics`)
  );
  const row = list.find((r) => r.SecuritiesCompanyCode === ticker);
  if (!row) return null;
  return {
    date: rocToIso(row.Date),
    open: null,
    high: parseTwNumber(row.Highest),
    low: parseTwNumber(row.Lowest),
    close: parseTwNumber(row.LatestPrice),
    average: parseTwNumber(row.Average),
    volume: parseTwNumber(row.TransactionVolume),
    transactionCount: null,
  };
}

/** Latest session only. 興櫃 has no equivalent endpoint — callers should treat it as "no data". */
export async function getLatestInstitutionalFlowsOtc(
  ticker: string
): Promise<InstitutionalFlowRow | null> {
  const list = await fetchOtc3insti();
  const row = list.find((r) => r.SecuritiesCompanyCode === ticker);
  if (!row) return null;
  const foreignBuy = parseTwNumber(pickByPattern(row, ["foreigninvestorsincludemainlandareainvestors-totalbuy"])) ?? 0;
  const foreignSell = parseTwNumber(pickByPattern(row, ["foreigninvestorsincludemainlandareainvestors-totalsell"])) ?? 0;
  // Include 外資自營商 so foreignNet matches TWSE's definition (and sums to totalDifference).
  const foreignDealer = parseTwNumber(pickByPattern(row, ["foreigndealers-difference"])) ?? 0;
  return {
    date: rocToIso(row.Date),
    foreignNet: foreignBuy - foreignSell + foreignDealer,
    investmentTrustNet: parseTwNumber(pickByPattern(row, ["securitiesinvestmenttrustcompanies-difference"])),
    dealerNet: parseTwNumber(pickByPattern(row, ["dealers-difference"])),
    totalNet: parseTwNumber(pickByPattern(row, ["totaldifference"])),
  };
}

interface MarginRowEn {
  Date: string;
  SecuritiesCompanyCode: string;
  MarginPurchaseBalance?: string;
  MarginPurchase?: string;
  MarginSales?: string;
  ShortSaleBalance?: string;
  ShortSale?: string;
  ShortConvering?: string;
}

/** Latest session only. 興櫃 has no margin-trading data at all (per market_types.md). */
export async function getLatestMarginTradingOtc(ticker: string): Promise<MarginTradingRow | null> {
  const list = await getOrFetch("tpex:otcMargin", SNAPSHOT_TTL_MS, () =>
    fetchJson<MarginRowEn[]>(`${OPEN_BASE}/tpex_mainboard_margin_balance`)
  );
  const row = list.find((r) => r.SecuritiesCompanyCode === ticker);
  if (!row) return null;
  return {
    date: rocToIso(row.Date),
    marginBalance: parseTwNumber(row.MarginPurchaseBalance),
    marginBuy: parseTwNumber(row.MarginPurchase),
    marginSell: parseTwNumber(row.MarginSales),
    shortBalance: parseTwNumber(row.ShortSaleBalance),
    shortBuy: parseTwNumber(row.ShortConvering),
    shortSell: parseTwNumber(row.ShortSale),
  };
}
