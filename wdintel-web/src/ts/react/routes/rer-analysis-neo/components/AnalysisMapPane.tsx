import { Box } from '@mui/material';
import { createElement, useEffect, useRef } from 'react';

import type { AnalysisMapAttrs } from '../types';

type Props = {
  mapAttrs: AnalysisMapAttrs;
  search: string;
  visible: boolean;
  onDateRangeChange: (range: { startDate: number; endDate: number }) => void;
  onLoadMessages: (messageIds: number[]) => void;
  onUnitClick: (unitName: string | null) => void;
  onExit: () => void;
};

export function AnalysisMapPane({ mapAttrs, search, visible, onDateRangeChange, onLoadMessages, onUnitClick, onExit }: Props) {
  const hostRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const handleDateRangeChange = (event: Event) => {
      onDateRangeChange((event as CustomEvent<{ startDate: number; endDate: number }>).detail);
    };
    const handleLoadMessages = (event: Event) => {
      onLoadMessages((event as CustomEvent<{ messageIds: number[] }>).detail.messageIds ?? []);
    };
    const handleUnitClick = (event: Event) => {
      onUnitClick((event as CustomEvent<{ networkUnitName: string | null }>).detail.networkUnitName ?? null);
    };
    const handleExit = () => {
      onExit();
    };

    host.addEventListener('date-range-changed', handleDateRangeChange as EventListener);
    host.addEventListener('load-messages-description', handleLoadMessages as EventListener);
    host.addEventListener('message-unit-clicked', handleUnitClick as EventListener);
    host.addEventListener('exit', handleExit as EventListener);

    return () => {
      host.removeEventListener('date-range-changed', handleDateRangeChange as EventListener);
      host.removeEventListener('load-messages-description', handleLoadMessages as EventListener);
      host.removeEventListener('message-unit-clicked', handleUnitClick as EventListener);
      host.removeEventListener('exit', handleExit as EventListener);
    };
  }, [onDateRangeChange, onExit, onLoadMessages, onUnitClick]);

  return (
    <Box
      component="section"
      aria-label="Мапа аналізу"
      sx={{ flex: 1, minHeight: 0, display: 'flex', height: '100%' }}
    >
      {createElement('analysis-map', {
        ref: hostRef,
        class: 'block h-full',
        style: { display: 'block', width: '100%', height: '100%' },
        'data-testid': 'rer-analysis-neo-map',
        role: 'img',
        'aria-label': 'Інтерактивна мапа аналізу',
        daterange: mapAttrs.daterange,
        'daterange-loading': mapAttrs.daterangeLoading,
        points: mapAttrs.points,
        messages: mapAttrs.messages,
        'selected-units': mapAttrs.selectedUnits,
        palitras: mapAttrs.palitras,
        'palitras-loaded': mapAttrs.palitrasLoaded,
        'palitras-load-state': mapAttrs.palitrasLoadState,
        visibility: visible ? 'true' : 'false',
        search,
      })}
    </Box>
  );
}
