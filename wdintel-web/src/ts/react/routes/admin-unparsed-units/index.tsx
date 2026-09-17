import { Box, Button, CircularProgress, Paper, Stack, Typography } from '@mui/material';
import { useCallback, useEffect, useState } from 'react';

import type { UnresolvedUnitMessage } from '../../../../Bindings';
import { PageHeader } from '../../components/PageHeader';
import { PowerAlert } from '../../components/PowerAlert';
import { listUnresolvedUnitMessages } from '../../services/api/unresolved-unit-labels';

function formatError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'Помилка запиту до сервера.';
}

function formatCreatedAt(createdAt: number): string {
  return new Date(createdAt).toLocaleString('uk-UA');
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

export function AdminUnparsedUnitsPage({ title }: { title: string }) {
  const normalizedTitle = title.trim();
  const [messages, setMessages] = useState<UnresolvedUnitMessage[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMessages([]);
    setPage(0);
    setHasMore(false);
    setError(null);
    if (!normalizedTitle) {
      setLoading(false);
      setError('Не вказано мітку підрозділу.');
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    void listUnresolvedUnitMessages(
      { title: normalizedTitle, page: 0 },
      { signal: controller.signal },
    )
      .then((response) => {
        if (controller.signal.aborted) return;
        setMessages(response.messages);
        setHasMore(response.hasMore);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(formatError(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [normalizedTitle]);

  const loadMore = useCallback(async () => {
    const nextPage = page + 1;
    setLoadingMore(true);
    setError(null);
    try {
      const response = await listUnresolvedUnitMessages({
        title: normalizedTitle,
        page: nextPage,
      });
      setMessages((current) => [...current, ...response.messages]);
      setPage(nextPage);
      setHasMore(response.hasMore);
    } catch (error) {
      setError(formatError(error));
    } finally {
      setLoadingMore(false);
    }
  }, [normalizedTitle, page]);

  return (
    <Stack spacing={2} sx={{ height: '100%', minHeight: 0, p: 2 }}>
      <PageHeader title={normalizedTitle || 'Приклади перехоплень'} />
      {error ? (
        <PowerAlert severity="error" onClose={() => setError(null)}>
          {error}
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
            {hasMore ? (
              <Box sx={{ alignSelf: 'center', pb: 1 }}>
                <Button variant="outlined" disabled={loadingMore} onClick={() => void loadMore()}>
                  {loadingMore ? 'Завантаження…' : 'Завантажити ще'}
                </Button>
              </Box>
            ) : null}
          </Stack>
        </Box>
      )}
    </Stack>
  );
}
