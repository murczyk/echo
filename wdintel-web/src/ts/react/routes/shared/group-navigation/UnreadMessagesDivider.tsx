export function UnreadMessagesDivider({ duty = false }: { duty?: boolean }) {
  return (
    <div
      className="message-feed-unread-divider"
      data-duty-unread-divider={duty || undefined}
      role="separator"
      aria-label="Непрочитані повідомлення"
    >
      Непрочитані повідомлення
    </div>
  );
}
