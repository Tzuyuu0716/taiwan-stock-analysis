// TWSE (上市) data client.
//
// Historical per-ticker series (daily price / institutional flows / margin) only
// exist on the classic `www.twse.com.tw/rwd/zh/...` endpoints, which answer one
// month (price) or one trading day (flows/margin) per call. The newer
// `openapi.twse.com.tw` endpoints only ever return the latest snapshot for the
// whole market, so they're used here just for the static company-profile list.
import { getOrFetch } from "./cache.js";
import { fetchJson, parseTwNumber } from "./httpClient.js";
import {
  addDays,
  enumerateMonths,
  enumerateWeekdaysDesc,
  parseIsoDate,
  rocToIso,
  toIsoDate,
  todayUtc,
  toYyyymmdd,
} from "./dateUtils.js";
import type {
  CompanyProfile,
  DailyPriceRow,
  InstitutionalFlowRow,
  MarginTradingRow,
  TickerSearchHit,
} from "./types.js";

const RWD_BASE = "https://www.twse.com.tw/rwd/zh";
const OPEN_BASE = "https://openapi.twse.com.tw/v1";
const COMPANY_LIST_TTL_MS = 12 * 60 * 60 * 1000; // 12h: static reference data

interface RawCompany {
  公司代號: string;
  公司名稱: string;
  公司簡稱: string;
  上市日期: string;
  成立日期: string;
  產業別: string;
  董事長: string;
  總經理: string;
  實收資本額: string;
}

async function fetchCompanyList(): Promise<RawCompany[]> {
  return getOrFetch("twse:companyList", COMPANY_LIST_TTL_MS, () =>
    fetchJson<RawCompany[]>(`${OPEN_BASE}/opendata/t187ap03_L`)
  );
}

function isoFromCompactDate(s: string | undefined): string | null {
  if (!s || s.trim() === "") return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length !== 8) return null;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

export async function isTwseTicker(ticker: string): Promise<boolean> {
  const list = await fetchCompanyList();
  return list.some((c) => c.公司代號 === ticker);
}

export async function getCompanyProfile(ticker: string): Promise<CompanyProfile | null> {
  const list = await fetchCompanyList();
  const row = list.find((c) => c.公司代號 === ticker);
  if (!row) return null;
  return {
    ticker: row.公司代號,
    name: row.公司名稱,
    shortName: row.公司簡稱 || null,
    marketType: "TWSE",
    listedDate: isoFromCompactDate(row.上市日期),
    incorporationDate: isoFromCompactDate(row.成立日期),
    industry: row.產業別 || null,
    chairman: row.董事長 || null,
    generalManager: row.總經理 || null,
    capital: parseTwNumber(row.實收資本額),
  };
}

export async function searchByName(query: string): Promise<TickerSearchHit[]> {
  const list = await fetchCompanyList();
  const q = query.trim();
  return list
    .filter((c) => c.公司名稱.includes(q) || (c.公司簡稱 ?? "").includes(q))
    .map((c) => ({ ticker: c.公司代號, name: c.公司簡稱 || c.公司名稱, marketType: "TWSE" as const }));
}

interface StockDayResponse {
  stat: string;
  fields?: string[];
  data?: string[][];
}

/** One HTTP call per calendar month in [startIso, endIso], per TWSE's STOCK_DAY endpoint shape. */
export async function getDailyPrice(
  ticker: string,
  startIso: string,
  endIso: string
): Promise<DailyPriceRow[]> {
  const start = parseIsoDate(startIso);
  const end = parseIsoDate(endIso);
  const months = enumerateMonths(start, end);
  const rows: DailyPriceRow[] = [];

  for (const monthStart of months) {
    const url = `${RWD_BASE}/afterTrading/STOCK_DAY?response=json&date=${toYyyymmdd(monthStart)}&stockNo=${encodeURIComponent(ticker)}`;
    const json = await fetchJson<StockDayResponse>(url);
    if (json.stat !== "OK" || !json.data) continue; // e.g. no trading days that month
    for (const cols of json.data) {
      const iso = rocToIso(cols[0]);
      if (iso < startIso || iso > endIso) continue;
      rows.push({
        date: iso,
        volume: parseTwNumber(cols[1]),
        open: parseTwNumber(cols[3]),
        high: parseTwNumber(cols[4]),
        low: parseTwNumber(cols[5]),
        close: parseTwNumber(cols[6]),
        average: null,
        transactionCount: parseTwNumber(cols[8]),
      });
    }
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

interface T86Response {
  stat: string;
  fields?: string[];
  data?: string[][];
}

const MAX_DAILY_LOOKBACK = 40; // cap fan-out for per-day endpoints (T86 / margin)

/** One HTTP call per weekday, most-recent-first, capped at MAX_DAILY_LOOKBACK requests. */
export async function getInstitutionalFlows(
  ticker: string,
  days: number
): Promise<InstitutionalFlowRow[]> {
  const end = todayUtc();
  const start = addDays(end, -Math.max(days, 1) * 2); // widen window to absorb holidays
  const candidates = enumerateWeekdaysDesc(start, end, MAX_DAILY_LOOKBACK);
  const rows: InstitutionalFlowRow[] = [];

  for (const day of candidates) {
    if (rows.length >= days) break;
    const url = `${RWD_BASE}/fund/T86?response=json&date=${toYyyymmdd(day)}&selectType=ALL`;
    const json = await fetchJson<T86Response>(url);
    if (json.stat !== "OK" || !json.data) continue; // holiday / no session that day
    const match = json.data.find((cols) => cols[0] === ticker);
    if (!match) continue;
    const foreignA = parseTwNumber(match[4]) ?? 0;
    const foreignDealer = parseTwNumber(match[7]) ?? 0;
    rows.push({
      date: toIsoDate(day),
      foreignNet: foreignA + foreignDealer,
      investmentTrustNet: parseTwNumber(match[10]),
      dealerNet: parseTwNumber(match[11]),
      totalNet: parseTwNumber(match[18]),
    });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

interface MarginResponse {
  stat: string;
  fields?: string[];
  data?: string[][];
}

export async function getMarginTrading(ticker: string, days: number): Promise<MarginTradingRow[]> {
  const end = todayUtc();
  const start = addDays(end, -Math.max(days, 1) * 2);
  const candidates = enumerateWeekdaysDesc(start, end, MAX_DAILY_LOOKBACK);
  const rows: MarginTradingRow[] = [];

  for (const day of candidates) {
    if (rows.length >= days) break;
    const url = `${RWD_BASE}/marginTrading/TWT93U?response=json&date=${toYyyymmdd(day)}&stockNo=${encodeURIComponent(ticker)}`;
    const json = await fetchJson<MarginResponse>(url);
    if (json.stat !== "OK" || !json.data) continue;
    const match = json.data.find((cols) => cols[0] === ticker);
    if (!match) continue;
    rows.push({
      date: toIsoDate(day),
      marginBalance: parseTwNumber(match[6]),
      marginBuy: parseTwNumber(match[4]),
      marginSell: parseTwNumber(match[3]),
      shortBalance: parseTwNumber(match[12]),
      shortBuy: parseTwNumber(match[10]),
      shortSell: parseTwNumber(match[9]),
    });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}
