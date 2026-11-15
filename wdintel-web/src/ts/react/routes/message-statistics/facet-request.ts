import type { DailyMessageStatsReq } from '../../../../Bindings';

export function facetFilter(
  request: DailyMessageStatsReq,
  facet: 'Groups' | 'Units' | 'Senders',
): DailyMessageStatsReq {
  const sorted = <T extends string | number>(values: T[] | null): T[] | null =>
    values === null
      ? null
      : [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const senders =
    request.selectedSenders === null
      ? null
      : [...new Set(request.selectedSenders.map((entry) => entry.sender))]
          .sort((left, right) =>
            left === right ? 0 : left === null ? -1 : right === null ? 1 : left < right ? -1 : 1,
          )
          .map((sender) => ({ sender }));
  return {
    ...request,
    grouping: 'Groups',
    cursor: null,
    selectedGroups: facet === 'Groups' ? null : sorted(request.selectedGroups),
    selectedUnitIds: facet === 'Units' ? null : sorted(request.selectedUnitIds),
    selectedSenders: facet === 'Senders' ? null : senders,
  };
}
