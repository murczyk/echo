import type { ListPostsReq, Post } from '../../../../Bindings';
import { postJson } from './client';
import { transformSnakeToCamel } from '../../../snake-to-camel';

export async function listPosts(): Promise<Post[]> {
  const req: ListPostsReq = {
    sortBy: 'PostNameAsc',
  };
  const data = await postJson<Post[]>('/api/sigint/posts', { sort_by: req.sortBy });
  const normalized = transformSnakeToCamel(data);
  return Array.isArray(normalized) ? normalized : [];
}
