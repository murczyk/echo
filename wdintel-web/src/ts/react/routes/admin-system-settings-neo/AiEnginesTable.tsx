import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import {
  Box,
  IconButton,
  Menu,
  MenuItem,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import { useState } from 'react';

import type { AiEngineItem } from '../../../../Bindings';
import { PowerButton } from '../../components/PowerButton';

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat('uk-UA', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(timestamp);
}

export function AiEnginesTable({
  aiEngines,
  onCreate,
  onDelete,
  onEdit,
  onView,
}: {
  aiEngines: AiEngineItem[];
  onCreate: () => void;
  onDelete: (aiEngine: AiEngineItem) => void;
  onEdit: (aiEngine: AiEngineItem) => void;
  onView: (aiEngine: AiEngineItem) => void;
}) {
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [menuAiEngine, setMenuAiEngine] = useState<AiEngineItem | null>(null);

  function openMenu(element: HTMLElement, aiEngine: AiEngineItem) {
    setMenuAnchor(element);
    setMenuAiEngine(aiEngine);
  }

  function closeMenu() {
    setMenuAnchor(null);
    setMenuAiEngine(null);
  }

  return (
    <>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 2,
        }}
      >
        <Box>
          <Typography component="h2" variant="h6">
            ШІ движки
          </Typography>
          <Typography color="text.secondary" variant="body2">
            OpenAI та OpenAI-сумісні vLLM API
          </Typography>
        </Box>
        <PowerButton type="button" variant="contained" onClick={onCreate} startIcon={<AddIcon />}>
          Додати
        </PowerButton>
      </Box>

      <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 0 }}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell padding="checkbox">Дії</TableCell>
              <TableCell>Назва</TableCell>
              <TableCell>Модель</TableCell>
              <TableCell>URL</TableCell>
              <TableCell>Стан</TableCell>
              <TableCell>Токен</TableCell>
              <TableCell>Оновлено</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {aiEngines.map((aiEngine) => (
              <TableRow key={aiEngine.id} hover>
                <TableCell padding="checkbox">
                  <Box sx={{ display: 'flex' }}>
                    <Tooltip title="Переглянути">
                      <IconButton
                        type="button"
                        aria-label={`Переглянути ${aiEngine.name}`}
                        onClick={() => onView(aiEngine)}
                      >
                        <VisibilityOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Інші дії">
                      <IconButton
                        type="button"
                        aria-label={`Дії для ${aiEngine.name}`}
                        onClick={(event) => openMenu(event.currentTarget, aiEngine)}
                      >
                        <MoreVertIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Box>
                </TableCell>
                <TableCell>{aiEngine.name}</TableCell>
                <TableCell>{aiEngine.modelName}</TableCell>
                <TableCell sx={{ maxWidth: 320, overflowWrap: 'anywhere' }}>
                  {aiEngine.url}
                </TableCell>
                <TableCell>{aiEngine.enabled ? 'Увімкнено' : 'Вимкнено'}</TableCell>
                <TableCell>{aiEngine.hasToken ? 'Задано' : 'Не задано'}</TableCell>
                <TableCell>{formatDate(aiEngine.updatedAt)}</TableCell>
              </TableRow>
            ))}
            {aiEngines.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7}>
                  <Typography color="text.secondary" align="center" sx={{ py: 4 }}>
                    ШІ движків ще немає.
                  </Typography>
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </TableContainer>

      <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={closeMenu}>
        <MenuItem
          onClick={() => {
            if (menuAiEngine) onEdit(menuAiEngine);
            closeMenu();
          }}
        >
          <EditOutlinedIcon fontSize="small" sx={{ mr: 1 }} />
          Редагувати
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menuAiEngine) onDelete(menuAiEngine);
            closeMenu();
          }}
          sx={{ color: 'error.main' }}
        >
          <DeleteOutlineIcon fontSize="small" sx={{ mr: 1 }} />
          Видалити
        </MenuItem>
      </Menu>
    </>
  );
}
