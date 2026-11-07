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
      className="max-h-[30vh] min-h-12 shrink overflow-y-auto overscroll-contain"
    >
      <Typography variant="body2" className="whitespace-pre-wrap break-words">
        {text}
      </Typography>
    </section>
  );
}

function OriginalReportMessage({ source, text }: { source: ReactNode; text: string }) {
  if (!source && !text) return null;
  return (
    <div className="flex flex-col gap-echo-sm border-b border-echo-border pb-echo-sm">
      {source}
      {text ? <OriginalReportText text={text} /> : null}
    </div>
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
    // The fade is visual only: cards under it stay clickable, so starting another report still works.
    <div
      data-manage-message-minimal-scrim
      className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center bg-echo-surface/70 p-echo-sm"
    >
      <aside
        ref={surfaceRef}
        aria-labelledby={titleId}
        data-manage-message-presentation="minimal"
        className="pointer-events-auto flex max-h-full min-h-0 w-full flex-col overflow-hidden rounded-echo-md border-1 border-solid border-echo-border bg-echo-surface shadow-echo-lg"
      >
        <div
          ref={rootRef}
          tabIndex={-1}
          className="flex min-h-0 flex-col gap-echo-sm overflow-y-auto overscroll-contain p-echo-sm"
        >
          {formVisible ? <OriginalReportMessage source={source} text={originalText} /> : null}
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
      </aside>
    </div>,
    host,
  );
}
