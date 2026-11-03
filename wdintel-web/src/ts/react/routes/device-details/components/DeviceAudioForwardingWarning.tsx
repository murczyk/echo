import WarningIcon from '@mui/icons-material/Warning';
import { Tooltip } from '@mui/material';

export function DeviceAudioForwardingWarning({ configured }: { configured?: boolean }) {
  if (configured !== false) return null;

  return (
    <Tooltip
      title="Пересилання аудіо в групи не налаштоване для цього пристрою."
      arrow
      describeChild
    >
      <span
        role="img"
        aria-label="Пересилання аудіо не налаштоване"
        tabIndex={0}
        className="inline-flex shrink-0 cursor-help p-echo-sm"
      >
        <WarningIcon color="warning" fontSize="small" />
      </span>
    </Tooltip>
  );
}
