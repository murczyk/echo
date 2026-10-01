import AddCommentOutlinedIcon from '@mui/icons-material/AddCommentOutlined';
import CloseIcon from '@mui/icons-material/Close';
import RefreshIcon from '@mui/icons-material/Refresh';
import SendOutlinedIcon from '@mui/icons-material/SendOutlined';
import StopOutlinedIcon from '@mui/icons-material/StopOutlined';
import {
  Box,
  CircularProgress,
  Divider,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { FormEvent, lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AiAgentActivityPresentation,
  AiAgentMapEditTarget,
  AiAgentMapSummary,
  AiAgentMessageCitation,
} from '../../../../Bindings';
import { CitationMarkdown } from './CitationMarkdown';
import { MapEditContext } from './MapEditContext';
import { MapPreview } from './MapPreview';
import {
  ConversationMapsContext,
  invalidateMapDocument,
  MapSelectionContext,
} from './map-documents';

const MapWorkspace = lazy(() =>
  import('./MapWorkspace').then((module) => ({ default: module.MapWorkspace })),
);
import { ConversationHistoryItem } from './ConversationHistoryItem';
import {
  RequestActivity,
  RequestDuration,
  type RequestActivityItem,
  type ToolActivity,
} from './RequestActivity';
import {
  AI_AGENT_NEW_CONVERSATION_EVENT,
  conversationIdFromUrl,
  isConversationId,
  writeConversationUrl,
} from './conversation-url';

import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { SidePanelToggleButton } from '../../components/SidePanelToggleButton';
import {
  AiAgentConfiguration,
  AiAgentConversation,
  AiAgentConversationDetail,
  AiAgentEvent,
  AiAgentMessage,
  AiAgentRequestState,
  cancelAiAgentRequest,
  deleteAiAgentConversation,
  getAiAgentConfiguration,
  getAiAgentConversation,
  listAiAgentConversations,
  submitAiAgentRequest,
} from '../../services/api/ai-agent';
import { HttpRequestError } from '../../services/api/client';
import { streamAiAgentEventsWithReconnect } from './stream';

type Source = { title: string; url: string | null };

export type LiveRequest = {
  id: string;
  conversationId: string;
  prompt: string;
  createdAt: number;
  finishedAt?: number;
  state: AiAgentRequestState;
  assistantText: string;
  progress: string[];
  currentActivity?: string;
  currentActivityPresentation?: AiAgentActivityPresentation | null;
  tools: ToolActivity[];
  activity?: RequestActivityItem[];
  sources: Source[];
  citations?: AiAgentMessageCitation[];
  maps?: AiAgentMapSummary[];
  lastSequence: number;
  streamError: string | null;
};

type PendingSubmission = {
  id: string;
  prompt: string;
  createdAt: number;
};

const TERMINAL_STATES = new Set<AiAgentRequestState>(['completed', 'failed', 'cancelled']);
const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 48;
const GENERIC_REQUEST_FAILURE = 'Не вдалося виконати запит. Спробуйте ще раз.';
const GENERIC_STREAM_FAILURE = 'Не вдалося відновити з’єднання з потоком відповіді.';
const ACTIVE_CONVERSATION_STORAGE_KEY = 'echo.ai-agent.active-conversation-id';

export const AI_AGENT_CHAT_CARD_HEIGHT = '100%';
const AI_AGENT_CHAT_MAP_DOCK_WIDTH = '420px';
export type AiAgentAvailabilityState = 'enabled' | 'disabled' | 'unavailable';

export const AI_AGENT_CHAT_INITIAL_LOADING_SX = {
  width: '100%',
  height: AI_AGENT_CHAT_CARD_HEIGHT,
  minHeight: 0,
  display: 'grid',
  placeItems: 'center',
} as const;

export const AI_AGENT_CHAT_PANEL_HEADER_SX = {
  p: 2,
} as const;

export const AI_AGENT_CHAT_PANEL_LIST_SX = {
  px: 0,
  py: 0,
} as const;

export const AI_AGENT_CHAT_PANEL_LIST_ITEM_SX = {
  borderRadius: 0,
  mb: 0,
} as const;

export const AI_AGENT_CHAT_COLLAPSED_CONTROLS_SX = {
  top: 16,
  left: 16,
} as const;

export function AiAgentChatInitialLoading() {
  return (
    <Box sx={AI_AGENT_CHAT_INITIAL_LOADING_SX}>
      <CircularProgress aria-label="Завантаження ШІ чату" />
    </Box>
  );
}

function AiAgentChatUnavailable({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Box
      sx={{
        width: '100%',
        height: AI_AGENT_CHAT_CARD_HEIGHT,
        display: 'grid',
        placeItems: 'center',
        px: 2,
      }}
    >
      <Stack spacing={1.5} sx={{ width: '100%', maxWidth: 480 }}>
        <PowerAlert severity="error">{message}</PowerAlert>
        <PowerButton onClick={onRetry}>Спробувати ще раз</PowerButton>
      </Stack>
    </Box>
  );
}

export function historyPaneMotionStyles(open: boolean) {
  return {
    width: { xs: 'min(82%, 300px)', sm: open ? 300 : 0 },
    position: { xs: 'absolute', sm: 'relative' },
    opacity: open ? 1 : 0,
    transform: {
      xs: open ? 'translateX(0)' : 'translateX(-100%)',
      sm: open ? 'translateX(0)' : 'translateX(-12px)',
    },
    visibility: open ? 'visible' : 'hidden',
    pointerEvents: open ? 'auto' : 'none',
    transition: open
      ? 'width 200ms ease, transform 200ms ease, opacity 200ms ease, visibility 0s'
      : 'width 200ms ease, transform 200ms ease, opacity 200ms ease, visibility 0s linear 200ms',
    '@media (prefers-reduced-motion: reduce)': {
      transition: 'none',
    },
  } as const;
}

export function providerOptionDisabled(
  enabled: boolean,
  activeConversationId: string | null,
  selectedProviderId: string,
  optionProviderId: string,
): boolean {
  return !enabled || Boolean(activeConversationId && optionProviderId !== selectedProviderId);
}

function viewportIsNearBottom(): boolean {
  return (
    window.scrollY + window.innerHeight >=
    document.documentElement.scrollHeight - AUTO_SCROLL_BOTTOM_THRESHOLD_PX
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Невідома помилка';
}

function formatConversationTime(timestamp: number): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat('uk-UA', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

export function activeRequestsFromConversation(
  conversation: AiAgentConversationDetail,
): LiveRequest[] {
  const assistantByRequestId = new Map(
    conversation.messages
      .filter((message) => message.role === 'assistant')
      .map((message) => [message.requestId, message]),
  );
  return conversation.messages
    .filter((message) => message.role === 'user' && !TERMINAL_STATES.has(message.requestState))
    .map((message) => ({
      id: message.requestId,
      conversationId: conversation.id,
      prompt: message.content,
      createdAt: message.createdAt,
      state: message.requestState,
      assistantText: assistantByRequestId.get(message.requestId)?.content ?? '',
      citations: assistantByRequestId.get(message.requestId)?.citations ?? [],
      maps: assistantByRequestId.get(message.requestId)?.maps ?? [],
      progress: [],
      tools: [],
      sources: [],
      lastSequence: 0,
      streamError: null,
    }));
}

function updateTool(tools: ToolActivity[], event: AiAgentEvent): ToolActivity[] {
  const id = event.toolCallId ?? event.toolName ?? `tool-${event.sequence}`;
  const current = tools.find((tool) => tool.id === id);
  const next: ToolActivity = {
    id,
    name: event.toolLabel ?? current?.name ?? 'Робота з даними',
    status: event.type !== 'tool_end' ? 'running' : event.isError ? 'failed' : 'completed',
    summary: event.text ?? current?.summary ?? null,
    method: event.method ?? current?.method ?? null,
    path: event.path ?? current?.path ?? null,
    httpStatus: event.status ?? current?.httpStatus ?? null,
    presentation: event.activityPresentation ?? null,
  };
  return current ? tools.map((tool) => (tool.id === id ? next : tool)) : [...tools, next];
}

function appendUnique(items: string[], value: string | null): string[] {
  return value && items.at(-1) !== value ? [...items, value] : items;
}

function finishRequest(
  request: LiveRequest,
  state: AiAgentRequestState,
  finishedAt: number,
): LiveRequest {
  return {
    ...request,
    state,
    finishedAt: request.finishedAt ?? finishedAt,
    tools: request.tools.map((tool) =>
      tool.status === 'running' ? { ...tool, status: 'cancelled' } : tool,
    ),
  };
}

export function applyAiAgentEvent(request: LiveRequest, event: AiAgentEvent): LiveRequest {
  if (event.sequence <= request.lastSequence) return request;
  const next = { ...request, lastSequence: event.sequence };
  if (event.activityOnly) {
    const presentation = event.activityPresentation;
    const runningTool = [...request.tools].reverse().find((tool) => tool.status === 'running');
    const current = runningTool ? runningTool.presentation : request.currentActivityPresentation;
    if (TERMINAL_STATES.has(request.state) || !presentation || current?.key !== presentation.key)
      return next;
    return {
      ...next,
      currentActivityPresentation:
        request.currentActivityPresentation?.key === presentation.key
          ? presentation
          : request.currentActivityPresentation,
      tools: request.tools.map((tool) =>
        tool.presentation?.key === presentation.key ? { ...tool, presentation } : tool,
      ),
    };
  }

  switch (event.type) {
    case 'request_start':
      return { ...next, state: TERMINAL_STATES.has(request.state) ? request.state : 'running' };
    case 'assistant_delta':
      return { ...next, assistantText: request.assistantText + (event.text ?? '') };
    case 'assistant_snapshot':
      return { ...next, assistantText: event.text ?? '' };
    case 'progress': {
      const progress = appendUnique(request.progress, event.text);
      return {
        ...next,
        progress,
        currentActivity: event.text ?? request.currentActivity,
        currentActivityPresentation: event.activityPresentation ?? null,
        activity:
          progress === request.progress
            ? request.activity
            : [...(request.activity ?? []), { text: event.text! }],
      };
    }
    case 'tool_start':
    case 'tool_update':
    case 'tool_end': {
      const tools = updateTool(request.tools, event);
      const updated: LiveRequest = {
        ...next,
        tools,
        currentActivityPresentation: event.activityPresentation ?? null,
        currentActivity:
          event.toolLabel ??
          tools.find((tool) => tool.id === (event.toolCallId ?? event.toolName))?.name ??
          request.currentActivity,
        activity:
          tools.length === request.tools.length
            ? request.activity
            : [...(request.activity ?? []), { toolId: tools[tools.length - 1].id }],
      };
      return TERMINAL_STATES.has(updated.state)
        ? finishRequest(updated, updated.state, updated.finishedAt ?? event.createdAt)
        : updated;
    }
    case 'message_citations': {
      const citations = new Map(
        (request.citations ?? []).map((item) => [item.messageIdentifier, item]),
      );
      for (const citation of event.citations ?? [])
        citations.set(citation.messageIdentifier, citation);
      return { ...next, citations: [...citations.values()] };
    }
    case 'map_artifact': {
      if (!event.map || event.map.requestId !== request.id) return next;
      const maps = request.maps ?? [];
      return maps.some((summary) => summary.id === event.map!.id)
        ? next
        : { ...next, maps: [...maps, event.map] };
    }
    case 'source': {
      const source = {
        title: event.sourceUrl ? (event.sourceTitle ?? 'Джерело') : 'Дані Echo',
        url: event.sourceUrl,
      };
      return request.sources.some((item) => item.title === source.title && item.url === source.url)
        ? next
        : { ...next, sources: [...request.sources, source] };
    }
    case 'completion':
      return {
        ...finishRequest({ ...next, finishedAt: event.createdAt }, 'completed', event.createdAt),
        assistantText: request.assistantText || event.text || '',
      };
    case 'cancellation':
      return finishRequest({ ...next, finishedAt: event.createdAt }, 'cancelled', event.createdAt);
    case 'error':
      return finishRequest({ ...next, finishedAt: event.createdAt }, 'failed', event.createdAt);
    default:
      return next;
  }
}

export function shouldIgnoreStreamError(
  signal: AbortSignal,
  request: LiveRequest | undefined,
): boolean {
  return signal.aborted || Boolean(request && TERMINAL_STATES.has(request.state));
}

function MarkdownContent({
  children,
  citations,
  maps,
}: {
  children: string;
  citations: AiAgentMessageCitation[];
  maps: AiAgentMapSummary[];
}) {
  return (
    <Box
      sx={{
        overflowWrap: 'anywhere',
        '& > :first-of-type': { mt: 0 },
        '& > :last-child': { mb: 0 },
        '& p': { my: 1 },
        '& ul, & ol': { my: 1, pl: 3 },
        '& li': { mb: 0.5 },
        '& a:not(.echo-chip)': { color: 'text.primary', textDecoration: 'underline' },
        '& blockquote': { m: 0, my: 1, pl: 2, borderLeft: 2, borderColor: 'divider' },
        '& code': {
          px: 0.5,
          py: 0.125,
          borderRadius: 0.5,
          bgcolor: 'action.hover',
          fontFamily: 'monospace',
          fontSize: '0.875em',
        },
        '& pre': { overflowX: 'auto', p: 1.5, bgcolor: 'action.hover', borderRadius: 1 },
        '& pre code': { p: 0, bgcolor: 'transparent' },
        '& table': { width: '100%', borderCollapse: 'collapse', my: 1.5 },
        '& th, & td': { border: 1, borderColor: 'divider', px: 1, py: 0.75, textAlign: 'left' },
      }}
    >
      <CitationMarkdown citations={citations} maps={maps}>
        {children}
      </CitationMarkdown>
    </Box>
  );
}

function AssistantMessage({
  content,
  citations = [],
  maps = [],
}: {
  content: string;
  citations?: AiAgentMessageCitation[];
  maps?: AiAgentMapSummary[];
}) {
  const mainMap = [...maps].reverse().find((summary) => summary.isMain);
  const unreferencedMaps = maps.filter(
    (summary) => summary.id !== mainMap?.id && !content.includes(`](echo-map:${summary.id})`),
  );
  return (
    <Box
      sx={{
        alignSelf: 'flex-start',
        width: '100%',
        maxWidth: '100%',
        bgcolor: 'background.paper',
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        px: 2,
        py: 1.5,
      }}
    >
      <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.5 }}>
        ЕХО Агент
      </Typography>
      <MarkdownContent citations={citations} maps={maps}>
        {content}
      </MarkdownContent>
      {unreferencedMaps.length ? (
        <p className="flex flex-wrap gap-echo-xs">
          {unreferencedMaps.map((summary) => (
            <MapPreview key={`${summary.requestId}:${summary.id}`} summary={summary} inline />
          ))}
        </p>
      ) : null}
      {mainMap ? <MapPreview key={`${mainMap.requestId}:${mainMap.id}`} summary={mainMap} /> : null}
    </Box>
  );
}

function ConversationMessage({
  message,
  onRetry,
  retryDisabled = false,
}: {
  message: AiAgentMessage;
  onRetry?: (prompt: string) => void;
  retryDisabled?: boolean;
}) {
  if (message.role === 'assistant') {
    return (
      <AssistantMessage
        content={message.content}
        citations={message.citations}
        maps={message.maps}
      />
    );
  }

  const stateMessage =
    message.requestState === 'failed'
      ? GENERIC_REQUEST_FAILURE
      : message.requestState === 'cancelled'
        ? 'Запит скасовано.'
        : null;

  return (
    <Box
      sx={{
        alignSelf: 'flex-end',
        maxWidth: { xs: '95%', md: '80%' },
        bgcolor: 'action.selected',
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        px: 2,
        py: 1.5,
      }}
    >
      <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.5 }}>
        Ви
      </Typography>
      <Typography component="div" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {message.content}
      </Typography>
      {stateMessage ? (
        <Typography
          variant="body2"
          color={message.requestState === 'failed' ? 'error.main' : 'text.secondary'}
          sx={{ mt: 1 }}
        >
          {stateMessage}
        </Typography>
      ) : null}
      {message.requestState === 'failed' && onRetry ? (
        <PowerButton
          type="button"
          size="small"
          variant="text"
          color="inherit"
          startIcon={<RefreshIcon />}
          disabled={retryDisabled}
          onClick={() => onRetry(message.content)}
          sx={{ mt: 0.5, color: 'text.secondary' }}
        >
          Спробувати ще раз
        </PowerButton>
      ) : null}
    </Box>
  );
}

function LiveResponse({ request }: { request: LiveRequest }) {
  return (
    <Stack spacing={1.5} alignItems="flex-start">
      {request.assistantText || request.maps?.length ? (
        <AssistantMessage
          content={request.assistantText}
          citations={request.citations}
          maps={request.maps}
        />
      ) : null}

      {request.state === 'failed' ? (
        <PowerAlert severity="error">{GENERIC_REQUEST_FAILURE}</PowerAlert>
      ) : null}
      {request.state === 'cancelled' ? (
        <PowerAlert severity="info">Запит скасовано.</PowerAlert>
      ) : null}
      {request.streamError ? (
        <PowerAlert severity="warning">Потік перервано: {request.streamError}</PowerAlert>
      ) : null}
    </Stack>
  );
}

function requestStatus(request: LiveRequest): string {
  if (request.state === 'completed') return 'Хід виконання';
  if (request.state === 'failed') return 'Не вдалося виконати запит';
  if (request.state === 'cancelled') return 'Скасовано';
  if (request.state === 'queued') return 'Готуємо запит…';
  return (
    [...request.tools].reverse().find((tool) => tool.status === 'running')?.name ??
    request.currentActivity ??
    request.progress.at(-1) ??
    'ЕХО Агент працює…'
  );
}

function currentActivityPresentation(request: LiveRequest) {
  if (TERMINAL_STATES.has(request.state)) return { title: requestStatus(request), detail: null };
  const runningTool = [...request.tools].reverse().find((tool) => tool.status === 'running');
  const presentation = runningTool ? runningTool.presentation : request.currentActivityPresentation;
  if (presentation) return presentation;
  const [title, ...detail] = requestStatus(request).split(' · ');
  return { title, detail: detail.join(' · ') || null };
}

function RequestControls({
  request,
  cancelling,
  onCancel,
  onReconnect,
}: {
  request: LiveRequest;
  cancelling: boolean;
  onCancel: (id: string) => void;
  onReconnect: (request: LiveRequest) => void;
}) {
  return (
    <Stack direction="row" alignItems="center">
      <Tooltip title="Скасувати запит">
        <span>
          <IconButton
            type="button"
            aria-label="Скасувати запит"
            disabled={cancelling}
            onClick={() => onCancel(request.id)}
            sx={{ width: 28, height: 28, color: 'inherit', opacity: 0.65 }}
          >
            {cancelling ? <CircularProgress size={14} /> : <CloseIcon sx={{ fontSize: 16 }} />}
          </IconButton>
        </span>
      </Tooltip>
      {request.streamError ? (
        <Tooltip title="Відновити потік">
          <IconButton
            type="button"
            aria-label="Відновити потік"
            onClick={() => onReconnect(request)}
            sx={{ width: 28, height: 28, color: 'inherit' }}
          >
            <RefreshIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      ) : null}
    </Stack>
  );
}

function LiveRequestView({
  request,
  cancelling,
  onCancel,
  onReconnect,
  onRetry,
  retryDisabled,
}: {
  request: LiveRequest;
  cancelling: boolean;
  onCancel: (id: string) => void;
  onReconnect: (request: LiveRequest) => void;
  onRetry: (prompt: string) => void;
  retryDisabled: boolean;
}) {
  const prompt: AiAgentMessage = {
    id: `${request.id}-live-user`,
    requestId: request.id,
    requestState: request.state,
    role: 'user',
    citations: [],
    maps: [],
    content: request.prompt,
    createdAt: request.createdAt,
  };
  const active = !TERMINAL_STATES.has(request.state);
  const presentation = currentActivityPresentation(request);

  return (
    <Stack spacing={1} data-testid={`live-request-${request.id}`}>
      <ConversationMessage message={prompt} onRetry={onRetry} retryDisabled={retryDisabled} />
      <RequestActivity
        tools={request.tools}
        activity={request.activity ?? []}
        active={active}
        completed={request.state === 'completed'}
        status={presentation.title}
        detail={presentation.detail}
        duration={
          <RequestDuration
            createdAt={request.createdAt}
            finishedAt={request.finishedAt}
            active={active}
          />
        }
        controls={
          active ? (
            <RequestControls
              request={request}
              cancelling={cancelling}
              onCancel={onCancel}
              onReconnect={onReconnect}
            />
          ) : undefined
        }
      />
      <LiveResponse request={request} />
    </Stack>
  );
}

export function AiAgentChat({
  onAvailabilityChange,
}: {
  onAvailabilityChange?: (state: AiAgentAvailabilityState) => void;
} = {}) {
  const [configuration, setConfiguration] = useState<AiAgentConfiguration | null>(null);
  const [conversations, setConversations] = useState<AiAgentConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AiAgentMessage[]>([]);
  const [providerId, setProviderId] = useState('');
  const [draft, setDraft] = useState('');
  const [liveRequests, setLiveRequests] = useState<LiveRequest[]>([]);
  const [pendingSubmission, setPendingSubmission] = useState<PendingSubmission | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cancellingIds, setCancellingIds] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [conversationLoadFailed, setConversationLoadFailed] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedMap, setSelectedMap] = useState<AiAgentMapSummary | null>(null);
  const [mapRefreshToken, setMapRefreshToken] = useState(0);
  const mapTargetRef = useRef<AiAgentMapEditTarget | null>(null);
  const editedMapsRef = useRef(new Map<string, AiAgentMapEditTarget>());
  const [mapEditEnabled, setMapEditEnabled] = useState(true);
  const [mapSelectionCount, setMapSelectionCount] = useState(0);
  const mapOpenerRef = useRef<HTMLElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const liveRequestsRef = useRef<LiveRequest[]>([]);
  const streamAbortRefs = useRef(new Map<string, AbortController>());
  const cancellingIdsRef = useRef(new Set<string>());
  const activeConversationIdRef = useRef<string | null>(null);
  const submittingRef = useRef(false);
  const refreshSequenceRef = useRef(0);
  const viewSequenceRef = useRef(0);
  const listSequenceRef = useRef(0);
  const deletedIdsRef = useRef(new Set<string>());
  const requestedConversationIdRef = useRef<string | null>(null);
  const defaultProviderIdRef = useRef('');
  const readyRef = useRef(false);
  const mountedRef = useRef(true);
  const followOutputRef = useRef(false);
  const outputAnchorRef = useRef<HTMLDivElement | null>(null);
  const collapsedHistoryToggleRef = useRef<HTMLButtonElement | null>(null);
  const { notify } = usePowerSnackbar();
  const navigationRef = useRef(syncConversationUrl);
  navigationRef.current = syncConversationUrl;
  const resetRef = useRef(resetConversationView);
  resetRef.current = resetConversationView;

  useEffect(() => {
    mountedRef.current = true;
    try {
      window.sessionStorage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY);
    } catch (_) {}
    const navigate = () => {
      if (readyRef.current) void navigationRef.current();
    };
    const reset = () => {
      requestedConversationIdRef.current = null;
      resetRef.current();
    };
    window.addEventListener('popstate', navigate);
    window.addEventListener(AI_AGENT_NEW_CONVERSATION_EVENT, reset);
    void loadPage();
    return () => {
      mountedRef.current = false;
      viewSequenceRef.current += 1;
      window.removeEventListener('popstate', navigate);
      window.removeEventListener(AI_AGENT_NEW_CONVERSATION_EVENT, reset);
      for (const controller of streamAbortRefs.current.values()) controller.abort();
      streamAbortRefs.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!followOutputRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      outputAnchorRef.current?.scrollIntoView?.({ block: 'nearest' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [liveRequests, pendingSubmission]);

  function replaceLiveRequests(next: LiveRequest[]) {
    liveRequestsRef.current = next;
    if (mountedRef.current) setLiveRequests(next);
  }

  function updateLiveRequest(id: string, update: (request: LiveRequest) => LiveRequest) {
    replaceLiveRequests(
      liveRequestsRef.current.map((request) => (request.id === id ? update(request) : request)),
    );
  }

  function clearLiveRequests() {
    for (const controller of streamAbortRefs.current.values()) controller.abort();
    streamAbortRefs.current.clear();
    replaceLiveRequests([]);
  }

  function closeHistoryPanel() {
    const focusedElement = document.activeElement;
    if (focusedElement instanceof HTMLElement && focusedElement.closest('aside')) {
      focusedElement.blur();
    }
    setHistoryOpen(false);
    window.requestAnimationFrame(() => collapsedHistoryToggleRef.current?.focus());
  }

  async function loadPage() {
    setLoading(true);
    setUnavailable(false);
    setError(null);
    try {
      const nextConfiguration = await getAiAgentConfiguration();
      if (!mountedRef.current) return;
      setConfiguration(nextConfiguration);
      defaultProviderIdRef.current =
        nextConfiguration.defaultProviderId ?? nextConfiguration.providers[0]?.id ?? '';
      setProviderId(defaultProviderIdRef.current);
      if (nextConfiguration.enabled) {
        const nextConversations = await listAiAgentConversations();
        if (!mountedRef.current) return;
        applyConversationList(nextConversations);
        readyRef.current = true;
        void navigationRef.current();
        onAvailabilityChange?.('enabled');
      } else {
        onAvailabilityChange?.('disabled');
      }
    } catch (loadError) {
      const message = `Не вдалося завантажити ШІ чат: ${errorMessage(loadError)}`;
      if (!mountedRef.current) return;
      onAvailabilityChange?.('unavailable');
      setUnavailable(true);
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }

  function applyConversationList(next: AiAgentConversation[]) {
    setConversations(next.filter((conversation) => !deletedIdsRef.current.has(conversation.id)));
  }

  async function refreshConversationList() {
    const sequence = ++listSequenceRef.current;
    try {
      const next = await listAiAgentConversations();
      if (mountedRef.current && sequence === listSequenceRef.current) applyConversationList(next);
    } catch (loadError) {
      if (!mountedRef.current) return;
      notify({
        severity: 'error',
        message: `Не вдалося оновити історію розмов: ${errorMessage(loadError)}`,
      });
    }
  }

  async function refreshConversation(conversationId: string) {
    const refreshSequence = ++refreshSequenceRef.current;
    const viewSequence = viewSequenceRef.current;
    try {
      const conversation = await getAiAgentConversation(conversationId);
      if (
        !mountedRef.current ||
        viewSequence !== viewSequenceRef.current ||
        refreshSequence !== refreshSequenceRef.current ||
        activeConversationIdRef.current !== conversationId
      ) {
        return;
      }
      setMessages(conversation.messages);
      void refreshConversationList();
      reconcileLiveRequests(conversation);
    } catch (reloadError) {
      if (!mountedRef.current || viewSequence !== viewSequenceRef.current) return;
      notify({
        severity: 'error',
        message: `Не вдалося оновити історію розмови: ${errorMessage(reloadError)}`,
      });
    }
  }

  async function syncConversationUrl() {
    if (window.location.pathname !== '/') {
      requestedConversationIdRef.current = null;
      resetConversationView();
      return;
    }
    const id = conversationIdFromUrl();
    if (id === requestedConversationIdRef.current) return;
    requestedConversationIdRef.current = id;
    if (id === null) {
      resetConversationView();
    } else if (!isConversationId(id) || deletedIdsRef.current.has(id)) {
      startNewConversation(true);
      notify({ severity: 'error', message: 'Посилання на розмову недійсне або розмову видалено.' });
    } else {
      await openConversation(id);
    }
  }

  function selectConversation(id: string) {
    closeHistoryPanel();
    if (requestedConversationIdRef.current === id && conversationLoadFailed) {
      void openConversation(id);
    } else {
      writeConversationUrl(id);
    }
  }

  async function openConversation(id: string) {
    const viewSequence = resetConversationView();
    setLoadingConversation(true);
    try {
      const conversation = await getAiAgentConversation(id);
      if (!mountedRef.current || viewSequence !== viewSequenceRef.current) return;
      activateConversation(conversation);
    } catch (loadError) {
      const message = `Не вдалося відкрити розмову: ${errorMessage(loadError)}`;
      if (!mountedRef.current || viewSequence !== viewSequenceRef.current) return;
      if (loadError instanceof HttpRequestError && [403, 404].includes(loadError.status)) {
        startNewConversation(true);
      } else {
        setConversationLoadFailed(true);
        setError(message);
      }
      notify({ severity: 'error', message });
    } finally {
      if (mountedRef.current && viewSequence === viewSequenceRef.current) {
        setLoadingConversation(false);
      }
    }
  }

  function activateConversation(conversation: AiAgentConversationDetail) {
    clearLiveRequests();
    activeConversationIdRef.current = conversation.id;
    setActiveConversationId(conversation.id);
    setMessages(conversation.messages);
    if (conversation.providerId) setProviderId(conversation.providerId);
    const activeRequests = activeRequestsFromConversation(conversation);
    replaceLiveRequests(activeRequests);
    for (const request of activeRequests) {
      void connectToRequest(request.id, request.conversationId);
    }
  }

  function reconcileLiveRequests(conversation: AiAgentConversationDetail) {
    const userByRequestId = new Map(
      conversation.messages
        .filter((message) => message.role === 'user')
        .map((message) => [message.requestId, message]),
    );
    const assistantByRequestId = new Map(
      conversation.messages
        .filter((message) => message.role === 'assistant')
        .map((message) => [message.requestId, message]),
    );
    replaceLiveRequests(
      liveRequestsRef.current.map((request) => {
        const userMessage = userByRequestId.get(request.id);
        if (request.conversationId !== conversation.id || !userMessage) return request;
        const assistantMessage = assistantByRequestId.get(request.id);
        return {
          ...(TERMINAL_STATES.has(userMessage.requestState)
            ? finishRequest(
                assistantMessage ? { ...request, finishedAt: assistantMessage.createdAt } : request,
                userMessage.requestState,
                Date.now(),
              )
            : request),
          state: userMessage.requestState,
          assistantText: assistantMessage?.content ?? request.assistantText,
          citations: assistantMessage?.citations ?? request.citations,
          maps: assistantMessage?.maps ?? request.maps,
        };
      }),
    );
  }

  function resetConversationView() {
    viewSequenceRef.current += 1;
    refreshSequenceRef.current += 1;
    activeConversationIdRef.current = null;
    submittingRef.current = false;
    setActiveConversationId(null);
    setProviderId(defaultProviderIdRef.current);
    setMessages([]);
    setSelectedMap(null);
    mapOpenerRef.current = null;
    clearLiveRequests();
    setDraft('');
    setPendingSubmission(null);
    setSubmitting(false);
    setLoadingConversation(false);
    setConversationLoadFailed(false);
    setError(null);
    followOutputRef.current = false;
    return viewSequenceRef.current;
  }

  function startNewConversation(replace = false) {
    requestedConversationIdRef.current = null;
    resetConversationView();
    writeConversationUrl(null, replace);
  }

  async function deleteConversation(id: string) {
    await deleteAiAgentConversation(id);
    if (!mountedRef.current) return;
    deletedIdsRef.current.add(id);
    setConversations((current) => current.filter((conversation) => conversation.id !== id));
    if (requestedConversationIdRef.current === id) startNewConversation(true);
  }

  function handleEvent(requestId: string, event: AiAgentEvent) {
    updateLiveRequest(requestId, (request) => applyAiAgentEvent(request, event));
    if (event.type === 'error') {
      notify({ severity: 'error', message: GENERIC_REQUEST_FAILURE });
    }
  }

  async function connectToRequest(requestId: string, conversationId: string) {
    if (streamAbortRefs.current.has(requestId)) return;
    const viewSequence = viewSequenceRef.current;
    const controller = new AbortController();
    streamAbortRefs.current.set(requestId, controller);
    updateLiveRequest(requestId, (request) => ({ ...request, streamError: null }));
    try {
      await streamAiAgentEventsWithReconnect({
        requestId,
        signal: controller.signal,
        getAfterSequence: () =>
          liveRequestsRef.current.find((request) => request.id === requestId)?.lastSequence ?? 0,
        isTerminal: () =>
          Boolean(
            liveRequestsRef.current
              .filter((request) => request.id === requestId)
              .some((request) => TERMINAL_STATES.has(request.state)),
          ),
        onEvent: (event) => {
          if (!controller.signal.aborted && viewSequence === viewSequenceRef.current) {
            handleEvent(requestId, event);
          }
        },
      });
    } catch (_) {
      const current = liveRequestsRef.current.find((request) => request.id === requestId);
      if (!shouldIgnoreStreamError(controller.signal, current)) {
        const terminal = await reconcileRequestState(requestId, conversationId, viewSequence);
        const reconciled = liveRequestsRef.current.find((request) => request.id === requestId);
        if (!terminal && !shouldIgnoreStreamError(controller.signal, reconciled)) {
          updateLiveRequest(requestId, (request) => ({
            ...request,
            streamError: GENERIC_STREAM_FAILURE,
          }));
          notify({ severity: 'error', message: GENERIC_STREAM_FAILURE });
        }
      }
    } finally {
      if (streamAbortRefs.current.get(requestId) === controller) {
        streamAbortRefs.current.delete(requestId);
      }
    }

    const current = liveRequestsRef.current.find((request) => request.id === requestId);
    if (!controller.signal.aborted && current && TERMINAL_STATES.has(current.state)) {
      setMapRefreshToken((token) => token + 1);
      const edited = editedMapsRef.current.get(requestId);
      if (edited) {
        editedMapsRef.current.delete(requestId);
        // Refresh previews of the edited map even when its workspace is closed.
        invalidateMapDocument({ requestId: edited.requestId, id: edited.mapId });
      }
      await refreshConversation(conversationId);
    }
  }

  async function reconcileRequestState(
    requestId: string,
    conversationId: string,
    viewSequence: number,
  ) {
    try {
      const conversation = await getAiAgentConversation(conversationId);
      if (!mountedRef.current || viewSequence !== viewSequenceRef.current) return false;
      setMessages(conversation.messages);
      reconcileLiveRequests(conversation);
      const requestMessage = conversation.messages.find(
        (message) => message.role === 'user' && message.requestId === requestId,
      );
      return Boolean(requestMessage && TERMINAL_STATES.has(requestMessage.requestState));
    } catch (_) {
      return false;
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    await submitPrompt(draft.trim());
  }

  function retryRequest(prompt: string) {
    void submitPrompt(prompt, { preserveDraft: true });
  }

  async function submitPrompt(prompt: string, { preserveDraft = false } = {}) {
    if (
      !prompt ||
      !providerId ||
      submittingRef.current ||
      loadingConversation ||
      conversationLoadFailed ||
      (preserveDraft &&
        liveRequestsRef.current.some((request) => !TERMINAL_STATES.has(request.state)))
    )
      return;
    const viewSequence = viewSequenceRef.current;

    followOutputRef.current = viewportIsNearBottom();
    submittingRef.current = true;
    setSubmitting(true);
    const createdAt = Date.now();
    setPendingSubmission({ id: `pending-${createdAt}`, prompt, createdAt });
    if (!preserveDraft) setDraft('');
    setError(null);

    try {
      const mapTarget = mapTargetRef.current;
      const mapEdit =
        selectedMap &&
        mapEditEnabled &&
        mapTarget &&
        mapTarget.requestId === selectedMap.requestId &&
        mapTarget.mapId === selectedMap.id
          ? mapTarget
          : null;
      const created = await submitAiAgentRequest({
        conversationId: activeConversationIdRef.current,
        providerId,
        message: prompt,
        ...(mapEdit ? { mapEdit } : {}),
      });
      if (mapEdit) editedMapsRef.current.set(created.id, mapEdit);
      if (!mountedRef.current) return;
      void refreshConversationList();
      if (viewSequence !== viewSequenceRef.current) return;
      activeConversationIdRef.current = created.conversationId;
      requestedConversationIdRef.current = created.conversationId;
      setActiveConversationId(created.conversationId);
      writeConversationUrl(created.conversationId);
      replaceLiveRequests([
        ...liveRequestsRef.current,
        {
          id: created.id,
          conversationId: created.conversationId,
          prompt,
          createdAt,
          state: created.state,
          assistantText: '',
          progress: [],
          tools: [],
          sources: [],
          lastSequence: 0,
          streamError: null,
        },
      ]);
      setPendingSubmission(null);
      void connectToRequest(created.id, created.conversationId);
    } catch (submitError) {
      const message = `Не вдалося надіслати запит: ${errorMessage(submitError)}`;
      if (!mountedRef.current) return;
      if (viewSequence !== viewSequenceRef.current) {
        notify({ severity: 'error', message });
        return;
      }
      if (!preserveDraft) setDraft((current) => current || prompt);
      setPendingSubmission(null);
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      if (mountedRef.current && viewSequence === viewSequenceRef.current) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
  }

  async function cancelRequest(id: string) {
    const request = liveRequestsRef.current.find((item) => item.id === id);
    if (!request || TERMINAL_STATES.has(request.state) || cancellingIdsRef.current.has(id)) return;
    const viewSequence = viewSequenceRef.current;
    cancellingIdsRef.current = new Set(cancellingIdsRef.current).add(id);
    setCancellingIds(cancellingIdsRef.current);
    try {
      const state = await cancelAiAgentRequest(id);
      if (!mountedRef.current || viewSequence !== viewSequenceRef.current) return;
      updateLiveRequest(id, (current) =>
        TERMINAL_STATES.has(state)
          ? finishRequest(current, state, Date.now())
          : { ...current, state },
      );
      void refreshConversation(request.conversationId);
    } catch (cancelError) {
      notify({
        severity: 'error',
        message: `Не вдалося скасувати запит: ${errorMessage(cancelError)}`,
      });
    } finally {
      if (mountedRef.current) {
        const next = new Set(cancellingIdsRef.current);
        next.delete(id);
        cancellingIdsRef.current = next;
        setCancellingIds(next);
      }
    }
  }

  function selectMap(summary: AiAgentMapSummary, opener: HTMLElement) {
    mapOpenerRef.current = opener;
    setSelectedMap(summary);
    setMapEditEnabled(true);
  }

  function closeMap() {
    setSelectedMap(null);
    window.requestAnimationFrame(() => {
      if (mapOpenerRef.current?.isConnected) mapOpenerRef.current.focus({ preventScroll: true });
    });
  }

  const conversationMaps = useMemo(
    () => [
      ...new Map(
        [
          ...messages.flatMap((message) => message.maps ?? []),
          ...liveRequests.flatMap((request) => request.maps ?? []),
        ].map((summary) => [summary.id, summary]),
      ).values(),
    ],
    [messages, liveRequests],
  );

  const selectedProvider = useMemo(
    () => configuration?.providers.find((provider) => provider.id === providerId) ?? null,
    [configuration, providerId],
  );
  const activeRequests = liveRequests.filter((request) => !TERMINAL_STATES.has(request.state));
  const activeRequestExists = activeRequests.length > 0;
  const liveRequestIds = useMemo(
    () => new Set(liveRequests.map((request) => request.id)),
    [liveRequests],
  );
  const visibleMessages = messages.filter((message) => !liveRequestIds.has(message.requestId));
  const interactionLocked = submitting || activeRequestExists;
  const retryDisabled =
    interactionLocked || loadingConversation || conversationLoadFailed || !selectedProvider;

  if (unavailable && error) {
    return <AiAgentChatUnavailable message={error} onRetry={() => void loadPage()} />;
  }
  if (!configuration || loading) return <AiAgentChatInitialLoading />;
  if (!configuration.enabled) return null;

  const view = (
    <Box
      sx={{
        width: '100%',
        height: AI_AGENT_CHAT_CARD_HEIGHT,
        display: 'flex',
        position: 'relative',
        overflow: 'hidden',
        bgcolor: 'var(--background-color)',
      }}
    >
      <Box
        component="aside"
        aria-hidden={!historyOpen}
        sx={{
          ...historyPaneMotionStyles(historyOpen),
          flexShrink: 0,
          borderRight: historyOpen ? 1 : 0,
          borderColor: 'divider',
          bgcolor: 'var(--color-card)',
          zIndex: 2,
          inset: { xs: 0, sm: 'auto' },
          boxShadow: { xs: historyOpen ? 4 : 0, sm: 0 },
          overflowY: 'auto',
        }}
      >
        <Stack direction="row" alignItems="center" sx={AI_AGENT_CHAT_PANEL_HEADER_SX}>
          <Typography variant="h6" fontWeight={600} sx={{ flex: 1 }}>
            Розмови
          </Typography>
          <SidePanelToggleButton
            side="left"
            active
            label="Згорнути ліву панель"
            onClick={closeHistoryPanel}
          />
        </Stack>
        <Divider />
        <List sx={AI_AGENT_CHAT_PANEL_LIST_SX}>
          <ListItemButton
            onClick={() => {
              startNewConversation();
              closeHistoryPanel();
            }}
            sx={AI_AGENT_CHAT_PANEL_LIST_ITEM_SX}
          >
            <AddCommentOutlinedIcon fontSize="small" sx={{ mr: 1.5 }} />
            <ListItemText primary="Нова розмова" />
          </ListItemButton>
          {conversations.map((conversation) => (
            <ConversationHistoryItem
              key={conversation.id}
              conversation={conversation}
              selected={conversation.id === activeConversationId}
              timestamp={formatConversationTime(conversation.updatedAt)}
              onSelect={() => selectConversation(conversation.id)}
              onDelete={() => deleteConversation(conversation.id)}
            />
          ))}
        </List>
      </Box>
      <Stack
        data-testid="ai-agent-chat-pane"
        sx={{
          flex: selectedMap ? { xs: 1, lg: `0 0 ${AI_AGENT_CHAT_MAP_DOCK_WIDTH}` } : 1,
          minWidth: 0,
          minHeight: 0,
          position: 'relative',
        }}
      >
        {!historyOpen ? (
          <Stack
            spacing={0.5}
            sx={{ position: 'absolute', ...AI_AGENT_CHAT_COLLAPSED_CONTROLS_SX, zIndex: 1 }}
          >
            <SidePanelToggleButton
              side="left"
              active={false}
              label="Розгорнути ліву панель"
              ref={collapsedHistoryToggleRef}
              onClick={() => setHistoryOpen(true)}
            />
            <Tooltip title="Нова розмова">
              <span>
                <IconButton
                  type="button"
                  aria-label="Нова розмова"
                  onClick={() => startNewConversation()}
                >
                  <AddCommentOutlinedIcon />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
        ) : null}
        <Box
          sx={{
            width: '100%',
            maxWidth: 1300,
            mx: 'auto',
            px: { xs: 1, md: 2 },
            py: { xs: 1, md: 2 },
            pl: historyOpen ? { xs: 1, md: 2 } : { xs: 6, md: 7 },
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            '&:last-child': { pb: { xs: 1, md: 2 } },
          }}
        >
          <Stack spacing={1.5} sx={{ flex: 1, minHeight: 0 }}>
            {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
            {conversationLoadFailed ? (
              <PowerButton
                onClick={() => void openConversation(requestedConversationIdRef.current!)}
              >
                Спробувати ще раз
              </PowerButton>
            ) : null}

            <Stack
              data-testid="ai-agent-chat-messages"
              spacing={1.5}
              sx={{ flex: 1, minHeight: 0, overflowY: 'auto', pr: 0.5 }}
            >
              {loadingConversation ? (
                <Box sx={{ flex: 1, display: 'flex', justifyContent: 'center', py: 5 }}>
                  <CircularProgress />
                </Box>
              ) : visibleMessages.length === 0 &&
                liveRequests.length === 0 &&
                !pendingSubmission ? (
                <Box sx={{ flex: 1, display: 'grid', placeItems: 'center', py: 5 }}>
                  <Typography color="text.secondary" align="center">
                    Спитайте ЕХО
                  </Typography>
                </Box>
              ) : (
                visibleMessages.map((message) => (
                  <ConversationMessage
                    key={message.id}
                    message={message}
                    onRetry={retryRequest}
                    retryDisabled={retryDisabled}
                  />
                ))
              )}
              {liveRequests.map((request) => (
                <LiveRequestView
                  key={request.id}
                  request={request}
                  cancelling={cancellingIds.has(request.id)}
                  onCancel={(id) => void cancelRequest(id)}
                  onRetry={retryRequest}
                  retryDisabled={retryDisabled}
                  onReconnect={(current) =>
                    void connectToRequest(current.id, current.conversationId)
                  }
                />
              ))}
              {pendingSubmission ? (
                <Stack spacing={1} data-testid="pending-ai-agent-request">
                  <ConversationMessage
                    message={{
                      id: pendingSubmission.id,
                      requestId: pendingSubmission.id,
                      requestState: 'queued',
                      role: 'user',
                      citations: [],
                      maps: [],
                      content: pendingSubmission.prompt,
                      createdAt: pendingSubmission.createdAt,
                    }}
                  />
                  <Stack direction="row" spacing={1} alignItems="center" color="text.secondary">
                    <CircularProgress size={13} color="inherit" />
                    <Typography variant="body2">Надсилаємо…</Typography>
                  </Stack>
                </Stack>
              ) : null}
              <Box ref={outputAnchorRef} aria-hidden />
            </Stack>

            <Box
              component="form"
              onSubmit={submit}
              sx={{
                width: '100%',
                maxWidth: 768,
                alignSelf: 'center',
                border: 1,
                borderColor: 'divider',
                borderRadius: 3,
                px: 1.5,
                py: 1,
              }}
            >
              {selectedMap ? (
                <MapEditContext
                  title={selectedMap.title}
                  enabled={mapEditEnabled}
                  selectionCount={mapSelectionCount}
                  onToggle={() => setMapEditEnabled((enabled) => !enabled)}
                  onPrompt={(text) =>
                    setDraft((current) => (current ? `${current} ${text}` : text))
                  }
                />
              ) : null}
              <TextField
                fullWidth
                multiline
                maxRows={5}
                variant="standard"
                placeholder="Повідомлення"
                value={draft}
                disabled={
                  submitting || loadingConversation || conversationLoadFailed || !selectedProvider
                }
                slotProps={{ input: { disableUnderline: true } }}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.closest('form')?.requestSubmit();
                  }
                }}
              />
              <Stack
                direction="row"
                alignItems="center"
                justifyContent="space-between"
                sx={{ mt: 0.5 }}
              >
                <Select
                  variant="standard"
                  disableUnderline
                  value={providerId}
                  disabled={interactionLocked || Boolean(activeConversationId)}
                  onChange={(event) => setProviderId(event.target.value)}
                  inputProps={{ 'aria-label': 'Провайдер ШІ' }}
                  sx={{
                    maxWidth: '70%',
                    minWidth: 0,
                    color: 'text.secondary',
                    fontSize: '0.75rem',
                    opacity: 0.65,
                    '& .MuiSelect-select': { py: 0.25, pr: 3 },
                  }}
                >
                  {configuration.providers.map((provider) => (
                    <MenuItem
                      key={provider.id}
                      value={provider.id}
                      disabled={providerOptionDisabled(
                        provider.enabled,
                        activeConversationId,
                        providerId,
                        provider.id,
                      )}
                    >
                      {provider.name}
                    </MenuItem>
                  ))}
                </Select>
                <Stack direction="row" alignItems="center" spacing={1}>
                  {activeRequestExists ? (
                    <PowerButton
                      type="button"
                      size="small"
                      aria-label={
                        activeRequests.length === 1 ? 'Зупинити запит' : 'Зупинити всі запити'
                      }
                      disabled={activeRequests.every((request) => cancellingIds.has(request.id))}
                      startIcon={
                        activeRequests.some((request) => cancellingIds.has(request.id)) ? (
                          <CircularProgress size={14} color="inherit" />
                        ) : (
                          <StopOutlinedIcon />
                        )
                      }
                      onClick={() =>
                        void Promise.all(activeRequests.map((request) => cancelRequest(request.id)))
                      }
                    >
                      Зупинити
                    </PowerButton>
                  ) : null}
                  <IconButton
                    type="submit"
                    aria-label="Надіслати"
                    disabled={
                      submitting ||
                      loadingConversation ||
                      conversationLoadFailed ||
                      !draft.trim() ||
                      !selectedProvider
                    }
                    size="small"
                    sx={{
                      bgcolor: 'text.primary',
                      color: 'background.paper',
                      '&:hover': { bgcolor: 'text.secondary' },
                    }}
                  >
                    {submitting ? (
                      <CircularProgress size={16} color="inherit" />
                    ) : (
                      <SendOutlinedIcon fontSize="small" />
                    )}
                  </IconButton>
                </Stack>
              </Stack>
            </Box>
          </Stack>
        </Box>
      </Stack>
      {selectedMap ? (
        <Suspense fallback={null}>
          <MapWorkspace
            key={`${selectedMap.requestId}:${selectedMap.id}`}
            summary={selectedMap}
            refreshToken={mapRefreshToken}
            onTargetChange={(target) => {
              mapTargetRef.current = target;
              setMapSelectionCount(target?.selectedPointIds.length ?? 0);
            }}
            onClose={closeMap}
          />
        </Suspense>
      ) : null}
    </Box>
  );
  return (
    <ConversationMapsContext.Provider value={conversationMaps}>
      <MapSelectionContext.Provider value={selectMap}>{view}</MapSelectionContext.Provider>
    </ConversationMapsContext.Provider>
  );
}
