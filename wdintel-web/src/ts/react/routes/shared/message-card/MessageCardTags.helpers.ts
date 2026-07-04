import type { InboxMessage, Tag } from '../../../../../Bindings';

export type MessageCardTagRow = {
  tagId: number;
  label: string;
  isSet: boolean;
  tip: string | null;
  showBadge: boolean;
  humanContribsLen: number;
  botContribsLen: number;
};

function getFallbackTagOrder(tagsMap: Record<number, Tag>): number[] {
  return Object.keys(tagsMap)
    .map(Number)
    .filter((tagId) => Number.isFinite(tagId));
}

export function resolveTagDisplayOrder(
  tagsMap: Record<number, Tag>,
  tagsOrder?: number[],
): number[] {
  const seen = new Set<number>();
  const ordered: number[] = [];

  for (const tagId of tagsOrder ?? []) {
    if (!Number.isFinite(tagId)) continue;
    if (!tagsMap[tagId]) continue;
    if (seen.has(tagId)) continue;
    seen.add(tagId);
    ordered.push(tagId);
  }

  for (const tagId of getFallbackTagOrder(tagsMap)) {
    if (seen.has(tagId)) continue;
    seen.add(tagId);
    ordered.push(tagId);
  }

  const isCustom = (tagId: number): boolean => tagsMap[tagId]?.ownerOrganismId != null;
  const ordValue = (tagId: number): number => tagsMap[tagId]?.ord ?? Number.POSITIVE_INFINITY;

  // Stable sort: organism (custom) tags first, sorted by ord ascending (null ord last);
  // global tags keep their backend order.
  return ordered.slice().sort((a, b) => {
    const aCustom = isCustom(a);
    const bCustom = isCustom(b);
    if (aCustom !== bCustom) return aCustom ? -1 : 1;
    if (aCustom && bCustom) return ordValue(a) - ordValue(b);
    return 0;
  });
}

export function buildMessageCardTagRows(
  msg: InboxMessage,
  tagsMap: Record<number, Tag>,
  tagsOrder?: number[],
): MessageCardTagRow[] {
  return resolveTagDisplayOrder(tagsMap, tagsOrder).map((numericTagId) => {
    const tag = tagsMap[numericTagId];
    const label = tag?.label ?? `#${numericTagId}`;
    const inboxTagList = msg.inboxTags ?? [];
    const isSet =
      inboxTagList.length > 0
        ? inboxTagList.some((tagEntry) => tagEntry.tagId === numericTagId)
        : (msg.tags ?? []).includes(numericTagId);
    const contribs = inboxTagList.filter((tagEntry) => tagEntry.tagId === numericTagId);
    const humanContribs = contribs.filter((tagEntry) => !tagEntry.model);
    const botContribs = contribs.filter((tagEntry) => tagEntry.model);
    const humanLogins = humanContribs
      .map((tagEntry) => tagEntry.login)
      .filter((value): value is string => Boolean(value));
    const bots = botContribs.map(
      (tagEntry) => `${tagEntry.model} (${Math.round((tagEntry.confidence ?? 0) * 100)}%)`,
    );
    const tip =
      isSet && (humanContribs.length > 0 || botContribs.length > 0)
        ? [
            ...(humanLogins.length > 0
              ? [`Користувачі: ${humanLogins.join(', ')}`]
              : humanContribs.length > 0
                ? ['Користувачі: (ваш вибір)']
                : []),
            ...(bots.length > 0 ? [`Боти: ${bots.join(', ')}`] : []),
          ].join('\n')
        : null;

    return {
      tagId: numericTagId,
      label,
      isSet,
      tip,
      showBadge: isSet && (humanContribs.length > 0 || botContribs.length > 0),
      humanContribsLen: humanContribs.length,
      botContribsLen: botContribs.length,
    };
  });
}
