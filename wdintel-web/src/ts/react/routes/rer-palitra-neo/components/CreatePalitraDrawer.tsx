import {
  Alert,
  Backdrop,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Drawer,
  FormControlLabel,
  Paper,
  Stack,
  Step,
  StepButton,
  Stepper,
  TextField,
  Typography,
} from '@mui/material';
import React from 'react';

import { AnalyzeKmzResponse, AreaOfResponsibility, MyScope, Organism, User } from '../../../../../Bindings';
import { isFormValid } from '../helpers';
import { KmzColorOption, PalitraFormState } from '../types';
import { AccessEditor } from './AccessEditor';

type Props = {
  open: boolean;
  onClose: () => void;
  onExited: () => void;
  createInFlight: boolean;
  kmzAnalyzing: boolean;
  kmzFile: File | null;
  kmzAnalysis: AnalyzeKmzResponse | null;
  kmzColorOptions: KmzColorOption[];
  selectedColorFromKmz: string;
  createForm: PalitraFormState;
  user: User | null;
  myScope: MyScope | null;
  organisms: Organism[];
  aors: AreaOfResponsibility[];
  allLogins: string[];
  availableAccessTypes: ('logins' | 'organisms' | 'aor')[];
  onRequestAnalyzeKmz: () => void;
  onSetKmzColorOptions: (updater: (prev: KmzColorOption[]) => KmzColorOption[]) => void;
  onSetSelectedColorFromKmz: (value: string) => void;
  onSetCreateForm: (updater: (prev: PalitraFormState) => PalitraFormState) => void;
  onCreate: () => void;
};

const steps = [ 'KMZ файл', 'Параметри і доступ' ];

function CreatePalitraDrawerComponent({
  open,
  onClose,
  onExited,
  createInFlight,
  kmzAnalyzing,
  kmzFile,
  kmzAnalysis,
  kmzColorOptions,
  selectedColorFromKmz,
  createForm,
  user,
  myScope,
  organisms,
  aors,
  allLogins,
  availableAccessTypes,
  onRequestAnalyzeKmz,
  onSetKmzColorOptions,
  onSetSelectedColorFromKmz,
  onSetCreateForm,
  onCreate,
}: Props) {
  const [activeStep, setActiveStep] = React.useState(0);
  const prevCanContinueFromKmzStepRef = React.useRef(false);

  React.useEffect(() => {
    setActiveStep(0);
    prevCanContinueFromKmzStepRef.current = false;
    if (!open) return;
  }, [open]);

  const hasSelectedKmzColor = kmzColorOptions.some((option) => option.selected);
  const canContinueFromKmzStep = Boolean(kmzFile) && !kmzAnalyzing;
  const canCreate =
    createInFlight || !kmzFile || !isFormValid(createForm) || (kmzColorOptions.length > 0 && !hasSelectedKmzColor);

  React.useEffect(() => {
    if (!open) return;
    const wasReady = prevCanContinueFromKmzStepRef.current;
    prevCanContinueFromKmzStepRef.current = canContinueFromKmzStep;

    if (activeStep !== 0) return;
    if (!wasReady && canContinueFromKmzStep) {
      setActiveStep(1);
    }
  }, [open, activeStep, canContinueFromKmzStep]);

  React.useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      onClose();
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  function canContinueStep(step: number) {
    if (step === 0) return canContinueFromKmzStep;
    return !canCreate;
  }

  function canGoToStep(targetStep: number) {
    if (targetStep <= activeStep) return true;

    for (let step = activeStep; step < targetStep; step += 1) {
      if (!canContinueStep(step)) return false;
    }

    return true;
  }

  return (
    <>
      <Backdrop
        open={open}
        onClick={onClose}
        sx={{
          zIndex: (theme) => theme.zIndex.drawer - 1,
          color: 'common.white',
          backgroundColor: 'rgba(0, 0, 0, 0.24)',
        }}
      />
      <Drawer
        anchor="right"
        variant="persistent"
        open={open}
        SlideProps={{ onExited }}
        PaperProps={{ sx: { width: { xs: '100%', sm: 680 }, maxWidth: '100vw', display: 'flex' } }}
      >
        <Box sx={{ position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <Box sx={{ p: 2.5, borderBottom: '1px solid', borderColor: 'divider' }}>
          <Typography variant="h6">Додати палітру</Typography>
        </Box>
        <Box sx={{ p: 2.5, flex: 1, overflowY: 'auto' }}>
          <Stack spacing={2}>
          <Stepper activeStep={activeStep} alternativeLabel nonLinear>
            {steps.map((label, index) => (
              <Step key={label}>
                <StepButton
                  onClick={() => setActiveStep(index)}
                  disabled={createInFlight || !canGoToStep(index)}
                >
                  {label}
                </StepButton>
              </Step>
            ))}
          </Stepper>

          {activeStep === 0 ? (
            <Stack spacing={2}>
              <Button
                variant="outlined"
                onClick={onRequestAnalyzeKmz}
                disabled={kmzAnalyzing || createInFlight}
                sx={{ alignSelf: 'center' }}
              >
                {kmzAnalyzing ? 'Аналіз...' : kmzFile ? 'Замінити KMZ файл' : 'Обрати KMZ файл'}
              </Button>

              {kmzFile ? (
                <Typography variant="caption" color="text.secondary">
                  Файл: {kmzFile.name}
                </Typography>
              ) : null}

              {kmzAnalysis ? <Alert severity="success">KMZ проаналізовано, кольорів: {kmzAnalysis.topColors.length}</Alert> : null}
            </Stack>
          ) : null}

          {activeStep === 1 ? (
            <Stack spacing={2}>
              {kmzColorOptions.length > 0 ? (
                <Stack spacing={1}>
                  <Typography variant="subtitle2" sx={{ px: 1.5 }}>
                    Кольори з KMZ
                  </Typography>
                  <Stack direction="row" spacing={2} sx={{ px: 1.5 }}>
                    <Button
                      size="small"
                      onClick={() => onSetKmzColorOptions((prev) => prev.map((option) => ({ ...option, selected: true })))}
                    >
                      Обрати всі
                    </Button>
                    <Button
                      size="small"
                      onClick={() => onSetKmzColorOptions((prev) => prev.map((option) => ({ ...option, selected: false })))}
                    >
                      Зняти всі
                    </Button>
                  </Stack>
                  {kmzColorOptions.map((option) => (
                    <Paper key={option.colorHex} variant="outlined" sx={{ p: 1.5 }}>
                      <Stack direction="row" spacing={2} alignItems="center" sx={{ width: '100%' }}>
                        <FormControlLabel
                          sx={{ m: 0, flex: 1 }}
                          control={
                            <Checkbox
                              size="small"
                              checked={option.selected}
                              onChange={() =>
                                onSetKmzColorOptions((prev) =>
                                  prev.map((entry) =>
                                    entry.colorHex === option.colorHex ? { ...entry, selected: !entry.selected } : entry,
                                  ),
                                )
                              }
                            />
                          }
                          label={
                            <Stack direction="row" spacing={1} alignItems="center">
                              <Chip
                                size="small"
                                label={option.colorHex}
                                sx={{ backgroundColor: option.colorHex, color: '#fff', fontFamily: 'monospace' }}
                              />
                              <Typography variant="caption">топ #{option.rank} ({option.count})</Typography>
                            </Stack>
                          }
                        />
                        <TextField
                          size="small"
                          label="Суфікс"
                          value={option.suffix}
                          onChange={(event) =>
                            onSetKmzColorOptions((prev) =>
                              prev.map((entry) =>
                                entry.colorHex === option.colorHex ? { ...entry, suffix: event.target.value } : entry,
                              ),
                            )
                          }
                          sx={{ minWidth: '220px', ml: 'auto' }}
                        />
                      </Stack>
                    </Paper>
                  ))}
                </Stack>
              ) : (
                <TextField
                  label="Колір"
                  type="color"
                  size="small"
                  value={selectedColorFromKmz}
                  onChange={(event) => {
                    onSetSelectedColorFromKmz(event.target.value);
                    onSetCreateForm((prev) => ({ ...prev, colorHex: event.target.value }));
                  }}
                  disabled={createInFlight}
                  sx={{ width: '140px' }}
                />
              )}

              <TextField
                label="Назва"
                size="small"
                value={createForm.name}
                onChange={(event) => onSetCreateForm((prev) => ({ ...prev, name: event.target.value }))}
                disabled={createInFlight}
                fullWidth
              />

              <AccessEditor
                form={createForm}
                onChange={(next) => onSetCreateForm(() => next)}
                user={user}
                myScope={myScope}
                organisms={organisms}
                aors={aors}
                allLogins={allLogins}
                availableAccessTypes={availableAccessTypes}
              />
            </Stack>
          ) : null}
          </Stack>
        </Box>
        <Box sx={{ p: 2.5, borderTop: '1px solid', borderColor: 'divider', display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
          <Button onClick={onClose} disabled={createInFlight}>
            Скасувати
          </Button>
          {activeStep > 0 ? (
            <Button onClick={() => setActiveStep((prev) => prev - 1)} disabled={createInFlight}>
              Назад
            </Button>
          ) : null}
          {activeStep < steps.length - 1 ? (
            <Button variant="contained" onClick={() => setActiveStep((prev) => prev + 1)} disabled={!canContinueStep(activeStep)}>
              Далі
            </Button>
          ) : (
            <Button onClick={onCreate} variant="contained" disabled={canCreate}>
              {createInFlight ? <CircularProgress size={16} /> : 'Створити'}
            </Button>
          )}
        </Box>

        {kmzAnalyzing || createInFlight ? (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              zIndex: (theme) => theme.zIndex.drawer + 1,
              color: 'common.white',
              backgroundColor: 'rgba(0, 0, 0, 0.42)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Stack spacing={1.5} alignItems="center">
              <CircularProgress color="inherit" />
              <Typography variant="body2">
                {kmzAnalyzing ? 'Аналіз KMZ...' : 'Додавання палітри...'}
              </Typography>
            </Stack>
          </Box>
        ) : null}
        </Box>
      </Drawer>
    </>
  );
}

export const CreatePalitraDrawer = React.memo(CreatePalitraDrawerComponent);
