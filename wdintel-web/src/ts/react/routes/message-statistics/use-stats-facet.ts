import type {
  DailyMessageStatsFacet,
  DailyMessageStatsFacetRsp,
  DailyMessageStatsReq,
} from '../../../../Bindings';
import { fetchDailyMessageStatsFacet } from '../../services/api/daily-message-stats';
import { facetFilter } from './facet-request';
import type { useStatsCatalog } from './use-stats-catalog';
import { useStatsResource } from './use-stats-resource';

export function useStatsFacet(
  facet: DailyMessageStatsFacet,
  request: DailyMessageStatsReq | null,
  children: boolean,
  open: boolean,
  catalog: ReturnType<typeof useStatsCatalog>,
) {
  const filter = request ? facetFilter(request, facet) : null;
  const key =
    filter && catalog.accessRevision
      ? JSON.stringify([
          facet,
          catalog.scopeVersion,
          catalog.accessRevision,
          filter,
          facet === 'Units' ? [children, catalog.hierarchy?.revision] : null,
        ])
      : null;
  return useStatsResource<DailyMessageStatsFacetRsp>({
    cache: catalog.cache,
    resourceKey: key,
    active: open && !catalog.denied,
    load: (signal) =>
      fetchDailyMessageStatsFacet(
        { facet, filter: filter!, includeChildren: children },
        { signal },
      ),
    accept: catalog.checkResponse,
    onDenied: catalog.reject,
  });
}
