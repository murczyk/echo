import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import { CircularProgress, ListItemButton, Tooltip } from '@mui/material';
import dayjs from 'dayjs';
import { PowerButton } from '../../../components/PowerButton';
import type { DeviceAudioState } from '../use-device-audio';

export function DeviceAudioList({ audio }: { audio: DeviceAudioState }) {
  return (
    <div className="flex min-w-0 flex-col gap-echo-sm" data-testid="device-audio-list">
      {audio.loading ? (
        <div role="status">
          <CircularProgress size={24} aria-label="Завантаження аудіо" />
        </div>
      ) : null}
      {audio.error ? (
        <div role="alert" className="break-words">
          <p>{audio.error}</p>
          <PowerButton disabled={audio.loading} onClick={() => void audio.retry()}>
            Спробувати ще раз
          </PowerButton>
        </div>
      ) : null}
      {audio.ready &&
      !audio.loading &&
      !audio.error &&
      audio.rows.length === 0 &&
      audio.nextCursor === null ? (
        <p role="status">
          {audio.unprocessedOnly ? 'Необроблених аудіо немає.' : 'Аудіоматеріалів немає.'}
        </p>
      ) : null}
      {audio.rows.map((row) => (
        <ListItemButton
          component="button"
          key={row.id}
          data-audio-id={row.id}
          selected={audio.selectedAudioId === row.id}
          aria-pressed={audio.selectedAudioId === row.id}
          className="w-full! min-w-0! gap-echo-sm rounded-echo-sm! px-echo-sm! py-echo-sm! max-echo-lg:min-h-echo-control-lg"
          onClick={() => audio.selectAudio(row.id)}
        >
          <Tooltip title={row.processed ? 'Оброблене' : 'Необроблене'}>
            <span
              role="img"
              aria-label={row.processed ? 'Оброблене' : 'Необроблене'}
              className="flex shrink-0 items-center text-[length:var(--echo-size-icon-sm)]"
            >
              {row.processed ? (
                <CheckCircleOutlineIcon fontSize="inherit" color="success" />
              ) : (
                <RadioButtonUncheckedIcon fontSize="inherit" color="disabled" />
              )}
            </span>
          </Tooltip>
          <span className="min-w-0 text-left text-echo-sm leading-normal tabular-nums">
            <time className="whitespace-nowrap" dateTime={row.recordingStartedAt}>
              {dayjs(row.recordingStartedAt).format('DD.MM.YY HH:mm:ss')}
            </time>{' '}
            <span className="whitespace-nowrap">
              {'- '}
              <time dateTime={row.recordingEndedAt}>
                {dayjs(row.recordingEndedAt).format('DD.MM.YY HH:mm:ss')}
              </time>
            </span>
          </span>
        </ListItemButton>
      ))}
      {audio.loadMoreError ? (
        <p role="alert" className="break-words">
          {audio.loadMoreError}
        </p>
      ) : null}
      {audio.nextCursor !== null ? (
        <PowerButton
          key={audio.loadMoreError ? 'retry' : 'more'}
          disabled={audio.loading || audio.loadingMore}
          onClick={() => void audio.loadMore()}
        >
          {audio.loadingMore
            ? 'Завантаження…'
            : audio.loadMoreError
              ? 'Повторити завантаження решти'
              : 'Завантажити ще'}
        </PowerButton>
      ) : null}
    </div>
  );
}
