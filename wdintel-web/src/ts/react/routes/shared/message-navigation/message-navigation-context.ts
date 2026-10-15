import type { InboxItemContextRsp } from '../../../../../Bindings';
import { fetchInboxItemContext } from '../../../services/api/inbox-messages';

export type LinkedMessageContextResult =
  { status: 'found'; context: InboxItemContextRsp } | { status: 'unavailable' };

export async function resolveLinkedMessageContext(
  reference: string,
  signal: AbortSignal,
): Promise<LinkedMessageContextResult> {
  const context = await fetchInboxItemContext({ messageUid: reference }, { signal });
  return context.message == null ? { status: 'unavailable' } : { status: 'found', context };
}
