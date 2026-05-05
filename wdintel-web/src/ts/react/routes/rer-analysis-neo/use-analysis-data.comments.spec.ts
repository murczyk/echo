import { describe, expect, it } from 'vitest';

import type { MessageComment, User } from '../../../../Bindings';
import { filterOtherMessageComments } from './use-analysis-data.comments';

function buildUser(overrides: Partial<User>): User {
  return {
    name: 'tester',
    roles: [],
    sigintZoneId: null,
    organismId: null,
    deltaLogin: null,
    goiConfiguredForOrganism: false,
    goiFullAccessForOrganism: false,
    goiHost: null,
    goiIntegrations: [],
    ...overrides,
  };
}

function buildComment(overrides: Partial<MessageComment>): MessageComment {
  return {
    id: 1,
    messageId: 42,
    login: 'peer-login',
    comment: 'peer comment',
    ...overrides,
  };
}

describe('filterOtherMessageComments', () => {
  it('fails closed until organism identity is known', () => {
    const comments = [buildComment({ login: 'unknown-peer' })];

    expect(filterOtherMessageComments('tester', null, {}, comments)).toEqual([]);
    expect(filterOtherMessageComments('tester', buildUser({ organismId: 1 }), {}, comments)).toEqual([]);
    expect(filterOtherMessageComments('tester', buildUser({ organismId: 1 }), { 'unknown-peer': null }, comments)).toEqual([]);
  });

  it('keeps only confirmed same-organism comments from other users', () => {
    const comments = [buildComment({ login: 'peer-login' }), buildComment({ login: 'tester' })];
    const currentUser = buildUser({ name: 'tester', organismId: 1 });

    expect(
      filterOtherMessageComments('tester', currentUser, {
        'peer-login': buildUser({ name: 'peer-login', organismId: 1 }),
      }, comments),
    ).toEqual([comments[0]]);
  });
});
