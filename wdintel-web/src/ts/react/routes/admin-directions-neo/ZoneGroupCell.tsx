import { Box, ButtonBase } from '@mui/material';

import { PowerChip } from '../../components/PowerChip';
import { MrtOverflowText } from '../../components/mui-customized/table/mrt-overflow';

export function ZoneGroupCell({
  name,
  isSecret,
  onView,
}: {
  name: string;
  isSecret: boolean;
  onView: () => void;
}) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
      <Box sx={{ minWidth: 0, flex: '1 1 auto' }}>
        <MrtOverflowText
          displayValue={name}
          fullValue={name}
          interactive
          component={ButtonBase}
          componentProps={{ onClick: onView }}
          sx={{ color: 'inherit', textAlign: 'left' }}
        />
      </Box>
      {isSecret ? (
        <PowerChip
          label="прихована"
          color="warning"
          size="small"
          interactive={false}
          sx={{ flexShrink: 0 }}
        />
      ) : null}
    </Box>
  );
}
