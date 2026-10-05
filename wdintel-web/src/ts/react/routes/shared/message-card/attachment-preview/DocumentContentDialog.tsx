import { useCallback, useEffect, useState } from 'react';
import { Button, Dialog, DialogContent, DialogTitle, Stack, Typography } from '@mui/material';
import type { AttachmentReadRsp } from '../../../../../../Bindings';
import { usePowerSnackbar } from '../../../../components/PowerSnackbar';
import { attachmentReadRequest, readAttachment } from '../../../../services/api/attachments';

export function AttachmentDocumentDialog({
  mediaId,
  onClose,
}: {
  mediaId: string;
  onClose: () => void;
}) {
  const [document, setDocument] = useState<AttachmentReadRsp | null>(null);
  const { notify } = usePowerSnackbar();
  const load = useCallback(
    async (after: number | null = null) => {
      try {
        const response = await readAttachment({
          ...attachmentReadRequest(mediaId),
          after,
          revision: after === null ? null : (document?.document.revision ?? null),
        });
        setDocument((previous) =>
          after === null
            ? response
            : { ...response, sections: [...(previous?.sections ?? []), ...response.sections] },
        );
      } catch (error) {
        notify({ severity: 'error', message: `Не вдалося прочитати документ: ${String(error)}` });
      }
    },
    [mediaId, document?.document.revision, notify],
  );
  useEffect(() => {
    void load();
  }, [mediaId]);
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="lg">
      <DialogTitle>{document?.document.fileName ?? 'Документ'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <Button onClick={onClose}>Закрити</Button>
          <Button href={`/api/messenger/media/${encodeURIComponent(mediaId)}`} target="_blank">
            Відкрити оригінал
          </Button>
          {document && (
            <>
              <Typography>
                {document.document.state} ·{' '}
                {document.document.complete ? 'Повний вміст' : 'Неповний вміст'}
              </Typography>
              <Typography>{document.document.summary}</Typography>
              {document.warnings.map((warning, index) => (
                <Typography color="warning.main" key={index}>
                  {warning}
                </Typography>
              ))}
              {document.sections.map((section) => (
                <section key={section.id}>
                  <Typography variant="subtitle2">
                    {section.member} — {section.locator}
                  </Typography>
                  <pre className="whitespace-pre-wrap break-words">{section.markdown}</pre>
                </section>
              ))}
              {document.nextAfter !== null && (
                <Button onClick={() => void load(document.nextAfter)}>Наступні розділи</Button>
              )}
            </>
          )}
        </Stack>
      </DialogContent>
    </Dialog>
  );
}
