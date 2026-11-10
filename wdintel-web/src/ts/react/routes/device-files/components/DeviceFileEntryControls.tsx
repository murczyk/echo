import CheckIcon from '@mui/icons-material/Check';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import { ButtonBase, Tooltip } from '@mui/material';
import type { DeviceFileTreeEntry } from '../../../../../Bindings';
import { PowerIconButton } from '../../../components/PowerIconButton';

export function FileViewedLabel({
  viewed,
  newLabel = 'Нове',
}: {
  viewed: boolean;
  newLabel?: string;
}) {
  return viewed ? (
    <span role="img" className="inline-flex text-echo-success" aria-label="Переглянуто">
      <CheckIcon fontSize="small" />
    </span>
  ) : (
    <span className="rounded-full border border-echo-primary px-echo-sm text-[length:var(--echo-typography-font-size-xs)] text-echo-primary">
      {newLabel}
    </span>
  );
}

export function FileViewedButton({
  entry,
  onViewed,
  pending,
  newLabel,
}: {
  entry: DeviceFileTreeEntry;
  onViewed?: (entry: DeviceFileTreeEntry) => void;
  pending?: boolean;
  newLabel?: string;
}) {
  const label = <FileViewedLabel viewed={entry.isViewed} newLabel={newLabel} />;
  if (!onViewed) return label;
  const action = entry.isViewed ? 'Позначити як нове' : 'Позначити як переглянуте';
  return (
    <Tooltip title={action}>
      <span className="inline-flex">
        <ButtonBase
          aria-label={`${action}: ${entry.name}`}
          aria-pressed={entry.isViewed}
          disabled={pending || !entry.fileId || entry.revision == null}
          onClick={(event) => {
            event.stopPropagation();
            onViewed(entry);
          }}
          className="min-h-7! min-w-7! rounded-full! disabled:opacity-55 focus-visible:outline focus-visible:outline-echo-focus"
        >
          {label}
        </ButtonBase>
      </span>
    </Tooltip>
  );
}

export function FileFavoriteButton({
  entry,
  onFavorite,
  pending,
  className,
}: {
  entry: DeviceFileTreeEntry;
  onFavorite: (entry: DeviceFileTreeEntry) => void;
  pending?: boolean;
  className?: string;
}) {
  return (
    <Tooltip title={entry.isFavorite ? 'Прибрати з обраного' : 'Додати в обране'}>
      <PowerIconButton
        size="small"
        className={className}
        aria-label={`${entry.isFavorite ? 'Прибрати з обраного' : 'Додати в обране'}: ${entry.name}`}
        aria-pressed={entry.isFavorite}
        disabled={pending}
        onClick={() => onFavorite(entry)}
      >
        {entry.isFavorite ? <StarIcon className="text-echo-warning" /> : <StarBorderIcon />}
      </PowerIconButton>
    </Tooltip>
  );
}
