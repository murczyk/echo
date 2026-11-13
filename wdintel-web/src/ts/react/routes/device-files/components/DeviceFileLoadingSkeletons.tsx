import { Skeleton } from '@mui/material';
import { DEVICE_FILE_LOADING_PLACEHOLDER_COUNT } from '../types';

export function DeviceFileGridSkeletons() {
  return (
    <div
      aria-hidden="true"
      className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,11rem),1fr))] gap-echo-md pt-echo-md"
    >
      {Array.from({ length: DEVICE_FILE_LOADING_PLACEHOLDER_COUNT }, (_, index) => (
        <div
          key={index}
          data-device-file-loading-skeleton
          className="flex min-h-44 min-w-0 flex-col items-center gap-echo-sm rounded-echo-md border border-echo-primary/60 bg-echo-surface p-echo-sm"
        >
          <Skeleton animation="wave" variant="rounded" className="h-20! w-full! shrink-0!" />
          <Skeleton
            animation="wave"
            variant="text"
            className="w-3/4! text-[length:var(--echo-typography-font-size-base)]!"
          />
          <div className="w-full">
            <Skeleton
              animation="wave"
              variant="text"
              className="w-full! text-[length:var(--echo-typography-font-size-xs)]!"
            />
            <Skeleton
              animation="wave"
              variant="text"
              className="w-3/4! text-[length:var(--echo-typography-font-size-xs)]!"
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export function DeviceFileTableSkeletons({ columns }: { columns: number }) {
  return Array.from({ length: DEVICE_FILE_LOADING_PLACEHOLDER_COUNT }, (_, row) => (
    <tr
      key={row}
      aria-hidden="true"
      data-device-file-loading-skeleton
      className="even:bg-echo-surface/50"
    >
      {Array.from({ length: columns }, (_, column) => (
        <td key={column} className="px-echo-sm">
          <div className="flex min-h-echo-control-md items-center gap-echo-sm max-echo-lg:min-h-echo-control-lg">
            {column === 0 && (
              <Skeleton
                animation="wave"
                variant="rounded"
                className="size-echo-icon-md! shrink-0!"
              />
            )}
            <Skeleton
              animation="wave"
              variant="text"
              className="w-3/4! text-[length:var(--echo-typography-font-size-base)]!"
            />
          </div>
        </td>
      ))}
    </tr>
  ));
}
