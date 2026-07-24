import UploadFileIcon from '@mui/icons-material/UploadFile';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  Typography,
} from '@mui/material';
import { useEffect, useState } from 'react';

import { PowerAlert } from '../../../components/PowerAlert';
import { STANDARD_DIALOG_ACTIONS_SX } from '../../../components/dialogStyles';

export function KmzUploadDialog({
  open,
  uploading,
  onClose,
  onUpload,
}: {
  open: boolean;
  uploading: boolean;
  onClose: () => void;
  onUpload: (file: File) => void;
}) {
  const [file, setFile] = useState<File | null>(null);

  useEffect(() => {
    if (open) setFile(null);
  }, [open]);

  return (
    <Dialog open={open} onClose={uploading ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>Підвантажити KMZ з картою підрозділів з Дельти</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <DialogContentText>
            Оберіть KMZ-файл, експортований із Дельти. Система перетворить його на шар карти
            підрозділів противника; останній успішно оброблений файл стане актуальною картою.
          </DialogContentText>
          <PowerAlert severity="info" autoHideDuration={null}>
            Обробка виконується у фоновому режимі. Її прогрес і журнал будуть показані на цій
            сторінці.
          </PowerAlert>
          <Stack direction="row" spacing={2} alignItems="center">
            <Button
              component="label"
              variant="outlined"
              startIcon={<UploadFileIcon />}
              disabled={uploading}
            >
              Обрати KMZ-файл
              <input
                hidden
                type="file"
                accept=".kmz,application/vnd.google-earth.kmz"
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  event.target.value = '';
                }}
              />
            </Button>
            <Typography
              variant="body2"
              color={file === null ? 'text.secondary' : 'text.primary'}
              sx={{ overflowWrap: 'anywhere' }}
            >
              {file?.name ?? 'Файл не обрано'}
            </Typography>
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions sx={STANDARD_DIALOG_ACTIONS_SX}>
        <Button onClick={onClose} disabled={uploading}>
          Скасувати
        </Button>
        <Button
          variant="contained"
          onClick={() => {
            if (file === null) return;
            onUpload(file);
            onClose();
          }}
          disabled={uploading || file === null}
        >
          Підвантажити
        </Button>
      </DialogActions>
    </Dialog>
  );
}
