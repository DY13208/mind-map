// Non-operation sources (attachment extraction + legacy saves) have a separate,
// transactional PER-ROOM revision. A global sequence is not a commit-order cursor.
async function initSchema(db) {
  await db.query(`
    create table if not exists knowledge_source_state (
      room_key text primary key, revision bigint not null default 0
    );
    create table if not exists knowledge_source_changes (
      room_key text not null, revision bigint not null, uids text[] not null,
      reason text not null, primary key(room_key, revision)
    );
    create or replace function knowledge_attachment_changed() returns trigger as $$
    declare r text; ids text[]; v bigint;
    begin
      r := coalesce(NEW.room_key, OLD.room_key);
      ids := array_remove(array[NEW.node_uid, OLD.node_uid], null);
      ids := ids || array(select uid from room_nodes where room_key=r
        and deleted_at is null and data->>'attachmentId'=coalesce(NEW.id, OLD.id));
      insert into knowledge_source_state(room_key, revision) values(r, 1)
        on conflict(room_key) do update set revision = knowledge_source_state.revision + 1
        returning revision into v;
      insert into knowledge_source_changes values(r, v, ids, 'attachment');
      perform pg_notify('knowledge_events', json_build_object('roomId', r, 'revision', v)::text);
      return coalesce(NEW, OLD);
    end;
    $$ language plpgsql;
    drop trigger if exists knowledge_attachment_change on node_attachments;
    create trigger knowledge_attachment_change after insert or update or delete on node_attachments
      for each row execute function knowledge_attachment_changed();
  `)
}
async function recordLegacySave(db, roomId) {
  // Called inside the existing save transaction, only after a real tree write.
  await db.query(`with next as (
    insert into knowledge_source_state(room_key, revision) values($1, 1)
    on conflict(room_key) do update set revision = knowledge_source_state.revision + 1
    returning revision
  ) insert into knowledge_source_changes(room_key, revision, uids, reason)
    select $1, revision, array['*']::text[], 'legacy_save' from next`, [roomId])
}
module.exports = { initSchema, recordLegacySave }
