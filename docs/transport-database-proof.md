# Disposable transport database proof

`test_provisioned_transport_db.py` exercises the provisioner's real SQL using
synthetic agents, secret references and run records. The agent API is an offline
executable; no agent is provisioned and no provider/model request is made.

Use only a disposable PostgreSQL service. The proof requires an explicit host
(`localhost`, `127.0.0.1`, or the agent-test service `agent-testdb`), port `5432`,
role `agent_test`, empty password and database `toolkit_transport_fixture`.
There is no URL/service/credential fallback. Children receive a small environment
without inherited provider credentials, startup hooks, service/host overrides,
proxy configuration or ambient search paths. Password files are disabled.

With native `psql` and `createdb` installed, an example for a local disposable
CI service is:

```sh
export PGHOST=localhost PGPORT=5432 PGUSER=agent_test PGPASSWORD=
export PGDATABASE=toolkit_transport_fixture
createdb --no-password toolkit_transport_fixture
python3 test_provisioned_transport_db.py --init
python3 -m unittest -v test_provisioned_transport_db
python3 -m unittest -v test_transport_db_guards
```

Do not replace the host/role with application or production credentials.
Initialization refuses a different database, an existing wrong/multiple sentinel,
or existing public relations without a matching sentinel. It never resets
application tables. The initializer is an explicit write operation, not a probe.

Tests create one random `transport_test_` schema and clean up only that schema.
Every fixture write includes the server database and exact single-row sentinel
guards in the same connection and transaction. A malformed/non-generated schema
or failed SQL operation refuses. Tests retain each stale-run/configuration,
usage-type, identity, binding, secret-status and API-vs-stored-config control.

Offline guard tests do not need PostgreSQL. Database tests deliberately fail
without their prerequisites; they are not silently skipped. Minimal projected
application tables are used, so this is SQL-behavior evidence, not schema-drift,
deployed-service, credential-authority, live smoke or production acceptance.

Local author verification used PostgreSQL through a private limited psql
argument/variable adapter backed by psycopg2-binary 2.9.10, because no native psql
client was installed in that workspace. This is not evidence of native psql
parsing/formatting or hosted CI. The ported CI step uses native psql and its own
service container; its exact-head result remains a separate release gate.
