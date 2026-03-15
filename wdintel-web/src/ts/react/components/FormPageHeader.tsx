import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { Stack, Typography } from '@mui/material';
import React from 'react';

import { Button } from './mui-customized/button';

type Props = {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
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
      <Button variant="outlined" startIcon={<ArrowBackIcon />} onClick={onBack}>
        {backLabel}
      </Button>
    </Stack>
  );
}
