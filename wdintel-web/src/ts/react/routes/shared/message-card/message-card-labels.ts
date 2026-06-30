import type { InboxMessage, SignalGroupEntry, SignalProfileEntry } from '../../../../../Bindings';

export type MessageCardCommentPreview = {
  text: string | null;
  freq: string | null;
  groupMasterKey: string | null;
  groupName: string | null;
  sender: string | null;
  senderName: string | null;
};

export type MessageCardDisplayLabels = {
  groupName: string | null;
  senderName: string | null;
  commentPreview: MessageCardCommentPreview;
};

type MessageCardDisplayLabelsOptions = {
  groupInfos: Record<string, SignalGroupEntry>;
  profiles: Record<string, SignalProfileEntry | null>;
};

function buildSenderName(sender: string | null | undefined, profiles: Record<string, SignalProfileEntry | null>): string | null {
  if (sender == null || sender.trim() === '') return null;
  const profile = profiles[sender];
  const parts = [profile?.givenName, profile?.familyName].filter((part): part is string => Boolean(part && part.trim() !== ''));
  return parts.length > 0 ? parts.join(' ') : sender;
}

export function buildMessageCardDisplayLabels(
  msg: Pick<InboxMessage, 'text' | 'freq' | 'groupMasterKey' | 'sender'>,
  options: MessageCardDisplayLabelsOptions,
): MessageCardDisplayLabels {
  const groupName = msg.groupMasterKey ? options.groupInfos[msg.groupMasterKey]?.name ?? msg.groupMasterKey : null;
  const senderName = buildSenderName(msg.sender, options.profiles);

  return {
    groupName,
    senderName,
    commentPreview: {
      text: msg.text,
      freq: msg.freq,
      groupMasterKey: msg.groupMasterKey,
      groupName,
      sender: msg.sender,
      senderName,
    },
  };
}
