import { Skeleton } from '@mui/material';

const messageCardSkeletons = [
  [100, 94, 100, 88, 68],
  [100, 86, 62],
  [100, 92, 98, 74],
  [100, 78, 54],
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
        const lines = messageCardSkeletons[index % messageCardSkeletons.length];
        return (
          <div key={index} className="message-card-item" aria-hidden="true">
            <div
              data-message-feed-skeleton-card
              className="message-card-root message-feed-skeleton-card"
            >
              <div className="message-feed-skeleton-card-identity">
                <div className="message-card-header-unit message-feed-skeleton-card-identity-row">
                  <Skeleton
                    animation={animation}
                    variant="rectangular"
                    width={12}
                    height={12}
                    className="message-feed-skeleton-card-unit-icon"
                  />
                  <Skeleton
                    animation={animation}
                    variant="rounded"
                    width={240}
                    height="calc(1rem * 16 / 14)"
                  />
                </div>
                <div className="message-card-timestamp-item message-feed-skeleton-card-identity-row">
                  <Skeleton animation={animation} variant="rounded" width={16} height={16} />
                  <Skeleton
                    animation={animation}
                    variant="rounded"
                    width={180}
                    height="calc(1rem * 16 / 14)"
                  />
                </div>
              </div>
              <div className="message-card-divider" />
              <div className="message-card-content-layout message-card-content-layout--with-timestamp">
                <div className="message-card-main">
                  <div>
                    {lines.map((width, lineIndex) => (
                      <div key={lineIndex} className="message-feed-skeleton-card-text-line">
                        <Skeleton
                          animation={animation}
                          variant="rounded"
                          width={`${width}%`}
                          height="calc(1rem * 16 / 14)"
                        />
                      </div>
                    ))}
                  </div>
                </div>
                <div className="message-card-details-region">
                  <div className="message-feed-skeleton-card-meta">
                    <Skeleton animation={animation} variant="circular" width={16} height={16} />
                    <Skeleton animation={animation} variant="rounded" width="30%" height="1rem" />
                    <Skeleton animation={animation} variant="circular" width={16} height={16} />
                    <Skeleton animation={animation} variant="rounded" width="22%" height="1rem" />
                  </div>
                  <Skeleton animation={animation} variant="rounded" width="82%" height="1rem" />
                  <div className="message-card-divider" />
                  <div className="message-feed-skeleton-card-tags">
                    {[64, 96, 72].map((width) => (
                      <Skeleton
                        key={width}
                        animation={animation}
                        variant="rounded"
                        width={width}
                        height={24}
                        className="message-feed-skeleton-card-tag"
                      />
                    ))}
                  </div>
                </div>
                <div className="message-card-timestamp-footer">
                  <Skeleton
                    animation={animation}
                    variant="rounded"
                    width={40}
                    height="calc(1rem * 12 / 14)"
                  />
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </Container>
  );
}
