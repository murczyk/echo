import type {
  AdminAnalyticsTag,
  AnalyticsTagIdReq,
  CreateAnalyticsTagReq,
  ListAnalyticsTagTestFilesRsp,
  RuleExpression,
  RuleField,
  RuleMatcher,
  SaveAnalyticsTagRuleReq,
  TestAnalyticsTagRuleReq,
  TestAnalyticsTagRuleRsp,
  UpdateAnalyticsTagReq,
} from '../../../../Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';
import { postJson } from './client';
import type { RequestOptions } from './client';
type WireRuleExpression =
  | { op: 'all'; children: WireRuleExpression[] }
  | { op: 'any'; children: WireRuleExpression[] }
  | { op: 'not'; child: WireRuleExpression }
  | { op: 'match'; field: RuleField; matcher: RuleMatcher; values: string[] };

type WireAdminAnalyticsTag = Omit<AdminAnalyticsTag, 'ruleExpression'> & {
  ruleExpression: WireRuleExpression | null;
};

type WireListAnalyticsTagsRsp = {
  tags: WireAdminAnalyticsTag[];
};

function serializeRuleExpression(expression: RuleExpression): WireRuleExpression {
  if ('all' in expression) {
    return { op: 'all', children: expression.all.children.map(serializeRuleExpression) };
  }
  if ('any' in expression) {
    return { op: 'any', children: expression.any.children.map(serializeRuleExpression) };
  }
  if ('not' in expression) {
    return { op: 'not', child: serializeRuleExpression(expression.not.child) };
  }
  return {
    op: 'match',
    field: expression.match.field,
    matcher: expression.match.matcher,
    values: expression.match.values,
  };
}

function deserializeRuleExpression(expression: WireRuleExpression): RuleExpression {
  switch (expression.op) {
    case 'all':
      return { all: { children: expression.children.map(deserializeRuleExpression) } };
    case 'any':
      return { any: { children: expression.children.map(deserializeRuleExpression) } };
    case 'not':
      return { not: { child: deserializeRuleExpression(expression.child) } };
    case 'match':
      return {
        match: {
          field: expression.field,
          matcher: expression.matcher,
          values: expression.values,
        },
      };
  }
}

function normalizeAdminAnalyticsTag(tag: WireAdminAnalyticsTag): AdminAnalyticsTag {
  return {
    ...tag,
    ruleExpression:
      tag.ruleExpression === null ? null : deserializeRuleExpression(tag.ruleExpression),
  };
}

async function postAnalytics<TResponse>(
  path: string,
  body?: object,
  options?: RequestOptions,
): Promise<TResponse> {
  const data = await postJson(
    path,
    body === undefined ? undefined : transformCamelToSnake(body),
    options,
  );
  return transformSnakeToCamel<TResponse>(data);
}

export async function listAdminAnalyticsTags(
  options?: RequestOptions,
): Promise<{ tags: AdminAnalyticsTag[] }> {
  const rsp = await postAnalytics<WireListAnalyticsTagsRsp>(
    '/api/admin/device-analytics/tags/list',
    undefined,
    options,
  );
  return { tags: rsp.tags.map(normalizeAdminAnalyticsTag) };
}

export async function createAnalyticsTag(
  req: CreateAnalyticsTagReq,
  options?: RequestOptions,
): Promise<AdminAnalyticsTag> {
  const tag = await postAnalytics<WireAdminAnalyticsTag>(
    '/api/admin/device-analytics/tags/create',
    req,
    options,
  );
  return normalizeAdminAnalyticsTag(tag);
}

export async function updateAnalyticsTag(
  req: UpdateAnalyticsTagReq,
  options?: RequestOptions,
): Promise<AdminAnalyticsTag> {
  const tag = await postAnalytics<WireAdminAnalyticsTag>(
    '/api/admin/device-analytics/tags/update',
    req,
    options,
  );
  return normalizeAdminAnalyticsTag(tag);
}

export async function archiveAnalyticsTag(
  req: AnalyticsTagIdReq,
  options?: RequestOptions,
): Promise<AdminAnalyticsTag> {
  const tag = await postAnalytics<WireAdminAnalyticsTag>(
    '/api/admin/device-analytics/tags/archive',
    req,
    options,
  );
  return normalizeAdminAnalyticsTag(tag);
}

export async function restoreAnalyticsTag(
  req: AnalyticsTagIdReq,
  options?: RequestOptions,
): Promise<AdminAnalyticsTag> {
  const tag = await postAnalytics<WireAdminAnalyticsTag>(
    '/api/admin/device-analytics/tags/restore',
    req,
    options,
  );
  return normalizeAdminAnalyticsTag(tag);
}

export async function saveAnalyticsTagRule(
  req: SaveAnalyticsTagRuleReq,
  options?: RequestOptions,
): Promise<AdminAnalyticsTag> {
  const tag = await postAnalytics<WireAdminAnalyticsTag>(
    '/api/admin/device-analytics/tags/rule/save',
    {
      ...req,
      ruleExpression:
        req.ruleExpression === null ? null : serializeRuleExpression(req.ruleExpression),
    },
    options,
  );
  return normalizeAdminAnalyticsTag(tag);
}

export function listAnalyticsTagTestFiles(
  req: AnalyticsTagIdReq,
  options?: RequestOptions,
): Promise<ListAnalyticsTagTestFilesRsp> {
  return postAnalytics('/api/admin/device-analytics/tags/rule/test-files/list', req, options);
}

export function testAnalyticsTagRule(
  req: TestAnalyticsTagRuleReq,
  options?: RequestOptions,
): Promise<TestAnalyticsTagRuleRsp> {
  return postAnalytics(
    '/api/admin/device-analytics/tags/rule/test',
    {
      ...req,
      ruleExpression:
        req.ruleExpression === null ? null : serializeRuleExpression(req.ruleExpression),
    },
    options,
  );
}
