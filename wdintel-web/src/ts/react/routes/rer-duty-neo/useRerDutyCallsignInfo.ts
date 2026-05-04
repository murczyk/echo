import { useCallback, useMemo, useState } from 'react';

import type { CallsignInfoRes } from '../../../../Bindings';
import { normalizeCallsignLookupValue } from '../../utils/callsign-normalization';

function normalizeDutyCallsignText(value: string | null | undefined): string {
  return typeof value === 'string' ? value : '';
}

function mergeDutyCallsignTextField(existing: string | null | undefined, incoming: string | null | undefined): string {
  const existingValue = normalizeDutyCallsignText(existing);
  const incomingValue = normalizeDutyCallsignText(incoming);
  const existingTrimmed = existingValue.trim();
  const incomingTrimmed = incomingValue.trim();
  if (existingTrimmed === '') return incomingValue;
  if (incomingTrimmed === '') return existingValue;
  return incomingTrimmed.length > existingTrimmed.length ? incomingValue : existingValue;
}

export function mergeDutyCallsignInfoEntry(current: CallsignInfoRes | undefined, incoming: CallsignInfoRes): CallsignInfoRes {
  if ((current === null || current === undefined)) return incoming;

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
      position: mergeDutyCallsignTextField(existing.position, row.position),
      comment: mergeDutyCallsignTextField(existing.comment, row.comment),
      unit1: mergeDutyCallsignTextField(existing.unit1, row.unit1),
      unit2: mergeDutyCallsignTextField(existing.unit2, row.unit2),
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
    const key = normalizeCallsignLookupValue(item.callsign);
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

export function updateDutyResolvedCallsignInfoMap(
  prev: Record<string, CallsignInfoRes>,
  items: CallsignInfoRes[] | null | undefined,
): Record<string, CallsignInfoRes> {
  if (!items || items.length === 0) return prev;

  const next = { ...prev };
  items.forEach((item) => {
    const key = normalizeCallsignLookupValue(item.callsign);
    if (item.res.length === 0) {
      delete next[key];
      return;
    }
    next[key] = mergeDutyCallsignInfoEntry(next[key], item);
  });
  return next;
}

export function updateDutyInboxCallsignInfoMapByFeedId(
  prev: Record<string, Record<string, CallsignInfoRes>>,
  feedId: string,
  callsigns: CallsignInfoRes[] | null | undefined,
  options?: { replace?: boolean },
): Record<string, Record<string, CallsignInfoRes>> {
  if (options?.replace) {
    return {
      ...prev,
      [feedId]: replaceDutyCallsignInfoMap(prev[feedId] ?? {}, callsigns),
    };
  }

  if (!callsigns || callsigns.length === 0) return prev;

  return {
    ...prev,
    [feedId]: mergeDutyCallsignInfoMap(prev[feedId] ?? {}, callsigns),
  };
}

export function useRerDutyCallsignInfo() {
  const [inboxCallsignInfoMapByFeedId, setInboxCallsignInfoMapByFeedId] = useState<Record<string, Record<string, CallsignInfoRes>>>(
    {},
  );
  const [resolvedCallsignInfoMap, setResolvedCallsignInfoMap] = useState<Record<string, CallsignInfoRes>>({});

  const mergeInboxCallsigns = useCallback(
    (feedId: string, callsigns: CallsignInfoRes[] | null | undefined, options?: { replace?: boolean }) => {
      setInboxCallsignInfoMapByFeedId((prev) => updateDutyInboxCallsignInfoMapByFeedId(prev, feedId, callsigns, options));
    },
    [],
  );

  const mergeResolvedCallsigns = useCallback((callsigns: CallsignInfoRes[] | null | undefined) => {
    if (!callsigns || callsigns.length === 0) return;
    setResolvedCallsignInfoMap((prev) => updateDutyResolvedCallsignInfoMap(prev, callsigns));
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
