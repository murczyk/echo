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

export const MessageCardQuickActionContext = createContext<MessageCardQuickAction>('createReport');

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
