import dayjs from 'dayjs';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type {
  AiAgentMapSummary,
  AiAgentMessageCitation,
  InboxMessage,
  SignalGroupEntry,
} from '../../../../Bindings';
import { MapPreview } from './MapPreview';
import { ConversationMapsContext } from './map-documents';
import { EchoChip } from '../../components/EchoChip';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { fetchMessagesByIdsWithMetadata } from '../../services/api/inbox-messages';
import { APP_TIME_ZONE } from '../../utils/misc';
import { summarizeIntelligenceMessage } from '../shared/intelligence-reports';
import { MessageSummaryPreview } from '../shared/message-card/MessageSummaryPreview';
import { buildMessageLinkHref } from '../shared/message-card/message-card.utils';

type ResolvedCitation = { message: InboxMessage; groupName: string } | null;
const EMPTY_CITATIONS: AiAgentMessageCitation[] = [];
const CITATION_BATCH_SIZE = 100;

function citationHref(citation: AiAgentMessageCitation): string {
  return buildMessageLinkHref({ messageUuid: citation.messageIdentifier }, 'analysis');
}

function citationTime(message: InboxMessage): string {
  const date =
    message.timestamp != null
      ? dayjs(message.timestamp).tz(APP_TIME_ZONE)
      : message.date
        ? dayjs.tz(message.date, APP_TIME_ZONE)
        : null;
  if (!date?.isValid()) return 'Дата не вказана';
  const format = date.year() === dayjs().tz(APP_TIME_ZONE).year() ? 'DD.MM' : 'DD.MM.YYYY';
  const time =
    message.isTimeNull === true
      ? ''
      : message.timestamp != null
        ? date.format('HH:mm')
        : (message.time?.slice(0, 5) ?? '');
  return [date.format(format), time].filter(Boolean).join(' ');
}

function resolveMessages(
  ids: number[],
  messages: Array<[number, InboxMessage]>,
  groups: SignalGroupEntry[],
): Map<number, ResolvedCitation> {
  const result = new Map<number, ResolvedCitation>(ids.map((id) => [id, null]));
  for (const [id, message] of messages) {
    result.set(id, {
      message,
      groupName:
        groups.find((group) => group.masterKey === message.groupMasterKey)?.name ?? 'Без групи',
    });
  }
  return result;
}

const CitationContext = createContext<{
  registered: Map<string, AiAgentMessageCitation>;
  maps: Map<string, AiAgentMapSummary>;
  resolved: Map<number, ResolvedCitation>;
  failed: boolean;
  refresh: (id: number) => Promise<boolean>;
} | null>(null);

function CitationAnchor({ href, children: label }: ComponentProps<'a'>) {
  const context = useContext(CitationContext)!;
  const { registered, resolved, failed, refresh } = context;

  if (href?.startsWith('echo-map:')) {
    const summary = context.maps.get(href);
    return summary ? (
      <MapPreview key={`${summary.requestId}:${summary.id}`} summary={summary} inline />
    ) : (
      <EchoChip label="Мапа недоступна" />
    );
  }

  const citation = registered.get(href ?? '');
  if (!citation) {
    if (href?.startsWith('/rer-analysis-neo?')) return <EchoChip label="Неперевірене джерело" />;
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
    );
  }
  const source = resolved.get(citation.messageId);
  if (source === undefined)
    return <EchoChip label={failed ? 'Джерело недоступне' : 'Завантаження джерела…'} />;
  if (source === null) return <EchoChip label="Джерело недоступне" />;
  const time = citationTime(source.message);
  return (
    <MessageSummaryPreview
      summary={summarizeIntelligenceMessage(citation.messageId, source.message)}
      label="Повідомлення"
      groupName={source.groupName}
      time={time}
      onBeforeOpen={() => refresh(citation.messageId)}
    >
      <EchoChip
        label={`${time} ${source.groupName}`}
        href={citationHref(citation)}
        target="_blank"
        rel="noopener noreferrer"
        tone="neutral"
      />
    </MessageSummaryPreview>
  );
}
const MARKDOWN_COMPONENTS = { a: CitationAnchor };

export function CitationMarkdown({
  children,
  citations = EMPTY_CITATIONS,
  maps = [],
}: {
  children: string;
  citations?: AiAgentMessageCitation[];
  maps?: AiAgentMapSummary[];
}) {
  const { notify } = usePowerSnackbar();
  const conversationMaps = useContext(ConversationMapsContext);
  const [resolved, setResolved] = useState(new Map<number, ResolvedCitation>());
  const resolvedRef = useRef(resolved);
  resolvedRef.current = resolved;
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const pending = useRef(new Map<number, Promise<boolean>>());
  const alive = useRef(true);
  const registered = useMemo(
    () => new Map(citations.map((citation) => [citationHref(citation), citation])),
    [citations],
  );
  const needed = [...registered]
    .filter(([href]) => children.includes(`](${href})`))
    .map(([, citation]) => citation.messageId);
  const neededKey = [...new Set(needed)].sort((a, b) => a - b).join(',');

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const ids = neededKey
      .split(',')
      .filter(Boolean)
      .map(Number)
      .filter((id) => !resolvedRef.current.has(id));
    setFailed(false);
    void (async () => {
      try {
        for (let offset = 0; offset < ids.length; offset += CITATION_BATCH_SIZE) {
          const batch = ids.slice(offset, offset + CITATION_BATCH_SIZE);
          const response = await fetchMessagesByIdsWithMetadata(
            batch,
            { skipGroupStats: true },
            { signal: controller.signal },
          );
          if (controller.signal.aborted) return;
          const values = resolveMessages(batch, response.inboxItems, response.signalGroups);
          setResolved((previous) => new Map([...previous, ...values]));
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setResolved(new Map());
        setFailed(true);
        notify({
          severity: 'error',
          message: 'Не вдалося завантажити джерела відповіді. Спробуйте ще раз.',
        });
      }
    })();
    return () => controller.abort();
  }, [neededKey, retry, notify]);

  const refresh = (id: number) => {
    const existing = pending.current.get(id);
    if (existing) return existing;
    const request = fetchMessagesByIdsWithMetadata([id], { skipGroupStats: true })
      .then((response) => {
        if (!alive.current) return false;
        const values = resolveMessages([id], response.inboxItems, response.signalGroups);
        setResolved((previous) => new Map([...previous, ...values]));
        return values.get(id) != null;
      })
      .catch(() => {
        if (alive.current) {
          setResolved((previous) => new Map(previous).set(id, null));
          setFailed(true);
          notify({
            severity: 'error',
            message: 'Не вдалося завантажити попередній перегляд повідомлення.',
          });
        }
        return false;
      })
      .finally(() => {
        pending.current.delete(id);
      });
    pending.current.set(id, request);
    return request;
  };

  return (
    <>
      <CitationContext.Provider
        value={{
          registered,
          resolved,
          failed,
          refresh,
          maps: new Map(
            [...conversationMaps, ...maps].map((summary) => [`echo-map:${summary.id}`, summary]),
          ),
        }}
      >
        <ReactMarkdown
          skipHtml
          disallowedElements={['img']}
          remarkPlugins={[remarkGfm]}
          components={MARKDOWN_COMPONENTS}
          urlTransform={(url) => (url.startsWith('echo-map:') ? url : defaultUrlTransform(url))}
        >
          {children}
        </ReactMarkdown>
      </CitationContext.Provider>
      {failed ? (
        <button
          type="button"
          onClick={() => {
            setResolved(new Map());
            setRetry((value) => value + 1);
          }}
        >
          Повторити завантаження джерел
        </button>
      ) : null}
    </>
  );
}
