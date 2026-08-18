import MoreVertIcon from '@mui/icons-material/MoreVert';
import { CircularProgress, IconButton, Menu, MenuItem, Tooltip } from '@mui/material';
import { useState, type MouseEvent } from 'react';

import type { OcrEngineItem, OcrMediaSummary } from '../../../../../../Bindings';
import { useOptionalPowerSnackbar } from '../../../../components/PowerSnackbar';
import { getOcrPage, reprocessMediaOcr } from '../../../../services/api/ocr';
import { hasRole } from '../../../../utils/roles';

function currentUserIsAdmin(): boolean {
  const roles =
    document
      .querySelector('.app-shell')
      ?.getAttribute('data-auth-user-roles')
      ?.split(',')
      .map((role) => role.trim())
      .filter(Boolean) ?? [];
  return hasRole(roles, 'Admin');
}

function isOcrProcessing(ocr: OcrMediaSummary | null | undefined): boolean {
  return ocr != null && ['pending', 'queued', 'submitted', 'retry_wait'].includes(ocr.state);
}

export function isSupportedOcrImage(
  contentType: string | null | undefined,
  fileName: string | null | undefined,
): boolean {
  const mime = contentType?.split(';')[0]?.trim().toLowerCase();
  if (mime != null && ['image/jpeg', 'image/jpg', 'image/png'].includes(mime)) return true;
  return /\.(?:jpe?g|png)$/i.test(fileName?.trim() ?? '');
}

export function MediaReprocessAction({
  mediaId,
  supported,
  ocr,
  onQueued,
}: {
  mediaId?: string | null;
  supported: boolean;
  ocr?: OcrMediaSummary | null;
  onQueued: (ocr: OcrMediaSummary) => void;
}) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [reprocessing, setReprocessing] = useState(false);
  const [engines, setEngines] = useState<OcrEngineItem[] | null>(null);
  const { notify } = useOptionalPowerSnackbar();
  const id = mediaId?.trim() ?? '';

  if (!supported || id === '' || !currentUserIsAdmin()) return null;

  const loadEngines = async () => {
    try {
      const page = await getOcrPage(1);
      setEngines(page.settings.engines);
    } catch (error) {
      setEngines([]);
      notify({
        severity: 'error',
        message: `Не вдалося завантажити OCR-движки: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  };

  const reprocess = async (aiEngineId?: string) => {
    setAnchorEl(null);
    setReprocessing(true);
    try {
      const nextOcr = aiEngineId
        ? await reprocessMediaOcr(id, aiEngineId)
        : await reprocessMediaOcr(id);
      onQueued(nextOcr);
      notify({
        severity: 'success',
        message: `${aiEngineId ? 'Медіа додано до черги через вибраний OCR-движок.' : 'Медіа додано до черги повторної обробки.'}`,
      });
    } catch (error) {
      notify({
        severity: 'error',
        message: `Не вдалося повторно обробити медіа: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    } finally {
      setReprocessing(false);
    }
  };

  const disabled = reprocessing || isOcrProcessing(ocr);

  return (
    <>
      <Tooltip title="Більше дій" enterDelay={300}>
        <IconButton
          aria-label="Більше дій"
          aria-busy={reprocessing}
          size="small"
          onClick={(event: MouseEvent<HTMLButtonElement>) => {
            setAnchorEl(event.currentTarget);
            void loadEngines();
          }}
          sx={{
            color: 'text.secondary',
            '&:hover': { color: 'text.primary', backgroundColor: 'action.hover' },
          }}
        >
          {reprocessing ? <CircularProgress size={16} color="inherit" /> : <MoreVertIcon />}
        </IconButton>
      </Tooltip>
      <Menu anchorEl={anchorEl} open={anchorEl !== null} onClose={() => setAnchorEl(null)}>
        {engines == null && <MenuItem disabled>Завантаження OCR-движків…</MenuItem>}
        {engines != null && engines.length === 0 && (
          <MenuItem disabled={disabled} onClick={() => void reprocess()}>
            Обробити повторно
          </MenuItem>
        )}
        {engines?.map((engine) => (
          <MenuItem key={engine.id} disabled={disabled} onClick={() => void reprocess(engine.id)}>
            Обробити повторно через {engine.name}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
