import { useCallback, useMemo, useState } from 'react';

import type { CallsignInfoRes } from '../../../../Bindings';

export function mergeDutyCallsignInfoEntry(current: CallsignInfoRes | undefined, incoming: CallsignInfoRes): CallsignInfoRes {
  if (current == null) return incoming;

  const rowsById = new Map<number, CallsignInfoRes['res'][number]>();
  current.res.forEach((row) => {
    rowsById.set(row.id, row);
  });
  incoming.res.forEach((row) => {
    const existing = rowsById.get(row.id);
    if (!existing) {
      rowsById.set(row.id, row);
      return;
    }
    rowsById.set(row.id, {
      ...existing,
      ...row,
      position: row.position || existing.position,
      comment: row.comment || existing.comment,
      unit1: row.unit1 || existing.unit1,
      unit2: row.unit2 || existing.unit2,
      networkIdsReportedIn: Array.from(new Set([...(existing.networkIdsReportedIn ?? []), ...(row.networkIdsReportedIn ?? [])])),
    });
  });

  return {
    callsign: incoming.callsign || current.callsign,
    res: [...rowsById.values()],
  };
}

export function mergeDutyCallsignInfoMap(
  prev: Record<string, CallsignInfoRes>,
  items: CallsignInfoRes[] | null | undefined,
): Record<string, CallsignInfoRes> {
  if (!items || items.length === 0) return prev;

  const next = { ...prev };
  items.forEach((item) => {
    const key = item.callsign.toLowerCase();
    next[key] = mergeDutyCallsignInfoEntry(next[key], item);
  });
  return next;
}

export function replaceDutyCallsignInfoMap(
  prev: Record<string, CallsignInfoRes>,
  items: CallsignInfoRes[] | null | undefined,
): Record<string, CallsignInfoRes> {
  void prev;
  return mergeDutyCallsignInfoMap({}, items);
}

export function combineDutyCallsignInfoMaps(
  inboxByFeedId: Record<string, Record<string, CallsignInfoRes>>,
  resolved: Record<string, CallsignInfoRes>,
): Record<string, CallsignInfoRes> {
  let next = { ...resolved };
  Object.values(inboxByFeedId).forEach((feedMap) => {
    next = mergeDutyCallsignInfoMap(next, Object.values(feedMap));
  });
  return next;
}

export function useRerDutyCallsignInfo() {
  const [inboxCallsignInfoMapByFeedId, setInboxCallsignInfoMapByFeedId] = useState<Record<string, Record<string, CallsignInfoRes>>>(
    {},
  );
  const [resolvedCallsignInfoMap, setResolvedCallsignInfoMap] = useState<Record<string, CallsignInfoRes>>({});

  const mergeInboxCallsigns = useCallback(
    (feedId: string, callsigns: CallsignInfoRes[] | null | undefined, options?: { replace?: boolean }) => {
      if (!callsigns || callsigns.length === 0) return;
      setInboxCallsignInfoMapByFeedId((prev) => ({
        ...prev,
        [feedId]: options?.replace
          ? replaceDutyCallsignInfoMap(prev[feedId] ?? {}, callsigns)
          : mergeDutyCallsignInfoMap(prev[feedId] ?? {}, callsigns),
      }));
    },
    [],
  );

  const mergeResolvedCallsigns = useCallback((callsigns: CallsignInfoRes[] | null | undefined) => {
    if (!callsigns || callsigns.length === 0) return;
    setResolvedCallsignInfoMap((prev) => mergeDutyCallsignInfoMap(prev, callsigns));
  }, []);

  const retainFeedIds = useCallback((feedIds: string[]) => {
    const activeFeedIds = new Set(feedIds);
    setInboxCallsignInfoMapByFeedId((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([feedId]) => activeFeedIds.has(feedId))),
    );
  }, []);

  const inboxCallsignInfoMap = useMemo(
    () => combineDutyCallsignInfoMaps(inboxCallsignInfoMapByFeedId, {}),
    [inboxCallsignInfoMapByFeedId],
  );
  const callsignInfoMap = useMemo(
    () => combineDutyCallsignInfoMaps(inboxCallsignInfoMapByFeedId, resolvedCallsignInfoMap),
    [inboxCallsignInfoMapByFeedId, resolvedCallsignInfoMap],
  );

  return {
    inboxCallsignInfoMap,
    callsignInfoMap,
    mergeInboxCallsigns,
    mergeResolvedCallsigns,
    retainFeedIds,
  };
}
