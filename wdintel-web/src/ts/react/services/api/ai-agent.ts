import { emitUnauthorizedEvent } from '../../auth-redirect';
import { getJson, postJson, postVoid } from './client';
import type {
  AiAgentAdminRequestDetail,
  AiAgentAdminRequestItem,
  AiAgentAdminRequestListReq,
  AiAgentAdminRequestListRsp,
  AiAgentAdminSettingsItem,
  AiAgentAdminSettingsUpdateReq,
  AiAgentAdminUserItem,
  AiAgentAdminUserReq,
  AiAgentConfigurationRsp,
  AiAgentConnectionTestRsp,
  AiAgentContainerItem,
  AiAgentContainerListRsp,
  AiAgentConversationCreateReq,
  AiAgentConversationDetail as AiAgentConversationDetailRsp,
  AiAgentConversationIdReq,
  AiAgentConversationListRsp,
  AiAgentConversationSummary,
  AiAgentConversationUpdateReq,
  AiAgentDispatcherItem,
  AiAgentDispatcherUpdateReq,
  AiAgentEchoProxyItem,
  AiAgentEchoProxyListRsp,
  AiAgentEchoProxyUpsertReq,
  AiAgentIdReq,
  AiAgentMessageItem,
  AiAgentProviderItem,
  AiAgentRequestCancelRsp,
  AiAgentRequestCreateReq,
  AiAgentRequestCreateRsp,
  AiAgentRequestEventItem,
  AiAgentRequestIdReq,
} from '../../../../Bindings';

export type AiAgentRequestState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type AiAgentReviewState = 'pending' | 'safe' | 'suspicious' | 'failed';
export type AiAgentSeverity = 'low' | 'medium' | 'high' | 'critical';

export type AiAgentProvider = AiAgentProviderItem & {
  enabled: boolean;
  isDefault: boolean;
};

export type AiAgentConfiguration = {
  enabled: boolean;
  providers: AiAgentProvider[];
  defaultProviderId: string | null;
};

export type AiAgentConversation = Omit<AiAgentConversationSummary, 'aiEngineId'> & {
  providerId: string | null;
};

export type AiAgentMessage = Omit<AiAgentMessageItem, 'requestState' | 'role'> & {
  id: string;
  requestState: AiAgentRequestState;
  role: 'user' | 'assistant';
};

export type AiAgentConversationDetail = AiAgentConversation & {
  messages: AiAgentMessage[];
};

export type AiAgentEventType =
  | 'request_start'
  | 'progress'
  | 'assistant_delta'
  | 'tool_start'
  | 'tool_update'
  | 'tool_end'
  | 'source'
  | 'completion'
  | 'cancellation'
  | 'error';

export type AiAgentEvent = {
  sequence: number;
  requestId: string;
  type: AiAgentEventType;
  createdAt: number;
  text: string | null;
  toolCallId: string | null;
  toolName: string | null;
  toolLabel?: string | null;
  sourceTitle: string | null;
  sourceUrl: string | null;
  method: string | null;
  path: string | null;
  status: number | null;
  isError: boolean | null;
};

export type AiAgentRequestCreated = {
  id: string;
  conversationId: string;
  state: AiAgentRequestState;
};

export type AiAgentContainer = {
  id: string;
  humanLoginId: string;
  humanLogin: string;
  linkedLoginId: string | null;
  linkedLogin: string | null;
  instanceName: string | null;
  status: string;
  cpuCount: number;
  memoryMib: number;
  storageGib: number;
  processLimit: number;
  lastError: string | null;
  lastStartedAt: number | null;
  lastStoppedAt: number | null;
};

export type AiAgentAuditRequest = {
  id: string;
  humanLoginId: string;
  humanLogin: string;
  conversationId: string;
  providerName: string;
  state: AiAgentRequestState;
  prompt: string;
  response: string | null;
  progress: string[];
  toolActivity: string[];
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  reviewState: AiAgentReviewState;
  severity: AiAgentSeverity | null;
  reviewSummary: string | null;
  reviewCategories: string[];
  reviewAttemptCount: number;
  reviewLastError: string | null;
  alertState: string | null;
  alertAttemptCount: number;
  alertLastError: string | null;
};

export type AiAgentAuditRequestDetail = AiAgentAuditRequest & {
  conversation: AiAgentConversationDetail;
};

export type AiAgentEchoProxy = {
  id: string;
  hostname: string;
  upstream: string;
  enabled: boolean;
  lastTestedAt: number | null;
  lastTestError: string | null;
};

export type AiAgentDispatcher = AiAgentDispatcherItem;

export type AiAgentSettings = {
  enabled: boolean;
  defaultProviderId: string | null;
  allowedProviderIds: string[];
  templateLoginId: string | null;
  reviewerProviderId: string | null;
  reviewEnabled: boolean;
  mattermostChatEnabled: boolean;
  mattermostWebhookConfigured: boolean;
  mattermostWebhookUrl: string;
  clearMattermostWebhook: boolean;
};

export type AiAgentUserStatus = {
  humanLoginId: string;
  linkedLoginId: string | null;
  linkedLogin: string | null;
  linkedLoginEnabled: boolean;
  roles: string[];
  organismName: string | null;
  zoneName: string | null;
  hiddenGroups: string[];
  container: AiAgentContainer | null;
};

type EventPayload = Record<string, unknown>;

const REQUEST_STATES: readonly AiAgentRequestState[] = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
];
const REVIEW_STATES: readonly AiAgentReviewState[] = ['pending', 'safe', 'suspicious', 'failed'];
const SEVERITIES: readonly AiAgentSeverity[] = ['low', 'medium', 'high', 'critical'];

function eventPayload(value: unknown): EventPayload {
  return value && typeof value === 'object' ? (value as EventPayload) : {};
}

function payloadValue(source: EventPayload, camel: string, snake: string = camel): unknown {
  return source[camel] ?? source[snake];
}

function payloadString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function payloadNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function payloadBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function requestState(value: string): AiAgentRequestState {
  if (REQUEST_STATES.includes(value as AiAgentRequestState)) return value as AiAgentRequestState;
  throw new Error(`Невідомий стан запиту: ${value}`);
}

function reviewState(value: string | undefined): AiAgentReviewState {
  return REVIEW_STATES.includes(value as AiAgentReviewState)
    ? (value as AiAgentReviewState)
    : 'pending';
}

function severity(value: string | null | undefined): AiAgentSeverity | null {
  return SEVERITIES.includes(value as AiAgentSeverity) ? (value as AiAgentSeverity) : null;
}

function normalizeProvider(
  value: AiAgentProviderItem,
  defaultProviderId: string | null,
): AiAgentProvider {
  return {
    ...value,
    enabled: true,
    isDefault: value.id === defaultProviderId,
  };
}

function normalizeConversation(
  value: AiAgentConversationSummary | AiAgentConversationDetailRsp,
): AiAgentConversation {
  return {
    id: value.id,
    title: value.title,
    providerId: value.aiEngineId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function normalizeMessage(value: AiAgentMessageItem): AiAgentMessage {
  if (value.role !== 'user' && value.role !== 'assistant') {
    throw new Error(`Невідома роль повідомлення: ${value.role}`);
  }
  return {
    ...value,
    id: `${value.requestId}-${value.role}`,
    requestState: requestState(value.requestState),
    role: value.role,
  };
}

export function normalizeAiAgentEvent(
  value: AiAgentRequestEventItem,
  requestId = '',
): AiAgentEvent {
  let payload: EventPayload = {};
  try {
    payload = eventPayload(JSON.parse(value.payloadJson));
  } catch (_) {
    payload = { text: value.payloadJson };
  }
  return {
    sequence: value.sequence,
    requestId,
    type: value.eventType as AiAgentEventType,
    createdAt: value.createdAt,
    text: payloadString(
      payloadValue(payload, 'errorSummary', 'error_summary') ??
        payload.text ??
        payload.message ??
        payload.delta ??
        payload.content ??
        payload.summary ??
        payload.error,
    ),
    toolCallId: payloadString(payloadValue(payload, 'toolCallId', 'tool_call_id')),
    toolName:
      payloadString(payloadValue(payload, 'toolName', 'tool_name')) ?? payloadString(payload.tool),
    toolLabel: payloadString(payloadValue(payload, 'toolLabel', 'tool_label')),
    sourceTitle:
      payloadString(payloadValue(payload, 'sourceTitle', 'source_title')) ??
      payloadString(payload.title),
    sourceUrl:
      payloadString(payloadValue(payload, 'sourceUrl', 'source_url')) ?? payloadString(payload.url),
    method: payloadString(payload.method)?.toUpperCase() ?? null,
    path: payloadString(payload.path),
    status: payloadNumber(payload.status),
    isError: payloadBoolean(payloadValue(payload, 'isError', 'is_error')),
  };
}

function formatToolActivity(event: AiAgentEvent): string {
  const route = [event.method, event.path].filter(Boolean).join(' ');
  const status = event.status === null ? '' : `HTTP ${event.status}`;
  const result = event.isError === null ? '' : event.isError ? 'помилка' : 'успішно';
  return [
    event.toolName ?? event.sourceTitle ?? (event.type === 'source' ? 'Джерело' : 'Інструмент'),
    route,
    status,
    result,
    event.text,
  ]
    .filter(Boolean)
    .join(' · ');
}

function normalizeContainer(value: AiAgentContainerItem): AiAgentContainer {
  return {
    id: value.linkedAgentId,
    humanLoginId: value.humanLoginId,
    humanLogin: value.humanLogin,
    linkedLoginId: value.agentLoginId,
    linkedLogin: value.agentLogin,
    instanceName: value.instanceName,
    status: value.state,
    cpuCount: 2,
    memoryMib: 4096,
    storageGib: 20,
    processLimit: 512,
    lastError: value.lastError,
    lastStartedAt: value.startedAt,
    lastStoppedAt: value.stoppedAt,
  };
}

function normalizeAuditRequest(
  request: AiAgentAdminRequestItem,
  eventItems: AiAgentRequestEventItem[] = [],
): AiAgentAuditRequest {
  const review = request.review;
  const events = eventItems.map((event) => normalizeAiAgentEvent(event, request.id));
  return {
    id: request.id,
    humanLoginId: request.humanLoginId,
    humanLogin: request.humanLogin,
    conversationId: request.conversationId,
    providerName: request.aiEngineName,
    state: requestState(request.state),
    prompt: request.prompt,
    response: request.response,
    progress: events
      .filter((event) => event.type === 'progress')
      .flatMap((event) => (event.text ? [event.text] : [])),
    toolActivity: events
      .filter((event) => event.type.startsWith('tool_') || event.type === 'source')
      .map(formatToolActivity),
    createdAt: request.queuedAt,
    startedAt: request.startedAt,
    completedAt: request.completedAt,
    reviewState: reviewState(review?.state),
    severity: severity(review?.severity),
    reviewSummary: review?.summary ?? null,
    reviewCategories: review?.categories ?? [],
    reviewAttemptCount: review?.attemptCount ?? 0,
    reviewLastError: review?.lastError ?? null,
    alertState: review?.alertState ?? null,
    alertAttemptCount: review?.alertAttemptCount ?? 0,
    alertLastError: review?.alertLastError ?? null,
  };
}

function normalizeProxy(value: AiAgentEchoProxyItem): AiAgentEchoProxy {
  return {
    id: value.id,
    hostname: value.hostname,
    upstream: `${value.upstreamHost}:${value.upstreamPort}`,
    enabled: value.enabled,
    lastTestedAt: value.lastTestedAt,
    lastTestError: value.lastTestError,
  };
}

function normalizeSettings(value: AiAgentAdminSettingsItem): AiAgentSettings {
  return {
    enabled: value.featureEnabled,
    defaultProviderId: value.defaultAiEngineId,
    allowedProviderIds: value.allowedAiEngineIds,
    templateLoginId: value.templateLoginId,
    reviewerProviderId: value.reviewerAiEngineId,
    reviewEnabled: value.securityReviewEnabled,
    mattermostChatEnabled: value.mattermostChatEnabled,
    mattermostWebhookConfigured: value.hasMattermostWebhook,
    mattermostWebhookUrl: '',
    clearMattermostWebhook: false,
  };
}

export async function getAiAgentConfiguration(): Promise<AiAgentConfiguration> {
  const response = await getJson<AiAgentConfigurationRsp>('/api/ai-agent/configuration');
  return {
    enabled: response.featureEnabled,
    providers: response.providers.map((provider) =>
      normalizeProvider(provider, response.defaultAiEngineId),
    ),
    defaultProviderId: response.defaultAiEngineId,
  };
}

export async function listAiAgentConversations(): Promise<AiAgentConversation[]> {
  const response = await postJson<AiAgentConversationListRsp>(
    '/api/ai-agent/conversations/list',
    {},
  );
  return response.items.map(normalizeConversation);
}

export async function createAiAgentConversation(providerId: string): Promise<AiAgentConversation> {
  const req: AiAgentConversationCreateReq = { aiEngineId: providerId, title: null };
  return normalizeConversation(
    await postJson<AiAgentConversationDetailRsp>('/api/ai-agent/conversations/create', req),
  );
}

export async function getAiAgentConversation(id: string): Promise<AiAgentConversationDetail> {
  const req: AiAgentConversationIdReq = { id };
  const response = await postJson<AiAgentConversationDetailRsp>(
    '/api/ai-agent/conversations/get',
    req,
  );
  return {
    ...normalizeConversation(response),
    messages: response.messages.map(normalizeMessage),
  };
}

export async function updateAiAgentConversation(
  id: string,
  title: string,
): Promise<AiAgentConversationDetail> {
  const req: AiAgentConversationUpdateReq = { id, title };
  const response = await postJson<AiAgentConversationDetailRsp>(
    '/api/ai-agent/conversations/update',
    req,
  );
  return {
    ...normalizeConversation(response),
    messages: response.messages.map(normalizeMessage),
  };
}

export async function deleteAiAgentConversation(id: string): Promise<void> {
  const req: AiAgentConversationIdReq = { id };
  await postVoid('/api/ai-agent/conversations/delete', req);
}

export async function submitAiAgentRequest(input: {
  conversationId: string | null;
  providerId: string;
  message: string;
}): Promise<AiAgentRequestCreated> {
  const req: AiAgentRequestCreateReq = {
    conversationId: input.conversationId,
    aiEngineId: input.providerId,
    prompt: input.message,
  };
  const response = await postJson<AiAgentRequestCreateRsp>('/api/ai-agent/requests/create', req);
  return {
    id: response.requestId,
    conversationId: response.conversationId,
    state: requestState(response.state),
  };
}

export async function cancelAiAgentRequest(id: string): Promise<AiAgentRequestState> {
  const req: AiAgentRequestIdReq = { requestId: id };
  const response = await postJson<AiAgentRequestCancelRsp>('/api/ai-agent/requests/cancel', req);
  return requestState(response.state);
}

export async function streamAiAgentEvents(input: {
  requestId: string;
  afterSequence: number;
  signal: AbortSignal;
  onEvent: (event: AiAgentEvent) => void;
  inactivityTimeoutMs?: number;
}): Promise<void> {
  const url = new URL(
    `/api/ai-agent/requests/${encodeURIComponent(input.requestId)}/events`,
    window.location.origin,
  );
  if (input.afterSequence > 0) url.searchParams.set('after', String(input.afterSequence));

  const controller = new AbortController();
  const abort = () => controller.abort(input.signal.reason);
  if (input.signal.aborted) abort();
  else input.signal.addEventListener('abort', abort, { once: true });

  try {
    const response = await fetch(url, {
      credentials: 'include',
      headers: {
        Accept: 'text/event-stream',
        ...(input.afterSequence > 0 ? { 'Last-Event-ID': String(input.afterSequence) } : {}),
      },
      signal: controller.signal,
    });
    if (response.status === 401) emitUnauthorizedEvent();
    if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
    if (!response.body) throw new Error('Сервер не повернув потік подій.');

    await readAiAgentEventStream(
      response.body.getReader(),
      input,
      controller,
      input.inactivityTimeoutMs ?? 15_000,
    );
  } finally {
    input.signal.removeEventListener('abort', abort);
  }
}

async function readAiAgentEventStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  input: {
    requestId: string;
    onEvent: (event: AiAgentEvent) => void;
  },
  controller: AbortController,
  inactivityTimeoutMs: number,
) {
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await readWithInactivityDeadline(
      reader,
      controller,
      inactivityTimeoutMs,
    );
    buffer += decoder.decode(value, { stream: !done });
    const chunks = buffer.split(/\r?\n\r?\n/);
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) emitAiAgentEventChunk(chunk, input);
    if (done) break;
  }
}

function readWithInactivityDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  controller: AbortController,
  inactivityTimeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort();
      reject(new Error('Потік подій неактивний понад 15 секунд.'));
    }, inactivityTimeoutMs);
    void reader.read().then(
      (result) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeout);
        resolve(result);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function emitAiAgentEventChunk(
  chunk: string,
  input: {
    requestId: string;
    onEvent: (event: AiAgentEvent) => void;
  },
) {
  const data = chunk
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data) return;
  input.onEvent(
    normalizeAiAgentEvent(JSON.parse(data) as AiAgentRequestEventItem, input.requestId),
  );
}

export async function listAiAgentContainers(): Promise<AiAgentContainer[]> {
  const response = await getJson<AiAgentContainerListRsp>('/api/admin/ai-agent/containers');
  return response.items.map(normalizeContainer);
}

export async function startAiAgentContainer(humanLoginId: string): Promise<AiAgentUserStatus> {
  const req: AiAgentAdminUserReq = { loginId: humanLoginId };
  return normalizeUserStatus(
    await postJson<AiAgentAdminUserItem>('/api/admin/ai-agent/users/start', req),
  );
}

export async function stopAiAgentContainer(humanLoginId: string): Promise<AiAgentUserStatus> {
  const req: AiAgentAdminUserReq = { loginId: humanLoginId };
  return normalizeUserStatus(
    await postJson<AiAgentAdminUserItem>('/api/admin/ai-agent/users/force-stop', req),
  );
}

export async function testAiAgentConnection(humanLoginId: string): Promise<void> {
  const req: AiAgentAdminUserReq = { loginId: humanLoginId };
  const result = await postJson<AiAgentConnectionTestRsp>(
    '/api/admin/ai-agent/users/test-connection',
    req,
  );
  if (!result.ok) throw new Error(result.message);
}

export async function getAiAgentUserStatus(humanLoginId: string): Promise<AiAgentUserStatus> {
  const req: AiAgentAdminUserReq = { loginId: humanLoginId };
  return normalizeUserStatus(
    await postJson<AiAgentAdminUserItem>('/api/admin/ai-agent/users/get', req),
  );
}

function normalizeUserStatus(value: AiAgentAdminUserItem): AiAgentUserStatus {
  const container: AiAgentContainer | null = value.containerState
    ? {
        id: value.linkedAgentId ?? value.humanLoginId,
        humanLoginId: value.humanLoginId,
        humanLogin: value.humanLogin,
        linkedLoginId: value.agentLoginId,
        linkedLogin: value.agentLogin,
        instanceName: value.instanceName,
        status: value.containerState,
        cpuCount: 2,
        memoryMib: 4096,
        storageGib: 20,
        processLimit: 512,
        lastError: value.containerLastError,
        lastStartedAt: null,
        lastStoppedAt: null,
      }
    : null;
  return {
    humanLoginId: value.humanLoginId,
    linkedLoginId: value.agentLoginId,
    linkedLogin: value.agentLogin,
    linkedLoginEnabled: value.linkedLoginEnabled ?? false,
    roles: value.roles,
    organismName: value.organismName,
    zoneName: value.sigintZoneName,
    hiddenGroups: value.directHiddenGroups,
    container,
  };
}

export async function listAiAgentAuditRequests(): Promise<AiAgentAuditRequest[]> {
  const req: AiAgentAdminRequestListReq = { state: null, suspicious: null, limit: 200 };
  const response = await postJson<AiAgentAdminRequestListRsp>(
    '/api/admin/ai-agent/requests/list',
    req,
  );
  return response.items.map((request) => normalizeAuditRequest(request));
}

export async function listAiAgentEchoProxies(): Promise<AiAgentEchoProxy[]> {
  const response = await getJson<AiAgentEchoProxyListRsp>('/api/admin/ai-agent/echo-proxies');
  return response.items.map(normalizeProxy);
}

export async function getAiAgentDispatcher(): Promise<AiAgentDispatcher> {
  return getJson<AiAgentDispatcherItem>('/api/admin/ai-agent/dispatcher');
}

export async function saveAiAgentDispatcher(
  dispatcher: AiAgentDispatcher,
): Promise<AiAgentDispatcher> {
  const req: AiAgentDispatcherUpdateReq = {
    host: dispatcher.host,
    sshPort: dispatcher.sshPort,
    sshUser: dispatcher.sshUser,
    namespace: dispatcher.namespace,
  };
  return postJson<AiAgentDispatcherItem>('/api/admin/ai-agent/dispatcher', req);
}

export async function testAiAgentDispatcher(): Promise<AiAgentDispatcher> {
  return postJson<AiAgentDispatcherItem>('/api/admin/ai-agent/dispatcher/test', {});
}

export async function saveAiAgentEchoProxy(
  proxy: Pick<AiAgentEchoProxy, 'id' | 'hostname' | 'upstream' | 'enabled'>,
): Promise<AiAgentEchoProxy> {
  const match = proxy.upstream.trim().match(/^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/);
  if (!match) throw new Error('Upstream має формат host:port.');
  const upstreamPort = Number(match[3]);
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) {
    throw new Error('Порт upstream має бути від 1 до 65535.');
  }
  const req: AiAgentEchoProxyUpsertReq = {
    id: proxy.id || null,
    hostname: proxy.hostname,
    upstreamHost: match[1] ?? match[2] ?? '',
    upstreamPort,
    enabled: proxy.enabled,
  };
  return normalizeProxy(
    await postJson<AiAgentEchoProxyItem>('/api/admin/ai-agent/echo-proxies/upsert', req),
  );
}

export async function testAiAgentEchoProxy(id: string): Promise<AiAgentEchoProxy> {
  const req: AiAgentIdReq = { id };
  return normalizeProxy(
    await postJson<AiAgentEchoProxyItem>('/api/admin/ai-agent/echo-proxies/test', req),
  );
}

export async function deleteAiAgentEchoProxy(id: string): Promise<void> {
  const req: AiAgentIdReq = { id };
  await postVoid('/api/admin/ai-agent/echo-proxies/delete', req);
}

export async function getAiAgentAuditRequest(id: string): Promise<AiAgentAuditRequestDetail> {
  const req: AiAgentRequestIdReq = { requestId: id };
  const response = await postJson<AiAgentAdminRequestDetail>(
    '/api/admin/ai-agent/requests/get',
    req,
  );
  return {
    ...normalizeAuditRequest(response.request, response.events),
    conversation: {
      ...normalizeConversation(response.conversation),
      messages: response.conversation.messages.map(normalizeMessage),
    },
  };
}

export async function retryAiAgentSecurityReview(id: string): Promise<AiAgentAuditRequestDetail> {
  const req: AiAgentRequestIdReq = { requestId: id };
  await postVoid('/api/admin/ai-agent/requests/retry-review', req);
  return getAiAgentAuditRequest(id);
}

export async function getAiAgentSettings(): Promise<AiAgentSettings> {
  return normalizeSettings(await getJson<AiAgentAdminSettingsItem>('/api/admin/ai-agent/settings'));
}

export async function saveAiAgentSettings(settings: AiAgentSettings): Promise<AiAgentSettings> {
  const req: AiAgentAdminSettingsUpdateReq = {
    featureEnabled: settings.enabled,
    defaultAiEngineId: settings.defaultProviderId,
    allowedAiEngineIds: settings.allowedProviderIds,
    templateLoginId: settings.templateLoginId,
    reviewerAiEngineId: settings.reviewerProviderId,
    securityReviewEnabled: settings.reviewEnabled,
    mattermostChatEnabled: settings.mattermostChatEnabled,
    mattermostWebhookUrl: settings.mattermostWebhookUrl.trim() || null,
    clearMattermostWebhook: settings.clearMattermostWebhook,
  };
  return normalizeSettings(
    await postJson<AiAgentAdminSettingsItem>('/api/admin/ai-agent/settings', req),
  );
}
