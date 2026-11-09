import { useCallback, useEffect, useLayoutEffect, useState } from 'react';

export const DUTY_FEED_COLUMN_SELECTOR = '[data-duty-feed-column]';

export function findDutyFeedColumn(feedId: string | null): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>(DUTY_FEED_COLUMN_SELECTOR)).find(
      (column) => column.dataset.dutyFeedId === feedId,
    ) ?? null
  );
}

type DutyMinimalReportEditorOptions = {
  /** User preference, already narrowed to surfaces that can show a panel over the feed. */
  enabled: boolean;
  reportIntent: boolean;
  editorIntentKey: string | null;
  sourceFeedId: string | null;
  /** Feed identity key: a removed source column must not strand the panel off-screen. */
  feedIdsKey: string;
};

export function useDutyMinimalReportEditor({
  enabled,
  reportIntent,
  editorIntentKey,
  sourceFeedId,
  feedIdsKey,
}: DutyMinimalReportEditorOptions) {
  const [expandedIntentKey, setExpandedIntentKey] = useState<string | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const active =
    enabled && reportIntent && editorIntentKey !== null && expandedIntentKey !== editorIntentKey;

  useEffect(() => {
    setExpandedIntentKey((current) => (current === editorIntentKey ? current : null));
  }, [editorIntentKey]);

  useLayoutEffect(() => {
    setHost(
      active
        ? (findDutyFeedColumn(sourceFeedId) ??
            document.querySelector<HTMLElement>(DUTY_FEED_COLUMN_SELECTOR))
        : null,
    );
  }, [active, feedIdsKey, sourceFeedId]);

  const expand = useCallback(() => setExpandedIntentKey(editorIntentKey), [editorIntentKey]);

  return { active, host, expand };
}
