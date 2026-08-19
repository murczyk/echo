import { Box, Tooltip } from '@mui/material';

export function UserUuidValue({ uuid, shortValue }: { uuid: string; shortValue: string }) {
  return (
    <Tooltip describeChild title={uuid}>
      <Box
        component="span"
        tabIndex={0}
        sx={{
          fontFamily: 'monospace',
          whiteSpace: 'nowrap',
          '&:focus-visible': {
            outline: '2px solid',
            outlineColor: 'primary.main',
            outlineOffset: 2,
          },
        }}
      >
        {shortValue}
      </Box>
    </Tooltip>
  );
}
