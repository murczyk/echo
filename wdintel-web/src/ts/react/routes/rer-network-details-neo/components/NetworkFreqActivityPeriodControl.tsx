import { Box, Button, ButtonGroup, Stack, Typography } from '@mui/material';
import { useId } from 'react';

import { formatUtcDateInputValue } from '../../../utils/misc';
import { NetworkFreqDatePickerField } from './NetworkFreqDatePickerField';

type Props = {
  activeFrom: string;
  activeTo: string;
  onActiveFromChange: (nextValue: string) => void;
  onActiveToChange: (nextValue: string) => void;
  onActiveFromBlur?: () => void;
  onActiveToBlur?: () => void;
  disabled?: boolean;
  required?: boolean;
  activeFromError?: boolean;
  activeFromHelperText?: string;
  activeToError?: boolean;
  activeToHelperText?: string;
};

export function NetworkFreqActivityPeriodControl({
  activeFrom,
  activeTo,
  onActiveFromChange,
  onActiveToChange,
  onActiveFromBlur,
  onActiveToBlur,
  disabled = false,
  required = false,
  activeFromError = false,
  activeFromHelperText,
  activeToError = false,
  activeToHelperText,
}: Props) {
  const labelId = useId();
  const isActive = activeTo.trim() === '';

  const handleActivate = () => {
    onActiveToChange('');
  };

  const handleDeactivate = () => {
    onActiveToChange(activeTo.trim() === '' ? formatUtcDateInputValue(new Date()) : activeTo);
  };

  return (
    <Stack spacing={2} aria-labelledby={labelId}>
      <Box>
        <Typography
          id={labelId}
          variant="subtitle2"
          color="text.secondary"
          sx={{ fontWeight: 600 }}
        >
          Активність
        </Typography>

        <ButtonGroup
          size="small"
          disabled={disabled}
          sx={{
            width: 'fit-content',
            mt: 1,
            height: 40,
            '& .MuiButton-root': {
              height: 40,
              px: 2,
            },
          }}
        >
          <Button
            variant={isActive ? 'contained' : 'outlined'}
            onClick={handleActivate}
            disabled={disabled}
            sx={{ fontSize: '0.875rem' }}
          >
            Активна
          </Button>
          <Button
            variant={!isActive ? 'contained' : 'outlined'}
            onClick={handleDeactivate}
            disabled={disabled}
            sx={{ fontSize: '0.875rem' }}
          >
            Неактивна
          </Button>
        </ButtonGroup>
      </Box>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: isActive
            ? { xs: '1fr' }
            : { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
          gap: 2,
          alignItems: 'start',
        }}
      >
        <NetworkFreqDatePickerField
          label="Активна з"
          value={activeFrom}
          onChange={onActiveFromChange}
          onBlur={onActiveFromBlur}
          disabled={disabled}
          required={required}
          error={activeFromError}
          helperText={activeFromHelperText}
          textFieldSx={{ width: '100%' }}
        />

        {!isActive ? (
          <NetworkFreqDatePickerField
            label="Активна по"
            value={activeTo}
            onChange={onActiveToChange}
            onBlur={onActiveToBlur}
            disabled={disabled}
            required={required}
            error={activeToError}
            helperText={activeToHelperText}
            textFieldSx={{ width: '100%' }}
          />
        ) : null}
      </Box>
    </Stack>
  );
}
