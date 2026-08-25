-- Minimal company used by the two privilege-ceiling suites.
-- UUID suffixes make the role visible while debugging a failed CI database.
\set company_id '00000000-0000-4000-8000-000000000480'

INSERT INTO agents (id, company_id, name, title, reports_to, metadata) VALUES
('00000000-0000-4000-8000-000000000001', :'company_id', 'Fixture Owner', 'Owner', NULL,
 '{"orgRoleId":"P0","permissionProfile":"P0_OWNER"}'),
('00000000-0000-4000-8000-000000000002', :'company_id', 'Fixture President', 'President and COO', NULL,
 '{"orgRoleId":"O1","permissionProfile":"P1_PRESIDENT_COO"}'),
('00000000-0000-4000-8000-000000000003', :'company_id', 'Fixture Chief of Staff', 'Chief of Staff', '00000000-0000-4000-8000-000000000002',
 '{"orgRoleId":"O2","permissionProfile":"P2_OWNER_COS"}'),
('00000000-0000-4000-8000-000000000004', :'company_id', 'Fixture Audit', 'Audit and Risk', NULL,
 '{"orgRoleId":"O3","permissionProfile":"P3_AUDIT_RISK"}'),
('00000000-0000-4000-8000-000000000005', :'company_id', 'Fixture Steward', 'Provisioning Steward', '00000000-0000-4000-8000-000000000002',
 '{"orgRoleId":"A0","permissionProfile":"P4_PROVISIONING_STEWARD"}'),
('00000000-0000-4000-8000-000000000006', :'company_id', 'Fixture Tech Chief', 'Technology Chief', '00000000-0000-4000-8000-000000000002',
 '{"orgRoleId":"T0","permissionProfile":"B2_TECH_CHIEF"}'),
('00000000-0000-4000-8000-000000000007', :'company_id', 'Fixture Security Chief', 'Security Chief', '00000000-0000-4000-8000-000000000002',
 '{"orgRoleId":"S0","permissionProfile":"B3_SECURITY_CHIEF"}'),
('00000000-0000-4000-8000-000000000008', :'company_id', 'Fixture Finance Chief', 'Finance Chief', '00000000-0000-4000-8000-000000000002',
 '{"orgRoleId":"F0","permissionProfile":"B4_FINANCE_CHIEF"}');

INSERT INTO company_memberships (company_id, principal_type, principal_id, status, membership_role)
SELECT :'company_id', 'agent', id::text, 'active', 'member' FROM agents;

INSERT INTO principal_permission_grants
  (company_id, principal_type, principal_id, permission_key, scope)
SELECT :'company_id', 'agent', '00000000-0000-4000-8000-000000000006', permission_key,
       CASE WHEN self_scoped THEN jsonb_build_object('subtreeRootAgentId','00000000-0000-4000-8000-000000000006') ELSE NULL END
FROM (VALUES
  ('agents:configure',true), ('tasks:assign_scope',true),
  ('tasks:manage_active_checkouts',true), ('skills:create',false),
  ('environments:manage',false), ('tools:manage_connections',false),
  ('tools:view_audit',false), ('tools:manage_runtime',false)
) AS g(permission_key,self_scoped);
