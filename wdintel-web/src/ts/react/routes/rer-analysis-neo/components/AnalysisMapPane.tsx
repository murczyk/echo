import { Box } from '@mui/material';
import { createElement, useEffect, useRef, useState } from 'react';

import type { AnalysisMapAttrs } from '../types';

type Props = {
  mapAttrs: AnalysisMapAttrs;
  search: string;
  visible: boolean;
  onDateRangeChange: (range: { startDate: number; endDate: number }) => void;
  onLoadMessages: (messageIds: number[]) => Promise<boolean>;
  onUnitClick: (unitName: string | null) => void;
};

export function AnalysisMapPane({ mapAttrs, search, visible, onDateRangeChange, onLoadMessages, onUnitClick }: Props) {
  const hostRef = useRef<HTMLElement | null>(null);
  const [renderedVisible, setRenderedVisible] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const messagesLoadRequestRef = useRef(0);
  const [messagesLoadSerial, setMessagesLoadSerial] = useState(0);

  useEffect(() => {
    return () => {
      messagesLoadRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!visible) {
      setRenderedVisible(false);
      setMessagesLoading(false);
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      setRenderedVisible(true);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [visible]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const handleDateRangeChange = (event: Event) => {
      onDateRangeChange((event as CustomEvent<{ startDate: number; endDate: number }>).detail);
    };
    const handleLoadMessages = (event: Event) => {
      const messageIds = (event as CustomEvent<{ messageIds: Array<number | null | undefined> }>).detail.messageIds ?? [];
      const requestId = messagesLoadRequestRef.current + 1;
      messagesLoadRequestRef.current = requestId;
      setMessagesLoading(true);
      void Promise.resolve(onLoadMessages(messageIds.filter((messageId): messageId is number => Number.isInteger(messageId))))
        .then((loaded) => {
          if (messagesLoadRequestRef.current !== requestId) {
            return;
          }
          if (loaded) {
            setMessagesLoadSerial((current) => current + 1);
          }
        })
        .finally(() => {
          if (messagesLoadRequestRef.current === requestId) {
            setMessagesLoading(false);
          }
        });
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
      sx={{ flex: 1, minHeight: 0, display: 'flex', height: '100%', position: 'relative' }}
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
        'messages-loading': messagesLoading ? 'true' : 'false',
        'messages-load-serial': String(messagesLoadSerial),
        'overlay-controls-collapsed': visible ? 'true' : 'false',
        visibility: renderedVisible ? 'true' : 'false',
        search,
      })}
    </Box>
  );
}
