import type { FreqDetailedPoint } from '../../../../Bindings';

export function normalizeMapMessageIds(messageIds: readonly unknown[]): number[] {
  return Array.from(
    new Set(messageIds.filter((messageId): messageId is number => Number.isInteger(messageId))),
  );
}

export function missingMapMessageIds(
  requestedMessageIds: readonly number[],
  messages: Array<readonly [number, unknown]>,
): number[] {
  const loadedMessageIds = new Set(messages.map(([messageId]) => messageId));
  return requestedMessageIds.filter((messageId) => !loadedMessageIds.has(messageId));
}

export function removeMapPointsForMissingMessages(
  points: FreqDetailedPoint[],
  missingMessageIds: readonly number[],
): FreqDetailedPoint[] {
  if (missingMessageIds.length === 0) return points;

  const missingMessageIdsSet = new Set(missingMessageIds);
  return points.filter((point) => !missingMessageIdsSet.has(point.messageId));
}
