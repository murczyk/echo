import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import {
  Box,
  Card,
  CardContent,
  IconButton,
  Menu,
  MenuItem,
  Stack,
  Typography,
} from '@mui/material';
import { useState } from 'react';

import type { AiEngineItem } from '../../../../Bindings';
import { PowerButton } from '../../components/PowerButton';
import { SidePanelToggleButton } from '../../components/SidePanelToggleButton';
import { AiEngineChat } from './AiEngineChat';

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat('uk-UA', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(timestamp);
}

function DetailValue({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography sx={{ overflowWrap: 'anywhere' }}>{value}</Typography>
    </Box>
  );
}

export function AiEngineDetails({
  aiEngine,
  onBack,
  onDelete,
  onEdit,
}: {
  aiEngine: AiEngineItem;
  onBack: () => void;
  onDelete: () => void;
  onEdit: () => void;
}) {
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(true);

  return (
    <Stack spacing={3}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          flexWrap: 'wrap',
        }}
      >
        <PowerButton
          type="button"
          variant="outlined"
          onClick={onBack}
          startIcon={<ArrowBackIcon />}
        >
          Назад
        </PowerButton>
        <SidePanelToggleButton
          side="left"
          active={detailsOpen}
          label={detailsOpen ? 'Згорнути ліву панель' : 'Розгорнути ліву панель'}
          onClick={() => setDetailsOpen((current) => !current)}
        />
        <Typography variant="h6" component="h2" sx={{ flex: 1 }}>
          {aiEngine.name}
        </Typography>
        <IconButton
          type="button"
          aria-label="Інші дії"
          onClick={(event) => setMenuAnchor(event.currentTarget)}
        >
          <MoreVertIcon />
        </IconButton>
      </Box>

      <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
        <MenuItem
          onClick={() => {
            setMenuAnchor(null);
            onEdit();
          }}
        >
          <EditOutlinedIcon fontSize="small" sx={{ mr: 1 }} />
          Редагувати
        </MenuItem>
        <MenuItem
          onClick={() => {
            setMenuAnchor(null);
            onDelete();
          }}
          sx={{ color: 'error.main' }}
        >
          <DeleteOutlineIcon fontSize="small" sx={{ mr: 1 }} />
          Видалити
        </MenuItem>
      </Menu>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: detailsOpen ? { xs: '1fr', lg: '360px minmax(0, 1fr)' } : '1fr',
          gap: 2,
          alignItems: 'start',
          minWidth: 0,
        }}
      >
        {detailsOpen ? (
          <Card variant="outlined" sx={{ borderRadius: 0, minWidth: 0 }}>
            <CardContent>
              <Stack spacing={2}>
                <DetailValue label="ID" value={aiEngine.id} />
                <DetailValue label="Модель" value={aiEngine.modelName} />
                <DetailValue label="Base URL" value={aiEngine.url} />
                <DetailValue label="Стан" value={aiEngine.enabled ? 'Увімкнено' : 'Вимкнено'} />
                <DetailValue
                  label="Позивні й розвіддонесення"
                  value={aiEngine.callsignEnabled ? 'Увімкнено' : 'Вимкнено'}
                />
                <DetailValue label="OCR" value={aiEngine.ocrEnabled ? 'Увімкнено' : 'Вимкнено'} />
                <DetailValue label="Токен" value={aiEngine.hasToken ? 'Задано' : 'Не задано'} />
                <DetailValue label="Створено" value={formatDate(aiEngine.createdAt)} />
                <DetailValue label="Оновлено" value={formatDate(aiEngine.updatedAt)} />
              </Stack>
            </CardContent>
          </Card>
        ) : null}
        <Box sx={{ minWidth: 0 }}>
          <AiEngineChat aiEngine={aiEngine} />
        </Box>
      </Box>
    </Stack>
  );
}
