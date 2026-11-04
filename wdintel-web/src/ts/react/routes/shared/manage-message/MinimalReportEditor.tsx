import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import {
  Button,
  CircularProgress,
  IconButton,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useRef, type FormEventHandler, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Controller, FormProvider, type UseFormReturn } from 'react-hook-form';

import { PowerForm } from '../../../components/PowerForm';
import { useEditorEscapeClose } from './ManageMessageEditorSurface';
import type { MessageFormData } from './manage-message-drawer.schema';
import { useFocusWhenEnabled } from './useFocusWhenEnabled';

const MINIMAL_REPORT_TEXT_MIN_ROWS = 2;
const MINIMAL_REPORT_TEXT_MAX_ROWS = 6;

export type MinimalReportEditorProps = {
  /** Feed column the panel floats over; the panel must never reflow the feed itself. */
  host: HTMLElement;
  rootRef: RefObject<HTMLDivElement>;
  methods: UseFormReturn<MessageFormData>;
  titleId: string;
  title: string;
  submitLabel: string;
  source: ReactNode;
  originalText: string;
  alerts: ReactNode;
  destinationNote: string | null;
  detailsMissing: boolean;
  loading: boolean;
  formVisible: boolean;
  busy: boolean;
  saving: boolean;
  canSubmit: boolean;
  dismissDisabled: boolean;
  interactionActive: boolean;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onRequestClose: () => void;
  onExpand: () => void;
};

function OriginalReportText({ text }: { text: string }) {
  return (
    <section
      aria-label="Текст оригінального повідомлення"
      tabIndex={0}
      className="max-h-[30vh] min-h-0 shrink overflow-y-auto overscroll-contain"
    >
      <Typography variant="body2" className="whitespace-pre-wrap break-words">
        {text}
      </Typography>
    </section>
  );
}

function MinimalReportFooterNote({
  destinationNote,
  detailsMissing,
}: Pick<MinimalReportEditorProps, 'destinationNote' | 'detailsMissing'>) {
  if (detailsMissing) {
    return (
      <Typography role="status" variant="caption" color="warning.main">
        Потрібні додаткові поля: розгорніть панель.
      </Typography>
    );
  }
  return destinationNote ? (
    <Typography variant="caption" color="text.secondary">
      {destinationNote}
    </Typography>
  ) : null;
}

export function MinimalReportEditor({
  host,
  rootRef,
  methods,
  titleId,
  title,
  submitLabel,
  source,
  originalText,
  alerts,
  destinationNote,
  detailsMissing,
  loading,
  formVisible,
  busy,
  saving,
  canSubmit,
  dismissDisabled,
  interactionActive,
  onSubmit,
  onRequestClose,
  onExpand,
}: MinimalReportEditorProps) {
  const surfaceRef = useRef<HTMLElement | null>(null);
  const reportTextRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  useEditorEscapeClose(surfaceRef, !dismissDisabled, onRequestClose);
  useFocusWhenEnabled(reportTextRef, formVisible && !busy);

  return createPortal(
    <aside
      ref={surfaceRef}
      aria-labelledby={titleId}
      data-manage-message-presentation="minimal"
      className="absolute inset-x-echo-sm bottom-echo-sm z-[5] flex max-h-[calc(100%-16px)] min-h-0 flex-col overflow-hidden rounded-echo-md border-1 border-solid border-echo-border bg-echo-surface shadow-echo-lg"
    >
      <div ref={rootRef} tabIndex={-1} className="flex min-h-0 flex-col gap-echo-sm p-echo-sm">
        <div className="flex min-w-0 items-center justify-between gap-echo-sm">
          <Typography id={titleId} component="h2" variant="subtitle2" noWrap>
            {title}
          </Typography>
          <Tooltip title="Розгорнути в повну бічну панель">
            <IconButton
              type="button"
              size="small"
              aria-label="Розгорнути в повну бічну панель"
              disabled={dismissDisabled}
              onClick={onExpand}
            >
              <OpenInFullIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </div>
        {alerts}
        {loading ? (
          <div className="grid place-items-center py-echo-md">
            <CircularProgress size={24} aria-label="Завантаження розвіддонесення" />
          </div>
        ) : null}
        {formVisible ? (
          <FormProvider {...methods}>
            <PowerForm
              id="create-message-form"
              noValidate
              onSubmit={onSubmit}
              canSubmit={canSubmit}
              globalSubmitShortcut={interactionActive}
              className="flex min-h-0 flex-col gap-echo-sm"
            >
              {source}
              {originalText ? <OriginalReportText text={originalText} /> : null}
              <Controller
                name="full_body"
                control={methods.control}
                render={({ field }) => (
                  <TextField
                    {...field}
                    label="Текст розвіддонесення"
                    size="small"
                    fullWidth
                    multiline
                    minRows={MINIMAL_REPORT_TEXT_MIN_ROWS}
                    maxRows={MINIMAL_REPORT_TEXT_MAX_ROWS}
                    required
                    inputRef={reportTextRef}
                    disabled={busy}
                  />
                )}
              />
              <div className="flex flex-wrap items-center justify-end gap-x-echo-sm gap-y-echo-xs">
                <div className="min-w-0 flex-1 basis-40">
                  <MinimalReportFooterNote
                    destinationNote={destinationNote}
                    detailsMissing={detailsMissing}
                  />
                </div>
                <Button size="small" onClick={onRequestClose} disabled={dismissDisabled}>
                  Закрити
                </Button>
                <Button
                  type="submit"
                  size="small"
                  variant="contained"
                  color="primary"
                  disabled={!canSubmit || busy}
                  startIcon={saving ? <CircularProgress size={16} color="inherit" /> : undefined}
                >
                  {saving ? 'Збереження...' : submitLabel}
                </Button>
              </div>
            </PowerForm>
          </FormProvider>
        ) : (
          <div className="flex justify-end">
            <Button size="small" onClick={onRequestClose} disabled={dismissDisabled}>
              Закрити
            </Button>
          </div>
        )}
      </div>
    </aside>,
    host,
  );
}
