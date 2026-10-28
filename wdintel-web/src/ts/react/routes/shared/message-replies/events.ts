import type { MessageReplyScreen } from '../../../../../Bindings';

export const MESSAGE_REPLY_POLL_EVENT = 'echo-message-replies-poll';

export function notifyMessageReplyPoll(screen: MessageReplyScreen): void {
  window.dispatchEvent(new CustomEvent(MESSAGE_REPLY_POLL_EVENT, { detail: screen }));
}
