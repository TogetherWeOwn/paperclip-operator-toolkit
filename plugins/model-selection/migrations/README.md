This plugin owns no tables of its own.

The database namespace is declared in the manifest only because `ctx.db` is
not wired until the plugin has an ACTIVE namespace: `getRuntimeNamespace`
throws otherwise (plugin-database.ts:413-419), and `ensureNamespace` returns
null unless `manifest.database` is present (plugin-database.ts:469-471).

The read we actually need is `public.heartbeat_runs`, granted through
`database.coreReadTables` and enforced per query by `assertAllowedPublicRead`
(plugin-database.ts:157-168) — not a table in this schema.

This directory is intentionally free of .sql files. `listSqlMigrationFiles`
returns an empty list and the apply loop no-ops, but the directory itself must
exist because that function calls readdir on it unconditionally
(plugin-database.ts:328-334). Do not add an empty .sql file here: a migration
file with no statements throws "Plugin migration <key> is empty"
(plugin-database.ts:497).
