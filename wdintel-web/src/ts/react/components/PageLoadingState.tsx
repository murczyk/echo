import { Box, Skeleton, Stack } from '@mui/material';

type Props = {
  minHeight?: number | string;
};

export function PageLoadingState({ minHeight = 240 }: Props) {
  return (
    <Box
      sx={{
        width: '100%',
        minHeight,
        py: 3,
        px: 2,
        display: 'flex',
        alignItems: 'stretch',
      }}
    >
      <Stack spacing={2} sx={{ width: '100%' }}>
        <Skeleton variant="text" width={180} height={36} />
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <Skeleton variant="rounded" height={40} sx={{ flex: 1 }} />
          <Skeleton variant="rounded" height={40} sx={{ flex: 1 }} />
        </Stack>
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} variant="rounded" height={56} />
        ))}
      </Stack>
    </Box>
  );
}
