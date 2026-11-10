import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  InboxMessage,
  InboxMessagesReq,
  InboxMessagesRsp,
  Tag,
  Unit,
} from '../../../../Bindings';
import { fetchMessagesByIdsMatchingFilters } from '../../services/api/analysis';
import { fetchMessagesByIdsWithMetadata } from '../../services/api/inbox-messages';
import { getTagsForDisplay } from '../../services/api/inbox-reference-data';
import { fetchMessageReplies } from '../../services/api/message-replies';
import { getUnitsByIds } from '../../services/api/units';
import { combineDateTimeToMs } from '../../utils/misc';
import { useInboxChangedMessageIds } from '../shared/useInboxChangedMessageIds';
import { analysisThreadOptions } from './analysis-thread-options';
import { buildInboxReq } from './helpers';
import type { AnalysisQueryState } from './types';
import { toErrorMessage } from './use-analysis-data.shared';

const THREAD_BATCH_SIZE = 100;
const THREAD_REFRESH_INTERVAL_MS = 30_000;
const emptyInbox = (): InboxMessagesRsp => ({
  historySinceMs: null,
  historyPeriodMs: null,
  inboxItems: [],
  signalGroups: [],
  signalProfiles: {},
  callsigns: [],
  pollCursorId: null,
  pageLimit: null,
  freqPelengsSummary: null,
});

async function resolveThreadMembership(anchors: number[], signal: AbortSignal) {
  for (let offset = 0; offset < anchors.length; offset += THREAD_BATCH_SIZE) {
    const candidates = anchors.slice(offset, offset + THREAD_BATCH_SIZE);
    const replies = await fetchMessageReplies(
      { signalMessageIds: candidates, screen: 'Analysis' },
      { signal },
    );
    const available = new Set(replies.replyMessages.map(({ id }) => id));
    const anchor = candidates.find((id) => available.has(id));
    if (anchor != null) return { replies, anchor };
  }
  throw new Error('Повідомлення ланцюжка недоступні.');
}

async function loadThreadInbox(messageId: number, knownIds: number[], signal: AbortSignal) {
  const options = { signal };
  const { replies, anchor } = await resolveThreadMembership(
    Array.from(new Set([messageId, ...knownIds])),
    signal,
  );
  const threadId = replies.replies.find(
    (reply) =>
      (reply.originalSignalMessageId === anchor && !reply.originalDeleted) ||
      (reply.replySignalMessageId === anchor && !reply.replyDeleted),
  )?.threadId;
  const relations = replies.replies.filter((reply) => reply.threadId === threadId);
  const ids = new Set([anchor]);
  for (const relation of relations) {
    if (relation.originalSignalMessageId != null && !relation.originalDeleted)
      ids.add(relation.originalSignalMessageId);
    if (relation.replySignalMessageId != null && !relation.replyDeleted)
      ids.add(relation.replySignalMessageId);
  }
  const inbox = emptyInbox();
  const candidates = Array.from(ids);
  for (let offset = 0; offset < candidates.length; offset += THREAD_BATCH_SIZE) {
    const batch = await fetchMessagesByIdsWithMetadata(
      candidates.slice(offset, offset + THREAD_BATCH_SIZE),
      { skipGroupStats: true },
      options,
    );
    inbox.inboxItems.push(...batch.inboxItems.filter(([id]) => ids.has(id)));
    inbox.signalGroups.push(...batch.signalGroups);
    Object.assign(inbox.signalProfiles, batch.signalProfiles);
    inbox.callsigns.push(...batch.callsigns);
  }
  const unitIds = Array.from(
    new Set([
      ...inbox.inboxItems.flatMap(([, message]) => message.unitIds ?? []),
      ...inbox.callsigns.flatMap(({ res }) =>
        res.flatMap(({ unitId }) => (unitId == null ? [] : [unitId])),
      ),
    ]),
  );
  const [tags, units] = await Promise.all([
    getTagsForDisplay(options),
    getUnitsByIds(unitIds, options),
  ]);
  return {
    inbox,
    tags,
    units: Object.fromEntries(units.map((unit) => [unit.id, unit])),
    deletedCount:
      relations.filter((reply) => reply.replyDeleted).length +
      (relations[0]?.originalDeleted ? 1 : 0),
  };
}

function threadMessageOrder(message: InboxMessage, basis: AnalysisQueryState['messageTimeBasis']) {
  if (basis === 'creation') return message.createdAtOrder ?? (message.createdAt ?? 0) * 1000;
  const date = message.date?.replace(/^(\d{2})\.(\d{2})\.(\d{4})$/, '$3-$2-$1');
  const time = message.time?.match(/^(\d{2}:\d{2})(?::(\d{2}(?:\.\d+)?))?$/);
  const dateTime = date && time ? combineDateTimeToMs(date, time[1]) : null;
  return dateTime == null ? (message.timestamp ?? 0) : dateTime + Number(time?.[2] ?? 0) * 1000;
}

async function filterThreadMessages(
  inbox: InboxMessagesRsp,
  request: InboxMessagesReq | null,
  basis: AnalysisQueryState['messageTimeBasis'],
  newestFirst: boolean,
  signal: AbortSignal,
) {
  if (!request) return [];
  const ids = inbox.inboxItems.map(([id]) => id);
  const allowed = new Set(ids);
  const messages: Array<[number, InboxMessage]> = [];
  for (let offset = 0; offset < ids.length; offset += THREAD_BATCH_SIZE) {
    const batch = await fetchMessagesByIdsMatchingFilters(
      ids.slice(offset, offset + THREAD_BATCH_SIZE),
      request,
      { signal },
    );
    messages.push(...batch.filter(([id]) => allowed.has(id)));
  }
  return messages.sort(
    ([leftId, left], [rightId, right]) =>
      (threadMessageOrder(left, basis) - threadMessageOrder(right, basis) || leftId - rightId) *
      (newestFirst ? -1 : 1),
  );
}

export function useAnalysisThreadData({
  messageId,
  enabled,
  queryState,
  newestFirst,
  onError,
}: {
  messageId: number | null;
  enabled: boolean;
  queryState: AnalysisQueryState;
  newestFirst: boolean;
  onError: (error: string) => void;
}) {
  const [inbox, setInbox] = useState(emptyInbox);
  const [tags, setTags] = useState<{ tagsMap: Record<number, Tag>; tagsOrder: number[] }>({
    tagsMap: {},
    tagsOrder: [],
  });
  const [units, setUnits] = useState<Record<number, Unit>>({});
  const [messages, setMessages] = useState<Array<[number, InboxMessage]>>([]);
  const [membersLoading, setMembersLoading] = useState(true);
  const [filtersLoading, setFiltersLoading] = useState(true);
  const [deletedCount, setDeletedCount] = useState(0);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(async () => {
    setRevision((value) => value + 1);
  }, []);
  const knownIds = useRef<number[]>([]);
  const dirty = useRef(false);
  const errorRef = useRef(onError);
  errorRef.current = onError;

  useEffect(() => {
    knownIds.current = [];
    setInbox(emptyInbox());
    setMessages([]);
  }, [messageId]);
  useEffect(() => {
    if (messageId == null || !enabled) return;
    const controller = new AbortController();
    setMembersLoading(true);
    void (async () => {
      try {
        const result = await loadThreadInbox(messageId, knownIds.current, controller.signal);
        controller.signal.throwIfAborted();
        knownIds.current = result.inbox.inboxItems.map(([id]) => id);
        setDeletedCount(result.deletedCount);
        setTags(result.tags);
        setUnits(result.units);
        setInbox(result.inbox);
      } catch (error) {
        if (!controller.signal.aborted) {
          setInbox(emptyInbox());
          setMessages([]);
          errorRef.current(`Не вдалося завантажити ланцюжок: ${toErrorMessage(error)}`);
        }
      } finally {
        if (!controller.signal.aborted) setMembersLoading(false);
      }
    })();
    return () => controller.abort();
  }, [messageId, enabled, revision]);

  const filterOptions = useMemo(
    () => analysisThreadOptions(inbox, tags.tagsMap, units),
    [inbox, tags, units],
  );
  const inboxReq = buildInboxReq(
    queryState,
    filterOptions.freqs.map(({ value }) => value),
    true,
  );
  const requestKey = JSON.stringify(inboxReq);
  useEffect(() => {
    if (messageId == null || !enabled) return;
    const controller = new AbortController();
    const request = inboxReq;
    setFiltersLoading(true);
    void (async () => {
      try {
        const messages = await filterThreadMessages(
          inbox,
          request,
          queryState.messageTimeBasis,
          newestFirst,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        setMessages(messages);
      } catch (error) {
        if (!controller.signal.aborted) {
          setMessages([]);
          errorRef.current(`Не вдалося відфільтрувати ланцюжок: ${toErrorMessage(error)}`);
        }
      } finally {
        if (!controller.signal.aborted) setFiltersLoading(false);
      }
    })();
    return () => controller.abort();
  }, [messageId, enabled, inbox, requestKey, newestFirst]);

  useInboxChangedMessageIds({
    ignoreEvent: () => messageId == null,
    onMessageIds: async (ids) => {
      dirty.current = true;
      if (ids.some((id) => knownIds.current.includes(id))) await refresh();
    },
  });
  useEffect(() => {
    if (messageId == null) return;
    const timer = window.setInterval(() => {
      if (!dirty.current) return;
      dirty.current = false;
      void refresh();
    }, THREAD_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [messageId, refresh]);
  return {
    messages,
    inbox,
    anchorId: inbox.inboxItems.some(([id]) => id === messageId)
      ? messageId
      : (inbox.inboxItems[0]?.[0] ?? null),
    options: filterOptions,
    tags,
    units,
    loading: membersLoading || filtersLoading,
    deletedCount,
    refresh,
  };
}
