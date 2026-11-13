import type { MessageMediaInfo } from '../../../../../Bindings';

export function attachmentPositions(
  media: MessageMediaInfo[],
  pendingIds: string[],
  overrides: Record<string, number>,
): Map<string, number> {
  const positions = new Map<string, number>();
  let last = Math.max(0, ...media.map((item) => item.orderF64 ?? 0));
  for (const item of media) positions.set(item.id, item.orderF64 ?? ++last);
  for (const [id, order] of Object.entries(overrides)) {
    if (positions.has(id)) positions.set(id, order);
  }
  last = Math.max(0, ...positions.values());
  for (const id of pendingIds) {
    const order = overrides[id] ?? last + 1;
    positions.set(id, order);
    last = Math.max(last, order);
  }
  return positions;
}

export function moveAttachment(
  ids: string[],
  id: string,
  targetId: string,
  positions: ReadonlyMap<string, number>,
  overrides: Record<string, number>,
  initialize: boolean,
): Record<string, number> {
  const index = ids.indexOf(id);
  const target = ids.indexOf(targetId);
  if (index < 0 || target < 0 || index === target) return overrides;
  const reordered = [...ids];
  reordered.splice(index, 1);
  reordered.splice(target, 0, id);
  const before = positions.get(reordered[target - 1]);
  const after = positions.get(reordered[target + 1]);
  const order = before == null ? after! - 1 : after == null ? before + 1 : before / 2 + after / 2;
  if (
    !Number.isFinite(order) ||
    (before != null && order <= before) ||
    (after != null && order >= after)
  ) {
    return Object.fromEntries(reordered.map((id, index) => [id, index + 1]));
  }
  return { ...(initialize ? Object.fromEntries(positions) : overrides), [id]: order };
}
