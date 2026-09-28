SELECT json_build_object(
  'namespace', (SELECT namespace FROM ai_agent_dispatcher WHERE id=1),
  'dispatcher', (SELECT json_build_object('host',host,'port',port,'ssh_user',ssh_user) FROM ai_agent_dispatcher WHERE id=1),
  'enabled', (SELECT feature_enabled FROM ai_agent_settings WHERE id=1),
  'template_id', (SELECT template_login_id FROM ai_agent_settings WHERE id=1),
  'active_requests', (SELECT count(*) FROM ai_agent_request WHERE state IN ('queued','running')),
  'migrations', (SELECT coalesce(json_agg(version),'[]') FROM seaql_migrations),
  'containers', (SELECT coalesce(json_agg(json_build_object('name',c.instance_name,'state',c.state,'human_id',l.human_login_id,'agent_id',l.agent_login_id) ORDER BY c.instance_name),'[]') FROM ai_agent_container c JOIN ai_agent_user_link l ON l.id=c.ai_agent_user_link_id)
)::jsonb AS inventory;
