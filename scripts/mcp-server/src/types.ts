export type MarketType = "TWSE" | "TPEx_OTC" | "TPEx_Emerging" | "unknown";

export const MARKET_LABEL: Record<MarketType, string> = {
  TWSE: "上市",
  TPEx_OTC: "上櫃",
  TPEx_Emerging: "興櫃",
  unknown: "查無此代號",
};

export interface DailyPriceRow {
  date: string; // ISO yyyy-mm-dd
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  average: number | null;
  volume: number | null;
  transactionCount: number | null;
}

export interface InstitutionalFlowRow {
  date: string;
  foreignNet: number | null;
  investmentTrustNet: number | null;
  dealerNet: number | null;
  totalNet: number | null;
}

export interface MarginTradingRow {
  date: string;
  marginBalance: number | null;
  marginBuy: number | null;
  marginSell: number | null;
  shortBalance: number | null;
  shortBuy: number | null;
  shortSell: number | null;
}

export interface CompanyProfile {
  ticker: string;
  name: string;
  shortName: string | null;
  marketType: MarketType;
  listedDate: string | null; // ISO
  incorporationDate: string | null; // ISO
  industry: string | null;
  chairman: string | null;
  generalManager: string | null;
  capital: number | null;
}

export interface TickerSearchHit {
  ticker: string;
  name: string;
  marketType: MarketType;
}

export interface DistributionTier {
  level: number; // TDCC 持股分級 1-15
  range: string | null; // official share range label, e.g. "400,001-600,000"; null if unavailable
  holders: number | null;
  shares: number | null;
  pct: number | null; // 占集保庫存數比例 %
}

export interface DistributionWeek {
  date: string; // ISO
  totalHolders: number | null;
  totalShares: number | null;
  bigHolderLevels: number[]; // tiers whose lower bound exceeds 400,000 shares (400 張)
  bigHolderCount: number | null;
  bigHolderPct: number | null;
  tiers: DistributionTier[];
}
