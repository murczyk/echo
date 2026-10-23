import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';
import type { InboxMessage, MessageReplyScreen, User } from '../../../../../Bindings';
import { usePowerSnackbar } from '../../../components/PowerSnackbar';
import { isUnauthorizedError } from '../../../services/api/client';
import type { MessageTimeBasis } from '../../../services/api/user-settings';
import { canReplyToMessages } from '../../../utils/roles';
import { ANALYSIS_SYSTEM_COUNT_INTERVAL_MS } from '../../rer-analysis-neo/config';
import {
  ManageMessageDrawer,
  type ManageMessageEditorHandle,
} from '../manage-message/ManageMessageDrawer';
import { inboxChangedEvents } from '../useInboxChangedMessageIds';
import { ReplyStore } from './reply-store';
import { MESSAGE_REPLY_POLL_EVENT } from './events';

type Target = { id: number; message: InboxMessage; focus: HTMLElement | null };
type ReplyContext = { store: ReplyStore; open?: (target: Target) => void };
const Context = createContext<ReplyContext | null>(null);
const EMPTY = { loaded: false, relations: [], messages: new Map() };
const noop = () => () => {};

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

function ReplyComposer({
  target,
  currentUser,
  cyberEchoEnabled,
  timeBasis,
  editorRef,
  close,
  created,
}: {
  target: Target | null;
  currentUser: User | null;
  cyberEchoEnabled: boolean;
  timeBasis: MessageTimeBasis;
  editorRef: { current: ManageMessageEditorHandle | null };
  close: () => void;
  created: () => Promise<void>;
}) {
  const { snapshot } = useMessageReplies(target?.id ?? -1);
  const citation = target ? snapshot.messages.get(target.id) : undefined;
  return (
    <ManageMessageDrawer
      ref={editorRef}
      open={target != null}
      currentUser={currentUser}
      cyberEchoEnabled={cyberEchoEnabled}
      onClose={close}
      onCreated={created}
      initialGroupMasterKey={target?.message.groupMasterKey}
      initialFocusTarget={target?.focus}
      intentKey={target ? `reply:${target.id}` : undefined}
      engagedMessageId={target?.id}
      citedMessage={citation}
      citationLoading={!snapshot.loaded}
      citationTimeBasis={timeBasis}
    />
  );
}

export function MessageRepliesProvider({
  screen,
  currentUser,
  cyberEchoEnabled,
  timeBasis,
  children,
}: {
  screen: MessageReplyScreen;
  currentUser: User | null;
  cyberEchoEnabled: boolean;
  timeBasis: MessageTimeBasis;
  children: ReactNode;
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
  const [target, setTarget] = useState<Target | null>(null);
  const editorRef = useRef<ManageMessageEditorHandle | null>(null);
  const targetRef = useRef(target);
  targetRef.current = target;
  const open = useCallback((next: Target) => {
    const commit = () => setTarget(next);
    if (editorRef.current && targetRef.current)
      editorRef.current.requestIntentChange({ key: `reply:${next.id}`, commit });
    else commit();
  }, []);
  const canReply = canReplyToMessages(currentUser?.roles);
  const value = useMemo(
    () => ({ store, open: canReply ? open : undefined }),
    [store, open, canReply],
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

  return (
    <Context.Provider value={value}>
      {children}
      {canReply && target ? (
        <ReplyComposer
          target={target}
          currentUser={currentUser}
          cyberEchoEnabled={cyberEchoEnabled}
          timeBasis={timeBasis}
          editorRef={editorRef}
          close={() => setTarget(null)}
          created={async () => {
            if (targetRef.current) store.invalidate([targetRef.current.id]);
            setTarget(null);
            await store.flush();
          }}
        />
      ) : null}
    </Context.Provider>
  );
}
