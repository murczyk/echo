import type { InboxMessage, Tag } from '../../../../../Bindings';

export type MessageCardTagRow = {
  tagId: number;
  label: string;
  isOrganismTag: boolean;
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
  const isExtra = (tagId: number): boolean => Boolean(tagsMap[tagId]?.extra);
  const ordValue = (tagId: number): number => tagsMap[tagId]?.ord ?? Number.POSITIVE_INFINITY;

  // Stable sort that keeps the backend grouping: organism (custom) tags first, then global.
  // Within custom tags, primary (non-extra) tags come before extra tags — matching how the
  // backend appends extra tags after primary ones — and only tags in the same group are
  // reordered by ord ascending (null ord last). This prevents a low-ord extra tag from
  // jumping ahead of primary custom tags in the main chip order.
  return ordered.slice().sort((a, b) => {
    const aCustom = isCustom(a);
    const bCustom = isCustom(b);
    if (aCustom !== bCustom) return aCustom ? -1 : 1;
    if (!aCustom) return 0;
    const aExtra = isExtra(a);
    const bExtra = isExtra(b);
    if (aExtra !== bExtra) return aExtra ? 1 : -1;
    return ordValue(a) - ordValue(b);
  });
}

export function buildMessageCardTagRows(
  msg: InboxMessage,
  tagsMap: Record<number, Tag>,
  tagsOrder?: number[],
  tagContributionsOrganismId?: number,
): MessageCardTagRow[] {
  const inboxTagList = (msg.inboxTags ?? []).filter(
    (tagEntry) =>
      tagContributionsOrganismId == null ||
      (tagEntry.organismId === tagContributionsOrganismId && tagEntry.model == null),
  );
  return resolveTagDisplayOrder(tagsMap, tagsOrder).map((numericTagId) => {
    const tag = tagsMap[numericTagId];
    const label = tag?.label ?? `#${numericTagId}`;
    const isSet =
      tagContributionsOrganismId != null || inboxTagList.length > 0
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
      isOrganismTag: tag?.ownerOrganismId != null,
      isSet,
      tip,
      showBadge: isSet && (humanContribs.length > 0 || botContribs.length > 0),
      humanContribsLen: humanContribs.length,
      botContribsLen: botContribs.length,
    };
  });
}
