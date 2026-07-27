import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import {
  Box,
  Card,
  CardContent,
  Divider,
  IconButton,
  Menu,
  MenuItem,
  Stack,
  Typography,
} from '@mui/material';
import { useState } from 'react';

import type { AiEngineItem } from '../../../../Bindings';
import { PowerButton } from '../../components/PowerButton';
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
        <Typography variant="h6" component="h2" sx={{ flex: 1 }}>
          {aiEngine.name}
        </Typography>
        <PowerButton
          type="button"
          variant="contained"
          onClick={onEdit}
          startIcon={<EditOutlinedIcon />}
        >
          Редагувати
        </PowerButton>
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

      <Card variant="outlined" sx={{ borderRadius: 0 }}>
        <CardContent>
          <Box
            sx={{
              display: 'grid',
              gap: 2,
              gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
            }}
          >
            <DetailValue label="ID" value={aiEngine.id} />
            <DetailValue label="Модель" value={aiEngine.modelName} />
            <DetailValue label="Base URL" value={aiEngine.url} />
            <DetailValue label="Стан" value={aiEngine.enabled ? 'Увімкнено' : 'Вимкнено'} />
            <DetailValue label="Токен" value={aiEngine.hasToken ? 'Задано' : 'Не задано'} />
            <DetailValue label="Створено" value={formatDate(aiEngine.createdAt)} />
            <DetailValue label="Оновлено" value={formatDate(aiEngine.updatedAt)} />
          </Box>
        </CardContent>
      </Card>

      <Divider />
      <AiEngineChat aiEngine={aiEngine} />
    </Stack>
  );
}
