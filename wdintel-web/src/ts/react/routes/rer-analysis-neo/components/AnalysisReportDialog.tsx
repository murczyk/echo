import DownloadIcon from '@mui/icons-material/Download';
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  InputLabel,
  ListItemText,
  MenuItem,
  Select,
  Stack,
  Typography,
} from '@mui/material';
import { useId } from 'react';

import { STANDARD_DIALOG_ACTIONS_SX } from '../../../components/dialogStyles';
import {
  REPORT_ADJACENT_FREQS_OPTIONS,
  type AnalysisReportState,
  type ReportTemplateId,
} from '../report-helpers';
import type { AnalysisAorEntry } from '../types';

type Props = {
  aors: AnalysisAorEntry[];
  downloadInFlight: boolean;
  open: boolean;
  report: AnalysisReportState;
  onClose: () => void;
  onDownload: () => void;
  onUpdate: (patch: Partial<AnalysisReportState>) => void;
};

const templateOptions: Array<{ id: ReportTemplateId; title: string; description: string }> = [
  { id: 'tags', title: 'З донесенням', description: 'Простий перелік повідомлень разом з їх донесенням' },
  { id: 'pelengs', title: 'Пеленги', description: 'Таблиця з пеленгами' },
  { id: 'babak', title: 'Бабак', description: 'Детальний звіт по підрозділах' },
  { id: 'interception', title: 'Перехоплення', description: 'Звіт по перехопленнях' },
  { id: 'senders', title: 'Відправники', description: 'Аналіз відправників або постів' },
  { id: 'posts_docx', title: 'Пости', description: 'Docx-звіт з узагальненими метриками по постах' },
  { id: 'mouse', title: 'Мишка', description: 'Детальний почастотний звіт по привʼязках' },
  { id: 'reo', title: 'РЕО', description: 'Потрібні права редактора чи адміна' },
  { id: 'digest', title: 'Дайджест', description: 'Потрібні права редактора чи адміна' },
  { id: 'active_networks', title: 'Активні радіомережі', description: 'Потрібні права редактора чи адміна' },
  { id: 'summary_table', title: 'Підсумкова таблиця', description: 'XLSX-експорт підсумкової таблиці без обмеження в 1 тиждень' },
];

export function AnalysisReportDialog({ aors, downloadInFlight, open, report, onClose, onDownload, onUpdate }: Props) {
  const titleId = useId().replace(/:/g, '-');

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="lg" aria-labelledby={titleId}>
      <DialogTitle id={titleId}>Конструктор звітів</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={3}>
          <Stack spacing={1.5}>
            <Typography variant="subtitle1">Шаблон</Typography>
            <Stack direction={{ xs: 'column', md: 'row' }} flexWrap="wrap" gap={1.5}>
              {templateOptions.map((option) => (
                <Button
                  key={option.id}
                  variant={report.template === option.id ? 'contained' : 'outlined'}
                  onClick={() => onUpdate({ template: option.id })}
                  sx={{ alignItems: 'flex-start', justifyContent: 'flex-start', textAlign: 'left', p: 2, minWidth: 220 }}
                >
                  <Stack alignItems="flex-start" spacing={0.75}>
                    <Typography variant="subtitle2">{option.title}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {option.description}
                    </Typography>
                  </Stack>
                </Button>
              ))}
            </Stack>
          </Stack>

          {report.template === 'senders' ? (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <FormControl fullWidth size="small">
                <InputLabel id="analysis-report-aggregation-label">Агрегація</InputLabel>
                <Select
                  labelId="analysis-report-aggregation-label"
                  label="Агрегація"
                  value={report.senderAggregation}
                  onChange={(event) => onUpdate({ senderAggregation: event.target.value as AnalysisReportState['senderAggregation'] })}
                >
                  <MenuItem value="ByProfile">Профілі</MenuItem>
                  <MenuItem value="ByPost">Пости</MenuItem>
                </Select>
              </FormControl>
              <FormControlLabel
                control={<Checkbox checked={report.senderAdvancedFreqs} onChange={(_event, value) => onUpdate({ senderAdvancedFreqs: value })} />}
                label="Розширений звіт"
              />
            </Stack>
          ) : null}

          {report.template === 'reo' ? (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <FormControl fullWidth size="small">
                <InputLabel id="analysis-report-reo-adjacent-label">Суміжні частоти</InputLabel>
                <Select
                  labelId="analysis-report-reo-adjacent-label"
                  label="Суміжні частоти"
                  value={String(report.reoAdjacentFreqsDistance)}
                  onChange={(event) => onUpdate({ reoAdjacentFreqsDistance: Number(event.target.value) })}
                >
                  {REPORT_ADJACENT_FREQS_OPTIONS.map((option) => (
                    <MenuItem key={option} value={String(option)}>
                      {(option * 1000).toFixed(option === 0 ? 0 : 1)} кГц
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl fullWidth size="small">
                <InputLabel id="analysis-report-reo-file-label">Формат</InputLabel>
                <Select
                  labelId="analysis-report-reo-file-label"
                  label="Формат"
                  value={report.reoFileType}
                  onChange={(event) => onUpdate({ reoFileType: event.target.value as AnalysisReportState['reoFileType'] })}
                >
                  <MenuItem value="Docx">docx</MenuItem>
                  <MenuItem value="Xlsx">xlsx</MenuItem>
                </Select>
              </FormControl>
              <FormControlLabel
                control={<Checkbox checked={report.reoNoComments} onChange={(_event, value) => onUpdate({ reoNoComments: value })} />}
                label="Без коментарів"
              />
            </Stack>
          ) : null}

          {report.template === 'active_networks' ? (
            <FormControl fullWidth size="small">
              <InputLabel id="analysis-report-aors-label">Смуги відповідальності</InputLabel>
              <Select
                labelId="analysis-report-aors-label"
                label="Смуги відповідальності"
                multiple
                value={report.activeNetworksAorIds.map(String)}
                onChange={(event) =>
                  onUpdate({ activeNetworksAorIds: (event.target.value as string[]).map((value) => Number(value)).filter(Number.isFinite) })
                }
                renderValue={(selected) =>
                  (selected as string[])
                    .map((value) => aors.find((aor) => aor.id === Number(value))?.name ?? value)
                    .join(', ')
                }
              >
                {aors.map((aor) => (
                  <MenuItem key={aor.id} value={String(aor.id)}>
                    <Checkbox checked={report.activeNetworksAorIds.includes(aor.id)} />
                    <ListItemText primary={aor.name} />
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          ) : null}

          {['tags', 'pelengs', 'babak', 'interception', 'posts_docx', 'mouse', 'reo'].includes(report.template) ? (
            <Stack spacing={0.5}>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={report.reportTagsOnlyThisUnit}
                    disabled={report.template === 'babak' && report.withoutComments}
                    onChange={(_event, value) => onUpdate({ reportTagsOnlyThisUnit: value })}
                  />
                }
                label="Лише теги/коментарі мого підрозділу"
              />
              {report.template === 'babak' ? (
                <FormControlLabel
                  control={<Checkbox checked={report.withoutComments} onChange={(_event, value) => onUpdate({ withoutComments: value, reportTagsOnlyThisUnit: value ? false : report.reportTagsOnlyThisUnit })} />}
                  label="Не включати коментарі"
                />
              ) : null}
            </Stack>
          ) : null}

          {['babak', 'interception'].includes(report.template) ? (
            <FormControlLabel
              control={<Checkbox checked={report.withoutModelTags} onChange={(_event, value) => onUpdate({ withoutModelTags: value })} />}
              label="Без автоматичних тегів"
            />
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions sx={STANDARD_DIALOG_ACTIONS_SX}>
        <Button onClick={onClose}>Закрити</Button>
        <Button variant="contained" startIcon={<DownloadIcon />} onClick={onDownload} disabled={downloadInFlight}>
          {downloadInFlight ? 'Готуємо...' : report.template === 'summary_table' ? 'Завантажити xlsx' : 'Завантажити docx/xlsx'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
