import PeopleOutlineOutlinedIcon from '@mui/icons-material/PeopleOutlineOutlined';
import PermMediaOutlinedIcon from '@mui/icons-material/PermMediaOutlined';
import { Box, Tab, Tabs } from '@mui/material';
import { useEffect, useMemo, useState } from 'react';

import { analysisCompactTabsSx } from '../analysis-tab-styles';
import {
  parseMessengerPanelTabFromWindow,
  replaceMessengerPanelTabInUrl,
  type MessengerPanelTab,
} from '../helpers';
import { membersFileName, toMemberRow } from '../messenger-contacts-export';
import { useMessengerChatMembers } from '../use-messenger-chat-members';
import { AnalysisRightPanelToggle } from './AnalysisRightPanelToggle';
import { MessengerGallery } from './MessengerGallery';
import { MessengerPeopleTable } from './MessengerPeopleTable';

// The chat that is open in the messenger workspace, as the right panel needs it.
export type MessengerOpenChat = { accountId: string; chatId: string };

type Props = {
  chat: MessengerOpenChat;
  refreshToken?: number;
  showNarrowCloseButton?: boolean;
  // The hairline between the chat and the docked panel; the echo center panel draws it for the echo tabs, the chat does not.
  divider?: boolean;
  // Opens a chat at a message, from the media tab.
  onOpenMessage?: (chatId: string, messageId: string) => void;
  onClose: () => void;
};

type PanelTab = MessengerPanelTab;

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
// and its members.
export function MessengerRightPanel({
  chat,
  refreshToken = 0,
  showNarrowCloseButton = true,
  divider = false,
  onOpenMessage,
  onClose,
}: Props) {
  // The tab is in the URL while the panel is mounted (it is mounted only while open), so a shared link opens the same tab.
  const [tab, setTab] = useState<PanelTab>(() => parseMessengerPanelTabFromWindow() ?? 'media');
  useEffect(() => {
    replaceMessengerPanelTabInUrl(tab);
    return () => replaceMessengerPanelTabInUrl(null);
  }, [tab]);
  // The gallery is mounted when first shown and then stays, hidden behind the members, so its cache and scroll position
  // survive the switch. It is hidden with `invisible`, not `display: none`, which would reset the scroll of its list.
  // The members are mounted only while shown, so they are not requested before they are opened.
  const [galleryMounted, setGalleryMounted] = useState(tab === 'media');
  const changeTab = (value: PanelTab) => {
    if (value === 'media') setGalleryMounted(true);
    setTab(value);
  };
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
          onChange={(_event, value: PanelTab) => changeTab(value)}
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
      <Box sx={{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative' }}>
        {galleryMounted || tab === 'media' ? (
          <div
            className={`absolute inset-0 flex min-h-0 min-w-0 ${tab === 'media' ? '' : 'invisible'}`}
          >
            <MessengerGallery
              key={chat.chatId}
              accountId={chat.accountId}
              chatId={chat.chatId}
              refreshToken={refreshToken}
              onOpenMessage={onOpenMessage}
            />
          </div>
        ) : null}
        {tab === 'members' ? (
          <div className="absolute inset-0 flex min-h-0 min-w-0">
            <ChatMembers key={chat.chatId} chat={chat} refreshToken={refreshToken} />
          </div>
        ) : null}
      </Box>
    </Box>
  );
}
