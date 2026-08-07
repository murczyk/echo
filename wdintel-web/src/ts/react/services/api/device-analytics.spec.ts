/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { RuleExpression } from '../../../../Bindings';
import {
  listAdminAnalyticsTags,
  listAnalyticsTagTestFiles,
  saveAnalyticsTagRule,
  testAnalyticsTagRule,
} from './device-analytics';

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

  it('serializes the editor expression to the strict tagged rule DSL on save', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(wireTag()));

    const saved = await saveAnalyticsTagRule({ id: TAG_ID, ruleExpression: expression });

    expect(requestBody()).toEqual({ id: TAG_ID, rule_expression: wireExpression });
    expect(saved.ruleExpression).toEqual(expression);
  });

  it('lists reusable test files for a tag', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        files: [
          {
            name: 'report.pdf',
            absolute_path: 'C:\\reports\\report.pdf',
            extension: 'pdf',
          },
        ],
      }),
    );

    const rsp = await listAnalyticsTagTestFiles({ id: TAG_ID });

    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/admin/device-analytics/tags/rule/test-files/list',
    );
    expect(requestBody()).toEqual({ id: TAG_ID });
    expect(rsp.files).toEqual([
      {
        name: 'report.pdf',
        absolutePath: 'C:\\reports\\report.pdf',
        extension: 'pdf',
      },
    ]);
  });

  it('tests the local expression and stores its reusable files', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [{ index: 0, matched: true }] }));

    const rsp = await testAnalyticsTagRule({
      id: TAG_ID,
      ruleExpression: expression,
      files: [{ name: 'report.pdf', absolutePath: 'C:\\reports\\report.pdf', extension: 'pdf' }],
    });

    expect(requestBody()).toEqual({
      id: TAG_ID,
      rule_expression: wireExpression,
      files: [{ name: 'report.pdf', absolute_path: 'C:\\reports\\report.pdf', extension: 'pdf' }],
    });
    expect(rsp.results).toEqual([{ index: 0, matched: true }]);
  });
});
