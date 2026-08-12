/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getAiAgentEngineCompatibility } from '../admin-ai-agent/engine-eligibility';
import { AiEngineCompatibilityStatus } from './AiEnginesTable';

const TOKEN_ENGINE = {
  id: 'engine-1',
  name: 'Internal router',
  url: 'http://vllm.example:8000/v1',
  modelName: 'gemma',
  enabled: true,
  hasToken: true,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
});

describe('AiEnginesTable AI-agent compatibility', () => {
  it('renders a compatible token provider with a red credential warning tooltip', async () => {
    await act(async () =>
      root.render(
        <AiEngineCompatibilityStatus
          aiEngine={TOKEN_ENGINE}
          getCompatibility={getAiAgentEngineCompatibility}
        />,
      ),
    );

    expect(container.textContent).toContain('Сумісний');
    expect(container.textContent).not.toContain('токен провайдера передається');
    expect(container.querySelector('[aria-label]')?.getAttribute('aria-label')).toBe(
      'Увага: використання цього провайдера ШІ агентом передає токен до ізольованого контейнера. Доступний для ШІ агентів.',
    );
    expect(container.querySelector('svg')?.classList.contains('MuiSvgIcon-colorError')).toBe(true);
  });
});
