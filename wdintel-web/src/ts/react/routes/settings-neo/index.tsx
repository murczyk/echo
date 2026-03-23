import {
  Alert,
  Autocomplete,
  Box,
  Card,
  CircularProgress,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useMemo, useState } from "react";
import type { FormEvent, SyntheticEvent } from "react";

import { SettingsSaveReq, SigintZone } from "../../../../Bindings";
import { PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/mui-customized/button";
import { isUnauthorizedError } from "../../services/api/client";
import { fetchServerInfo } from "../../services/api/server-info";
import { fetchCurrentUser, saveUserSettings } from "../../services/api/user";
import { listSigintZones } from "../../services/api/zones";

type ZonePair = [number, SigintZone];
type ZoneOption = { id: number; label: string };

export type SettingsSection = "general" | "duty";

type SettingsNeoPageProps = {
  section?: SettingsSection;
};

const SETTINGS_SECTION_QUERY_PARAM = "section";

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error;
  return "Невідома помилка. Спробуйте ще раз.";
}

function toSettingsSaveReq(sigintZoneId: number | null): SettingsSaveReq {
  return { sigintZoneId };
}

function parseSettingsSection(section: string | null | undefined): SettingsSection {
  if (section === "duty") return section;
  return "general";
}

function readSettingsSectionFromUrl(): SettingsSection {
  return parseSettingsSection(new URLSearchParams(window.location.search).get(SETTINGS_SECTION_QUERY_PARAM));
}

function syncUrlSection(section: SettingsSection) {
  const url = new URL(window.location.href);
  url.searchParams.set(SETTINGS_SECTION_QUERY_PARAM, section);
  url.hash = "";
  window.history.replaceState(window.history.state, "", url);
}

export function SettingsNeoPage({ section }: SettingsNeoPageProps = {}) {
  const [zones, setZones] = useState<ZonePair[]>([]);
  const [zoneId, setZoneId] = useState<number | null>(null);
  const [initialZoneId, setInitialZoneId] = useState<number | null>(null);
  const [versionText, setVersionText] = useState<string>("невідома версія");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadInProgress, setLoadInProgress] = useState(true);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [saveInProgress, setSaveInProgress] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(() => parseSettingsSection(section ?? readSettingsSectionFromUrl()));

  const zoneOptions = useMemo<ZoneOption[]>(
    () => zones.map(([id, zone]) => ({ id, label: zone.name })),
    [zones],
  );

  const selectedZone = useMemo(
    () => zoneOptions.find((option) => option.id === zoneId) ?? null,
    [zoneOptions, zoneId],
  );

  useEffect(() => {
    setSettingsSection(parseSettingsSection(section ?? readSettingsSectionFromUrl()));
  }, [section]);

  useEffect(() => {
    syncUrlSection(settingsSection);
  }, [settingsSection]);

  useEffect(() => {
    const abortController = new AbortController();

    async function loadPageData() {
      setLoadInProgress(true);
      setLoadError(null);

      try {
        const [zonesData, user] = await Promise.all([
          listSigintZones(abortController.signal),
          fetchCurrentUser(abortController.signal),
        ]);

        setZones(zonesData);
        setZoneId(user.sigintZoneId);
        setInitialZoneId(user.sigintZoneId);
        try {
          const serverInfo = await fetchServerInfo(abortController.signal);
          if (!abortController.signal.aborted) {
            setVersionText(serverInfo.version || "невідома версія");
          }
        } catch (_) {
          if (!abortController.signal.aborted) {
            setVersionText("невідома версія");
          }
        }
      } catch (error) {
        if (abortController.signal.aborted) return;
        if (isUnauthorizedError(error)) {
          window.location.assign("/login");
          return;
        }
        setLoadError(`Помилка завантаження налаштувань: ${formatErrorMessage(error)}`);
      } finally {
        if (abortController.signal.aborted) return;
        setLoadInProgress(false);
      }
    }

    loadPageData();

    return () => {
      abortController.abort();
    };
  }, []);

  const isDirty = zoneId !== initialZoneId;

  async function handleSave(event?: FormEvent) {
    event?.preventDefault();
    if (saveInProgress) return;
    if (!isDirty) return;

    setSaveError(null);
    setSaveSuccess(null);
    setSaveInProgress(true);

    try {
      await saveUserSettings(toSettingsSaveReq(zoneId));
      setInitialZoneId(zoneId);
      setSaveSuccess("Налаштування збережено");
    } catch (error) {
      if (isUnauthorizedError(error)) {
        window.location.assign("/login");
        return;
      }
      setSaveError(`Помилка збереження: ${formatErrorMessage(error)}`);
    } finally {
      setSaveInProgress(false);
    }
  }

  function handleTabChange(_: SyntheticEvent, value: SettingsSection) {
    setSettingsSection(value);
  }

  return (
    <Box className="w-full" sx={{ maxWidth: 980, mx: "auto" }}>
      <Stack spacing={2} useFlexGap>
        <PageHeader title="Налаштування" />

        <Card variant="outlined" sx={{ borderRadius: 0, boxShadow: "none", overflow: "hidden", backgroundColor: "background.paper" }}>
          <Tabs
            value={settingsSection}
            onChange={handleTabChange}
            variant="scrollable"
            allowScrollButtonsMobile
            sx={{
              minHeight: 48,
              borderBottom: 1,
              borderColor: "divider",
              flexShrink: 0,
            }}
          >
            <Tab value="general" label="ЗАГАЛЬНІ" id="settings-neo-tab-general" aria-controls="settings-neo-panel-general" sx={{ alignItems: "flex-start", textAlign: "left", minHeight: 48 }} />
            <Tab value="duty" label="ОПЕРАТИВНИЙ" id="settings-neo-tab-duty" aria-controls="settings-neo-panel-duty" sx={{ alignItems: "flex-start", textAlign: "left", minHeight: 48 }} />
          </Tabs>

          {settingsSection === "general" ? (
            <Box role="tabpanel" id="settings-neo-panel-general" aria-labelledby="settings-neo-tab-general">
              <Box component="form" onSubmit={handleSave} noValidate sx={{ p: 3 }}>
                <Stack spacing={3} sx={{ width: "100%" }}>
                  {loadError ? <Alert severity="error">{loadError}</Alert> : null}
                  {saveError ? <Alert severity="error">{saveError}</Alert> : null}
                  {saveSuccess ? (
                    <Alert severity="success" role="status">
                      {saveSuccess}
                    </Alert>
                  ) : null}

                  <Box>
                    <Autocomplete
                      size="small"
                      options={zoneOptions}
                      value={selectedZone}
                      onChange={(_, option) => {
                        setSaveSuccess(null);
                        setZoneId(option?.id ?? null);
                      }}
                      isOptionEqualToValue={(option, value) => option.id === value.id}
                      getOptionLabel={(option) => option.label}
                      clearText="Очистити"
                      noOptionsText="Немає варіантів"
                      loading={loadInProgress}
                      loadingText="Завантаження..."
                      sx={{
                        width: { xs: "100%", sm: "420px" },
                        maxWidth: "100%",
                        "& .MuiOutlinedInput-root": {
                          backgroundColor: "var(--bs-body-bg)",
                        },
                        "& .MuiAutocomplete-clearIndicator": {
                          visibility: "visible",
                          opacity: 1,
                        },
                      }}
                      renderInput={(params) => (
                        <TextField
                          {...params}
                          id="settings-zone"
                          name="settings-zone"
                          label="РЕР-напрямок"
                          placeholder="Оберіть зону"
                          helperText="Оберіть зону РЕР-напрямку для вашого облікового запису"
                        />
                      )}
                    />
                  </Box>

                  <Box sx={{ display: "flex", alignItems: { xs: "flex-start", sm: "center" }, justifyContent: "space-between", gap: 2, flexWrap: "wrap", pt: 2 }}>
                    <Typography variant="caption" color="text.secondary">
                      Версія: {versionText}
                    </Typography>
                    <Button
                      variant="contained"
                      type="submit"
                      disabled={saveInProgress || !isDirty}
                      startIcon={saveInProgress ? <CircularProgress size={18} /> : undefined}
                      sx={{ fontWeight: 500 }}
                    >
                      зберегти
                    </Button>
                  </Box>
                </Stack>
              </Box>
            </Box>
          ) : null}

          {settingsSection === "duty" ? (
            <Box id="settings-neo-panel-duty" role="tabpanel" aria-labelledby="settings-neo-tab-duty" sx={{ p: 3 }}>
              <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 960 }}>
                Налаштування оперативного режиму з’являться тут.
              </Typography>
            </Box>
          ) : null}
        </Card>
      </Stack>
    </Box>
  );
}
