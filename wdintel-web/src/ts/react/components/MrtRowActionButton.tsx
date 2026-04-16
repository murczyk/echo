import MoreVertIcon from '@mui/icons-material/MoreVert';
import { ListItemIcon, ListItemText, MenuItem, Stack, Theme, Tooltip, alpha } from '@mui/material';
import { SystemStyleObject } from '@mui/system';
import { Children, isValidElement, useId, useState } from 'react';
import type { MouseEvent, ReactElement, ReactNode } from 'react';

import { PowerIconButton } from './PowerIconButton';
import { PowerMenu } from './PowerMenu';

type Tone = 'default' | 'danger';
type Layout = 'row' | 'grid';

type Props = {
  label: string;
  onClick: () => void;
  icon: ReactNode;
  disabled?: boolean;
  tone?: Tone;
};

type GroupProps = {
  children: ReactNode;
  layout?: Layout;
};

type ActionElement = ReactElement<Props, typeof MrtRowActionButton>;

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
  const actions = Children.toArray(children).filter(isMrtRowActionElement);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const menuButtonId = useId();
  const menuLabelId = `${menuButtonId}-trigger`;

  if (actions.length >= 3) {
    const primaryAction = actions[0];
    const overflowActions = actions.slice(1);
    const menuOpen = Boolean(anchorEl);

    return (
      <>
        <Stack direction="row" spacing={1} alignItems="center" justifyContent="center" useFlexGap>
          {primaryAction}
          <Tooltip title="Інші дії">
            <span style={{ display: 'inline-flex' }}>
              <PowerIconButton
                id={menuLabelId}
                size="small"
                aria-label="Інші дії"
                aria-controls={menuOpen ? menuButtonId : undefined}
                aria-expanded={menuOpen ? 'true' : undefined}
                aria-haspopup="menu"
                onClick={(event) => {
                  event.stopPropagation();
                  setAnchorEl(event.currentTarget);
                }}
                sx={(theme) => actionButtonSx(theme, 'default')}
              >
                <MoreVertIcon fontSize="small" />
              </PowerIconButton>
            </span>
          </Tooltip>
        </Stack>
        <PowerMenu
          id={menuButtonId}
          anchorEl={anchorEl}
          open={menuOpen}
          onClose={() => setAnchorEl(null)}
          slotProps={{ list: { 'aria-labelledby': menuLabelId } }}
        >
          {overflowActions.map((action, index) => (
            <OverflowMenuAction
              key={action.key ?? `overflow-action-${index}`}
              action={action}
              onClose={() => setAnchorEl(null)}
            />
          ))}
        </PowerMenu>
      </>
    );
  }

  return (
    <Stack
      direction={layout === 'grid' ? undefined : 'row'}
      spacing={1}
      alignItems="center"
      justifyContent="center"
      useFlexGap
      sx={
        layout === 'grid'
          ? {
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: 1,
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
  const button = (
    <span style={{ display: 'inline-flex', cursor: disabled ? 'not-allowed' : undefined }}>
      <PowerIconButton size="small" onClick={onClick} disabled={disabled} aria-label={label} sx={(theme) => actionButtonSx(theme, tone)}>
        {icon}
      </PowerIconButton>
    </span>
  );

  if (disabled) {
    return button;
  }

  return <Tooltip title={label}>{button}</Tooltip>;
}

function isMrtRowActionElement(child: ReactNode): child is ActionElement {
  return isValidElement(child) && child.type === MrtRowActionButton;
}

function OverflowMenuAction({ action, onClose }: { action: ActionElement; onClose: () => void }) {
  const { label, onClick, icon, disabled = false, tone = 'default' } = action.props;

  function handleClick(event: MouseEvent<HTMLLIElement>) {
    event.stopPropagation();
    onClose();
    onClick();
  }

  return (
    <MenuItem disabled={disabled} onClick={handleClick} sx={{ pl: 0.5 }}>
      <ListItemIcon
        sx={(theme) => ({
          minWidth: 40,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: tone === 'danger' ? theme.palette.error.main : theme.palette.text.primary,
          '& > *': {
            display: 'block',
          },
        })}
      >
        {icon}
      </ListItemIcon>
      <ListItemText primary={label} />
    </MenuItem>
  );
}

export function mrtRowActionsColumnSize(actionCount: number, layout: Layout = 'row') {
  if (actionCount >= 3) {
    return layout === 'grid' ? 84 : 78;
  }

  if (layout === 'grid') {
    return 84;
  }

  if (actionCount <= 1) {
    return 48;
  }

  return 20 + actionCount * 28 + (actionCount - 1) * 2;
}
