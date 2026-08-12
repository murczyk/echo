import { Box, Popover, Stack, Typography } from '@mui/material';
import { useId, useRef, useState } from 'react';

import type { AnalyticsTag } from '../../../../../Bindings';
import { PowerChip } from '../../../components/PowerChip';

export function DeviceAnalyticsTagBadges({ tags }: { tags: AnalyticsTag[] }) {
  const popoverId = useId();
  const overflowTriggerRef = useRef<HTMLDivElement | null>(null);
  const [anchorElement, setAnchorElement] = useState<HTMLElement | null>(null);

  if (tags.length === 0) return null;

  const visibleTags = tags.slice(0, 2);
  const hiddenTagCount = tags.length - visibleTags.length;
  const closePopover = () => {
    setAnchorElement(null);
    window.requestAnimationFrame(() => {
      const button = overflowTriggerRef.current?.querySelector<HTMLElement>('[role="button"]');
      button?.focus();
    });
  };

  return (
    <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
      {visibleTags.map((tag) => (
        <PowerChip key={tag.id} label={tag.name} color="primary" interactive={false} />
      ))}
      {hiddenTagCount > 0 ? (
        <>
          <Box ref={overflowTriggerRef} component="span" sx={{ display: 'inline-flex' }}>
            <PowerChip
              label={`+${hiddenTagCount}`}
              color="default"
              interactive
              onClick={() => {
                const button =
                  overflowTriggerRef.current?.querySelector<HTMLElement>('[role="button"]');
                if (button !== null && button !== undefined) setAnchorElement(button);
              }}
              title="Показати всі теги"
              sx={{ '&:focus-visible': { outline: 2, outlineColor: 'primary.main' } }}
            />
          </Box>
          <Popover
            id={popoverId}
            open={anchorElement !== null}
            anchorEl={anchorElement}
            onClose={closePopover}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
            slotProps={{ paper: { sx: { p: 1.5, maxWidth: 360 } } }}
          >
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Усі теги
            </Typography>
            <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
              {tags.map((tag) => (
                <PowerChip key={tag.id} label={tag.name} color="primary" interactive={false} />
              ))}
            </Stack>
          </Popover>
        </>
      ) : null}
    </Stack>
  );
}
