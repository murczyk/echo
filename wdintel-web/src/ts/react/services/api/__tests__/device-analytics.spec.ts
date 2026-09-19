/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { RuleExpression } from '../../../../../Bindings';
import {
  listAdminAnalyticsTags,
  listAnalyticsTagTestFiles,
  testAnalyticsTagRule,
} from '../device-analytics';

const TAG_ID = '018f0000-0000-7000-8000-000000000101';
const CREATED_AT = '2026-08-06T12:00:00Z';

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: Mock;

function requestBody(index = 0) {
  const init = fetchMock.mock.calls[index][1] as RequestInit;
  return init.body === undefined ? undefined : JSON.parse(String(init.body));
}

const expression: RuleExpression = {
  all: {
    children: [
      {
        match: {
          field: 'full_path',
          matcher: 'contains_token',
          values: ['report'],
        },
      },
      {
        not: {
          child: {
            match: {
              field: 'extension',
              matcher: 'equals',
              values: ['tmp'],
            },
          },
        },
      },
    ],
  },
};

const wireExpression = {
  op: 'all',
  children: [
    {
      op: 'match',
      field: 'full_path',
      matcher: 'contains_token',
      values: ['report'],
    },
    {
      op: 'not',
      child: {
        op: 'match',
        field: 'extension',
        matcher: 'equals',
        values: ['tmp'],
      },
    },
  ],
};

function wireTag() {
  return {
    id: TAG_ID,
    name: 'Звіти',
    rule_expression: wireExpression,
    archived_at: null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

describe('device analytics API service', () => {
  it('normalizes the strict tagged rule expression returned by the admin API', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ tags: [wireTag()] }));

    const rsp = await listAdminAnalyticsTags();

    expect(requestBody()).toBeUndefined();
    expect(rsp.tags[0]).toMatchObject({ id: TAG_ID, name: 'Звіти', ruleExpression: expression });
  });
  it('lists reusable test files for a tag', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        files: [
          {
            absolute_path: 'C:\\reports\\report.pdf',
            expected_match: true,
          },
        ],
      }),
    );

    const rsp = await listAnalyticsTagTestFiles({ id: TAG_ID });

    expect(rsp.files).toEqual([
      {
        absolutePath: 'C:\\reports\\report.pdf',
        expectedMatch: true,
      },
    ]);
  });
  it('normalizes local-expression test results', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ results: [{ index: 0, matched: true, passed: true }] }),
    );

    const rsp = await testAnalyticsTagRule({
      id: TAG_ID,
      ruleExpression: expression,
      files: [{ absolutePath: 'C:\\reports\\report.pdf', expectedMatch: true }],
    });

    expect(rsp.results).toEqual([{ index: 0, matched: true, passed: true }]);
  });
});
