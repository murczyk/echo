import { Skeleton } from '@mui/material';

type MessageFeedSkeletonsProps = {
  count?: number;
  listTag?: 'div' | 'ul';
  position?: 'initial' | 'refresh' | 'above' | 'below';
};

export function MessageFeedSkeletons({
  count = 3,
  listTag = 'div',
  position = 'initial',
}: MessageFeedSkeletonsProps) {
  const Container = listTag === 'ul' ? 'li' : 'div';
  return (
    <Container
      role="status"
      aria-label="Завантаження повідомлень"
      data-message-feed-skeleton={position}
      className="message-feed-skeletons"
    >
      {Array.from({ length: count }, (_, index) => (
        <div key={index} data-message-feed-skeleton-card className="message-feed-skeleton-card">
          <div className="message-feed-skeleton-card-header">
            <Skeleton variant="rounded" width={index % 2 ? 180 : 220} height={20} />
            <Skeleton variant="rounded" width={88} height={20} />
          </div>
          <Skeleton variant="rounded" height={index % 2 ? 92 : 128} />
          <div className="message-feed-skeleton-card-footer">
            <Skeleton variant="rounded" width="45%" height={16} />
            <Skeleton variant="rounded" width="30%" height={16} />
          </div>
        </div>
      ))}
    </Container>
  );
}
