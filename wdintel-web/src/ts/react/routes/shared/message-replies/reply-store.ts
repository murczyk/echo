import type { CitedMessage, MessageReply, MessageReplyScreen } from '../../../../../Bindings';
import { fetchMessageReplies } from '../../../services/api/message-replies';

export type ReplySnapshot = {
  relations: MessageReply[];
  messages: ReadonlyMap<number, CitedMessage>;
};

const EMPTY: ReplySnapshot = { relations: [], messages: new Map() };
const MAX_ANCHORS = 512;
const MAX_CACHED_ANCHORS = 1_024;

export class ReplyStore {
  private entries = new Map<number, ReplySnapshot>();
  private references = new Map<number, number>();
  private versions = new Map<number, number>();
  private listeners = new Map<number, Set<() => void>>();
  private initial = new Set<number>();
  private scheduled = false;
  private controller: AbortController | null = null;
  private disposed = false;
  private failureNotified = false;

  constructor(
    private screen: MessageReplyScreen,
    private onError: (error: unknown) => void,
  ) {}

  get = (id: number) => this.entries.get(id) ?? EMPTY;

  subscribe = (id: number, listener: () => void) => {
    const listeners = this.listeners.get(id) ?? new Set();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(id);
    };
  };

  attach = (id: number) => {
    this.disposed = false;
    this.references.set(id, (this.references.get(id) ?? 0) + 1);
    if (!this.entries.has(id)) this.initial.add(id);
    this.scheduleInitial();
    return () => {
      const count = (this.references.get(id) ?? 1) - 1;
      if (count > 0) this.references.set(id, count);
      else {
        this.references.delete(id);
        this.initial.delete(id);
        if (this.entries.size > MAX_CACHED_ANCHORS) {
          for (const cachedId of this.entries.keys()) {
            if (!this.references.has(cachedId)) {
              this.entries.delete(cachedId);
              this.versions.delete(cachedId);
              break;
            }
          }
        }
      }
    };
  };

  invalidate = (ids: number[]) => {
    const changed = new Set(ids);
    this.references.forEach((_, id) => {
      const snapshot = this.get(id);
      if (
        changed.has(id) ||
        snapshot.relations.some(
          (relation) =>
            changed.has(relation.originalSignalMessageId ?? -1) ||
            changed.has(relation.replySignalMessageId ?? -1),
        )
      ) {
        this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
      }
    });
  };

  flush = async () => {
    await this.load(Array.from(this.references.keys()));
  };

  dispose = () => {
    this.disposed = true;
    this.controller?.abort();
    this.controller = null;
  };

  private scheduleInitial = () => {
    if (this.scheduled || !this.initial.size) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.disposed) void this.load(Array.from(this.initial));
    });
  };

  private load = async (requested: number[]) => {
    if (this.controller || this.disposed || !requested.length) return;
    const controller = new AbortController();
    this.controller = controller;
    try {
      for (let offset = 0; offset < requested.length; offset += MAX_ANCHORS) {
        const ids = requested.slice(offset, offset + MAX_ANCHORS);
        const versions = new Map(ids.map((id) => [id, this.versions.get(id) ?? 0]));
        const response = await fetchMessageReplies(
          { signalMessageIds: ids, screen: this.screen },
          { signal: controller.signal },
        );
        if (controller.signal.aborted || this.disposed) return;
        const projections = new Map(response.replyMessages.map((message) => [message.id, message]));
        ids.forEach((id) => {
          if (!this.references.has(id) || versions.get(id) !== (this.versions.get(id) ?? 0)) return;
          const relations = response.replies.filter(
            (relation) =>
              relation.originalSignalMessageId === id || relation.replySignalMessageId === id,
          );
          const messages = new Map<number, CitedMessage>();
          const anchor = projections.get(id);
          if (anchor) messages.set(id, anchor);
          relations.forEach((relation) => {
            if (relation.deleted) return;
            [relation.originalSignalMessageId, relation.replySignalMessageId].forEach(
              (messageId) => {
                const message = messageId == null ? undefined : projections.get(messageId);
                if (message) messages.set(message.id, message);
              },
            );
          });
          const previous = this.entries.get(id);
          this.initial.delete(id);
          if (
            previous &&
            JSON.stringify(previous.relations) === JSON.stringify(relations) &&
            JSON.stringify(Array.from(previous.messages)) === JSON.stringify(Array.from(messages))
          )
            return;
          this.entries.set(id, { relations, messages });
          this.listeners.get(id)?.forEach((listener) => listener());
        });
      }
      this.failureNotified = false;
    } catch (error) {
      if (!controller.signal.aborted && !this.failureNotified) {
        this.failureNotified = true;
        this.onError(error);
      }
    } finally {
      if (this.controller === controller) this.controller = null;
      // Only newly mounted anchors may start an immediate follow-up; invalidations wait for polling.
      const remaining = Array.from(this.initial).filter((id) => !requested.includes(id));
      if (remaining.length && !this.disposed) queueMicrotask(() => void this.load(remaining));
    }
  };
}
