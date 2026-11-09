import { CircularProgress } from '@mui/material';
import type { ComponentProps, ReactNode } from 'react';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerButton } from '../../../components/PowerButton';
import { DeviceFileCards } from './DeviceFileCards';
import { DeviceFileAutoLoad } from './DeviceFileAutoLoad';
import { useDeviceFileScroll } from '../use-device-file-scroll';
import type { DeviceFileScrollPositions } from '../types';
import { DeviceFileGridSkeletons } from './DeviceFileLoadingSkeletons';

export function DeviceFileFolderContent({
  loading,
  loadingMore,
  error,
  nextCursor,
  onRetry,
  onLoadMore,
  active = true,
  scrollPositions,
  emptyMessage = 'Папка порожня.',
  children,
  ...cards
}: ComponentProps<typeof DeviceFileCards> & {
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  nextCursor: string | null;
  onRetry: () => void;
  onLoadMore: () => void;
  active?: boolean;
  scrollPositions?: DeviceFileScrollPositions;
  emptyMessage?: string;
  children?: ReactNode;
}) {
  const tableVisible =
    cards.viewMode === 'list' && (cards.entries.length > 0 || loadingMore) && !loading;
  const { viewportRef, onScrollCapture } = useDeviceFileScroll({
    positions: scrollPositions,
    viewMode: cards.viewMode,
    loading,
    active,
    tableVisible,
  });
  const pagination =
    nextCursor !== null ? (
      <DeviceFileAutoLoad
        cursor={nextCursor}
        enabled={active && !loading && !error}
        loading={loadingMore}
        onLoadMore={onLoadMore}
      >
        {cards.viewMode === 'grid' && <DeviceFileGridSkeletons />}
      </DeviceFileAutoLoad>
    ) : null;
  const errorAlert = error && (
    <PowerAlert
      severity="error"
      autoHideDuration={null}
      action={<PowerButton onClick={onRetry}>Повторити</PowerButton>}
    >
      {error}
    </PowerAlert>
  );
  return (
    <section
      ref={viewportRef}
      onScrollCapture={onScrollCapture}
      aria-label="Вміст папки"
      data-device-file-scroll-viewport
      className={`flex h-full min-h-0 min-w-0 flex-col bg-echo-background ${cards.viewMode === 'list' ? 'overflow-hidden' : 'overflow-y-auto'}`}
    >
      <div
        className={`min-w-0 flex-1 py-echo-lg pr-[var(--device-files-scroll-gutter,0px)] ${cards.viewMode === 'list' ? 'flex min-h-0 flex-col gap-echo-md' : 'space-y-echo-md'}`}
      >
        {children}
        {(tableVisible || cards.entries.length === 0) && errorAlert}
        {loading ? (
          <div className="grid min-h-40 place-items-center">
            <CircularProgress aria-label="Завантаження файлів" />
          </div>
        ) : cards.entries.length === 0 && !error && !tableVisible ? (
          <p className="m-0 p-echo-xl text-center text-echo-text-muted">
            {nextCursor !== null ? 'Пошук наступних файлів…' : emptyMessage}
          </p>
        ) : (
          <DeviceFileCards
            {...cards}
            loadingMore={loadingMore}
            footer={tableVisible ? pagination : undefined}
          />
        )}
        {!tableVisible && cards.entries.length > 0 && errorAlert}
        {!tableVisible && pagination}
      </div>
    </section>
  );
}
