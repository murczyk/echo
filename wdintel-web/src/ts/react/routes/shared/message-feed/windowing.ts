import type { MessageFeedId } from './message-feed.types';

export type MessageWindowResult<T> = {
  items: T[];
  addedItems: T[];
  removedItems: T[];
};

type MessageWindowOptions<T, Id extends MessageFeedId> = {
  limit: number;
  getId: (item: T) => Id;
  order?: (items: T[]) => T[];
};

export function mergeMessageWindow<T, Id extends MessageFeedId = number>(
  existing: readonly T[],
  incoming: readonly T[],
  edge: 'above' | 'below',
  { limit, getId, order }: MessageWindowOptions<T, Id>,
): MessageWindowResult<T> {
  const seen = new Set<Id>();
  const uniqueExisting = existing.filter((item) => {
    const id = getId(item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const addedItems = incoming.filter((item) => {
    const id = getId(item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const combined =
    edge === 'above' ? [...addedItems, ...uniqueExisting] : [...uniqueExisting, ...addedItems];
  const ordered = order ? order(combined) : combined;
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : ordered.length;
  const removeCount = Math.max(0, ordered.length - normalizedLimit);
  const removedItems =
    edge === 'above' ? ordered.slice(ordered.length - removeCount) : ordered.slice(0, removeCount);
  const items =
    edge === 'above' ? ordered.slice(0, ordered.length - removeCount) : ordered.slice(removeCount);

  const unchanged =
    items.length === existing.length && items.every((item, index) => item === existing[index]);
  return { items: unchanged ? (existing as T[]) : items, addedItems, removedItems };
}
