// TWSE (上市) data client.
//
// Historical per-ticker series (daily price / institutional flows / margin) only
// exist on the classic `www.twse.com.tw/rwd/zh/...` endpoints, which answer one
// month (price) or one trading day (flows/margin) per call. The newer
// `openapi.twse.com.tw` endpoints only ever return the latest snapshot for the
// whole market, so they're used here just for the static company-profile list.
import { getOrFetch } from "./cache.js";
import { UpstreamError, fetchJson, parseTwNumber } from "./httpClient.js";
import { rocToIso, toYyyymmdd } from "./dateUtils.js";
import { cacheDay, cacheMonth, collectDaily, collectMonthly, toSnapshot, type DailySeries } from "./series.js";
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

// ETFs (0050 etc.) are not in the company list; TWSE publishes them separately.
interface RawEtf {
  基金代號: string;
  基金簡稱: string;
  基金中文名稱: string;
  基金類型: string;
  成立日期: string;
  上市日期: string;
}

async function fetchEtfList(): Promise<RawEtf[]> {
  return getOrFetch("twse:etfList", COMPANY_LIST_TTL_MS, () =>
    fetchJson<RawEtf[]>(`${OPEN_BASE}/opendata/t187ap47_L`)
  );
}

function rocOrNull(s: string | undefined): string | null {
  return s && s.replace(/\D/g, "").length === 7 ? rocToIso(s) : null;
}

export async function isTwseTicker(ticker: string): Promise<boolean> {
  const [companies, etfs] = await Promise.all([fetchCompanyList(), fetchEtfList()]);
  return companies.some((c) => c.公司代號 === ticker) || etfs.some((e) => e.基金代號 === ticker);
}

export async function getCompanyProfile(ticker: string): Promise<CompanyProfile | null> {
  const list = await fetchCompanyList();
  const row = list.find((c) => c.公司代號 === ticker);
  if (!row) {
    const etf = (await fetchEtfList()).find((e) => e.基金代號 === ticker);
    if (!etf) return null;
    return {
      ticker: etf.基金代號,
      name: etf.基金中文名稱,
      shortName: etf.基金簡稱 || null,
      marketType: "TWSE",
      listedDate: rocOrNull(etf.上市日期),
      incorporationDate: rocOrNull(etf.成立日期),
      industry: `ETF（${etf.基金類型}）`,
      chairman: null,
      generalManager: null,
      capital: null,
    };
  }
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
  const [companies, etfs] = await Promise.all([fetchCompanyList(), fetchEtfList()]);
  const q = query.trim();
  return [
    ...companies
      .filter((c) => c.公司名稱.includes(q) || (c.公司簡稱 ?? "").includes(q))
      .map((c) => ({ ticker: c.公司代號, name: c.公司簡稱 || c.公司名稱, marketType: "TWSE" as const })),
    ...etfs
      .filter((e) => e.基金中文名稱.includes(q) || e.基金簡稱.includes(q))
      .map((e) => ({ ticker: e.基金代號, name: e.基金簡稱, marketType: "TWSE" as const })),
  ];
}

interface TwseResponse {
  stat: string;
  data?: string[][];
  tables?: { title?: string; data?: string[][] }[];
}

const NO_DATA = "沒有符合條件"; // TWSE's stat for holidays / months without trading

export function getDailyPrice(ticker: string, startIso: string, endIso: string): Promise<DailySeries<DailyPriceRow>> {
  return collectMonthly(
    "證交所",
    (monthStart, deadline) =>
      cacheMonth(`twse-STOCK_DAY-${ticker}`, monthStart, async () => {
        const url = `${RWD_BASE}/afterTrading/STOCK_DAY?response=json&date=${toYyyymmdd(monthStart)}&stockNo=${encodeURIComponent(ticker)}`;
        const json = await fetchJson<TwseResponse>(url, { retries: 2, deadline });
        if (json.stat.includes(NO_DATA)) return []; // e.g. before listing
        if (json.stat !== "OK" || !json.data) throw new UpstreamError(`TWSE stat: ${json.stat}`, url);
        return json.data.map((c) => ({
          date: rocToIso(c[0]),
          volume: parseTwNumber(c[1]), // 成交股數
          open: parseTwNumber(c[3]),
          high: parseTwNumber(c[4]),
          low: parseTwNumber(c[5]),
          close: parseTwNumber(c[6]),
          average: null,
          transactionCount: parseTwNumber(c[8]),
        }));
      }),
    startIso,
    endIso
  );
}

/** One whole-market day table; `pick` selects the table out of the response. */
function twseDay(name: string, urlFor: (ymd: string) => string, cols: number[], pick: (j: TwseResponse) => string[][] | undefined) {
  return (day: Date, deadline: number) =>
    cacheDay(`twse-${name}`, day, async () => {
      const url = urlFor(toYyyymmdd(day));
      const json = await fetchJson<TwseResponse>(url, { retries: 2, deadline });
      const data = json.stat === "OK" ? pick(json) : undefined;
      if (data) return toSnapshot(data, cols);
      if (json.stat.includes(NO_DATA)) return null;
      throw new UpstreamError(`TWSE stat: ${json.stat}`, url);
    });
}

// T86 columns: 4 外陸資(不含自營) 7 外資自營 10 投信 11 自營商 18 三大法人合計
const t86Day = twseDay(
  "T86",
  // ALLBUT0999 = 不含權證/牛熊證: ~1.3k rows vs ~16k, ~7x faster; stocks and ETFs are all still there
  (ymd) => `${RWD_BASE}/fund/T86?response=json&date=${ymd}&selectType=ALLBUT0999`,
  [4, 7, 10, 11, 18],
  (j) => j.data
);

export function getInstitutionalFlows(ticker: string, days: number): Promise<DailySeries<InstitutionalFlowRow>> {
  return collectDaily("證交所", t86Day, ticker, days, (date, v) => ({
    date,
    foreignNet: (parseTwNumber(v[0]) ?? 0) + (parseTwNumber(v[1]) ?? 0),
    investmentTrustNet: parseTwNumber(v[2]),
    dealerNet: parseTwNumber(v[3]),
    totalNet: parseTwNumber(v[4]),
  }));
}

// MI_MARGN 融資融券彙總 (單位：張): 2 資買 3 資賣 6 資餘額 8 券買 9 券賣 12 券餘額.
// (Not TWT93U — that is 信用額度總量管制餘額表: 融券 + 借券賣出, no 融資 at all.)
const marginDay = twseDay(
  "MI_MARGN",
  (ymd) => `${RWD_BASE}/marginTrading/MI_MARGN?response=json&date=${ymd}&selectType=ALL`,
  [2, 3, 6, 8, 9, 12],
  (j) => j.tables?.find((t) => t.title?.includes("融資融券彙總"))?.data
);

export function getMarginTrading(ticker: string, days: number): Promise<DailySeries<MarginTradingRow>> {
  return collectDaily("證交所", marginDay, ticker, days, (date, v) => ({
    date,
    marginBuy: parseTwNumber(v[0]),
    marginSell: parseTwNumber(v[1]),
    marginBalance: parseTwNumber(v[2]),
    shortBuy: parseTwNumber(v[3]),
    shortSell: parseTwNumber(v[4]),
    shortBalance: parseTwNumber(v[5]),
  }));
}
