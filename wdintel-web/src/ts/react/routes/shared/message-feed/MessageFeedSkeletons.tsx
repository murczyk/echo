import { Box, Skeleton } from '@mui/material';

const messageCardSkeletons = [
  { lines: [320, 180, 140], bodyHeight: 92 },
  { lines: [240, 160], bodyHeight: 76 },
  { lines: [280, 200, 160], bodyHeight: 88 },
  { lines: [220, 180], bodyHeight: 76 },
];

type MessageFeedSkeletonsProps = {
  count?: number;
  listTag?: 'div' | 'ul';
  position?: 'initial' | 'refresh' | 'above' | 'below';
  loading?: boolean;
};

export function MessageFeedSkeletons({
  count = 3,
  listTag = 'div',
  position = 'initial',
  loading = true,
}: MessageFeedSkeletonsProps) {
  const Container = listTag === 'ul' ? 'li' : 'div';
  const isEdge = position === 'above' || position === 'below';
  const animation = isEdge || loading ? 'pulse' : false;
  return (
    <Container
      role={loading ? 'status' : undefined}
      aria-label={loading ? 'Завантаження повідомлень' : undefined}
      aria-hidden={loading ? undefined : true}
      data-message-feed-skeleton={position}
      className="message-feed-skeletons"
    >
      {Array.from({ length: isEdge ? 1 : count }, (_, index) => {
        const card = messageCardSkeletons[index % messageCardSkeletons.length];
        return (
          <Box
            key={index}
            data-message-feed-skeleton-card
            className="message-feed-skeleton-card"
            sx={{ borderColor: 'divider' }}
          >
            <div className="message-feed-skeleton-card-header">
              <Skeleton animation={animation} variant="rounded" width={card.lines[0]} height={20} />
              <div className="message-feed-skeleton-card-meta">
                {[88, 72, 96].map((width) => (
                  <Skeleton
                    key={width}
                    animation={animation}
                    variant="rounded"
                    width={width}
                    height={24}
                  />
                ))}
              </div>
            </div>
            <div className="message-feed-skeleton-card-body">
              <Skeleton animation={animation} variant="rounded" height={card.bodyHeight} />
              <div className="message-feed-skeleton-card-footer">
                {card.lines.slice(1).map((width, lineIndex) => (
                  <Skeleton
                    key={lineIndex}
                    animation={animation}
                    variant="rounded"
                    width={width}
                    height={16}
                  />
                ))}
              </div>
            </div>
          </Box>
        );
      })}
    </Container>
  );
}
