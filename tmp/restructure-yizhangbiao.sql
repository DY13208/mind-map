begin;
insert into kb.parse_runs (file_id, options, raw_json_key, docling_status)
select f.id, '{"source":"structure"}'::jsonb, p.raw_json_key, p.docling_status
from kb.files f
left join kb.parse_runs p on p.id = f.current_run_id
where f.name = '一张表.xlsx' and f.deleted_at is null;
insert into kb.jobs (file_id, run_id, kind)
select r.file_id, r.id, 'structure'
from kb.parse_runs r
join kb.files f on f.id = r.file_id
where f.name = '一张表.xlsx' and f.deleted_at is null
order by r.created_at desc
limit 1;
update kb.files
set status = 'structuring', status_detail = 'structure queued', updated_at = now()
where name = '一张表.xlsx' and deleted_at is null;
commit;
select j.id as job_id, j.state, r.id as run_id, f.status
from kb.jobs j
join kb.parse_runs r on r.id = j.run_id
join kb.files f on f.id = j.file_id
where f.name = '一张表.xlsx'
order by j.id desc
limit 1;
