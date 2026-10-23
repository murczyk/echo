import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';
import type { CitedMessage, InboxMessage, MessageReplyScreen, User } from '../../../../../Bindings';
import { usePowerSnackbar } from '../../../components/PowerSnackbar';
import { isUnauthorizedError } from '../../../services/api/client';
import type { MessageTimeBasis } from '../../../services/api/user-settings';
import { canReplyToMessages } from '../../../utils/roles';
import { ANALYSIS_SYSTEM_COUNT_INTERVAL_MS } from '../../rer-analysis-neo/config';
import {
  ManageMessageDrawer,
  type ManageMessageEditorHandle,
  type Props as MessageEditorProps,
} from '../manage-message/ManageMessageDrawer';
import { inboxChangedEvents } from '../useInboxChangedMessageIds';
import { ReplyStore } from './reply-store';
import { MESSAGE_REPLY_POLL_EVENT } from './events';

export type ReplyTarget = { id: number; message: InboxMessage; focus: HTMLElement | null };
export type ReplyNavigation = (message: CitedMessage, source: HTMLElement) => void;
type ReplyContext = {
  store: ReplyStore;
  open?: (target: ReplyTarget) => void;
  navigate: ReplyNavigation;
};
const Context = createContext<ReplyContext | null>(null);
const EMPTY = { loaded: false, relations: [], messages: new Map() };
const noop = () => () => {};

export function useReplyNavigation() {
  return useContext(Context)?.navigate;
}

export function useMessageReplies(id: number) {
  const context = useContext(Context);
  useEffect(() => (id > 0 ? context?.store.attach(id) : undefined), [context?.store, id]);
  const subscribe = useCallback(
    (listener: () => void) => context?.store.subscribe(id, listener) ?? noop(),
    [context?.store, id],
  );
  const get = useCallback(() => context?.store.get(id) ?? EMPTY, [context?.store, id]);
  const snapshot = useSyncExternalStore(subscribe, get, get);
  return { snapshot, open: context?.open };
}

export const ReplyMessageEditor = forwardRef<
  ManageMessageEditorHandle,
  MessageEditorProps & { replyTarget: ReplyTarget | null; timeBasis: MessageTimeBasis }
>(function ReplyMessageEditor({ replyTarget, timeBasis, ...props }, ref) {
  const context = useContext(Context);
  const { snapshot } = useMessageReplies(replyTarget?.id ?? -1);
  const citation = replyTarget ? snapshot.messages.get(replyTarget.id) : undefined;
  return (
    <ManageMessageDrawer
      {...props}
      ref={ref}
      citedSignalMessageIds={replyTarget ? [replyTarget.id] : undefined}
      citedMessages={citation ? [citation] : undefined}
      citationsLoading={replyTarget != null && !snapshot.loaded}
      citationTimeBasis={timeBasis}
      onCreated={async (result) => {
        if (replyTarget) {
          context?.store.invalidate([replyTarget.id]);
          props.onClose();
          await context?.store.flush();
        }
        await props.onCreated?.(result);
      }}
    />
  );
});

export function MessageRepliesProvider({
  screen,
  currentUser,
  children,
  onReply,
  onNavigate,
}: {
  screen: MessageReplyScreen;
  currentUser: User | null;
  children: ReactNode;
  onReply: (target: ReplyTarget) => void;
  onNavigate: ReplyNavigation;
}) {
  const { notify } = usePowerSnackbar();
  const onErrorRef = useRef((error: unknown) => {});
  onErrorRef.current = (error) => {
    if (!isUnauthorizedError(error))
      notify({
        message: error instanceof Error ? error.message : 'Не вдалося завантажити відповіді.',
        severity: 'error',
      });
  };
  const identity = `${currentUser?.id ?? ''}:${currentUser?.sigintZoneId ?? ''}:${currentUser?.organismId ?? ''}:${currentUser?.roles?.join(',') ?? ''}`;
  const store = useMemo(
    () => new ReplyStore(screen, (error) => onErrorRef.current(error)),
    [screen, identity],
  );
  const canReply = canReplyToMessages(currentUser?.roles);
  const value = useMemo(
    () => ({ store, open: canReply ? onReply : undefined, navigate: onNavigate }),
    [store, onReply, canReply, onNavigate],
  );

  useEffect(() => {
    const onInbox = (event: Event) =>
      store.invalidate(
        inboxChangedEvents((event as CustomEvent).detail).map((entry) => entry.messageId),
      );
    const onPoll = (event: Event) => {
      if ((event as CustomEvent).detail === screen) void store.flush();
    };
    window.addEventListener('echo-inbox-changed', onInbox);
    window.addEventListener(MESSAGE_REPLY_POLL_EVENT, onPoll);
    const interval =
      screen === 'Analysis'
        ? window.setInterval(() => void store.flush(), ANALYSIS_SYSTEM_COUNT_INTERVAL_MS)
        : null;
    return () => {
      window.removeEventListener('echo-inbox-changed', onInbox);
      window.removeEventListener(MESSAGE_REPLY_POLL_EVENT, onPoll);
      if (interval != null) window.clearInterval(interval);
      store.dispose();
    };
  }, [store, screen]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}
