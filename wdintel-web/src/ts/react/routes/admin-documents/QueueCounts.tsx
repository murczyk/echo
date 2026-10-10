import { Chip, Stack } from '@mui/material';

import type { AttachmentQueueCount } from '../../../../Bindings';

export function QueueCounts({ counts }: { counts: AttachmentQueueCount[] }) {
  if (counts.length === 0) return null;
  return (
    <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" aria-label="Черга обробки">
      {counts.map((count) => (
        <Chip
          key={`${count.kind}:${count.state}`}
          size="small"
          variant="outlined"
          label={`${count.kind} / ${count.state}: ${count.count}`}
        />
      ))}
    </Stack>
  );
}
