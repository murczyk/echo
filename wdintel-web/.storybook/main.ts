import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StorybookConfig } from '@storybook/react-vite';
import type { Plugin } from 'vite';
import { mergeConfig } from 'vite';

const storybookDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(storybookDir, '..');
const mockApiRoot = resolve(webRoot, 'src/stories/fixtures/mock-api');

function messengerMediaMockMiddleware(
  req: { url?: string },
  res: {
    statusCode: number;
    setHeader: (name: string, value: string) => void;
    end: (body?: string | Buffer) => void;
  },
  next: () => void,
) {
  const pathname = (req.url ?? '').split('?')[0] ?? '';
  const match = pathname.match(/^\/api\/messenger\/media\/([^/]+)\/(wave|spectrogram)$/);
  if (!match) {
    next();
    return;
  }

  const [, mediaId, kind] = match;
  try {
    const body = readFileSync(resolve(mockApiRoot, mediaId, kind));
    res.statusCode = 200;
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Not found');
  }
}

function messengerMediaMockPlugin(): Plugin {
  return {
    name: 'storybook-messenger-media-mock',
    configureServer(server) {
      server.middlewares.use(messengerMediaMockMiddleware);
    },
  };
}

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(js|jsx|mjs|ts|tsx)'],
  addons: [],
  framework: '@storybook/react-vite',
  // Wave/spectrogram mocks are served by messengerMediaMockPlugin (correct Content-Type).
  // Do not also map them via staticDirs — sirv wins and omits image/png.
  async viteFinal(config) {
    return mergeConfig(config, {
      plugins: [messengerMediaMockPlugin()],
      resolve: {
        alias: {
          react: resolve(webRoot, 'node_modules/react'),
          'react-dom': resolve(webRoot, 'node_modules/react-dom'),
        },
        dedupe: ['react', 'react-dom'],
      },
      optimizeDeps: {
        include: [
          'react',
          'react-dom',
          '@mui/material',
          '@mui/icons-material',
          '@echoua/echo-audio-player/register',
        ],
      },
    });
  },
};

export default config;
