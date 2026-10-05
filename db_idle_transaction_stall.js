#!/usr/bin/env node
'use strict';

// Detect PostgreSQL sessions left idle in an open transaction. This is a
// read-only staleness probe: it opens one short connection to the database
// named by DATABASE_URL, reads pg_stat_activity, and closes the connection.

const DEFAULT_MAX_AGE_MINUTES = 5;

function usage() {
  process.stderr.write(
    'usage: db_idle_transaction_stall.js [--json] [--max-age-minutes N]\n' +
    '\n' +
    'Exit 0: no stale idle transaction; 1: stall detected; 2: unmeasured.\n',
  );
}

function parseArgs(argv) {
  let json = false;
  let maxAgeMinutes = DEFAULT_MAX_AGE_MINUTES;

  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--json':
        json = true;
        break;
      case '--max-age-minutes': {
        i += 1;
        const value = argv[i];
        if (!value || !/^[1-9][0-9]*$/.test(value)) {
          throw new Error('--max-age-minutes needs a positive whole number');
        }
        maxAgeMinutes = Number(value);
        break;
      }
      case '-h':
      case '--help':
        usage();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${argv[i]}`);
    }
  }

  return { json, maxAgeMinutes };
}

// The probe's own node_modules may not include `pg`, while the application's
// pnpm store does. Resolve by glob rather than a hard-coded version so an
// upgrade doesn't turn this into a silent "cannot find module".
function requirePg() {
  const fs = require('fs');
  const path = require('path');
  const roots = [process.env.PAPERCLIP_PG_MODULE, '/app/node_modules/pg'].filter(Boolean);
  for (const root of roots) {
    try {
      return require(root);
    } catch {
      // keep looking
    }
  }
  const store = '/app/node_modules/.pnpm';
  let entries = [];
  try {
    entries = fs.readdirSync(store);
  } catch {
    // no store
  }
  const candidates = entries
    .filter((entry) => /^pg@\d/.test(entry))
    .sort()
    .reverse()
    .map((entry) => path.join(store, entry, 'node_modules', 'pg'));
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // keep looking
    }
  }
  try {
    return require('pg');
  } catch (error) {
    throw new Error(`the pg package is required: ${error.code || error.message}`);
  }
}

function emit(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (result.verdict === 'stall') {
    process.stdout.write('DATABASE IDLE-TRANSACTION STALL DETECTED\n');
  } else if (result.verdict === 'ok') {
    process.stdout.write('No stale idle transaction detected\n');
  } else {
    process.stdout.write('INCONCLUSIVE -- database activity was not measured\n');
  }
  process.stdout.write(`  checked at                   ${result.checkedAt}\n`);
  process.stdout.write(`  threshold                    ${result.maxAgeMinutes} min\n`);
  if (result.measured) {
    process.stdout.write(`  connections                  ${result.totalConnections}/${result.maxConnections}\n`);
    process.stdout.write(`  idle                         ${result.idleConnections}\n`);
    process.stdout.write(`  idle in transaction          ${result.idleInTransaction}\n`);
    process.stdout.write(`  stale idle in transaction    ${result.staleIdleInTransaction}\n`);
    process.stdout.write(`  oldest stale transaction     ${result.oldestStaleMinutes} min\n`);
  }
  for (const reason of result.reasons) process.stdout.write(`  - ${reason}\n`);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`);
    usage();
    process.exitCode = 2;
    return;
  }

  const checkedAt = new Date().toISOString();
  if (!process.env.DATABASE_URL) {
    const result = {
      verdict: 'inconclusive',
      measured: false,
      checkedAt,
      maxAgeMinutes: options.maxAgeMinutes,
      reasons: ['DATABASE_URL is not set, so pg_stat_activity was not queried.'],
      exitCode: 2,
    };
    emit(result, options.json);
    process.exitCode = 2;
    return;
  }

  let Client;
  try {
    ({ Client } = requirePg());
  } catch (error) {
    const result = {
      verdict: 'inconclusive',
      measured: false,
      checkedAt,
      maxAgeMinutes: options.maxAgeMinutes,
      reasons: [error.message],
      exitCode: 2,
    };
    emit(result, options.json);
    process.exitCode = 2;
    return;
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    application_name: 'paperclip-db-idle-transaction-monitor',
  });

  try {
    await client.connect();
    const { rows } = await client.query(
      `with settings as (
         select setting::int as max_connections
           from pg_settings
          where name = 'max_connections'
       )
       select
         count(*) filter (where a.pid <> pg_backend_pid())::int as total_connections,
         count(*) filter (where a.pid <> pg_backend_pid() and a.state = 'idle')::int as idle_connections,
         count(*) filter (where a.pid <> pg_backend_pid() and a.state = 'idle in transaction')::int as idle_in_transaction,
         count(*) filter (
           where a.pid <> pg_backend_pid()
             and a.state = 'idle in transaction'
             and now() - a.state_change > make_interval(mins => $1::int)
         )::int as stale_idle_in_transaction,
         coalesce(floor(extract(epoch from max(now() - a.state_change) filter (
           where a.pid <> pg_backend_pid()
             and a.state = 'idle in transaction'
             and now() - a.state_change > make_interval(mins => $1::int)
         )) / 60), 0)::int as oldest_stale_minutes,
         settings.max_connections
       from pg_stat_activity a
       cross join settings
       where a.datname = current_database()
       group by settings.max_connections`,
      [options.maxAgeMinutes],
    );

    if (rows.length !== 1) throw new Error(`expected one aggregate row, got ${rows.length}`);
    const row = rows[0];
    const stale = Number(row.stale_idle_in_transaction);
    const result = {
      verdict: stale > 0 ? 'stall' : 'ok',
      measured: true,
      checkedAt,
      maxAgeMinutes: options.maxAgeMinutes,
      totalConnections: Number(row.total_connections),
      idleConnections: Number(row.idle_connections),
      idleInTransaction: Number(row.idle_in_transaction),
      staleIdleInTransaction: stale,
      oldestStaleMinutes: Number(row.oldest_stale_minutes),
      maxConnections: Number(row.max_connections),
      reasons: stale > 0
        ? [`${stale} connection(s) have been idle in an open transaction for more than ${options.maxAgeMinutes} minutes.`]
        : [],
      exitCode: stale > 0 ? 1 : 0,
    };
    emit(result, options.json);
    process.exitCode = result.exitCode;
  } catch (error) {
    const result = {
      verdict: 'inconclusive',
      measured: false,
      checkedAt,
      maxAgeMinutes: options.maxAgeMinutes,
      reasons: [`pg_stat_activity query failed: ${error.code || error.name}: ${error.message}`],
      exitCode: 2,
    };
    emit(result, options.json);
    process.exitCode = 2;
  } finally {
    await client.end().catch(() => {});
  }
}

main();
