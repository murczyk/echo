import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { Stack, Typography } from '@mui/material';
import type { ReactNode } from 'react';

import { PowerButton } from './PowerButton';

type Props = {
  title: ReactNode;
  subtitle?: ReactNode;
  onBack: () => void;
  backLabel?: string;
};

export function FormPageHeader({ title, subtitle, onBack, backLabel = 'Назад' }: Props) {
  return (
    <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'flex-start' }} gap={3}>
      <Stack spacing={1}>
        <Typography component="h1" variant="h5" sx={{ m: 0, fontWeight: 600, lineHeight: 1.2 }}>
          {title}
        </Typography>
        {subtitle ? (
          <Typography variant="body2" color="text.secondary">
            {subtitle}
          </Typography>
        ) : null}
      </Stack>
      <PowerButton variant="outlined" startIcon={<ArrowBackIcon />} onClick={onBack}>
        {backLabel}
      </PowerButton>
    </Stack>
  );
}
