import { Box } from '@mui/material';
import { createElement, useEffect, useRef, useState } from 'react';

import type { AnalysisMapAttrs } from '../types';

type Props = {
  mapAttrs: AnalysisMapAttrs;
  search: string;
  visible: boolean;
  onDateRangeChange: (range: { startDate: number; endDate: number }) => void;
  onLoadMessages: (messageIds: number[]) => Promise<boolean>;
  onLoadSettlementMessages: (settlementId: number) => Promise<boolean>;
  onUnitClick: (unitName: string | null) => void;
  onShowSettlementsChange?: (show: boolean) => Promise<void>;
};

export const ANALYSIS_NARROW_MAP_HEIGHT = 'clamp(360px, 55svh, 520px)';

export function AnalysisMapPane({
  mapAttrs,
  search,
  visible,
  onDateRangeChange,
  onLoadMessages,
  onLoadSettlementMessages,
  onUnitClick,
  onShowSettlementsChange = async () => undefined,
}: Props) {
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
    if (!visible) return;
    const frameId = window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [visible]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const handleDateRangeChange = (event: Event) => {
      onDateRangeChange((event as CustomEvent<{ startDate: number; endDate: number }>).detail);
    };
    const loadMessages = (request: Promise<boolean>) => {
      const requestId = messagesLoadRequestRef.current + 1;
      messagesLoadRequestRef.current = requestId;
      setMessagesLoading(true);
      void request
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
    const handleLoadMessages = (event: Event) => {
      const messageIds =
        (event as CustomEvent<{ messageIds: Array<number | null | undefined> }>).detail
          .messageIds ?? [];
      loadMessages(
        onLoadMessages(
          messageIds.filter((messageId): messageId is number => Number.isInteger(messageId)),
        ),
      );
    };
    const handleLoadSettlementMessages = (event: Event) => {
      const settlementId = (event as CustomEvent<{ settlementId: number }>).detail?.settlementId;
      if (typeof settlementId !== 'number' || !Number.isSafeInteger(settlementId)) return;
      loadMessages(onLoadSettlementMessages(settlementId));
    };
    const handleUnitClick = (event: Event) => {
      onUnitClick(
        (event as CustomEvent<{ networkUnitName: string | null }>).detail.networkUnitName ?? null,
      );
    };
    const handleShowSettlementsChange = (event: Event) => {
      const show = (event as CustomEvent<{ show: boolean }>).detail?.show === true;
      void onShowSettlementsChange(show);
    };

    host.addEventListener('date-range-changed', handleDateRangeChange as EventListener);
    host.addEventListener('load-messages-description', handleLoadMessages as EventListener);
    host.addEventListener(
      'load-settlement-messages',
      handleLoadSettlementMessages as EventListener,
    );
    host.addEventListener('message-unit-clicked', handleUnitClick as EventListener);
    host.addEventListener('show-settlements-change', handleShowSettlementsChange as EventListener);

    return () => {
      host.removeEventListener('date-range-changed', handleDateRangeChange as EventListener);
      host.removeEventListener('load-messages-description', handleLoadMessages as EventListener);
      host.removeEventListener(
        'load-settlement-messages',
        handleLoadSettlementMessages as EventListener,
      );
      host.removeEventListener('message-unit-clicked', handleUnitClick as EventListener);
      host.removeEventListener(
        'show-settlements-change',
        handleShowSettlementsChange as EventListener,
      );
    };
  }, [
    onDateRangeChange,
    onLoadMessages,
    onLoadSettlementMessages,
    onShowSettlementsChange,
    onUnitClick,
  ]);

  return (
    <Box
      component="section"
      aria-label="Мапа аналізу"
      sx={{
        flex: 1,
        minHeight: 0,
        height: '100%',
        display: 'flex',
        position: 'relative',
      }}
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
        settlements: mapAttrs.settlements,
        'can-show-settlements': mapAttrs.canShowSettlements,
        'show-settlements': mapAttrs.showSettlements,
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
