import MoreVertIcon from '@mui/icons-material/MoreVert';
import { CircularProgress, IconButton, Menu, MenuItem, Tooltip } from '@mui/material';
import { useState, type MouseEvent } from 'react';

import type { OcrMediaSummary } from '../../../../../../Bindings';
import { useOptionalPowerSnackbar } from '../../../../components/PowerSnackbar';
import { reprocessMediaOcr } from '../../../../services/api/ocr';
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
  const { notify } = useOptionalPowerSnackbar();
  const id = mediaId?.trim() ?? '';

  if (!supported || id === '' || !currentUserIsAdmin()) return null;

  const reprocess = async () => {
    setAnchorEl(null);
    setReprocessing(true);
    try {
      const nextOcr = await reprocessMediaOcr(id);
      onQueued(nextOcr);
      notify({
        severity: 'success',
        message: 'Медіа додано до черги повторної обробки.',
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
          onClick={(event: MouseEvent<HTMLButtonElement>) => setAnchorEl(event.currentTarget)}
          sx={{
            color: 'text.secondary',
            '&:hover': { color: 'text.primary', backgroundColor: 'action.hover' },
          }}
        >
          {reprocessing ? <CircularProgress size={16} color="inherit" /> : <MoreVertIcon />}
        </IconButton>
      </Tooltip>
      <Menu anchorEl={anchorEl} open={anchorEl !== null} onClose={() => setAnchorEl(null)}>
        <MenuItem disabled={disabled} onClick={reprocess}>
          Обробити повторно
        </MenuItem>
      </Menu>
    </>
  );
}
