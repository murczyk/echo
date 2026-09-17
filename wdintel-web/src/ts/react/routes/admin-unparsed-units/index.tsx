import AddIcon from '@mui/icons-material/Add';
import LinkIcon from '@mui/icons-material/Link';
import { Box, Button, CircularProgress, Paper, Stack, Typography } from '@mui/material';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { UnresolvedUnitMessage } from '../../../../Bindings';
import { PageHeader } from '../../components/PageHeader';
import { PowerAlert } from '../../components/PowerAlert';
import {
  listUnresolvedUnitMessages,
  resolveUnresolvedUnitLabel,
} from '../../services/api/unresolved-unit-labels';
import { hasRole } from '../../utils/roles';
import { UnresolvedUnitLinkDialog } from '../admin-unit-unparsed/UnresolvedUnitLinkDialog';

function formatError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'Помилка запиту до сервера.';
}

function formatCreatedAt(createdAt: number): string {
  return new Date(createdAt).toLocaleString('uk-UA');
}

function sortMessagesNewestFirst(messages: UnresolvedUnitMessage[]): UnresolvedUnitMessage[] {
  return [...messages].sort(
    (left, right) => right.createdAt - left.createdAt || right.id - left.id,
  );
}

function UnresolvedUnitMessageCard({ message }: { message: UnresolvedUnitMessage }) {
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between">
          <Typography variant="subtitle1" fontWeight={700}>
            Група: {message.groupName || '—'}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {formatCreatedAt(message.createdAt)}
          </Typography>
        </Stack>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={{ xs: 0.5, sm: 3 }}>
          <Typography variant="body2">
            <Box component="span" fontWeight={700}>
              Мітка:
            </Box>{' '}
            {message.label}
          </Typography>
          <Typography variant="body2">
            <Box component="span" fontWeight={700}>
              Відправник:
            </Box>{' '}
            {message.sender || '—'}
          </Typography>
        </Stack>
        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {message.body || '—'}
        </Typography>
      </Stack>
    </Paper>
  );
}

export function AdminUnparsedUnitsPage({
  title,
  authUserRoles,
}: {
  title: string;
  authUserRoles: string[];
}) {
  const normalizedTitle = title.trim();
  const [messages, setMessages] = useState<UnresolvedUnitMessage[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const loadMoreControllerRef = useRef<AbortController | null>(null);
  const linkControllerRef = useRef<AbortController | null>(null);
  const canResolve =
    hasRole(authUserRoles, 'Admin') &&
    hasRole(authUserRoles, 'Rer') &&
    hasRole(authUserRoles, 'UnitsEditor');
  const canCreate = hasRole(authUserRoles, 'Rer') && hasRole(authUserRoles, 'UnitsEditor');

  useEffect(() => {
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = null;
    linkControllerRef.current?.abort();
    linkControllerRef.current = null;
    setMessages([]);
    setCursor(null);
    setLoadingMore(false);
    setLinkOpen(false);
    setLinking(false);
    setError(null);
    setStatus(null);
    if (!normalizedTitle) {
      setLoading(false);
      setError('Не вказано мітку підрозділу.');
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    void listUnresolvedUnitMessages(
      { title: normalizedTitle, cursor: null },
      { signal: controller.signal },
    )
      .then((response) => {
        if (controller.signal.aborted) return;
        setMessages(sortMessagesNewestFirst(response.messages));
        setCursor(response.nextCursor);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(formatError(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      loadMoreControllerRef.current?.abort();
      loadMoreControllerRef.current = null;
      linkControllerRef.current?.abort();
      linkControllerRef.current = null;
    };
  }, [normalizedTitle]);

  const loadMore = useCallback(async () => {
    if (cursor === null) return;
    loadMoreControllerRef.current?.abort();
    const controller = new AbortController();
    loadMoreControllerRef.current = controller;
    setLoadingMore(true);
    setError(null);
    try {
      const response = await listUnresolvedUnitMessages(
        {
          title: normalizedTitle,
          cursor,
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setMessages((current) => sortMessagesNewestFirst([...current, ...response.messages]));
      setCursor(response.nextCursor);
    } catch (error) {
      if (!controller.signal.aborted) setError(formatError(error));
    } finally {
      if (loadMoreControllerRef.current === controller) {
        loadMoreControllerRef.current = null;
        setLoadingMore(false);
      }
    }
  }, [cursor, normalizedTitle]);

  async function linkUnit(sigintUnitId: number) {
    linkControllerRef.current?.abort();
    const controller = new AbortController();
    linkControllerRef.current = controller;
    setLinking(true);
    setError(null);
    try {
      await resolveUnresolvedUnitLabel(
        {
          unitTxt: normalizedTitle,
          label: normalizedTitle,
          sigintUnitId,
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setLinkOpen(false);
      setStatus(`Синонім для «${normalizedTitle}» збережено.`);
    } catch (requestError) {
      if (!controller.signal.aborted) setError(formatError(requestError));
    } finally {
      if (linkControllerRef.current === controller) {
        linkControllerRef.current = null;
        setLinking(false);
      }
    }
  }

  return (
    <Stack spacing={2} sx={{ height: '100%', minHeight: 0, p: 2 }}>
      <PageHeader
        title={normalizedTitle || 'Приклади перехоплень'}
        actions={
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
            <Button
              variant="outlined"
              startIcon={<LinkIcon />}
              disabled={!canResolve || !normalizedTitle || linking}
              onClick={() => {
                setError(null);
                setStatus(null);
                setLinkOpen(true);
              }}
            >
              Прив'язати до підрозділу
            </Button>
            <Button
              component="a"
              variant="contained"
              startIcon={<AddIcon />}
              disabled={!canCreate}
              href="/rer-units-neo?create=true"
            >
              Створити підрозділ
            </Button>
          </Stack>
        }
      />
      {error ? (
        <PowerAlert severity="error" onClose={() => setError(null)}>
          {error}
        </PowerAlert>
      ) : null}
      {status ? (
        <PowerAlert severity="success" onClose={() => setStatus(null)}>
          {status}
        </PowerAlert>
      ) : null}
      {loading ? (
        <Stack alignItems="center" sx={{ py: 4 }}>
          <CircularProgress aria-label="Завантаження перехоплень" />
        </Stack>
      ) : (
        <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', pr: 1 }}>
          <Stack spacing={1.5}>
            {messages.length === 0 && !error ? (
              <Typography color="text.secondary">Перехоплень не знайдено.</Typography>
            ) : null}
            {messages.map((message) => (
              <UnresolvedUnitMessageCard key={message.id} message={message} />
            ))}
            {cursor !== null ? (
              <Box sx={{ alignSelf: 'center', pb: 1 }}>
                <Button variant="outlined" disabled={loadingMore} onClick={() => void loadMore()}>
                  {loadingMore ? 'Завантаження…' : 'Завантажити ще'}
                </Button>
              </Box>
            ) : null}
          </Stack>
        </Box>
      )}
      <UnresolvedUnitLinkDialog
        open={linkOpen}
        unitTxt={normalizedTitle}
        processing={linking}
        onClose={() => setLinkOpen(false)}
        onSubmit={(sigintUnitId) => void linkUnit(sigintUnitId)}
      />
    </Stack>
  );
}
