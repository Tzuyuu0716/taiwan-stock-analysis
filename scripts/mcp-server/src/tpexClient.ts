// TPEx (上櫃/興櫃) data client.
//
// Two sources:
// - OpenAPI (www.tpex.org.tw/openapi/v1/*): company lists and latest-day
//   snapshots only — every endpoint ignores any date parameter.
// - Website JSON (www.tpex.org.tw/www/zh-tw/*?response=json): the history the
//   OpenAPI lacks. 上櫃 daily price per ticker per month, and whole-market
//   三大法人 / 融資融券 per day. Columns verified against the OpenAPI snapshot
//   for the same day. A holiday answers stat "ok" with an empty table.
// 興櫃 has no history endpoint (tradingStock returns nothing), so its price stays
// a latest-quote snapshot.
import { getOrFetch } from "./cache.js";
import { UpstreamError, fetchJson, parseTwNumber } from "./httpClient.js";
import { rocToIso, toIsoDate } from "./dateUtils.js";
import { cacheDay, cacheMonth, collectDaily, collectMonthly, toSnapshot, type DailySeries } from "./series.js";
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
  return getOrFetch("tpex:otc3insti", LIST_TTL_MS, () =>
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

const WEB_BASE = "https://www.tpex.org.tw/www/zh-tw";

interface WebResponse {
  stat: string;
  tables?: { data?: string[][] }[];
}

/** "2026/10/30" — the website's date parameter format. */
function slashDate(d: Date): string {
  return toIsoDate(d).replace(/-/g, "/");
}

async function fetchWebTable(url: string, deadline: number): Promise<string[][]> {
  const json = await fetchJson<WebResponse>(url, { retries: 2, deadline });
  if (json.stat?.toLowerCase() !== "ok") throw new UpstreamError(`TPEx stat: ${json.stat}`, url);
  return json.tables?.[0]?.data ?? [];
}

export function getDailyPriceOtc(ticker: string, startIso: string, endIso: string): Promise<DailySeries<DailyPriceRow>> {
  return collectMonthly(
    "櫃買中心",
    (monthStart, deadline) =>
      cacheMonth(`tpex-tradingStock-${ticker}`, monthStart, async () => {
        const url = `${WEB_BASE}/afterTrading/tradingStock?code=${encodeURIComponent(ticker)}&date=${slashDate(monthStart)}&response=json`;
        // 日期 成交張數 成交仟元 開盤 最高 最低 收盤 漲跌 筆數
        return (await fetchWebTable(url, deadline)).map((c) => {
          const lots = parseTwNumber(c[1]);
          return {
            date: rocToIso(c[0]),
            volume: lots === null ? null : lots * 1000, // 張 -> 股, same unit as TWSE
            open: parseTwNumber(c[3]),
            high: parseTwNumber(c[4]),
            low: parseTwNumber(c[5]),
            close: parseTwNumber(c[6]),
            average: null,
            transactionCount: parseTwNumber(c[8]),
          };
        });
      }),
    startIso,
    endIso
  );
}

function tpexDay(name: string, urlFor: (date: string) => string, cols: number[]) {
  return (day: Date, deadline: number) =>
    cacheDay(`tpex-${name}`, day, async () => {
      const data = await fetchWebTable(urlFor(slashDate(day)), deadline);
      return data.length ? toSnapshot(data, cols) : null;
    });
}

// dailyTrade columns (groups of 買/賣/超): 10 外資及陸資合計(含外資自營) 13 投信 22 自營商合計 23 三大法人合計
const instiDay = tpexDay(
  "insti",
  (date) => `${WEB_BASE}/insti/dailyTrade?type=Daily&sect=EW&date=${date}&response=json`,
  [10, 13, 22, 23]
);

export function getInstitutionalFlowsOtc(ticker: string, days: number): Promise<DailySeries<InstitutionalFlowRow>> {
  return collectDaily("櫃買中心", instiDay, ticker, days, (date, v) => ({
    date,
    foreignNet: parseTwNumber(v[0]),
    investmentTrustNet: parseTwNumber(v[1]),
    dealerNet: parseTwNumber(v[2]),
    totalNet: parseTwNumber(v[3]),
  }));
}

// margin/balance columns (單位：張): 3 資買 4 資賣 6 資餘額 11 券賣 12 券買 14 券餘額
const marginDay = tpexDay("margin", (date) => `${WEB_BASE}/margin/balance?date=${date}&response=json`, [3, 4, 6, 11, 12, 14]);

export function getMarginTradingOtc(ticker: string, days: number): Promise<DailySeries<MarginTradingRow>> {
  return collectDaily("櫃買中心", marginDay, ticker, days, (date, v) => ({
    date,
    marginBuy: parseTwNumber(v[0]),
    marginSell: parseTwNumber(v[1]),
    marginBalance: parseTwNumber(v[2]),
    shortSell: parseTwNumber(v[3]),
    shortBuy: parseTwNumber(v[4]),
    shortBalance: parseTwNumber(v[5]),
  }));
}
