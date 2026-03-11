import { Stack, Theme, Tooltip, alpha } from '@mui/material';
import { SystemStyleObject } from '@mui/system';
import React from 'react';

import { IconButton } from './mui-customized/icon-button';

type Tone = 'default' | 'danger';
type Layout = 'row' | 'grid';

type Props = {
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
  disabled?: boolean;
  tone?: Tone;
};

type GroupProps = {
  children: React.ReactNode;
  layout?: Layout;
};

function actionButtonSx(theme: Theme, tone: Tone): SystemStyleObject<Theme> {
  if (tone === 'danger') {
    return {
      width: 28,
      height: 28,
      borderRadius: '50%',
      color: theme.palette.error.main,
      '&:hover': {
        backgroundColor: alpha(theme.palette.error.main, theme.palette.mode === 'dark' ? 0.22 : 0.14),
        color: theme.palette.error.main,
      },
      '&:focus-visible': {
        outline: `2px solid ${alpha(theme.palette.error.main, 0.8)}`,
        outlineOffset: 1,
        backgroundColor: alpha(theme.palette.error.main, theme.palette.mode === 'dark' ? 0.24 : 0.16),
      },
      '&.Mui-disabled': {
        color: theme.palette.action.disabled,
      },
    };
  }

  return {
    width: 28,
    height: 28,
    borderRadius: '50%',
    color: theme.palette.text.primary,
    '&:hover': {
      backgroundColor: theme.palette.action.hover,
      color: theme.palette.text.primary,
    },
    '&:focus-visible': {
      outline: `2px solid ${alpha(theme.palette.primary.main, 0.7)}`,
      outlineOffset: 1,
      backgroundColor: alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.18 : 0.1),
    },
    '&.Mui-disabled': {
      color: theme.palette.action.disabled,
    },
  };
}

export function MrtRowActions({ children, layout = 'row' }: GroupProps) {
  return (
    <Stack
      direction={layout === 'grid' ? undefined : 'row'}
      spacing={0.5}
      alignItems="center"
      justifyContent="center"
      useFlexGap
      sx={
        layout === 'grid'
          ? {
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: 0.5,
              justifyItems: 'center',
            }
          : undefined
      }
    >
      {children}
    </Stack>
  );
}

export function MrtRowActionButton({ label, onClick, icon, disabled = false, tone = 'default' }: Props) {
  return (
    <Tooltip title={label}>
      <span>
        <IconButton size="small" onClick={onClick} disabled={disabled} aria-label={label} sx={(theme) => actionButtonSx(theme, tone)}>
          {icon}
        </IconButton>
      </span>
    </Tooltip>
  );
}

export function mrtRowActionsColumnSize(actionCount: number, layout: Layout = 'row') {
  if (layout === 'grid') {
    return 84;
  }

  if (actionCount <= 1) {
    return 48;
  }

  return 20 + actionCount * 28 + (actionCount - 1) * 2;
}
