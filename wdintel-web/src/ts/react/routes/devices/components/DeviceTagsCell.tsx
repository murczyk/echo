import { Tooltip } from '@mui/material';
import { EchoChip } from '../../../components/EchoChip';

export function DeviceTagsCell({ tags }: { tags: string[] }) {
  if (tags.length === 0) return '—';
  return (
    <Tooltip title={tags.length > 3 ? tags.join(', ') : ''} describeChild>
      <div
        className="flex min-w-0 flex-wrap items-center gap-echo-xs"
        tabIndex={tags.length > 3 ? 0 : undefined}
      >
        {tags.slice(0, 3).map((tag) => (
          <EchoChip key={tag} label={tag} title={tag} tone="tag" />
        ))}
        {tags.length > 3 ? <span>+{tags.length - 3}</span> : null}
      </div>
    </Tooltip>
  );
}
