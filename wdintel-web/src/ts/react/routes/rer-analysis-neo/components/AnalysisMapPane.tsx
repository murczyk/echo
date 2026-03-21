import { Box } from '@mui/material';
import React from 'react';

import type { AnalysisMapAttrs } from '../types';

type Props = {
  mapAttrs: AnalysisMapAttrs;
  search: string;
  onDateRangeChange: (range: { startDate: number; endDate: number }) => void;
  onLoadMessages: (messageIds: number[]) => void;
  onUnitClick: (unitName: string | null) => void;
};

export function AnalysisMapPane({ mapAttrs, search, onDateRangeChange, onLoadMessages, onUnitClick }: Props) {
  const hostRef = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
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

    host.addEventListener('date-range-changed', handleDateRangeChange as EventListener);
    host.addEventListener('load-messages-description', handleLoadMessages as EventListener);
    host.addEventListener('message-unit-clicked', handleUnitClick as EventListener);

    return () => {
      host.removeEventListener('date-range-changed', handleDateRangeChange as EventListener);
      host.removeEventListener('load-messages-description', handleLoadMessages as EventListener);
      host.removeEventListener('message-unit-clicked', handleUnitClick as EventListener);
    };
  }, [onDateRangeChange, onLoadMessages, onUnitClick]);

  return (
    <Box
      component="section"
      aria-label="Мапа аналізу"
      sx={{ flex: 1, minHeight: 0 }}
    >
      {React.createElement('analysis-map', {
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
        'palitras-loaded': 'false',
        'palitras-load-state': 'idle',
        visibility: 'true',
        search,
      })}
    </Box>
  );
}
