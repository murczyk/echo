import { Box, Paper, Skeleton, Stack } from '@mui/material';

type Props = {
  rightPanelVisible: boolean;
};

const messageCardSkeletons = [
  { lines: [320, 180, 140], bodyHeight: 92 },
  { lines: [240, 160], bodyHeight: 76 },
  { lines: [280, 200, 160], bodyHeight: 88 },
  { lines: [220, 180], bodyHeight: 76 },
];

export function AnalysisLoadingSkeletons({ rightPanelVisible }: Props) {
  return (
    <>
      <Paper
        variant="outlined"
        component="section"
        aria-label="Центральна секція"
        aria-disabled="true"
        sx={{
          minHeight: 0,
          minWidth: 0,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <Stack spacing={0.75} sx={{ px: { xs: 1, lg: 2 }, pt: { xs: 0.5, lg: 1 }, mb: 0.25 }}>
          <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ minHeight: 40, alignItems: 'center' }}>
            <Skeleton variant="rounded" width={180} height={32} />
            <Skeleton variant="rounded" width={108} height={32} />
            <Skeleton variant="rounded" width={160} height={32} />
          </Stack>

        </Stack>
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            px: { xs: 1, lg: 2 },
            pb: { xs: 1, lg: 2 },
            pt: { xs: 0.5, lg: 1 },
            overflow: 'hidden',
          }}
        >
          <Stack spacing={1.25}>
            {messageCardSkeletons.map((card, index) => (
              <Box
                key={index}
                sx={{
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: 1,
                  p: 1.5,
                  bgcolor: 'rgba(255, 255, 255, 0.02)',
                }}
              >
                <Stack spacing={1}>
                  <Stack spacing={0.75}>
                    <Skeleton variant="rounded" width={card.lines[0]} height={20} />
                    <Stack direction="row" spacing={1} flexWrap="wrap" alignItems="center">
                      <Skeleton variant="rounded" width={88} height={24} />
                      <Skeleton variant="rounded" width={72} height={24} />
                      <Skeleton variant="rounded" width={96} height={24} />
                    </Stack>
                  </Stack>
                  <Stack spacing={0.75}>
                    <Skeleton variant="rounded" height={card.bodyHeight} />
                    <Stack direction="row" spacing={1} flexWrap="wrap">
                      {card.lines.slice(1).map((lineWidth, lineIndex) => (
                        <Skeleton key={lineIndex} variant="rounded" width={lineWidth} height={16} />
                      ))}
                    </Stack>
                  </Stack>
                </Stack>
              </Box>
            ))}
          </Stack>
        </Box>
      </Paper>

      {rightPanelVisible ? (
        <Paper
          variant="outlined"
          component="aside"
          aria-label="Аналітична права секція"
          aria-disabled="true"
          sx={{
            minHeight: 0,
            height: { xs: 'auto', lg: '100%' },
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            opacity: 0.55,
          }}
        >
          <Box
            sx={{
              flex: 1,
              minWidth: 0,
              p: { xs: 1, lg: 2 },
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <Stack spacing={2}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                <Skeleton variant="text" width={280} height={40} />
                <Stack direction="row" spacing={1}>
                  <Skeleton variant="rounded" width={92} height={28} />
                  <Skeleton variant="rounded" width={92} height={28} />
                </Stack>
              </Stack>
              {Array.from({ length: 6 }).map((_, index) => (
                <Skeleton key={index} variant="rounded" height={72} />
              ))}
              <Skeleton variant="rounded" height={72} />
            </Stack>
          </Box>
        </Paper>
      ) : null}
    </>
  );
}
