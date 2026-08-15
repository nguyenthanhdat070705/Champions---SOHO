// Data hook for the Today dashboard: loads the RPC snapshot + low-stock + open
// actions, caches the last good result in localStorage, and degrades to that
// cache (with its original dataFreshAt) when a refresh fails offline (spec 2.2
// / FR-13). All Supabase access is via db.ts — this hook only orchestrates.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getTodayDashboard,
  loadLowStockProducts,
  loadOpenActionItems,
} from "../lib/db";
import type { LowStockProduct } from "../lib/db";
import type { DashboardSnapshot, OpenAction } from "../lib/dashboard";

export interface DashboardData {
  snapshot: DashboardSnapshot;
  lowStock: LowStockProduct[];
  actions: OpenAction[];
}

export type DashboardStatus = "loading" | "ready" | "error";

export interface TodayDashboardState {
  status: DashboardStatus;
  data: DashboardData | null;
  /** True while a refresh is in flight on top of already-shown data. */
  refreshing: boolean;
  /** True when the shown data came from cache rather than a confirmed live fetch. */
  offline: boolean;
  /** Vietnamese error text when status === "error". */
  error: string | null;
  refresh: () => void;
}

const CACHE_PREFIX = "soho-today:v1:";

function cacheKey(merchantId: string): string {
  return CACHE_PREFIX + merchantId;
}

function readCache(merchantId: string): DashboardData | null {
  try {
    const raw = localStorage.getItem(cacheKey(merchantId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DashboardData;
    if (!parsed?.snapshot) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(merchantId: string, data: DashboardData): void {
  try {
    localStorage.setItem(cacheKey(merchantId), JSON.stringify(data));
  } catch {
    // storage full / unavailable — non-fatal, we just lose offline support.
  }
}

function isNetworkError(err: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return true;
  }
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("failed to fetch") ||
    msg.includes("networkerror") ||
    msg.includes("load failed") ||
    msg.includes("fetch failed") ||
    msg.includes("network request failed")
  );
}

export function useTodayDashboard(
  merchantId: string | null,
): TodayDashboardState {
  const [data, setData] = useState<DashboardData | null>(null);
  const [status, setStatus] = useState<DashboardStatus>("loading");
  const [refreshing, setRefreshing] = useState(false);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);
  const hasData = useRef(false); // is any (live or cache) data currently shown?

  const load = useCallback(async (merchant: string, isRefresh: boolean) => {
    const id = ++reqId.current;
    if (isRefresh) setRefreshing(true);
    try {
      const [snapshot, lowStock, actions] = await Promise.all([
        getTodayDashboard(merchant),
        loadLowStockProducts(merchant),
        loadOpenActionItems(merchant),
      ]);
      if (id !== reqId.current) return; // superseded by a newer request
      const fresh: DashboardData = { snapshot, lowStock, actions };
      writeCache(merchant, fresh);
      hasData.current = true;
      setData(fresh);
      setOffline(false);
      setError(null);
      setStatus("ready");
    } catch (e) {
      if (id !== reqId.current) return;
      const cached = readCache(merchant);
      if (cached && (isNetworkError(e) || !hasData.current)) {
        // Show the last snapshot honestly, labelled with its own dataFreshAt.
        hasData.current = true;
        setData(cached);
        setOffline(true);
        setError(null);
        setStatus("ready");
      } else if (!hasData.current) {
        setError("Không thể tải dữ liệu. Vui lòng thử lại.");
        setStatus("error");
      } else {
        // We already show data; surface a soft error but keep the numbers.
        setError("Không thể cập nhật dữ liệu mới. Vui lòng thử lại.");
        setOffline(true);
      }
    } finally {
      if (id === reqId.current) setRefreshing(false);
    }
  }, []);

  // Initial load: paint cache instantly (if any), then fetch live.
  useEffect(() => {
    if (!merchantId) return;
    hasData.current = false;
    const cached = readCache(merchantId);
    if (cached) {
      hasData.current = true;
      setData(cached);
      setStatus("ready");
      setOffline(true); // provisional until the live fetch confirms
    } else {
      setData(null);
      setStatus("loading");
    }
    void load(merchantId, false);
  }, [merchantId, load]);

  const refresh = useCallback(() => {
    if (merchantId) void load(merchantId, true);
  }, [merchantId, load]);

  return { status, data, refreshing, offline, error, refresh };
}
