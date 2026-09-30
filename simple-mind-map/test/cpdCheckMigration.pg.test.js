const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawnSync } = require('child_process')
const { CREATE_SCHEMA_SQL } = require('../bin/checkRuns/store')

test('检查报告迁移可重复运行，约束和索引在真实PostgreSQL中有效，验证结束回滚', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../migrations/008_check_runs_v1.sql'), 'utf8')
  const schema = `cpd_verify_${crypto.randomBytes(8).toString('hex')}`
  const sql = `
    begin;
    create schema ${schema};
    set local search_path to ${schema};
    ${migration}
    ${migration}
    ${CREATE_SCHEMA_SQL}
    ${CREATE_SCHEMA_SQL}
    insert into check_runs(run_id, room_key, node_uid, actor_id, request_id,
      chain_fingerprint, rule_version, status)
      values ('00000000-0000-4000-8000-000000000001','room-a','D1','user-1','request-1','v1','rules1','passed');
    update check_runs set report = '{"revision":2,"reviewDecisions":[{"requestId":"review-1"}]}'::jsonb
      where room_key='room-a' and coalesce((report->>'revision')::int,1)=1;
    update check_runs set report = '{"revision":3}'::jsonb
      where room_key='room-a' and coalesce((report->>'revision')::int,1)=1;
    do $validation$
    begin
      if (select (report->>'revision')::int from check_runs where room_key='room-a') <> 2 then
        raise exception 'revision conflict overwrote report';
      end if;
      if (select jsonb_array_length(report->'reviewDecisions') from check_runs where room_key='room-a') <> 1 then
        raise exception 'review audit lost';
      end if;
      if (select count(*) from check_runs where room_key = 'room-b') <> 0 then
        raise exception 'room query leaked';
      end if;
      if not exists(select 1 from pg_indexes where schemaname = '${schema}' and indexname = 'check_runs_room_node_created_idx') then
        raise exception 'history index missing';
      end if;
      begin
        insert into check_runs(run_id,room_key,node_uid,actor_id,request_id,chain_fingerprint,rule_version,status)
        values ('00000000-0000-4000-8000-000000000002','room-a','D1','user-1','request-1','v1','rules1','passed');
        raise exception 'duplicate request allowed';
      exception when unique_violation then null;
      end;
      begin
        update check_runs set status = 'unchecked';
        raise exception 'invalid status allowed';
      exception when check_violation then null;
      end;
    end $validation$;
    rollback;
  `
  const result = spawnSync('docker', ['exec', '-i', process.env.CPD_TEST_PG_CONTAINER || 'mind-map-postgres-1',
    'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', process.env.CPD_TEST_PG_USER || 'postgres',
    '-d', process.env.CPD_TEST_PG_DATABASE || 'mind_map'], { input: sql, encoding: 'utf8', timeout: 30000 })
  assert.equal(result.status, 0, result.stderr || String(result.error || 'PostgreSQL validation failed'))
  assert.match(result.stdout, /ROLLBACK/)
})

test('实际附件读取SQL遵守链路范围和全文预算，验证结束回滚', () => {
  const source = fs.readFileSync(path.join(__dirname, '../bin/mindApi.js'), 'utf8')
  const query = source.match(/`(with scoped_attachments as \([\s\S]*?from budgeted order by id)`/)[1]
    .replace(/\$1/g, "'room-a'").replace(/\$2/g, "ARRAY['D1']").replace(/\$3/g, "ARRAY['shared']")
  const schema = `cpd_attachment_${crypto.randomBytes(8).toString('hex')}`
  const sql = `begin; create schema ${schema}; set local search_path to ${schema};
    create table node_attachments(id text,node_uid text,file_name text,content_hash text,status text,
      updated_at timestamptz,extracted_text text,room_key text);
    insert into node_attachments values
      ('a','D1','a','h','ready',now(),repeat('甲',250000),'room-a'),
      ('b','D1','b','h','ready',now(),repeat('乙',250000),'room-a'),
      ('c','D1','c','h','ready',now(),'未读','room-a'),
      ('shared','other','s','h','ready',now(),'共享','room-a'),
      ('private','D1','p','h','ready',now(),'不可读','room-b');
    create temporary table actual as ${query};
    do $validation$ begin
      if (select count(*) from actual) <> 4 then raise exception 'scope incorrect'; end if;
      if (select sum(read_chars) from actual) <> 400001 then raise exception 'budget incorrect'; end if;
      if (select read_chars from actual where id='b') <> 200000 then raise exception 'second text incorrect'; end if;
      if (select content from actual where id='c') <> '' then raise exception 'budget exceeded'; end if;
    end $validation$; rollback;`
  const result = spawnSync('docker', ['exec', '-i', process.env.CPD_TEST_PG_CONTAINER || 'mind-map-postgres-1',
    'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', process.env.CPD_TEST_PG_USER || 'postgres',
    '-d', process.env.CPD_TEST_PG_DATABASE || 'mind_map'], { input: sql, encoding: 'utf8', timeout: 30000 })
  assert.equal(result.status, 0, result.stderr || String(result.error || 'PostgreSQL validation failed'))
  assert.match(result.stdout, /ROLLBACK/)
})
