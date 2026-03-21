import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import { Button, Stack } from '@mui/material';
import React from 'react';

type Props = {
  onOpenReport: () => void;
  onReset: () => void;
};

export function AnalysisToolbar({ onOpenReport, onReset }: Props) {
  return (
    <Stack direction="row" spacing={1.5} flexWrap="wrap">
      <Button variant="outlined" startIcon={<DescriptionOutlinedIcon />} onClick={onOpenReport}>
        Конструктор звітів
      </Button>
      <Button variant="outlined" color="inherit" onClick={onReset}>
        Скинути фільтри
      </Button>
    </Stack>
  );
}
