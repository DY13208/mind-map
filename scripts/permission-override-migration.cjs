#!/usr/bin/env node
// 权限“本图单独设置”迁移工具（只读报告 / 备份导出 / 回滚）
//
// 迁移本身由新版本启动时 roomAcl.initSchema 幂等完成（新增 override_role、
// acl_v2、direct_role_archive 三列，回填旧的 direct_role/team_role，不改变任何
// 现有效果）。本脚本用于：
//   report    只读统计旧数据冲突与新覆盖设置，不写库
//   export    导出所有新覆盖设置（acl_v2 = true）到 JSON 备份文件
//   rollback  把新覆盖设置转换回旧版可理解的 direct_role（默认 dry-run）
//
// 连接参数使用 PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD 环境变量。
//
// 注意：回滚后旧版程序按“取较高权限”合并，本图单独设置的 viewer 可能被
// 文件夹/团队 editor 抬高。脚本会在执行前明确列出这些行并要求 --yes。

const fs = require('fs')
const { Client } = require('../simple-mind-map/node_modules/pg')
const { sqlEffectiveRole } = require('../simple-mind-map/bin/roomAcl')

function parseArgs(argv) {
  const opts = { file: '', yes: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') opts.file = argv[++i] || ''
    else if (argv[i] === '--yes') opts.yes = true
  }
  return opts
}

function printRow(prefix, row) {
  console.log(`${prefix} ${row.room_key}\t${row.user_id}\t实际=${row.role || '-'}\tdirect=${row.direct_role || '-'}\tteam=${row.team_role || '-'}\tfolder=${row.folder_role || '-'}\toverride=${row.override_role || '-'}\t标题=${row.title || ''}`)
}

async function report(db) {
  const total = (
    await db.query(`select count(*)::int as n from room_members`)
  ).rows[0].n
  const overrideCount = (
    await db.query(
      `select count(*)::int as n from room_members where coalesce(acl_v2, false)`
    )
  ).rows[0].n || 0
  console.log(`成员行总数: ${total}`)
  console.log(`已采用新覆盖语义的行: ${overrideCount}`)

  const conflicts = await db.query(`
    select m.room_key, m.user_id, m.role, m.direct_role, m.team_role, m.folder_role,
           m.override_role, r.title
    from room_members m
    left join rooms r on r.room_key = m.room_key
    where coalesce(m.acl_v2, false) = false
      and m.direct_role is not null
      and (m.folder_role is not null or m.team_role is not null)
    order by m.room_key, m.user_id
    limit 500
  `)
  console.log(`\n历史数据中“直接授权 + 继承来源”并存（旧语义取较高权限）的行: ${conflicts.rows.length}${conflicts.rows.length === 500 ? '+（仅显示前 500 行）' : ''}`)
  conflicts.rows.forEach(row => printRow('  冲突', row))
  if (conflicts.rows.length) {
    console.log('  说明：这些行在旧版就是按较高权限生效；本次升级不自动转换。')
    console.log('  管理员在本图权限面板重新设置为“可查看/可编辑/跟随继承”后，该行才采用新覆盖语义。')
  }

  const overrides = await db.query(`
    select m.room_key, m.user_id, m.role, m.direct_role, m.team_role, m.folder_role,
           m.override_role, r.title
    from room_members m
    left join rooms r on r.room_key = m.room_key
    where coalesce(m.acl_v2, false) = true
    order by m.room_key, m.user_id
    limit 200
  `)
  console.log(`\n已采用新覆盖语义的行: ${overrides.rows.length}${overrides.rows.length === 200 ? '+（仅显示前 200 行）' : ''}`)
  overrides.rows.forEach(row => {
    const kind = row.override_role
      ? `本图单独设置=${row.override_role}`
      : '跟随继承'
    console.log(`  覆盖 ${row.room_key}\t${row.user_id}\t${kind}\t实际=${row.role || '-'}\tfolder=${row.folder_role || '-'}\tteam=${row.team_role || '-'}\t标题=${row.title || ''}`)
  })
}

async function exportBackup(db, file) {
  if (!file) {
    file = `permission-override-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  }
  const rows = (
    await db.query(`
      select room_key, user_id, role, direct_role, team_role, folder_role,
             override_role, acl_v2, direct_role_archive, source, source_team_id,
             source_folder_id, created_at, updated_at
      from room_members
      where coalesce(acl_v2, false) = true
      order by room_key, user_id
    `)
  ).rows
  const payload = {
    exportedAt: new Date().toISOString(),
    model: 'per-file-override-v1',
    rows
  }
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
  console.log(`已导出 ${rows.length} 行到 ${file}`)
}

async function rollback(db, opts) {
  const rows = (
    await db.query(`
      select room_key, user_id, role, direct_role, team_role, folder_role,
             override_role, direct_role_archive
      from room_members
      where coalesce(acl_v2, false) = true
      order by room_key, user_id
    `)
  ).rows
  const converted = rows.map(row => {
    const override = String(row.override_role || '').trim().toLowerCase()
    const archive = String(row.direct_role_archive || '').trim().toLowerCase()
    const legacyDirect = override || archive || null
    const hasSource =
      !!legacyDirect || !!row.team_role || !!row.folder_role
    return { ...row, legacyDirect, hasSource }
  })
  const raisedRisk = converted.filter(row => {
    const override = String(row.override_role || '').trim().toLowerCase()
    if (override !== 'viewer') return false
    const folder = String(row.folder_role || '').trim().toLowerCase()
    const team = String(row.team_role || '').trim().toLowerCase()
    return ['editor', 'manager'].includes(folder) || ['editor', 'manager'].includes(team)
  })
  const removed = converted.filter(row => !row.hasSource)
  console.log(`将转换 ${converted.length} 行新覆盖设置：`)
  console.log(`- 恢复为旧版直接授权: ${converted.length - removed.length} 行`)
  console.log(`- 无任何可回退来源、将删除访问: ${removed.length} 行`)
  console.log(`- 回滚后会被继承 editor 抬高的 viewer 设置: ${raisedRisk.length} 行（旧版合并语义所致，需人工确认）`)
  raisedRisk.forEach(row => printRow('  风险', row))
  removed.forEach(row => printRow('  删除', row))
  if (!opts.yes) {
    console.log('\n当前为 dry-run。确认影响后追加 --yes 执行（建议先执行 export 备份）。')
    return
  }
  await db.query('begin')
  try {
    await db.query(
      `update room_members
       set direct_role = coalesce(nullif(override_role, ''), direct_role_archive),
           override_role = null,
           acl_v2 = false,
           role = ${sqlEffectiveRole('coalesce(nullif(override_role, \'\'), direct_role_archive)', 'team_role', 'folder_role')}
       where coalesce(acl_v2, false) = true
         and (coalesce(nullif(override_role, ''), direct_role_archive) is not null
           or team_role is not null or folder_role is not null)`
    )
    await db.query(
      `delete from room_members
       where coalesce(acl_v2, false) = true
         and coalesce(nullif(override_role, ''), direct_role_archive) is null
         and team_role is null and folder_role is null`
    )
    await db.query('commit')
    console.log(`回滚完成：${converted.length - removed.length} 行转换、${removed.length} 行删除。`)
  } catch (err) {
    await db.query('rollback').catch(() => {})
    throw err
  }
}

async function main() {
  const mode = process.argv[2] || 'report'
  const opts = parseArgs(process.argv.slice(3))
  const db = new Client({
    host: process.env.PGHOST,
    port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD
  })
  await db.connect()
  try {
    const columns = new Set(
      (
        await db.query(
          `select column_name from information_schema.columns
           where table_name = 'room_members'
             and column_name in ('override_role', 'acl_v2', 'direct_role_archive')`
        )
      ).rows.map(row => row.column_name)
    )
    if (columns.size < 3) {
      console.log('数据库尚未执行新版本迁移（room_members 缺列）。请先启动一次新版本服务，或运行 roomAcl.initSchema。')
      if (mode !== 'report') process.exitCode = 1
      return
    }
    if (mode === 'report') await report(db)
    else if (mode === 'export') await exportBackup(db, opts.file)
    else if (mode === 'rollback') await rollback(db, opts)
    else {
      console.log('用法: node scripts/permission-override-migration.cjs [report|export|rollback] [--out file] [--yes]')
    }
  } finally {
    await db.end()
  }
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
