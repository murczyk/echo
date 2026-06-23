import MoreVertIcon from '@mui/icons-material/MoreVert';
import { ListItemIcon, ListItemText, MenuItem, Theme, Tooltip, alpha } from '@mui/material';
import { SystemStyleObject } from '@mui/system';
import { Children, isValidElement, useId, useState } from 'react';
import type { MouseEvent, ReactElement, ReactNode } from 'react';

import { PowerIconButton } from './PowerIconButton';
import { PowerMenu } from './PowerMenu';

type Tone = 'default' | 'warning' | 'danger';
type Layout = 'row' | 'grid';

type Props = {
  label: string;
  onClick: () => void;
  icon: ReactNode;
  disabled?: boolean;
  tone?: Tone;
  opensModal?: boolean;
};

type GroupProps = {
  children: ReactNode;
  layout?: Layout;
};

type ActionElement = ReactElement<Props, typeof MrtRowActionButton>;

export const MRT_ROW_ACTION_MODAL_PROPS = {
  disableRestoreFocus: true,
} as const;

function blurActiveElement() {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
}

function runRowAction({
  opensModal,
  onClick,
  onClose,
}: {
  opensModal: boolean;
  onClick: () => void;
  onClose?: () => void;
}) {
  if (opensModal) {
    blurActiveElement();
    onClose?.();
    window.setTimeout(onClick, 0);
    return;
  }

  onClose?.();
  onClick();
}

function actionButtonSx(theme: Theme, tone: Tone): SystemStyleObject<Theme> {
  if (tone !== 'default') {
    const toneColor =
      tone === 'danger' ? theme.palette.error.main : theme.palette.warning.main;

    return {
      width: 28,
      height: 28,
      borderRadius: '50%',
      color: toneColor,
      '&:hover': {
        backgroundColor: alpha(toneColor, theme.palette.mode === 'dark' ? 0.22 : 0.14),
        color: toneColor,
      },
      '&:focus-visible': {
        outline: `2px solid ${alpha(toneColor, 0.8)}`,
        outlineOffset: 1,
        backgroundColor: alpha(toneColor, theme.palette.mode === 'dark' ? 0.24 : 0.16),
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

  if (actions.length <= 1) {
    return actions[0] ?? null;
  }

  const menuOpen = Boolean(anchorEl);

  return (
    <>
      <Tooltip title="Дії">
        <span style={{ display: 'inline-flex' }}>
          <PowerIconButton
            id={menuLabelId}
            size="small"
            aria-label="Дії"
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
      <PowerMenu
        id={menuButtonId}
        anchorEl={anchorEl}
        open={menuOpen}
        onClose={() => setAnchorEl(null)}
        slotProps={{ list: { 'aria-labelledby': menuLabelId } }}
      >
        {actions.map((action, index) => (
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

export function MrtRowActionButton({ label, onClick, icon, disabled = false, tone = 'default', opensModal = false }: Props) {
  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (opensModal) {
      event.currentTarget.blur();
    }
    runRowAction({ opensModal, onClick });
  }

  const button = (
    <span style={{ display: 'inline-flex', cursor: disabled ? 'not-allowed' : undefined }}>
      <PowerIconButton
        size="small"
        onClick={handleClick}
        disabled={disabled}
        aria-label={label}
        title={label}
        sx={(theme) => ({
          ...actionButtonSx(theme, tone),
          cursor: disabled ? 'not-allowed' : 'pointer',
        })}
      >
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

function rowActionToneColor(theme: Theme, tone: Tone) {
  if (tone === 'danger') return theme.palette.error.main;
  if (tone === 'warning') return theme.palette.warning.main;
  return theme.palette.text.primary;
}

function OverflowMenuAction({ action, onClose }: { action: ActionElement; onClose: () => void }) {
  const { label, onClick, icon, disabled = false, tone = 'default', opensModal = false } = action.props;

  function handleClick(event: MouseEvent<HTMLLIElement>) {
    event.stopPropagation();
    if (opensModal) {
      event.currentTarget.blur();
    }
    runRowAction({ opensModal, onClick, onClose });
  }

  return (
    <MenuItem
      disabled={disabled}
      onClick={handleClick}
      sx={(theme) => ({
        pl: 0.5,
        ...(tone !== 'default' ? { color: rowActionToneColor(theme, tone) } : {}),
      })}
    >
      <ListItemIcon
        sx={(theme) => ({
          minWidth: 40,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: rowActionToneColor(theme, tone),
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
  void actionCount;
  void layout;
  return 48;
}
