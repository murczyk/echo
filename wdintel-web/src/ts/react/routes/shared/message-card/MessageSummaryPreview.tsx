import { Paper, Popper } from '@mui/material';
import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEventHandler,
  type MouseEventHandler,
  type PointerEventHandler,
  type ReactElement,
} from 'react';

import type { IntelligenceReportSummary } from '../intelligence-reports';

const PREVIEW_OPEN_DELAY_MS = 700;
const PREVIEW_CLOSE_DELAY_MS = 100;

type PreviewTriggerProps = {
  'aria-describedby'?: string;
  onBlur?: FocusEventHandler<HTMLElement>;
  onFocus?: FocusEventHandler<HTMLElement>;
  onMouseEnter?: MouseEventHandler<HTMLElement>;
  onMouseLeave?: MouseEventHandler<HTMLElement>;
  onMouseMove?: MouseEventHandler<HTMLElement>;
  onPointerDown?: PointerEventHandler<HTMLElement>;
  onTouchStart?: React.TouchEventHandler<HTMLElement>;
};

function canHover(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return true;
  }
  if (window.matchMedia('(hover: none)').matches) {
    return false;
  }
  return true;
}

type MessageSummaryPreviewProps = {
  summary: IntelligenceReportSummary;
  label: string;
  groupName: string | null;
  time: string | null;
  onBeforeOpen?: () => Promise<boolean | void>;
  children: ReactElement<PreviewTriggerProps>;
};

function MessageSummaryPreviewContent({
  summary,
  label,
  groupName,
  time,
}: Omit<MessageSummaryPreviewProps, 'children'>) {
  return (
    <Paper
      elevation={8}
      role="tooltip"
      data-testid={`message-summary-preview-${summary.id}`}
      sx={{
        width: 420,
        maxWidth: 'calc(100vw - 24px)',
        overflow: 'hidden',
        border: '1px solid',
        borderColor: 'divider',
      }}
    >
      <header className="border-b border-solid border-(--color-divider) px-3 py-2">
        <strong className="text-sm">{label}</strong>
      </header>
      <div className="max-h-60 overflow-y-auto whitespace-pre-wrap wrap-break-word px-3 py-2.5 text-sm leading-5">
        {summary.text.trim() || `Повідомлення #${summary.id}`}
      </div>
      <dl className="m-0 grid gap-1 border-t border-solid border-(--color-divider) px-3 py-2 text-xs">
        <div className="grid grid-cols-[76px_minmax(0,1fr)] gap-2">
          <dt className="text-(--color-action)">Група</dt>
          <dd className="m-0 wrap-break-word font-semibold">{groupName ?? 'Без групи'}</dd>
        </div>
        <div className="grid grid-cols-[76px_minmax(0,1fr)] gap-2">
          <dt className="text-(--color-action)">Дата і час</dt>
          <dd className="m-0 font-semibold">{time ?? 'Не вказано'}</dd>
        </div>
        <div className="grid grid-cols-[76px_minmax(0,1fr)] gap-2">
          <dt className="text-(--color-action)">Вкладення</dt>
          <dd className="m-0 font-semibold">{summary.attachmentsCount}</dd>
        </div>
      </dl>
    </Paper>
  );
}

export function MessageSummaryPreview({
  summary,
  label,
  groupName,
  time,
  onBeforeOpen,
  children,
}: MessageSummaryPreviewProps) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const openTimeoutRef = useRef<number | null>(null);
  const closeTimeoutRef = useRef<number | null>(null);
  const triggerHoveredRef = useRef(false);
  const previewHoveredRef = useRef(false);
  const triggerFocusedRef = useRef(false);
  const interactionDismissedRef = useRef(false);
  const isTouchInteractionRef = useRef(false);
  const previewElementRef = useRef<HTMLDivElement | null>(null);
  const previewId = useId().replace(/:/g, '-');

  const cancelOpen = useCallback(() => {
    if (openTimeoutRef.current !== null) {
      window.clearTimeout(openTimeoutRef.current);
      openTimeoutRef.current = null;
    }
  }, []);

  const cancelClose = useCallback(() => {
    if (closeTimeoutRef.current !== null) {
      window.clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
  }, []);

  const closeIfInactive = useCallback(() => {
    cancelClose();
    closeTimeoutRef.current = window.setTimeout(() => {
      if (!triggerHoveredRef.current && !previewHoveredRef.current && !triggerFocusedRef.current) {
        cancelOpen();
        setAnchorEl(null);
      }
    }, PREVIEW_CLOSE_DELAY_MS);
  }, [cancelClose, cancelOpen]);

  const dismissPreview = useCallback(() => {
    cancelOpen();
    interactionDismissedRef.current = true;
    previewHoveredRef.current = false;
    setAnchorEl(null);
  }, [cancelOpen]);

  useEffect(
    () => () => {
      cancelOpen();
      cancelClose();
    },
    [cancelClose, cancelOpen],
  );

  useEffect(() => {
    if (anchorEl === null) return;

    const closeOnOutsideScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && previewElementRef.current?.contains(target)) return;
      dismissPreview();
    };

    document.addEventListener('keydown', dismissPreview);
    window.addEventListener('pointerdown', dismissPreview, true);
    window.addEventListener('scroll', closeOnOutsideScroll, true);
    window.addEventListener('wheel', closeOnOutsideScroll, { capture: true, passive: true });
    window.addEventListener('touchmove', closeOnOutsideScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener('keydown', dismissPreview);
      window.removeEventListener('pointerdown', dismissPreview, true);
      window.removeEventListener('scroll', closeOnOutsideScroll, true);
      window.removeEventListener('wheel', closeOnOutsideScroll, true);
      window.removeEventListener('touchmove', closeOnOutsideScroll, true);
    };
  }, [anchorEl, dismissPreview]);

  if (!summary.isAccessible || summary.isDeleted) return children;

  const openPreview = (target: HTMLElement) => {
    const finishOpen = () => {
      if (
        interactionDismissedRef.current ||
        (!triggerHoveredRef.current && !triggerFocusedRef.current)
      ) {
        return;
      }
      setAnchorEl(target);
    };
    if (!onBeforeOpen) {
      finishOpen();
      return;
    }
    void onBeforeOpen().then((shouldOpen) => {
      if (shouldOpen !== false) finishOpen();
    });
  };

  const childProps = children.props;
  const open = anchorEl !== null;
  const trigger = cloneElement(children, {
    'aria-describedby': open ? previewId : childProps['aria-describedby'],
    onMouseEnter: (event) => {
      childProps.onMouseEnter?.(event);
      if (isTouchInteractionRef.current || !canHover()) return;
      interactionDismissedRef.current = false;
      triggerHoveredRef.current = true;
      cancelClose();
      cancelOpen();
      const currentTarget = event.currentTarget;
      openTimeoutRef.current = window.setTimeout(
        () => openPreview(currentTarget),
        PREVIEW_OPEN_DELAY_MS,
      );
    },
    onMouseMove: (event) => {
      childProps.onMouseMove?.(event);
      if (isTouchInteractionRef.current) {
        isTouchInteractionRef.current = false;
      }
    },
    onMouseLeave: (event) => {
      childProps.onMouseLeave?.(event);
      triggerHoveredRef.current = false;
      closeIfInactive();
    },
    onPointerDown: (event) => {
      childProps.onPointerDown?.(event);
      if (event.pointerType === 'touch') {
        isTouchInteractionRef.current = true;
      }
      dismissPreview();
    },
    onTouchStart: (event) => {
      childProps.onTouchStart?.(event);
      isTouchInteractionRef.current = true;
      dismissPreview();
    },
    onFocus: (event) => {
      childProps.onFocus?.(event);
      if (isTouchInteractionRef.current || !canHover()) return;
      let isFocusVisible = true;
      try {
        if (typeof event.currentTarget.matches === 'function') {
          isFocusVisible = event.currentTarget.matches(':focus-visible');
        }
      } catch {
        isFocusVisible = true;
      }
      if (!isFocusVisible) return;
      triggerFocusedRef.current = true;
      cancelClose();
      cancelOpen();
      if (interactionDismissedRef.current) return;
      openPreview(event.currentTarget);
    },
    onBlur: (event) => {
      childProps.onBlur?.(event);
      triggerFocusedRef.current = false;
      closeIfInactive();
    },
  });

  return (
    <>
      {trigger}
      {open ? (
        <Popper
          id={previewId}
          open
          anchorEl={anchorEl}
          placement="top-start"
          modifiers={[
            { name: 'offset', options: { offset: [0, 8] } },
            {
              name: 'flip',
              options: { fallbackPlacements: ['bottom-start', 'top-end', 'bottom-end'] },
            },
            { name: 'preventOverflow', options: { boundary: 'viewport', padding: 8 } },
          ]}
          sx={{ zIndex: (theme) => theme.zIndex.tooltip }}
        >
          <div
            ref={previewElementRef}
            onMouseEnter={() => {
              previewHoveredRef.current = true;
              cancelClose();
            }}
            onMouseLeave={() => {
              previewHoveredRef.current = false;
              closeIfInactive();
            }}
          >
            <MessageSummaryPreviewContent
              summary={summary}
              label={label}
              groupName={groupName}
              time={time}
            />
          </div>
        </Popper>
      ) : null}
    </>
  );
}
