import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import { Box, Chip, Stack, Tooltip, Typography } from '@mui/material';

import type { AiCallsignParseResultItem } from '../../../../Bindings';

function errorTooltip(result: AiCallsignParseResultItem) {
  return (
    <Box sx={{ maxWidth: 600 }}>
      <Typography variant="subtitle2">{result.error}</Typography>
      {result.responseText ? (
        <Typography
          component="pre"
          variant="body2"
          sx={{ mt: 1, mb: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
        >
          {result.responseText}
        </Typography>
      ) : null}
    </Box>
  );
}

export function AiCallsignResultCell({
  result,
}: {
  result: AiCallsignParseResultItem | undefined;
}) {
  if (!result) {
    return (
      <Typography variant="body2" color="text.secondary">
        —
      </Typography>
    );
  }

  if (result.error) {
    return (
      <Tooltip title={errorTooltip(result)} arrow>
        <Box
          component="span"
          sx={{ display: 'inline-flex', alignItems: 'center', color: 'error.main' }}
          aria-label={result.error}
        >
          <ErrorOutlineIcon />
        </Box>
      </Tooltip>
    );
  }

  if (result.callsigns.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        Позивних немає
      </Typography>
    );
  }

  return (
    <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap">
      {result.callsigns.map((callsign) => (
        <Chip key={callsign} label={callsign.toLocaleUpperCase('uk-UA')} size="small" />
      ))}
    </Stack>
  );
}
