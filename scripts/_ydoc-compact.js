// ydoc 膨胀压缩工具：在 docmost 容器内运行
// 用法: NODE_PATH=/app/apps/server/node_modules:/app/node_modules node /tmp/ydoc-compact.js [--dry]
// 逻辑: 对 ydoc 显著大于 content 的页面，用 createYdocFromJson 从当前内容
//       重建干净 Y.Doc（消除墓碑），乐观锁防编辑竞争，只在变小时更新。
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const u = require('/app/apps/server/dist/common/helpers/prosemirror/utils.js');
const postgres = require('/app/node_modules/.pnpm/postgres@3.4.8/node_modules/postgres');
const Y = require('yjs');

const DRY = process.argv.includes('--dry');
const BLOAT_FACTOR = 3;
const MIN_YDOC = 100 * 1024;

(async () => {
  const sql = postgres(process.env.DATABASE_URL, { max: 1 });

  const rows = await sql`
    SELECT id, title, content, ydoc, updated_at
      FROM pages
     WHERE deleted_at IS NULL
       AND ydoc IS NOT NULL AND content IS NOT NULL
       AND pg_column_size(ydoc) > ${MIN_YDOC}
       AND pg_column_size(ydoc) > pg_column_size(content) * ${BLOAT_FACTOR}
     ORDER BY pg_column_size(ydoc) DESC`;

  console.log(`膨胀页面数: ${rows.length}`);
  const backup = { ts: new Date().toISOString(), pages: [] };
  let totalBefore = 0, totalAfter = 0, done = 0, skipped = 0;

  for (const row of rows) {
    const before = row.ydoc.length;
    const tag = `${row.title} (${row.id.slice(0, 8)})`;
    try {
      const newYdocBuf = u.createYdocFromJson(row.content);
      if (!newYdocBuf) { console.log(`SKIP 无content ${tag}`); skipped++; continue; }
      // 防御：新文档反而更大则不动
      if (newYdocBuf.length >= before * 0.9) {
        console.log(`SKIP 重建无收益 ${tag}: ${before} -> ${newYdocBuf.length}`);
        skipped++;
        continue;
      }
      backup.pages.push({
        id: row.id, title: row.title,
        oldYdocBase64: row.ydoc.toString('base64'),
      });
      totalBefore += before;
      totalAfter += newYdocBuf.length;
      if (DRY) {
        console.log(`[dry] ${tag}: ${(before/1024).toFixed(0)}KB -> ${(newYdocBuf.length/1024).toFixed(0)}KB`);
        continue;
      }
      // 乐观锁: updated_at 未变才更新（防止处理期间有人编辑）
      const res = await sql`
        UPDATE pages SET ydoc = ${newYdocBuf}
         WHERE id = ${row.id} AND updated_at = ${row.updated_at}`;
      if (res.count === 1) {
        done++;
        console.log(`OK ${tag}: ${(before/1024).toFixed(0)}KB -> ${(newYdocBuf.length/1024).toFixed(0)}KB`);
      } else {
        console.log(`RACE 跳过(已被编辑) ${tag}`);
        skipped++;
      }
    } catch (e) {
      console.log(`ERR ${tag}: ${e.message}`);
      skipped++;
    }
  }

  if (!DRY && backup.pages.length) {
    const p = '/tmp/ydoc-backup-' + Date.now() + '.json';
    fs.writeFileSync(p, JSON.stringify(backup));
    execSync('gzip -f ' + p);
    console.log(`备份已落盘: ${p}.gz (${backup.pages.length} 页)`);
  }
  console.log(`\n汇总: 成功=${done} 跳过=${skipped} ydoc ${ (totalBefore/1024).toFixed(0) }KB -> ${(totalAfter/1024).toFixed(0) }KB`);
  await sql.end();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
