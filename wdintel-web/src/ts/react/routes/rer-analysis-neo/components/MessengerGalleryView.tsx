import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { IconButton } from '@mui/material';

import type { MessengerAccountItem } from './MessengerAccountList';
import { MessengerGallery } from './MessengerGallery';

type Props = {
  account: MessengerAccountItem;
  refreshToken?: number;
  // Opens a chat at a message ("go to message" of a tile).
  onOpenMessage: (chatId: string, messageId: string) => void;
  onBack: () => void;
};

const TITLE = 'Галерея акаунту';

// The media of every chat of an account, in the main area of the workspace: the same gallery as the Media tab of a chat, with
// the room of a whole page (more tiles in a row), and a header like the one of the contacts.
export function MessengerGalleryView({ account, refreshToken = 0, onOpenMessage, onBack }: Props) {
  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      aria-label={TITLE}
      data-messenger-gallery-view
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-solid border-black/12 px-2 py-1 dark:border-white/12">
        <IconButton size="small" aria-label="Назад до акаунта" onClick={onBack}>
          <ArrowBackIcon
            fontSize="small"
            className="group-data-[mobile=true]/messenger:!size-[18px]"
          />
        </IconButton>
        <h2 className="m-0 text-base font-medium group-data-[mobile=true]/messenger:!text-[18px] group-data-[mobile=true]/messenger:!font-medium">
          {TITLE}
        </h2>
      </div>
      <MessengerGallery
        key={account.id}
        accountId={account.id}
        chatId={null}
        refreshToken={refreshToken}
        onOpenMessage={onOpenMessage}
      />
    </section>
  );
}
