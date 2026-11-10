import PeopleOutlineOutlinedIcon from '@mui/icons-material/PeopleOutlineOutlined';
import PermMediaOutlinedIcon from '@mui/icons-material/PermMediaOutlined';
import { Box, Tab, Tabs } from '@mui/material';
import { useMemo, useState } from 'react';

import { analysisCompactTabsSx } from '../analysis-tab-styles';
import { membersFileName, toMemberRow } from '../messenger-contacts-export';
import { useMessengerChatMembers } from '../use-messenger-chat-members';
import { AnalysisRightPanelToggle } from './AnalysisRightPanelToggle';
import { MessengerPeopleTable } from './MessengerPeopleTable';

// The chat that is open in the messenger workspace, as the right panel needs it.
export type MessengerOpenChat = { accountId: string; chatId: string };

type Props = {
  chat: MessengerOpenChat;
  refreshToken?: number;
  showNarrowCloseButton?: boolean;
  // The hairline between the chat and the docked panel; the echo center panel draws it for the echo tabs, the chat does not.
  divider?: boolean;
  onClose: () => void;
};

type PanelTab = 'media' | 'members';

function ChatMembers({ chat, refreshToken }: { chat: MessengerOpenChat; refreshToken: number }) {
  const { members, loading, fetching, error, retry } = useMessengerChatMembers(
    chat.accountId,
    chat.chatId,
    refreshToken,
  );
  const rows = useMemo(() => members.map(toMemberRow), [members]);
  return (
    <MessengerPeopleTable
      tableId="rer-analysis-messenger-members"
      panel
      title="Учасники чату"
      searchLabel="Пошук учасників"
      exportLabel="Експорт учасників"
      rows={rows}
      allCount={rows.length}
      loading={loading}
      fetching={fetching}
      error={error}
      retry={retry}
      fileName={(extension) => membersFileName(chat.chatId, extension)}
    />
  );
}

// The right panel of an open analysis messenger chat, in place of the echo analytics tabs: the media of the chat
// (not built yet) and its members.
export function MessengerRightPanel({
  chat,
  refreshToken = 0,
  showNarrowCloseButton = true,
  divider = false,
  onClose,
}: Props) {
  const [tab, setTab] = useState<PanelTab>('members');
  return (
    <Box
      component="aside"
      aria-label="Права панель чату"
      data-messenger-right-panel
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        minWidth: 0,
        ...(divider && { borderLeft: '1px solid', borderColor: 'divider' }),
      }}
    >
      <Box sx={{ pt: 0.5, display: 'flex', alignItems: 'center', flexShrink: 0 }}>
        <Tabs
          value={tab}
          onChange={(_event, value: PanelTab) => setTab(value)}
          aria-label="Вкладки правої панелі чату"
          sx={{ ...analysisCompactTabsSx, flex: 1, minWidth: 0, px: { xs: 0.5, sm: 1 } }}
        >
          <Tab value="media" icon={<PermMediaOutlinedIcon />} iconPosition="start" label="Медіа" />
          <Tab
            value="members"
            icon={<PeopleOutlineOutlinedIcon />}
            iconPosition="start"
            label="Учасники"
          />
        </Tabs>
        {showNarrowCloseButton ? (
          <AnalysisRightPanelToggle
            expanded
            onClick={onClose}
            sx={{ display: { xs: 'inline-flex', lg: 'none' }, mr: { xs: 1, lg: 0 } }}
          />
        ) : null}
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex' }}>
        {tab === 'members' ? (
          <ChatMembers key={chat.chatId} chat={chat} refreshToken={refreshToken} />
        ) : (
          // shortcut: the media gallery of a chat waits for the backend (plan, section B item 7); this holds the tab.
          <p className="p-4 opacity-60" role="status">
            Галерея чату з’явиться пізніше.
          </p>
        )}
      </Box>
    </Box>
  );
}
