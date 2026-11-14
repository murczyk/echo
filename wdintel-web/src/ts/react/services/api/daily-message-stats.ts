import type {
  DailyMessageStatsReq,
  DailyMessageStatsPanelsRsp,
  DailyMessageStatsRsp,
  DailyMessageStatsOptionsReq,
  DailyMessageStatsOptionsRsp,
  DailyMessageStatsCatalogReq,
  DailyMessageStatsCatalogRsp,
  DailyMessageStatsFacetReq,
  DailyMessageStatsFacetRsp,
  DailyMessageStatsSendersReq,
  DailyMessageStatsSendersRsp,
} from '../../../../Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';
import { HttpRequestError, postJson, type RequestOptions } from './client';

const DAILY_MESSAGE_STATS_HTTP_TIMEOUT_MS = 65_000;

async function readStats<T>(
  url: string,
  req:
    | DailyMessageStatsReq
    | DailyMessageStatsOptionsReq
    | DailyMessageStatsCatalogReq
    | DailyMessageStatsFacetReq
    | DailyMessageStatsSendersReq,
  options?: RequestOptions,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  options?.signal?.addEventListener('abort', abort, { once: true });
  if (options?.signal?.aborted) abort();
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, DAILY_MESSAGE_STATS_HTTP_TIMEOUT_MS);
  try {
    const raw = await postJson<unknown>(url, transformCamelToSnake(req), {
      ...options,
      signal: controller.signal,
    });
    return transformSnakeToCamel<T>(raw);
  } catch (error) {
    if (timedOut)
      throw new HttpRequestError(
        408,
        'Час очікування статистики вичерпано. Спробуйте коротший період або додайте фільтри.',
      );
    throw error;
  } finally {
    window.clearTimeout(timer);
    options?.signal?.removeEventListener('abort', abort);
  }
}

export function fetchDailyMessageStats(
  req: DailyMessageStatsReq,
  options?: RequestOptions,
): Promise<DailyMessageStatsRsp> {
  return readStats('/api/rer/analysis/stats/daily-messages', req, options);
}

export function fetchDailyMessageStatsOptions(
  req: DailyMessageStatsOptionsReq,
  options?: RequestOptions,
): Promise<DailyMessageStatsOptionsRsp> {
  return readStats('/api/rer/analysis/stats/daily-messages/options', req, options);
}

export function fetchDailyMessageStatsCatalog(
  req: DailyMessageStatsCatalogReq,
  options?: RequestOptions,
): Promise<DailyMessageStatsCatalogRsp> {
  return readStats('/api/rer/analysis/stats/daily-messages/catalog', req, options);
}
export function fetchDailyMessageStatsFacet(
  req: DailyMessageStatsFacetReq,
  options?: RequestOptions,
): Promise<DailyMessageStatsFacetRsp> {
  return readStats('/api/rer/analysis/stats/daily-messages/facet-counts', req, options);
}
export function fetchDailyMessageStatsSenders(
  req: DailyMessageStatsSendersReq,
  options?: RequestOptions,
): Promise<DailyMessageStatsSendersRsp> {
  return readStats('/api/rer/analysis/stats/daily-messages/senders', req, options);
}

export function fetchDailyMessageStatsPanels(
  req: DailyMessageStatsReq,
  options?: RequestOptions,
): Promise<DailyMessageStatsPanelsRsp> {
  return readStats('/api/rer/analysis/stats/daily-messages/panels', req, options);
}
