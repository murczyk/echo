import {
  Backdrop,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Drawer,
  FormControlLabel,
  Paper,
  Stack,
  Step,
  StepButton,
  Stepper,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import { memo, useEffect, useRef, useState } from 'react';

import {
  AnalyzeKmzResponse,
  AreaOfResponsibility,
  MyScope,
  Organism,
  User,
} from '../../../../../Bindings';
import { pageDrawerBackdropSx } from '../../../components/loadingOverlayStyles';
import { PowerChip } from '../../../components/PowerChip';
import { ELLIPSIS } from '../../../utils/misc';
import { isFormValid } from '../helpers';
import { KmzColorOption, PalitraCreateMode, PalitraFormState } from '../types';
import { PalitraFormFields } from './PalitraFormFields';
import { PowerAlert } from '../../../components/PowerAlert';

type Props = {
  open: boolean;
  onClose: () => void;
  onExited: () => void;
  createInFlight: boolean;
  referenceDataReady: boolean;
  kmzAnalyzing: boolean;
  kmzFile: File | null;
  kmzAnalysis: AnalyzeKmzResponse | null;
  kmzColorOptions: KmzColorOption[];
  selectedColorFromKmz: string;
  createMode: PalitraCreateMode;
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
  onSetCreateMode: (mode: PalitraCreateMode) => void;
  onSetCreateForm: (updater: (prev: PalitraFormState) => PalitraFormState) => void;
  onCreate: (mode: PalitraCreateMode) => void;
};

const steps = ['Файл', 'Параметри і доступ'];

function CreatePalitraDrawerComponent({
  open,
  onClose,
  onExited,
  createInFlight,
  referenceDataReady,
  kmzAnalyzing,
  kmzFile,
  kmzAnalysis,
  kmzColorOptions,
  selectedColorFromKmz,
  createMode,
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
  onSetCreateMode,
  onSetCreateForm,
  onCreate,
}: Props) {
  const [activeStep, setActiveStep] = useState(0);
  const prevCanContinueFromKmzStepRef = useRef(false);

  useEffect(() => {
    setActiveStep(0);
    prevCanContinueFromKmzStepRef.current = false;
    if (!open) return;
  }, [open]);

  const hasSelectedKmzColor = kmzColorOptions.some((option) => option.selected);
  const isAdvancedMode = createMode === 'advanced';
  const hasSuccessfulKmzAnalysis = Boolean(kmzAnalysis);
  const dismissBlocked = createInFlight || kmzAnalyzing;
  const formBlocked = createInFlight || !referenceDataReady;
  const canContinueFromKmzStep = Boolean(kmzFile) && hasSuccessfulKmzAnalysis && !kmzAnalyzing;
  const requiresKmzSelection = isAdvancedMode && kmzColorOptions.length > 0;
  const isCreateFormValid = isFormValid(createForm);
  const canCreate =
    createInFlight ||
    !referenceDataReady ||
    !kmzFile ||
    !hasSuccessfulKmzAnalysis ||
    !isCreateFormValid ||
    (requiresKmzSelection && !hasSelectedKmzColor);
  const selectedKmzColorsCount = kmzColorOptions.filter((option) => option.selected).length;

  useEffect(() => {
    if (!open) return;
    const wasReady = prevCanContinueFromKmzStepRef.current;
    prevCanContinueFromKmzStepRef.current = canContinueFromKmzStep;

    if (activeStep !== 0) return;
    if (!wasReady && canContinueFromKmzStep) {
      setActiveStep(1);
    }
  }, [open, activeStep, canContinueFromKmzStep]);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      if (dismissBlocked) return;
      onClose();
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dismissBlocked, open, onClose]);

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
        onClick={() => {
          if (dismissBlocked) return;
          onClose();
        }}
        sx={(theme) => ({
          ...pageDrawerBackdropSx(theme),
          zIndex: theme.zIndex.drawer - 1,
        })}
      />
      <Drawer
        anchor="right"
        variant="persistent"
        open={open}
        SlideProps={{ onExited }}
        slotProps={{
          paper: { sx: { width: { xs: '100%', sm: 680 }, maxWidth: '100vw', display: 'flex' } },
        }}
      >
        <Box
          sx={{
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            flex: 1,
            minHeight: 0,
          }}
        >
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
                  {kmzAnalyzing ? (
                    <Stack direction="row" alignItems="center" justifyContent="center">
                      <CircularProgress size={18} />
                    </Stack>
                  ) : (
                    <Button
                      variant="outlined"
                      onClick={onRequestAnalyzeKmz}
                      disabled={createInFlight}
                      sx={{ alignSelf: 'center' }}
                    >
                      {kmzFile ? 'Замінити файл' : 'Обрати файл'}
                    </Button>
                  )}

                  {kmzFile ? (
                    <Typography variant="caption" color="text.secondary">
                      Файл: {kmzFile.name}
                    </Typography>
                  ) : null}

                  {kmzAnalysis ? (
                    <PowerAlert severity="success">
                      Файл прийнято, кольорів: {kmzAnalysis.topColors.length}
                    </PowerAlert>
                  ) : null}
                  {!referenceDataReady ? (
                    <PowerAlert severity="info">
                      Завантажуємо довідники (логіни, підрозділи, смуги){ELLIPSIS}
                    </PowerAlert>
                  ) : null}
                </Stack>
              ) : null}

              {activeStep === 1 ? (
                <Stack spacing={2}>
                  <Tabs
                    value={createMode}
                    onChange={(_, value: PalitraCreateMode) => onSetCreateMode(value)}
                    variant="fullWidth"
                    sx={{ mb: 0.5 }}
                  >
                    <Tab
                      value="basic"
                      label="Базовий"
                      disabled={dismissBlocked || !referenceDataReady}
                    />
                    <Tab
                      value="advanced"
                      label="Розширений"
                      disabled={dismissBlocked || !referenceDataReady}
                    />
                  </Tabs>

                  <Box sx={{ pt: 1.5 }}>
                    <PalitraFormFields
                      form={createForm}
                      onChange={onSetCreateForm}
                      user={user}
                      myScope={myScope}
                      organisms={organisms}
                      aors={aors}
                      allLogins={allLogins}
                      availableAccessTypes={availableAccessTypes}
                      loading={!referenceDataReady}
                      disabled={formBlocked}
                      colorField={
                        !isAdvancedMode ? null : kmzColorOptions.length === 0 ? (
                          <TextField
                            label="Колір"
                            type="color"
                            size="small"
                            value={selectedColorFromKmz}
                            onChange={(event) => {
                              onSetSelectedColorFromKmz(event.target.value);
                              onSetCreateForm((prev) => ({
                                ...prev,
                                colorHex: event.target.value,
                              }));
                            }}
                            disabled={formBlocked}
                            sx={{ width: '140px' }}
                          />
                        ) : (
                          <Box sx={{ display: 'flex', flexDirection: 'column', rowGap: 1.5 }}>
                            <Box
                              sx={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                px: 1.5,
                              }}
                            >
                              <Box sx={{ display: 'flex', alignItems: 'center', columnGap: 1 }}>
                                <Button
                                  size="small"
                                  sx={{ px: '9px' }}
                                  onClick={() =>
                                    onSetKmzColorOptions((prev) =>
                                      prev.map((option) => ({ ...option, selected: true })),
                                    )
                                  }
                                  disabled={formBlocked}
                                >
                                  Обрати всі
                                </Button>
                                <Button
                                  size="small"
                                  sx={{ px: '9px' }}
                                  onClick={() =>
                                    onSetKmzColorOptions((prev) =>
                                      prev.map((option) => ({ ...option, selected: false })),
                                    )
                                  }
                                  disabled={formBlocked}
                                >
                                  Зняти всі
                                </Button>
                              </Box>
                              <Typography variant="body2" color="text.secondary">
                                {`Обрано ${selectedKmzColorsCount} з ${kmzColorOptions.length}`}
                              </Typography>
                            </Box>
                            {kmzColorOptions.map((option) => (
                              <Paper key={option.colorHex} variant="outlined" sx={{ p: 1.5 }}>
                                <Stack
                                  direction="row"
                                  spacing={2}
                                  alignItems="center"
                                  sx={{ width: '100%' }}
                                >
                                  <FormControlLabel
                                    sx={{ m: 0, flex: 1 }}
                                    control={
                                      <Checkbox
                                        size="small"
                                        checked={option.selected}
                                        disabled={formBlocked}
                                        onChange={() =>
                                          onSetKmzColorOptions((prev) =>
                                            prev.map((entry) =>
                                              entry.colorHex === option.colorHex
                                                ? { ...entry, selected: !entry.selected }
                                                : entry,
                                            ),
                                          )
                                        }
                                      />
                                    }
                                    label={
                                      <Stack direction="row" spacing={1} alignItems="center">
                                        <PowerChip
                                          label={option.colorHex}
                                          size="small"
                                          fontSize="0.875rem"
                                          fontWeight={600}
                                          backgroundColor={option.colorHex}
                                          autoTextContrast
                                          interactive={false}
                                          unselectedOpacity={1}
                                          fontFamily="monospace"
                                          unselectedBorderColor="transparent"
                                        />
                                        <Typography variant="caption">
                                          топ #{option.rank} ({option.count})
                                        </Typography>
                                      </Stack>
                                    }
                                  />
                                  <TextField
                                    size="small"
                                    label="Суфікс"
                                    value={option.suffix}
                                    disabled={formBlocked}
                                    onChange={(event) =>
                                      onSetKmzColorOptions((prev) =>
                                        prev.map((entry) =>
                                          entry.colorHex === option.colorHex
                                            ? { ...entry, suffix: event.target.value }
                                            : entry,
                                        ),
                                      )
                                    }
                                    sx={{ minWidth: '220px', ml: 'auto' }}
                                  />
                                </Stack>
                              </Paper>
                            ))}
                          </Box>
                        )
                      }
                    />
                  </Box>
                </Stack>
              ) : null}
            </Stack>
          </Box>
          <Box
            sx={{
              p: 2.5,
              borderTop: '1px solid',
              borderColor: 'divider',
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 2,
            }}
          >
            <Button onClick={onClose} disabled={dismissBlocked}>
              Скасувати
            </Button>
            {activeStep > 0 ? (
              <Button
                onClick={() => setActiveStep((prev) => prev - 1)}
                disabled={dismissBlocked || !referenceDataReady}
              >
                Назад
              </Button>
            ) : null}
            {activeStep < steps.length - 1 ? (
              <Button
                variant="contained"
                onClick={() => setActiveStep((prev) => prev + 1)}
                disabled={!canContinueStep(activeStep)}
              >
                Далі
              </Button>
            ) : (
              <Button onClick={() => onCreate(createMode)} variant="contained" disabled={canCreate}>
                {createInFlight ? <CircularProgress size={16} /> : 'Додати'}
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
                  {kmzAnalyzing ? `Аналіз файлу${ELLIPSIS}` : `Додавання палітри${ELLIPSIS}`}
                </Typography>
              </Stack>
            </Box>
          ) : null}
        </Box>
      </Drawer>
    </>
  );
}

export const CreatePalitraDrawer = memo(CreatePalitraDrawerComponent);
