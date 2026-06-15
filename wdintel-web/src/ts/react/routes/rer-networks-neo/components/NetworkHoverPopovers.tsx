import { Box, Paper, Popper, Stack } from '@mui/material';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { NetworkRowView } from '../helpers';
import { buildNetworkFrequencyPopupGroups } from '../helpers';
import { CompactPowerChip } from '../../../components/CompactPowerChip';
import { buildFrequencyMetadataLabels, getLocationParts } from './NetworkCells';

export const FREQUENCY_HOVER_POPPER_PLACEMENT = 'top-start';
export const FREQUENCY_HOVER_POPPER_MODIFIERS: Array<{ name: string; options?: Record<string, unknown> }> = [
  { name: 'offset', options: { offset: [0, 8] } },
  { name: 'flip', options: { fallbackPlacements: ['bottom-start', 'top-end', 'bottom-end'] } },
  { name: 'preventOverflow', options: { boundary: 'viewport', padding: 8 } },
];

export type HoverPopoverState =
  | {
      kind: 'freq' | 'location';
      anchorEl: HTMLElement;
      row: NetworkRowView;
    }
  | null;

type HoverDetailsMenuProps = {
  anchorEl: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  minWidth?: number;
  placement?: 'bottom-start' | 'top-start' | 'bottom-end' | 'top-end';
  modifiers?: Array<{ name: string; options?: Record<string, unknown> }>;
  paperSx?: Record<string, unknown>;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
};

function HoverDetailsMenu({
  anchorEl,
  open,
  onClose,
  children,
  minWidth = 320,
  placement = 'bottom-start',
  modifiers,
  paperSx,
  onPointerEnter,
  onPointerLeave,
}: HoverDetailsMenuProps) {
  return (
    <Popper
      open={open}
      anchorEl={anchorEl}
      placement={placement}
      modifiers={modifiers ?? [{ name: 'offset', options: { offset: [0, 8] } }]}
      sx={{ zIndex: (theme) => theme.zIndex.modal + 1 }}
    >
      <Paper
        data-network-hover-popper="true"
        tabIndex={-1}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave ?? onClose}
        sx={{
          minWidth,
          p: 0,
          boxShadow: 8,
          maxWidth: 320,
          maxHeight: 'min(420px, calc(100vh - 32px))',
          overflowX: 'hidden',
          overflowY: 'auto',
          ...paperSx,
        }}
      >
        <Box sx={{ p: 1.5, maxWidth: '100%' }}>{children}</Box>
      </Paper>
    </Popper>
  );
}

function FrequencyGroupDetails({ group }: { group: ReturnType<typeof buildNetworkFrequencyPopupGroups>[number] }) {
  if (group.frequencies.length === 0) {
    return null;
  }

  return (
    <Stack spacing={0.75}>
      <Box sx={{ fontSize: 12, fontWeight: 700, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 0.6 }}>
        {group.title} ({group.frequencies.length})
      </Box>
      <Stack spacing={0.75}>
        {group.frequencies.map((freq) => (
          <Stack key={freq.id} direction="row" spacing={1} alignItems="center" useFlexGap sx={{ minWidth: 0, flexWrap: 'nowrap' }}>
            <Box
              title={freq.freq}
              sx={{
                fontWeight: 700,
                color: group.isInactive ? 'text.secondary' : 'text.primary',
                minWidth: 0,
                flexShrink: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {freq.freq}
            </Box>
            <Box sx={{ ml: 'auto', minWidth: 0, maxWidth: '100%', overflow: 'hidden' }}>
              <Stack
                direction="row"
                spacing={0.5}
                useFlexGap
                sx={{
                  flexWrap: 'nowrap',
                  minWidth: 0,
                  maxWidth: '100%',
                  overflow: 'hidden',
                  justifyContent: 'flex-end',
                }}
              >
                {buildFrequencyMetadataLabels(freq).map((label) => (
                  <CompactPowerChip
                    key={label}
                    label={label}
                    interactive={false}
                    title={label}
                    sx={{
                      maxWidth: '100%',
                      minWidth: 0,
                      '& .MuiChip-label': {
                        maxWidth: '100%',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      },
                    }}
                  />
                ))}
              </Stack>
            </Box>
          </Stack>
        ))}
      </Stack>
    </Stack>
  );
}

type Props = {
  hoverPopover: HoverPopoverState;
  onClose: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
};

export function NetworkHoverPopovers({ hoverPopover, onClose, onPointerEnter, onPointerLeave }: Props) {
  if (hoverPopover?.kind === 'freq') {
    return (
      <HoverDetailsMenu
        anchorEl={hoverPopover.anchorEl}
        open
        onClose={onClose}
        minWidth={220}
        placement={FREQUENCY_HOVER_POPPER_PLACEMENT}
        modifiers={FREQUENCY_HOVER_POPPER_MODIFIERS}
        paperSx={{
          maxWidth: 320,
          maxHeight: 'min(420px, calc(100vh - 32px))',
          overflowX: 'hidden',
          overflowY: 'auto',
        }}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
      >
        <Stack spacing={1.25}>
          {buildNetworkFrequencyPopupGroups(hoverPopover.row).map((group) => (
            <FrequencyGroupDetails key={group.title} group={group} />
          ))}
        </Stack>
      </HoverDetailsMenu>
    );
  }

  if (hoverPopover?.kind === 'location') {
    return (
      <HoverDetailsMenu
        anchorEl={hoverPopover.anchorEl}
        open
        onClose={onClose}
        minWidth={260}
        placement={FREQUENCY_HOVER_POPPER_PLACEMENT}
        modifiers={FREQUENCY_HOVER_POPPER_MODIFIERS}
        paperSx={{
          maxWidth: 320,
          maxHeight: 'min(420px, calc(100vh - 32px))',
          overflowX: 'hidden',
          overflowY: 'auto',
        }}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
      >
        <Stack spacing={0.75}>
          {getLocationParts(hoverPopover.row.network.location).map((item) => (
            <Box key={item} title={item} sx={{ lineHeight: 1.25 }}>
              {item}
            </Box>
          ))}
        </Stack>
      </HoverDetailsMenu>
    );
  }

  return null;
}

export function useHoverPopoverState() {
  const [hoverPopover, setHoverPopover] = useState<HoverPopoverState>(null);
  const hoverPopoverCloseTimeoutRef = useRef<number | null>(null);
  const hoverAnchorInsideRef = useRef(false);
  const hoverPopperInsideRef = useRef(false);

  const cancelHoverPopoverClose = useCallback(() => {
    if (hoverPopoverCloseTimeoutRef.current !== null) {
      window.clearTimeout(hoverPopoverCloseTimeoutRef.current);
      hoverPopoverCloseTimeoutRef.current = null;
    }
  }, []);

  const closeIfOutsideHoverZone = useCallback(() => {
    if (hoverAnchorInsideRef.current || hoverPopperInsideRef.current) {
      return;
    }
    setHoverPopover(null);
  }, []);

  const scheduleCloseHoverPopover = useCallback(() => {
    cancelHoverPopoverClose();
    hoverPopoverCloseTimeoutRef.current = window.setTimeout(() => {
      closeIfOutsideHoverZone();
      hoverPopoverCloseTimeoutRef.current = null;
    }, 80);
  }, [cancelHoverPopoverClose, closeIfOutsideHoverZone]);

  const openFreqPopover = useCallback(
    (anchorEl: HTMLElement, row: NetworkRowView) => {
      cancelHoverPopoverClose();
      hoverAnchorInsideRef.current = true;
      setHoverPopover({ kind: 'freq', anchorEl, row });
    },
    [cancelHoverPopoverClose],
  );

  const openLocationPopover = useCallback(
    (anchorEl: HTMLElement, row: NetworkRowView) => {
      cancelHoverPopoverClose();
      hoverAnchorInsideRef.current = true;
      setHoverPopover({ kind: 'location', anchorEl, row });
    },
    [cancelHoverPopoverClose],
  );

  const closeHoverPopover = useCallback(() => {
    cancelHoverPopoverClose();
    hoverAnchorInsideRef.current = false;
    hoverPopperInsideRef.current = false;
    setHoverPopover(null);
  }, [cancelHoverPopoverClose]);

  const onHoverAnchorPointerLeave = useCallback(() => {
    hoverAnchorInsideRef.current = false;
    scheduleCloseHoverPopover();
  }, [scheduleCloseHoverPopover]);

  const onHoverAnchorPointerEnter = useCallback(
    (anchorEl: HTMLElement, row: NetworkRowView) => {
      hoverAnchorInsideRef.current = true;
      openFreqPopover(anchorEl, row);
    },
    [openFreqPopover],
  );

  const onHoverLocationPointerEnter = useCallback(
    (anchorEl: HTMLElement, row: NetworkRowView) => {
      hoverAnchorInsideRef.current = true;
      openLocationPopover(anchorEl, row);
    },
    [openLocationPopover],
  );

  const onHoverPopperPointerEnter = useCallback(() => {
    hoverPopperInsideRef.current = true;
    cancelHoverPopoverClose();
  }, [cancelHoverPopoverClose]);

  const onHoverPopperPointerLeave = useCallback(() => {
    hoverPopperInsideRef.current = false;
    scheduleCloseHoverPopover();
  }, [scheduleCloseHoverPopover]);

  useEffect(() => {
    if (hoverPopover === null) return;

    const closeOnScroll = () => closeHoverPopover();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeHoverPopover();
      }
    };

    window.addEventListener('scroll', closeOnScroll, true);
    window.addEventListener('keydown', closeOnEscape);
    document.addEventListener('scroll', closeOnScroll, true);

    return () => {
      window.removeEventListener('scroll', closeOnScroll, true);
      window.removeEventListener('keydown', closeOnEscape);
      document.removeEventListener('scroll', closeOnScroll, true);
    };
  }, [closeHoverPopover, hoverPopover]);

  return {
    hoverPopover,
    onHoverAnchorPointerEnter,
    onHoverLocationPointerEnter,
    onHoverAnchorPointerLeave,
    onHoverPopperPointerEnter,
    onHoverPopperPointerLeave,
    closeHoverPopover,
  };
}
