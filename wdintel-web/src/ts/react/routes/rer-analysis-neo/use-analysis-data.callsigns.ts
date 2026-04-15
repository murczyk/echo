import type { CallsignInfoRes } from '../../../../Bindings';

export function mergeAnalysisCallsignInfoEntry(current: CallsignInfoRes | undefined, incoming: CallsignInfoRes): CallsignInfoRes {
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

export function mergeAnalysisCallsignInfoMap(
  prev: Record<string, CallsignInfoRes>,
  items: CallsignInfoRes[] | null | undefined,
  options?: { overwrite?: boolean },
): Record<string, CallsignInfoRes> {
  if (!items || items.length === 0) return prev;
  const overwrite = options?.overwrite ?? false;
  const next = { ...prev };
  items.forEach((item) => {
    const key = item.callsign.toLowerCase();
    if (overwrite || next[key] == null) {
      next[key] = item;
      return;
    }
    next[key] = mergeAnalysisCallsignInfoEntry(next[key], item);
  });
  return next;
}

export function buildSummaryCallsignsInfo(
  inboxCallsigns: CallsignInfoRes[] | null | undefined,
  enrichedCallsigns: CallsignInfoRes[] | null | undefined,
): Record<string, CallsignInfoRes> {
  let next: Record<string, CallsignInfoRes> = {};
  next = mergeAnalysisCallsignInfoMap(next, inboxCallsigns, { overwrite: true });
  next = mergeAnalysisCallsignInfoMap(next, enrichedCallsigns);
  return next;
}
