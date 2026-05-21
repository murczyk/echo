import { Box, CircularProgress, Stack, Typography } from '@mui/material';

type Props = {
  message: string;
  minHeight?: number;
};

export function NetworkDetailsLoadingState({ message, minHeight = 360 }: Props) {
  return (
    <Box
      sx={{
        minHeight,
        width: '100%',
        display: 'grid',
        placeItems: 'center',
        borderRadius: 2,
        border: '1px dashed',
        borderColor: 'divider',
        bgcolor: 'background.default',
        px: 3,
        py: 4,
        textAlign: 'center',
      }}
    >
      <Stack spacing={1.5} alignItems="center">
        <CircularProgress size={24} />
        <Typography variant="body1" color="text.secondary" sx={{ lineHeight: 1.5 }}>
          {message}
        </Typography>
      </Stack>
    </Box>
  );
}
