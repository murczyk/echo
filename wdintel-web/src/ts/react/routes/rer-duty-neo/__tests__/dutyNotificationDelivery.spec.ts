/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboxMessage, InboxMessagesRsp, InboxMessagesReq } from '../../../../../Bindings';
import { minimalInboxMessage } from '.././inbox-message-mocks';
import {
  beginDutyNotificationPollCycle,
  endDutyNotificationPollCycle,
  notifyDutyNewMessages,
  registerDutyNotificationPreview,
  setStoredDutyNotificationSettingsForFeed,
} from '.././notifications';
import { loadDutyNotificationPreview } from '.././dutyNotificationPreview';

const fetchInboxMessages = vi.hoisted(() => vi.fn());
vi.mock('../../../services/api/inbox', () => ({ fetchInboxMessages }));

const originalLocalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');

function setup(): ReturnType<typeof vi.fn> {
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  const NotificationMock = vi.fn(function () {
    return { addEventListener: vi.fn() };
  }) as unknown as typeof Notification;
  vi.stubGlobal('Notification', NotificationMock);
  Object.defineProperty(window, 'Notification', { configurable: true, value: NotificationMock });
  Object.defineProperty(Notification, 'permission', { configurable: true, value: 'granted' });
  setStoredDutyNotificationSettingsForFeed('feed-a', { soundEnabled: false, browserEnabled: true });
  return NotificationMock as unknown as ReturnType<typeof vi.fn>;
}

function response(message: InboxMessage, groupName = 'Group'): InboxMessagesRsp {
  return {
    inboxItems: [[7, message]],
    pollCursorId: 7,
    callsigns: [],
    signalProfiles: {},
    signalGroups: [{ masterKey: 'group', name: groupName } as never],
    freqPelengsSummary: null,
    pageLimit: 20,
  };
}

async function deliver(
  req: InboxMessagesReq,
  messageSortBy: 'IMSTimestamp' | 'IMSCreatedAt' = 'IMSTimestamp',
): Promise<ReturnType<typeof vi.fn>> {
  const NotificationMock = setup();
  const cycle = beginDutyNotificationPollCycle();
  registerDutyNotificationPreview(cycle, 'feed-a', () =>
    loadDutyNotificationPreview(req, messageSortBy, () => true),
  );
  notifyDutyNewMessages('feed-a', 1, cycle);
  endDutyNotificationPollCycle(cycle);
  await flushDelivery();
  return NotificationMock;
}

async function flushDelivery(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  fetchInboxMessages.mockReset();
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
  if (originalLocalStorage) Object.defineProperty(window, 'localStorage', originalLocalStorage);
});

describe('Duty rich notification delivery', () => {
  const req = {} as InboxMessagesReq;

  // @test-scope regression: https://github.com/echoua/echo/issues/3455
  it('uses the active message ordering basis for notification previews', async () => {
    const interceptionNewest = minimalInboxMessage({
      sender: 'Interception newest',
      groupMasterKey: 'group',
      timestamp: 200,
      createdAtOrder: 100,
    });
    const creationNewest = minimalInboxMessage({
      sender: 'Creation newest',
      groupMasterKey: 'group',
      timestamp: 100,
      createdAtOrder: 200,
    });
    const previewResponse = response(interceptionNewest);
    previewResponse.inboxItems = [
      [1, interceptionNewest],
      [2, creationNewest],
    ];
    fetchInboxMessages.mockResolvedValue(previewResponse);

    await expect(
      loadDutyNotificationPreview(req, 'IMSTimestamp', () => true),
    ).resolves.toMatchObject({
      kind: 'ready',
      preview: { messageId: 1, orderTimestamp: 200, title: 'Interception newest' },
    });
    await expect(
      loadDutyNotificationPreview(req, 'IMSCreatedAt', () => true),
    ).resolves.toMatchObject({
      kind: 'ready',
      preview: { messageId: 2, orderTimestamp: 200, title: 'Creation newest' },
    });
  });

  // @test-scope regression: https://github.com/echoua/echo/pull/3331
  it('delivers header-free rich content and sender/group fallbacks', async () => {
    fetchInboxMessages.mockResolvedValueOnce(
      response(
        minimalInboxMessage({
          sender: 'Sender',
          groupMasterKey: 'group',
          text: 'RAW HEADER SECRET',
          noHeadersBody: { body: 'header-free text' },
        }),
      ),
    );
    let NotificationMock = await deliver(req);
    expect(NotificationMock).toHaveBeenLastCalledWith(
      'Sender',
      expect.objectContaining({ body: 'Group\nheader-free text', silent: true }),
    );
    expect(NotificationMock.mock.calls[0]?.[1]?.body).not.toContain('RAW HEADER SECRET');

    fetchInboxMessages.mockResolvedValueOnce(
      response(
        minimalInboxMessage({
          sender: null,
          groupMasterKey: 'group',
          noHeadersBody: { body: 'text only' },
        }),
      ),
    );
    NotificationMock = await deliver(req);
    expect(NotificationMock).toHaveBeenLastCalledWith(
      'Group',
      expect.objectContaining({ body: 'text only' }),
    );

    fetchInboxMessages.mockResolvedValueOnce(
      response(
        minimalInboxMessage({
          sender: 'Sender',
          groupMasterKey: 'group',
          images: ['attachment'],
          noHeadersBody: null,
        }),
      ),
    );
    NotificationMock = await deliver(req);
    expect(NotificationMock).toHaveBeenLastCalledWith(
      'Sender',
      expect.objectContaining({ body: 'Group\nВкладення' }),
    );
  });

  // @test-scope regression: https://github.com/echoua/echo/pull/3331
  it('uses one generic banner for an immediate current failure', async () => {
    fetchInboxMessages.mockRejectedValueOnce(new Error('preview failed'));
    const NotificationMock = await deliver(req);
    expect(NotificationMock).toHaveBeenLastCalledWith(
      'Нове повідомлення',
      expect.objectContaining({ body: 'Відкрийте «Оперативний», щоб переглянути.', silent: true }),
    );
  });

  // @test-scope regression: https://github.com/echoua/echo/pull/3331
  it('uses one generic banner when the production three-second preview deadline aborts', async () => {
    vi.useFakeTimers();
    fetchInboxMessages.mockImplementationOnce(
      (_, { signal }: { signal: AbortSignal }) =>
        new Promise<InboxMessagesRsp>((_, reject) => {
          signal.addEventListener('abort', () =>
            reject(new DOMException('deadline', 'AbortError')),
          );
        }),
    );
    const NotificationMock = setup();
    const cycle = beginDutyNotificationPollCycle();
    registerDutyNotificationPreview(cycle, 'feed-a', () =>
      loadDutyNotificationPreview(req, 'IMSTimestamp', () => true),
    );
    notifyDutyNewMessages('feed-a', 1, cycle);
    endDutyNotificationPollCycle(cycle);
    await flushDelivery();
    expect(fetchInboxMessages).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(NotificationMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flushDelivery();
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    expect(NotificationMock).toHaveBeenLastCalledWith(
      'Нове повідомлення',
      expect.objectContaining({ body: 'Відкрийте «Оперативний», щоб переглянути.', silent: true }),
    );
    await flushDelivery();
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  // @test-scope regression: https://github.com/echoua/echo/pull/3331
  it('suppresses a preview invalidated after its request has started', async () => {
    vi.useFakeTimers();
    let current = true;
    let resolveResponse!: (value: InboxMessagesRsp) => void;
    const pending = new Promise<InboxMessagesRsp>((resolve) => {
      resolveResponse = resolve;
    });
    fetchInboxMessages.mockReturnValueOnce(pending);
    const NotificationMock = setup();
    const cycle = beginDutyNotificationPollCycle();
    registerDutyNotificationPreview(cycle, 'feed-a', () =>
      loadDutyNotificationPreview(req, 'IMSTimestamp', () => current),
    );
    notifyDutyNewMessages('feed-a', 1, cycle);
    endDutyNotificationPollCycle(cycle);
    await flushDelivery();
    expect(fetchInboxMessages).toHaveBeenCalledTimes(1);

    current = false;
    resolveResponse(
      response(
        minimalInboxMessage({
          sender: 'Sender',
          groupMasterKey: 'group',
          noHeadersBody: { body: 'header-free text' },
        }),
      ),
    );
    await flushDelivery();
    expect(NotificationMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
