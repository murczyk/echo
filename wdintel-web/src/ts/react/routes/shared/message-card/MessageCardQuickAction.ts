import BookmarkBorderOutlinedIcon from '@mui/icons-material/BookmarkBorderOutlined';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import FlagOutlinedIcon from '@mui/icons-material/FlagOutlined';
import LinkIcon from '@mui/icons-material/Link';
import MessageIcon from '@mui/icons-material/Message';
import NoteAddIcon from '@mui/icons-material/NoteAdd';
import ReplyIcon from '@mui/icons-material/Reply';
import { createContext } from 'react';
import type { MessageCardQuickAction } from '../../../../../Bindings';
import { DEFAULT_MESSAGE_CARD_SECOND_QUICK_ACTION } from '../../../hooks/duty-settings-defaults';
import type { MessageCardQuickActionSettings } from '../../../services/api/user-settings';

/** Narrow-card direct actions in slot order, without repeats. */
export function messageCardQuickActionList({
  messageCardQuickActionCount,
  messageCardQuickAction,
  messageCardSecondQuickAction,
}: MessageCardQuickActionSettings): readonly MessageCardQuickAction[] {
  return messageCardQuickActionCount === 1 ||
    messageCardSecondQuickAction === messageCardQuickAction
    ? [messageCardQuickAction]
    : [messageCardQuickAction, messageCardSecondQuickAction];
}

export const DEFAULT_MESSAGE_CARD_QUICK_ACTIONS: readonly MessageCardQuickAction[] = [
  'createReport',
  DEFAULT_MESSAGE_CARD_SECOND_QUICK_ACTION,
];

export const MessageCardQuickActionsContext = createContext<readonly MessageCardQuickAction[]>(
  DEFAULT_MESSAGE_CARD_QUICK_ACTIONS,
);

export const MESSAGE_CARD_QUICK_ACTION_ICONS = {
  createReport: NoteAddIcon,
  reply: ReplyIcon,
  important: FlagOutlinedIcon,
  bookmark: BookmarkBorderOutlinedIcon,
  copyText: MessageIcon,
  copyLink: LinkIcon,
  edit: EditIcon,
  delete: DeleteIcon,
} satisfies Record<MessageCardQuickAction, typeof NoteAddIcon>;
