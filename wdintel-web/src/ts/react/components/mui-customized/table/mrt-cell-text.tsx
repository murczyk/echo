import { Typography } from '@mui/material';
import type { TypographyProps } from '@mui/material/Typography';
import type { ReactNode } from 'react';

import { formatMrtCellTextValue } from '../../formatMrtCellTextValue';
import { NO_DATA_LABEL } from '../../../utils/misc';

export function renderMrtCellTextValue(
  value: string | null | undefined,
  props?: TypographyProps,
): ReactNode {
  return (
    <Typography variant="body2" {...props}>
      {formatMrtCellTextValue(value)}
    </Typography>
  );
}

export function renderMrtCellWithFallback(
  value: string | null | undefined,
  renderNonEmpty: (text: string) => ReactNode,
): ReactNode {
  const text = formatMrtCellTextValue(value);
  if (text === NO_DATA_LABEL) {
    return renderMrtCellTextValue(text);
  }

  return renderNonEmpty(text);
}
