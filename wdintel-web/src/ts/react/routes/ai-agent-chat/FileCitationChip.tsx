import { useEffect, useState } from 'react';
import type { AiAgentFileCitation } from '../../../../Bindings';
import { EchoChip } from '../../components/EchoChip';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { isAbortError } from '../../services/api/client';
import {
  deviceDocumentRequest,
  fileCitationHref,
  readDeviceDocument,
} from '../../services/api/device-documents';
import { DeviceDocumentDialog } from '../device-files/components/DeviceDocumentPreview';

export function FileCitationChip({ source }: { source: AiAgentFileCitation }) {
  const [name, setName] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [open, setOpen] = useState(false);
  const { notify } = usePowerSnackbar();
  const href = fileCitationHref(source);
  useEffect(() => {
    const controller = new AbortController();
    setName(null);
    setUnavailable(false);
    void readDeviceDocument({ ...deviceDocumentRequest(source), limit: 0 }, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setName(result.document.fileName);
      })
      .catch((error) => {
        if (!controller.signal.aborted && !isAbortError(error)) {
          setUnavailable(true);
          notify({ severity: 'error', message: 'Джерело файлу недоступне' });
        }
      });
    return () => controller.abort();
  }, [href, notify]);
  if (!name) return <EchoChip label={unavailable ? 'Джерело недоступне' : 'Завантаження файлу…'} />;
  return (
    <>
      <a
        className="echo-chip echo-chip--neutral"
        data-interactive="true"
        href={href}
        onClick={(event) => {
          if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        <span className="echo-chip__label">
          {name} · рев. {source.revision}
        </span>
      </a>
      {open && <DeviceDocumentDialog source={source} onClose={() => setOpen(false)} />}
    </>
  );
}
