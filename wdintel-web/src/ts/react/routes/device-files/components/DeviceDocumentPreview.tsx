import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Dialog, DialogContent, DialogTitle, Typography } from '@mui/material';
import type { AiAgentFileCitation, DeviceDocumentReadRsp } from '../../../../../Bindings';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerButton } from '../../../components/PowerButton';
import { usePowerSnackbar } from '../../../components/PowerSnackbar';
import type { FilePreviewLifecycleProps } from '../../shared/message-card/attachment-preview/file-preview-source';
import { isAbortError } from '../../../services/api/client';
import { deviceDocumentRequest, readDeviceDocument } from '../../../services/api/device-documents';
import {
  resolveMediaSummaryCoordinatePoint,
  type CoordinatePreviewPoint,
} from '../../shared/message-card/message-coordinate-preview';

const CoordinatePreviewMapSurface = lazy(async () => ({
  default: (await import('../../shared/message-card/CoordinatePreviewMapSurface'))
    .CoordinatePreviewMapSurface,
}));

export function DeviceDocumentPreview({
  source,
  lifecycle,
}: {
  source: AiAgentFileCitation;
  lifecycle?: FilePreviewLifecycleProps;
}) {
  const [result, setResult] = useState<DeviceDocumentReadRsp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const { notify } = usePowerSnackbar();
  const key = JSON.stringify(source);
  const signal = lifecycle?.signal;
  const onError = lifecycle?.onError;
  const isCurrent = lifecycle?.isCurrent;
  const load = useCallback(
    async (after: number | null = null, extractionRevision: string | null = null) => {
      pending.current?.abort();
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal?.aborted || isCurrent?.() === false) return;
      signal?.addEventListener('abort', abort, { once: true });
      pending.current = controller;
      setLoading(true);
      setError(null);
      try {
        const response = await readDeviceDocument(
          {
            ...deviceDocumentRequest(source),
            ...(after == null ? {} : { after, extractionRevision }),
          },
          controller.signal,
        );
        if (controller.signal.aborted || isCurrent?.() === false) return;
        setResult((previous) =>
          after == null
            ? response
            : {
                ...response,
                sections: [...(previous?.sections ?? []), ...response.sections],
                positions: [...(previous?.positions ?? []), ...response.positions],
                coordinates: [...(previous?.coordinates ?? []), ...response.coordinates],
              },
        );
      } catch (failure) {
        if (controller.signal.aborted || isAbortError(failure) || isCurrent?.() === false) return;
        onError?.(failure);
        const message = 'Не вдалося прочитати файл. Перевірте доступ або повторіть спробу.';
        setResult(null);
        setError(message);
        notify({ severity: 'error', message });
      } finally {
        signal?.removeEventListener('abort', abort);
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [key, notify, signal, onError, isCurrent],
  );
  useEffect(() => {
    setResult(null);
    void load();
    return () => pending.current?.abort();
  }, [load]);
  const points: CoordinatePreviewPoint[] = result
    ? [
        ...result.coordinates.flatMap((coordinate) => {
          const point = resolveMediaSummaryCoordinatePoint(coordinate);
          return point ? [point] : [];
        }),
        ...result.positions.flatMap((position) =>
          position.coordinates.map((coordinate): CoordinatePreviewPoint => ({
            source: 'position',
            lat: coordinate.lat,
            lng: coordinate.lng,
            label: position.name,
          })),
        ),
      ]
    : [];
  return (
    <div className="flex flex-col gap-echo-md p-echo-lg">
      {error && <PowerAlert severity="error">{error}</PowerAlert>}
      {result && (
        <>
          <p>
            {result.document.hasContent
              ? `${documentState(result.document.state)} · ${result.document.complete ? 'Повний вміст' : 'Неповний вміст'}`
              : 'Вміст файлу ще не завантажено в Echo.'}
          </p>
          <p>
            Підсумок: {documentState(result.document.summaryState)} · Позиції:{' '}
            {documentState(result.document.positionState)}
          </p>
          {result.document.summary && (
            <p className="whitespace-pre-wrap">{result.document.summary}</p>
          )}
          {result.warnings.map((warning, index) => (
            <PowerAlert key={index} severity="warning">
              {warning}
            </PowerAlert>
          ))}
          {result.positions.length > 0 && (
            <section aria-label="Позиції">
              <Typography component="h4" variant="subtitle2">
                Позиції
              </Typography>
              <ul>
                {result.positions.map((position, index) => (
                  <li key={index}>
                    {position.name} ({position.kind}):{' '}
                    {position.coordinates
                      .map((coordinate) => `${coordinate.mgrs} — ${coordinate.certainty}`)
                      .join('; ') || 'Координати невідомі'}
                  </li>
                ))}
              </ul>
              <p className="text-echo-sm text-echo-text-muted">
                Дата файлу не є датою спостереження.
              </p>
            </section>
          )}
          {result.coordinates.length > 0 && (
            <section aria-label="Координати">
              <Typography component="h4" variant="subtitle2">
                Координати
              </Typography>
              <ul>
                {result.coordinates.map((coordinate, index) => (
                  <li key={index}>
                    {coordinate.value} — {coordinate.title}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {points.length > 0 && (
            <Suspense fallback={<p>Завантаження мапи…</p>}>
              <CoordinatePreviewMapSurface
                points={points}
                mode="thumbnail"
                className="h-64 w-full"
              />
            </Suspense>
          )}
          {result.sections.map((section) => (
            <section key={section.id} id={`file-section-${section.ordinal}`}>
              <Typography component="h4" variant="subtitle2">
                {section.member} — {section.locator}
              </Typography>
              <div className="overflow-x-auto break-words text-echo-sm">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{ img: () => null, a: ({ children }) => <span>{children}</span> }}
                >
                  {section.markdown}
                </ReactMarkdown>
              </div>
            </section>
          ))}
          {result.nextAfter != null && (
            <PowerButton
              disabled={loading}
              onClick={() => void load(result.nextAfter, result.document.extractionRevision)}
            >
              Наступні розділи
            </PowerButton>
          )}
        </>
      )}
    </div>
  );
}
export function DeviceDocumentDialog({
  source,
  onClose,
}: {
  source: AiAgentFileCitation;
  onClose: () => void;
}) {
  return (
    <Dialog open fullWidth maxWidth="lg" onClose={onClose}>
      <DialogTitle>Файл пристрою</DialogTitle>
      <DialogContent>
        <PowerButton onClick={onClose}>Закрити</PowerButton>
        <DeviceDocumentPreview source={source} />
      </DialogContent>
    </Dialog>
  );
}
export function DeviceDocumentDeepLink({ deviceId }: { deviceId: string }) {
  const [open, setOpen] = useState(true);
  const query = new URLSearchParams(window.location.search);
  const fileId = query.get('file');
  const revision = Number(query.get('revision'));
  const sectionValue = query.get('section');
  const section = sectionValue == null ? null : Number(sectionValue);
  if (
    !open ||
    !fileId ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    (section != null && (!Number.isInteger(section) || section < 0))
  )
    return null;
  return (
    <DeviceDocumentDialog
      source={{ deviceId, fileId, revision, extractionRevision: query.get('extraction'), section }}
      onClose={() => setOpen(false)}
    />
  );
}

function documentState(state: string): string {
  return (
    (
      {
        completed: 'Готово',
        queued: 'У черзі',
        pending: 'Очікує обробки',
        running: 'Обробляється',
        retry_wait: 'Очікує повторної спроби',
        failed: 'Помилка обробки',
        skipped: 'Пропущено',
        unsupported: 'Формат не підтримується',
        content_unavailable: 'Вміст недоступний',
      } as Record<string, string>
    )[state] ?? 'Очікує обробки'
  );
}

export function DeviceDocumentDetails({
  source,
  lifecycle,
}: {
  source: AiAgentFileCitation;
  lifecycle?: FilePreviewLifecycleProps;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details className="p-echo-md" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer">Підсумок, текст і позиції</summary>
      {open && <DeviceDocumentPreview source={source} lifecycle={lifecycle} />}
    </details>
  );
}
