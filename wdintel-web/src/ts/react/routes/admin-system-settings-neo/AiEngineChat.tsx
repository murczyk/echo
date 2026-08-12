import AddCommentOutlinedIcon from '@mui/icons-material/AddCommentOutlined';
import SendIcon from '@mui/icons-material/Send';
import {
  Box,
  CircularProgress,
  List,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import type { KeyboardEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

import type { AiChatDetail, AiChatSummary, AiEngineItem } from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { SidePanelToggleButton } from '../../components/SidePanelToggleButton';
import { getAiChat, listAiChats, sendAiChatMessage } from '../../services/api/ai-engines';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat('uk-UA', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(timestamp);
}

function ChatMessages({ aiChat }: { aiChat: AiChatDetail | null }) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [aiChat?.messages.length]);

  if (!aiChat) {
    return (
      <Box sx={{ m: 'auto', px: 3, textAlign: 'center', color: 'text.secondary' }}>
        <Typography variant="h6">Новий чат</Typography>
        <Typography variant="body2">Надішліть запит, щоб почати розмову.</Typography>
      </Box>
    );
  }

  return (
    <Stack spacing={2} sx={{ p: 2, width: '100%', minWidth: 0, boxSizing: 'border-box' }}>
      {aiChat.messages.map((message) => {
        const isUser = message.role === 'user';
        return (
          <Box
            key={message.id}
            sx={{
              alignSelf: isUser ? 'flex-end' : 'flex-start',
              maxWidth: '85%',
              px: 2,
              py: 1.25,
              borderRadius: 2,
              bgcolor: isUser ? 'primary.main' : 'action.hover',
              color: isUser ? 'primary.contrastText' : 'text.primary',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}
          >
            <Typography variant="body1">{message.content}</Typography>
          </Box>
        );
      })}
      <div ref={bottomRef} />
    </Stack>
  );
}

export function AiEngineChat({ aiEngine }: { aiEngine: AiEngineItem }) {
  const [aiChats, setAiChats] = useState<AiChatSummary[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [aiChat, setAiChat] = useState<AiChatDetail | null>(null);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadInitialChats();
  }, [aiEngine.id]);

  async function loadInitialChats() {
    setLoading(true);
    setError(null);
    try {
      const response = await listAiChats(aiEngine.id);
      setAiChats(response.items);
      const first = response.items[0];
      if (first) {
        setSelectedChatId(first.id);
        setAiChat(await getAiChat(aiEngine.id, first.id));
      } else {
        setSelectedChatId(null);
        setAiChat(null);
      }
    } catch (loadError) {
      setError(`Помилка завантаження чатів: ${errorMessage(loadError)}`);
    } finally {
      setLoading(false);
    }
  }

  async function selectChat(chatId: string) {
    setSelectedChatId(chatId);
    setLoading(true);
    setError(null);
    try {
      setAiChat(await getAiChat(aiEngine.id, chatId));
    } catch (loadError) {
      setError(`Помилка завантаження чату: ${errorMessage(loadError)}`);
    } finally {
      setLoading(false);
    }
  }

  function startNewChat() {
    setSelectedChatId(null);
    setAiChat(null);
    setPrompt('');
    setError(null);
  }

  async function refreshChatList() {
    const response = await listAiChats(aiEngine.id);
    setAiChats(response.items);
  }

  async function sendMessage() {
    const nextPrompt = prompt.trim();
    if (!nextPrompt || sending) return;
    setSending(true);
    setError(null);
    try {
      const response = await sendAiChatMessage({
        aiEngineId: aiEngine.id,
        chatId: selectedChatId,
        prompt: nextPrompt,
      });
      setPrompt('');
      setSelectedChatId(response.id);
      setAiChat(response);
      await refreshChatList();
    } catch (sendError) {
      setError(`Помилка запиту до ШІ: ${errorMessage(sendError)}`);
    } finally {
      setSending(false);
    }
  }

  function handlePromptKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  return (
    <Stack spacing={2}>
      {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}

      <Paper
        variant="outlined"
        sx={{
          display: 'flex',
          flexDirection: 'column',
          minHeight: 560,
          overflow: 'hidden',
          borderRadius: 0,
        }}
      >
        <Box
          sx={{
            px: 1,
            py: 0.5,
            borderBottom: 1,
            borderColor: 'divider',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 1,
          }}
        >
          <SidePanelToggleButton
            side="left"
            active={historyOpen}
            label={historyOpen ? 'Згорнути ліву панель' : 'Розгорнути ліву панель'}
            onClick={() => setHistoryOpen((current) => !current)}
          />
          <PowerButton
            type="button"
            size="small"
            variant="outlined"
            onClick={startNewChat}
            startIcon={<AddCommentOutlinedIcon />}
          >
            Новий чат
          </PowerButton>
        </Box>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: historyOpen
              ? { xs: '1fr', md: '280px minmax(0, 1fr)' }
              : 'minmax(0, 1fr)',
            flex: 1,
            minHeight: 0,
          }}
        >
          {historyOpen ? (
            <Box
              sx={{
                borderRight: { md: 1 },
                borderBottom: { xs: 1, md: 0 },
                borderColor: 'divider',
              }}
            >
              <List
                dense
                disablePadding
                sx={{ maxHeight: { xs: 220, md: 500 }, overflowY: 'auto' }}
              >
                {aiChats.map((chat) => (
                  <ListItemButton
                    key={chat.id}
                    selected={chat.id === selectedChatId}
                    onClick={() => void selectChat(chat.id)}
                  >
                    <ListItemText
                      primary={chat.title}
                      secondary={`${chat.createdBy} · ${formatDate(chat.updatedAt)}`}
                      primaryTypographyProps={{ noWrap: true }}
                      secondaryTypographyProps={{ noWrap: true }}
                    />
                  </ListItemButton>
                ))}
                {!loading && aiChats.length === 0 ? (
                  <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
                    Попередніх чатів немає.
                  </Typography>
                ) : null}
              </List>
            </Box>
          ) : null}

          <Box sx={{ display: 'grid', gridTemplateRows: 'minmax(0, 1fr) auto', minWidth: 0 }}>
            <Box sx={{ display: 'flex', overflowY: 'auto', maxHeight: 480 }}>
              {loading ? <CircularProgress sx={{ m: 'auto' }} /> : <ChatMessages aiChat={aiChat} />}
            </Box>
            <Box sx={{ p: 2, borderTop: 1, borderColor: 'divider' }}>
              <Stack direction="row" spacing={1} alignItems="flex-end">
                <TextField
                  fullWidth
                  multiline
                  maxRows={6}
                  label="Повідомлення"
                  value={prompt}
                  disabled={sending}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={handlePromptKeyDown}
                />
                <PowerButton
                  type="button"
                  variant="contained"
                  disabled={sending || !prompt.trim()}
                  onClick={() => void sendMessage()}
                  startIcon={sending ? <CircularProgress size={18} /> : <SendIcon />}
                  sx={{ minHeight: 56 }}
                >
                  Надіслати
                </PowerButton>
              </Stack>
            </Box>
          </Box>
        </Box>
      </Paper>
    </Stack>
  );
}
