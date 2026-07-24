import { Box, LinearProgress, Paper, Stack, Typography } from '@mui/material';

import type { KmzTask } from '../use-rer-units-page';

export function KmzTaskStatus({ task }: { task: KmzTask }) {
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <Stack direction="row" justifyContent="space-between" spacing={2}>
          <Typography fontWeight={600}>Обробка «{task.fileName}»</Typography>
          <Typography variant="body2" color="text.secondary">
            задача #{task.id}
          </Typography>
        </Stack>
        <LinearProgress
          variant="determinate"
          value={task.running ? task.progress : task.error === null ? 100 : task.progress}
          color={task.error === null ? 'primary' : 'error'}
        />
        {task.logs.length > 0 || task.error !== null ? (
          <Box component="details">
            <Typography component="summary" variant="body2" sx={{ cursor: 'pointer' }}>
              Журнал обробки
            </Typography>
            <Box
              component="pre"
              sx={{
                mt: 1.5,
                mb: 0,
                p: 2,
                maxHeight: 240,
                overflow: 'auto',
                borderRadius: 1,
                bgcolor: 'grey.900',
                color: 'grey.100',
                whiteSpace: 'pre-wrap',
              }}
            >
              {[...task.logs, ...(task.error === null ? [] : [task.error])].join('\n')}
            </Box>
          </Box>
        ) : null}
      </Stack>
    </Paper>
  );
}
