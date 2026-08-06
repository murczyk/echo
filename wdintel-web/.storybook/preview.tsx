import type { Preview, Decorator } from '@storybook/react-vite';
import CssBaseline from '@mui/material/CssBaseline';
import { useEffect, type ReactNode } from 'react';

import '@echoua/echo-audio-player/register';
import 'bootstrap/dist/css/bootstrap.css';
import '../src/styles/style.css';

import { NeoMuiThemeProvider } from '../src/ts/react/mui-theme';
import { AudioTranscriptionPreferencesProvider } from '../src/ts/react/routes/shared/message-card/MessageCardAudioTranscription';

type ThemeMode = 'light' | 'dark';

function applyDocumentTheme(theme: ThemeMode) {
  document.documentElement.setAttribute('data-bs-theme', theme);
  window.dispatchEvent(new Event('echo-theme-applied'));
}

function StoryShell({
  theme,
  transcriptionCollapsed,
  transcriptionEnabled,
  children,
}: {
  theme: ThemeMode;
  transcriptionCollapsed: boolean;
  transcriptionEnabled: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    applyDocumentTheme(theme);
  }, [theme]);

  return (
    <NeoMuiThemeProvider>
      <CssBaseline />
      <AudioTranscriptionPreferencesProvider
        collapsedByDefault={transcriptionCollapsed}
        enabled={transcriptionEnabled}
      >
        <div
          className="min-h-screen"
          style={{
            background: 'var(--background-color)',
            color: 'var(--text-color)',
            padding: 16,
          }}
        >
          <ul className="m-0 p-0 list-none max-w-[480px]">{children}</ul>
        </div>
      </AudioTranscriptionPreferencesProvider>
    </NeoMuiThemeProvider>
  );
}

const withAppChrome: Decorator = (Story, context) => {
  const theme = (context.globals.theme as ThemeMode | undefined) ?? 'light';
  const transcriptionCollapsed = Boolean(context.parameters.audioTranscriptionCollapsed);
  const transcriptionEnabled = context.parameters.audioTranscriptionEnabled !== false;

  return (
    <StoryShell
      theme={theme}
      transcriptionCollapsed={transcriptionCollapsed}
      transcriptionEnabled={transcriptionEnabled}
    >
      <Story />
    </StoryShell>
  );
};

const preview: Preview = {
  parameters: {
    layout: 'fullscreen',
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
  },
  globalTypes: {
    theme: {
      description: 'App color theme (data-bs-theme)',
      toolbar: {
        title: 'Theme',
        icon: 'circlehollow',
        items: [
          { value: 'light', title: 'Light', icon: 'sun' },
          { value: 'dark', title: 'Dark', icon: 'moon' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: {
    theme: 'light',
  },
  decorators: [withAppChrome],
};

export default preview;
