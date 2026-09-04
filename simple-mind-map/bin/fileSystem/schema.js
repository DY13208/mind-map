async function initFileSystemSchema(db) {
  if (!db || typeof db.query !== 'function') return
  await db.query(`
    create table if not exists folders (
      id uuid primary key,
      parent_id uuid references folders(id) on delete restrict,
      name text not null,
      created_by text not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted_at timestamptz
    )
  `)
  await db.query(`
    create unique index if not exists folders_root_name_uniq
    on folders (lower(name))
    where deleted_at is null and parent_id is null
  `)
  await db.query(`
    create index if not exists folders_created_by_idx
    on folders (created_by)
    where deleted_at is null
  `)
  await db.query(`
    alter table rooms add column if not exists folder_id uuid
  `)
  await db.query(`
    alter table rooms add column if not exists owner_id text
  `)
  await db.query(`
    alter table rooms add column if not exists content_updated_at timestamptz
  `)
  await db.query(`
    update rooms
    set content_updated_at = coalesce(content_updated_at, updated_at, created_at, now())
    where content_updated_at is null
  `)
  await db.query(`
    do $$ begin
      alter table rooms
        add constraint rooms_folder_id_fkey
        foreign key (folder_id) references folders(id) on delete restrict;
    exception
      when duplicate_object then null;
    end $$
  `)
  await db.query(`
    create index if not exists rooms_folder_id_idx
    on rooms (folder_id)
    where folder_id is not null
  `)
  await db.query(`
    create index if not exists rooms_content_updated_at_desc_idx
    on rooms (content_updated_at desc)
  `)
}

module.exports = { initFileSystemSchema }
