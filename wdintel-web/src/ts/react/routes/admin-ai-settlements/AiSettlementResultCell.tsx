import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import { Box, Chip, Stack, Tooltip, Typography } from '@mui/material';

import type { AiSettlementParseResultItem } from '../../../../Bindings';

function errorTooltip(result: AiSettlementParseResultItem) {
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

export function AiSettlementResultCell({
  result,
}: {
  result: AiSettlementParseResultItem | undefined;
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

  if (result.settlements.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        Населених пунктів немає
      </Typography>
    );
  }

  return (
    <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap">
      {result.settlements.map((settlement) => (
        <Chip key={settlement} label={settlement.toLocaleUpperCase('uk-UA')} size="small" />
      ))}
    </Stack>
  );
}
