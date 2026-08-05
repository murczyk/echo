import AddCommentOutlinedIcon from '@mui/icons-material/AddCommentOutlined';
import CloseIcon from '@mui/icons-material/Close';
import RefreshIcon from '@mui/icons-material/Refresh';
import SendOutlinedIcon from '@mui/icons-material/SendOutlined';
import {
  Box,
  Card,
  CardContent,
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
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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
  getAiAgentConfiguration,
  getAiAgentConversation,
  listAiAgentConversations,
  submitAiAgentRequest,
} from '../../services/api/ai-agent';
import { streamAiAgentEventsWithReconnect } from './stream';

type ToolActivity = {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'failed';
  summary: string | null;
  method: string | null;
  path: string | null;
  httpStatus: number | null;
};

type Source = { title: string; url: string | null };

export type LiveRequest = {
  id: string;
  conversationId: string;
  prompt: string;
  createdAt: number;
  state: AiAgentRequestState;
  assistantText: string;
  progress: string[];
  tools: ToolActivity[];
  sources: Source[];
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

export const AI_AGENT_CHAT_CARD_HEIGHT = {
  xs: 'calc(100dvh - 9.5rem)',
  md: 'min(960px, calc(100dvh - 11rem))',
} as const;

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

function storedActiveConversationId(): string | null {
  try {
    return window.sessionStorage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY);
  } catch (_) {
    return null;
  }
}

function storeActiveConversationId(id: string | null) {
  try {
    if (id) window.sessionStorage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, id);
    else window.sessionStorage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY);
  } catch (_) {}
}

export function activeRequestsFromConversation(
  conversation: AiAgentConversationDetail,
): LiveRequest[] {
  const assistantByRequestId = new Map(
    conversation.messages
      .filter((message) => message.role === 'assistant')
      .map((message) => [message.requestId, message.content]),
  );
  return conversation.messages
    .filter((message) => message.role === 'user' && !TERMINAL_STATES.has(message.requestState))
    .map((message) => ({
      id: message.requestId,
      conversationId: conversation.id,
      prompt: message.content,
      createdAt: message.createdAt,
      state: message.requestState,
      assistantText: assistantByRequestId.get(message.requestId) ?? '',
      progress: [],
      tools: [],
      sources: [],
      lastSequence: 0,
      streamError: null,
    }));
}

function updateTool(tools: ToolActivity[], event: AiAgentEvent): ToolActivity[] {
  const id = event.toolName ?? event.toolCallId ?? `tool-${event.sequence}`;
  const current = tools.find((tool) => tool.id === id);
  const next: ToolActivity = {
    id,
    name: event.toolLabel ?? current?.name ?? 'Робота з даними',
    status: event.type !== 'tool_end' ? 'running' : event.isError ? 'failed' : 'completed',
    summary: event.text ?? current?.summary ?? null,
    method: event.method ?? current?.method ?? null,
    path: event.path ?? current?.path ?? null,
    httpStatus: event.status ?? current?.httpStatus ?? null,
  };
  return current ? tools.map((tool) => (tool.id === id ? next : tool)) : [...tools, next];
}

function appendUnique(items: string[], value: string | null): string[] {
  return value && !items.includes(value) ? [...items, value] : items;
}

export function applyAiAgentEvent(request: LiveRequest, event: AiAgentEvent): LiveRequest {
  if (event.sequence <= request.lastSequence) return request;
  const next = { ...request, lastSequence: event.sequence };

  switch (event.type) {
    case 'request_start':
      return { ...next, state: 'running' };
    case 'assistant_delta':
      return { ...next, assistantText: request.assistantText + (event.text ?? '') };
    case 'progress':
      return { ...next, progress: appendUnique(request.progress, event.text) };
    case 'tool_start':
    case 'tool_update':
    case 'tool_end':
      return { ...next, tools: updateTool(request.tools, event) };
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
        ...next,
        state: 'completed',
        assistantText: request.assistantText || event.text || '',
      };
    case 'cancellation':
      return { ...next, state: 'cancelled' };
    case 'error':
      return {
        ...next,
        state: 'failed',
      };
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

function MarkdownContent({ children }: { children: string }) {
  return (
    <Box
      sx={{
        overflowWrap: 'anywhere',
        '& > :first-of-type': { mt: 0 },
        '& > :last-child': { mb: 0 },
        '& p': { my: 1 },
        '& ul, & ol': { my: 1, pl: 3 },
        '& li': { mb: 0.5 },
        '& a': { color: 'text.primary', textDecoration: 'underline' },
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
      <ReactMarkdown skipHtml disallowedElements={['img']} remarkPlugins={[remarkGfm]}>
        {children}
      </ReactMarkdown>
    </Box>
  );
}

function ConversationMessage({ message }: { message: AiAgentMessage }) {
  const assistant = message.role === 'assistant';
  const stateMessage =
    message.role !== 'user'
      ? null
      : message.requestState === 'failed'
        ? GENERIC_REQUEST_FAILURE
        : message.requestState === 'cancelled'
          ? 'Запит скасовано.'
          : null;
  return (
    <Box
      sx={{
        alignSelf: assistant ? 'flex-start' : 'flex-end',
        maxWidth: { xs: '95%', md: '80%' },
        bgcolor: assistant ? 'background.paper' : 'action.selected',
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        px: 2,
        py: 1.5,
      }}
    >
      <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.5 }}>
        {assistant ? 'ШІ' : 'Ви'}
      </Typography>
      {assistant ? (
        <MarkdownContent>{message.content}</MarkdownContent>
      ) : (
        <Typography component="div" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {message.content}
        </Typography>
      )}
      {stateMessage ? (
        <Typography
          variant="body2"
          color={message.requestState === 'failed' ? 'error.main' : 'text.secondary'}
          sx={{ mt: 1 }}
        >
          {stateMessage}
        </Typography>
      ) : null}
    </Box>
  );
}

function LiveResponse({ request }: { request: LiveRequest }) {
  const hasActivity = request.progress.length > 0 || request.tools.length > 0;
  return (
    <Stack spacing={1.5} alignItems="flex-start">
      {hasActivity ? (
        <Card variant="outlined" sx={{ width: '100%', borderRadius: 0 }}>
          <CardContent sx={{ '&:last-child': { pb: 2 } }}>
            <Typography variant="subtitle2" component="h3">
              Хід виконання
            </Typography>
            {request.progress.map((progress, index) => (
              <Typography key={`${index}-${progress}`} variant="body2" color="text.secondary">
                {progress}
              </Typography>
            ))}
            {request.tools.map((tool) => (
              <Stack key={tool.id} direction="row" spacing={1} alignItems="center" sx={{ mt: 0.5 }}>
                {tool.status === 'running' ? <CircularProgress size={14} /> : null}
                <Typography variant="body2" color="text.secondary">
                  {tool.name}
                  {tool.status === 'running'
                    ? ' · виконується…'
                    : tool.status === 'failed'
                      ? ` · не вдалося${tool.summary ? `: ${tool.summary}` : ''}`
                      : ''}
                </Typography>
              </Stack>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {request.assistantText ? (
        <Box
          sx={{
            maxWidth: { xs: '95%', md: '80%' },
            border: 1,
            borderColor: 'divider',
            bgcolor: 'background.paper',
            borderRadius: 1,
            px: 2,
            py: 1.5,
          }}
        >
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.5 }}>
            ШІ
          </Typography>
          <MarkdownContent>{request.assistantText}</MarkdownContent>
        </Box>
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

function LiveRequestView({
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
  const prompt: AiAgentMessage = {
    id: `${request.id}-live-user`,
    requestId: request.id,
    requestState: request.state,
    role: 'user',
    content: request.prompt,
    createdAt: request.createdAt,
  };
  const active = !TERMINAL_STATES.has(request.state);

  return (
    <Stack spacing={1} data-testid={`live-request-${request.id}`}>
      <ConversationMessage message={prompt} />
      {active ? (
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          sx={{ color: 'text.secondary', minHeight: 32 }}
        >
          <CircularProgress size={14} color="inherit" />
          <Typography
            variant="body2"
            sx={{
              animation: 'aiAgentPulse 1.8s ease-in-out infinite',
              '@keyframes aiAgentPulse': {
                '0%, 100%': { opacity: 0.45 },
                '50%': { opacity: 1 },
              },
            }}
          >
            {request.state === 'queued' ? 'Готуємо запит…' : 'ШІ готує відповідь…'}
          </Typography>
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
            <PowerButton
              type="button"
              size="small"
              variant="text"
              color="inherit"
              startIcon={<RefreshIcon />}
              onClick={() => onReconnect(request)}
            >
              Відновити потік
            </PowerButton>
          ) : null}
        </Stack>
      ) : request.state === 'cancelled' ? (
        <Typography variant="caption" color="text.secondary">
          Скасовано
        </Typography>
      ) : null}
      <LiveResponse request={request} />
    </Stack>
  );
}

export function AiAgentChat({
  onAvailabilityChange,
}: {
  onAvailabilityChange?: (enabled: boolean) => void;
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const liveRequestsRef = useRef<LiveRequest[]>([]);
  const streamAbortRefs = useRef(new Map<string, AbortController>());
  const cancellingIdsRef = useRef(new Set<string>());
  const activeConversationIdRef = useRef<string | null>(null);
  const submittingRef = useRef(false);
  const refreshSequenceRef = useRef(0);
  const mountedRef = useRef(true);
  const followOutputRef = useRef(false);
  const outputAnchorRef = useRef<HTMLDivElement | null>(null);
  const { notify } = usePowerSnackbar();

  useEffect(() => {
    mountedRef.current = true;
    void loadPage();
    return () => {
      mountedRef.current = false;
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

  async function loadPage() {
    setLoading(true);
    setError(null);
    try {
      const nextConfiguration = await getAiAgentConfiguration();
      if (!mountedRef.current) return;
      setConfiguration(nextConfiguration);
      onAvailabilityChange?.(nextConfiguration.enabled);
      setProviderId(
        nextConfiguration.defaultProviderId ?? nextConfiguration.providers[0]?.id ?? '',
      );
      if (nextConfiguration.enabled) {
        const nextConversations = await listAiAgentConversations();
        if (!mountedRef.current) return;
        setConversations(nextConversations);
        await restoreStoredConversation();
      }
    } catch (loadError) {
      const message = `Не вдалося завантажити ШІ чат: ${errorMessage(loadError)}`;
      if (!mountedRef.current) return;
      onAvailabilityChange?.(false);
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }

  async function restoreStoredConversation() {
    const conversationId = storedActiveConversationId();
    if (!conversationId) return;
    try {
      const conversation = await getAiAgentConversation(conversationId);
      if (mountedRef.current) activateConversation(conversation);
    } catch (_) {
      if (!mountedRef.current) return;
      storeActiveConversationId(null);
      notify({
        severity: 'error',
        message: 'Не вдалося відновити останню розмову.',
      });
    }
  }

  async function refreshConversationList() {
    try {
      const next = await listAiAgentConversations();
      if (mountedRef.current) setConversations(next);
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
    try {
      const [conversation, nextConversations] = await Promise.all([
        getAiAgentConversation(conversationId),
        listAiAgentConversations(),
      ]);
      if (
        !mountedRef.current ||
        refreshSequence !== refreshSequenceRef.current ||
        activeConversationIdRef.current !== conversationId
      ) {
        return;
      }
      setMessages(conversation.messages);
      setConversations(nextConversations);
      reconcileLiveRequests(conversation);
    } catch (reloadError) {
      if (!mountedRef.current) return;
      notify({
        severity: 'error',
        message: `Не вдалося оновити історію розмови: ${errorMessage(reloadError)}`,
      });
    }
  }

  async function openConversation(id: string) {
    if (!id) {
      startNewConversation();
      return;
    }
    if (hasActiveRequests()) return;
    setLoadingConversation(true);
    setError(null);
    const refreshSequence = ++refreshSequenceRef.current;
    try {
      const conversation = await getAiAgentConversation(id);
      if (!mountedRef.current || refreshSequence !== refreshSequenceRef.current) return;
      activateConversation(conversation);
      setHistoryOpen(false);
    } catch (loadError) {
      const message = `Не вдалося відкрити розмову: ${errorMessage(loadError)}`;
      if (!mountedRef.current) return;
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      if (mountedRef.current) setLoadingConversation(false);
    }
  }

  function activateConversation(conversation: AiAgentConversationDetail) {
    clearLiveRequests();
    activeConversationIdRef.current = conversation.id;
    storeActiveConversationId(conversation.id);
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
        .map((message) => [message.requestId, message.content]),
    );
    replaceLiveRequests(
      liveRequestsRef.current.map((request) => {
        const userMessage = userByRequestId.get(request.id);
        if (request.conversationId !== conversation.id || !userMessage) return request;
        return {
          ...request,
          state: userMessage.requestState,
          assistantText: assistantByRequestId.get(request.id) ?? request.assistantText,
        };
      }),
    );
  }

  function startNewConversation() {
    if (hasActiveRequests()) return;
    refreshSequenceRef.current += 1;
    activeConversationIdRef.current = null;
    storeActiveConversationId(null);
    setActiveConversationId(null);
    setMessages([]);
    clearLiveRequests();
    setDraft('');
  }

  function hasActiveRequests() {
    return (
      submittingRef.current ||
      liveRequestsRef.current.some((request) => !TERMINAL_STATES.has(request.state))
    );
  }

  function handleEvent(requestId: string, event: AiAgentEvent) {
    updateLiveRequest(requestId, (request) => applyAiAgentEvent(request, event));
    if (event.type === 'error') {
      notify({ severity: 'error', message: GENERIC_REQUEST_FAILURE });
    }
  }

  async function connectToRequest(requestId: string, conversationId: string) {
    if (streamAbortRefs.current.has(requestId)) return;
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
        onEvent: (event) => handleEvent(requestId, event),
      });
    } catch (_) {
      const current = liveRequestsRef.current.find((request) => request.id === requestId);
      if (!shouldIgnoreStreamError(controller.signal, current)) {
        const terminal = await reconcileRequestState(requestId, conversationId);
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
    if (current && TERMINAL_STATES.has(current.state)) {
      await refreshConversation(conversationId);
    }
  }

  async function reconcileRequestState(requestId: string, conversationId: string) {
    try {
      const conversation = await getAiAgentConversation(conversationId);
      if (!mountedRef.current || activeConversationIdRef.current !== conversationId) return false;
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
    const prompt = draft.trim();
    if (!prompt || !providerId || submittingRef.current) return;

    followOutputRef.current = viewportIsNearBottom();
    submittingRef.current = true;
    setSubmitting(true);
    setPendingSubmission({ id: `pending-${Date.now()}`, prompt, createdAt: Date.now() });
    setDraft('');
    setError(null);

    try {
      const created = await submitAiAgentRequest({
        conversationId: activeConversationIdRef.current,
        providerId,
        message: prompt,
      });
      if (!mountedRef.current) return;
      activeConversationIdRef.current = created.conversationId;
      storeActiveConversationId(created.conversationId);
      setActiveConversationId(created.conversationId);
      replaceLiveRequests([
        ...liveRequestsRef.current,
        {
          id: created.id,
          conversationId: created.conversationId,
          prompt,
          createdAt: Date.now(),
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
      void refreshConversationList();
    } catch (submitError) {
      const message = `Не вдалося надіслати запит: ${errorMessage(submitError)}`;
      if (!mountedRef.current) return;
      setDraft((current) => current || prompt);
      setPendingSubmission(null);
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  }

  async function cancelRequest(id: string) {
    const request = liveRequestsRef.current.find((item) => item.id === id);
    if (!request || TERMINAL_STATES.has(request.state) || cancellingIdsRef.current.has(id)) return;
    cancellingIdsRef.current = new Set(cancellingIdsRef.current).add(id);
    setCancellingIds(cancellingIdsRef.current);
    try {
      const state = await cancelAiAgentRequest(id);
      updateLiveRequest(id, (current) => ({ ...current, state }));
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

  const selectedProvider = useMemo(
    () => configuration?.providers.find((provider) => provider.id === providerId) ?? null,
    [configuration, providerId],
  );
  const activeRequestExists = liveRequests.some((request) => !TERMINAL_STATES.has(request.state));
  const liveRequestIds = useMemo(
    () => new Set(liveRequests.map((request) => request.id)),
    [liveRequests],
  );
  const visibleMessages = messages.filter((message) => !liveRequestIds.has(message.requestId));
  const interactionLocked = submitting || activeRequestExists;

  if (!configuration) return null;
  if (loading && configuration.enabled) {
    return (
      <Box sx={{ py: 6, display: 'flex', justifyContent: 'center' }}>
        <CircularProgress aria-label="Завантаження ШІ чату" />
      </Box>
    );
  }
  if (!configuration.enabled) return null;

  return (
    <Card
      variant="outlined"
      sx={{
        borderRadius: 0,
        width: '100%',
        height: AI_AGENT_CHAT_CARD_HEIGHT,
        display: 'flex',
        position: 'relative',
        overflow: 'hidden',
        bgcolor: 'var(--color-card)',
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
          inset: { xs: '0 auto 0 0', sm: 'auto' },
          boxShadow: { xs: historyOpen ? 4 : 0, sm: 0 },
          overflowY: 'auto',
        }}
      >
        <Stack direction="row" alignItems="center" sx={{ minHeight: 56, px: 1.5 }}>
          <Typography variant="h6" fontWeight={600} sx={{ flex: 1 }}>
            Розмови
          </Typography>
          <IconButton aria-label="Закрити історію розмов" onClick={() => setHistoryOpen(false)}>
            <CloseIcon />
          </IconButton>
        </Stack>
        <Divider />
        <List sx={{ px: 1, py: 1 }}>
          <ListItemButton
            disabled={interactionLocked}
            onClick={() => {
              startNewConversation();
              setHistoryOpen(false);
            }}
            sx={{ borderRadius: 1, mb: 0.5 }}
          >
            <AddCommentOutlinedIcon fontSize="small" sx={{ mr: 1.5 }} />
            <ListItemText primary="Нова розмова" />
          </ListItemButton>
          {conversations.map((conversation) => (
            <ListItemButton
              key={conversation.id}
              selected={conversation.id === activeConversationId}
              disabled={interactionLocked || loadingConversation}
              onClick={() => void openConversation(conversation.id)}
              sx={{ borderRadius: 1, mb: 0.5 }}
            >
              <ListItemText
                primary={conversation.title}
                secondary={formatConversationTime(conversation.updatedAt)}
                slotProps={{ primary: { noWrap: true }, secondary: { noWrap: true } }}
              />
            </ListItemButton>
          ))}
        </List>
      </Box>
      <CardContent
        sx={{
          p: { xs: 2, md: 3 },
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          '&:last-child': { pb: { xs: 2, md: 3 } },
        }}
      >
        <Stack spacing={2} sx={{ flex: 1, minHeight: 0 }}>
          <Stack direction="row" gap={1} alignItems="center">
            <SidePanelToggleButton
              side="left"
              active={historyOpen}
              label={historyOpen ? 'Згорнути ліву панель' : 'Розгорнути ліву панель'}
              onClick={() => setHistoryOpen((current) => !current)}
            />
            <Typography component="h2" variant="h5" fontWeight={600} sx={{ flex: 1 }}>
              ШІ
            </Typography>
            <Tooltip title="Нова розмова">
              <span>
                <IconButton
                  type="button"
                  aria-label="Нова розмова"
                  disabled={interactionLocked}
                  onClick={startNewConversation}
                >
                  <AddCommentOutlinedIcon />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>

          {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
          <Divider />

          <Stack spacing={1.5} sx={{ flex: 1, minHeight: 0, overflowY: 'auto', pr: 0.5 }}>
            {loadingConversation ? (
              <Box sx={{ flex: 1, display: 'flex', justifyContent: 'center', py: 5 }}>
                <CircularProgress />
              </Box>
            ) : visibleMessages.length === 0 && liveRequests.length === 0 && !pendingSubmission ? (
              <Box sx={{ flex: 1, display: 'grid', placeItems: 'center', py: 5 }}>
                <Typography color="text.secondary" align="center">
                  Поставте запитання про дані ЕХО
                </Typography>
              </Box>
            ) : (
              visibleMessages.map((message) => (
                <ConversationMessage key={message.id} message={message} />
              ))
            )}
            {liveRequests.map((request) => (
              <LiveRequestView
                key={request.id}
                request={request}
                cancelling={cancellingIds.has(request.id)}
                onCancel={(id) => void cancelRequest(id)}
                onReconnect={(current) => void connectToRequest(current.id, current.conversationId)}
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
            sx={{ border: 1, borderColor: 'divider', borderRadius: 3, px: 1.5, py: 1 }}
          >
            <TextField
              fullWidth
              multiline
              maxRows={5}
              variant="standard"
              placeholder="Повідомлення"
              value={draft}
              disabled={submitting || loadingConversation || !selectedProvider}
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
                disabled={interactionLocked}
                onChange={(event) => setProviderId(event.target.value)}
                inputProps={{ 'aria-label': 'Провайдер ШІ' }}
                sx={{
                  maxWidth: '70%',
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
              <IconButton
                type="submit"
                aria-label="Надіслати"
                disabled={submitting || !draft.trim() || !selectedProvider}
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
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
}
