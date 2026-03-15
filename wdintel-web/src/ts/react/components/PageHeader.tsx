import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { Stack, Tooltip, Typography } from '@mui/material';
import React from 'react';

import { IconButton } from './mui-customized/icon-button';

type Props = {
  title: React.ReactNode;
  titleInfo?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  titleClassName?: string;
};

export function PageHeader({ title, titleInfo, actions, className, titleClassName }: Props) {
  return (
    <Stack
      direction="row"
      alignItems="center"
      justifyContent="space-between"
      flexWrap="wrap"
      gap={2}
      className={className}
    >
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" sx={{ minHeight: 40 }}>
        <Typography
          component="h1"
          variant="h5"
          sx={{ m: 0, fontWeight: 600, lineHeight: 1.2 }}
          className={titleClassName}
        >
          {title}
        </Typography>
        {titleInfo ? (
          <Tooltip title={titleInfo} arrow placement="right-start">
            <IconButton
              size="small"
              aria-label="Інформація про сторінку"
              sx={{ p: 0.25, alignSelf: 'center', display: 'inline-flex' }}
            >
              <InfoOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        ) : null}
      </Stack>
      {actions ?? null}
    </Stack>
  );
}
