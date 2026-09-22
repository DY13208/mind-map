#!/usr/bin/env node
/**
 * doc-extract-text.js —— 多格式文档正文提取（合同等）
 *
 * 默认走「视觉」通道：把页面渲染成图片，由具备视觉能力的模型直接读图。
 * 实测准确率显著高于本地 OCR —— 品牌名（瑷丝特兰 vs 瑗丝特兰）、
 * 公司名（天籁杉音 vs 天簿杉音）、平台名（快手 vs PEE:）、关键助词
 * （不得低于 vs 个得低于）四项，模型读图全对，tesseract 全错。
 * 无视觉能力时用 --ocr 走本地 tesseract 双通道兜底。
 *
 * 支持格式：
 *   .pdf   电子版 → pdftotext 无损；扫描件 → 渲染页图（vision）/ 双通道 OCR（ocr）
 *   图片   .jpg/.jpeg/.png/.tif/.bmp/.webp → vision 直接读 / ocr 识别
 *   文本   .txt/.md/.csv/.tsv/.json → 直接读
 *   Office .doc/.docx/.wps 等 → 本脚本不处理，走 tencent-local-office-edit（edsdk）
 *
 * 用法：
 *   node scripts/doc-extract-text.js <文件> [--vision|--ocr] [--dpi 150] [--pages 1-5]
 *                                     [--out <目录>] [--quiet]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const OFFICE_EXT = new Set([
  '.doc', '.docx', '.dot', '.dotx', '.docm', '.dotm', '.wps', '.wpt', '.rtf',
]);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp', '.webp']);
const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.tsv', '.json']);

let QUIET = false;
const log = (...a) => {
  if (!QUIET) console.log(...a);
};
function die(msg) {
  console.error('\n✖ ' + msg);
  process.exit(1);
}

function tool(name) {
  const override = process.env['DOC_EXTRACT_' + name.toUpperCase()];
  if (override) return override;
  const r = spawnSync(name, ['--version'], { stdio: 'ignore', windowsHide: true });
  if (r.error) {
    die(
      `缺少外部工具 \`${name}\`。\n` +
        '  PDF 处理需要 poppler（pdfinfo/pdftotext/pdftoppm/pdfimages）；\n' +
        '  --ocr 模式还需要 tesseract 及 chi_sim 语言包。\n' +
        '  本机实测路径：poppler = D:\\poppler-24.08.0\\Library\\bin，tesseract = D:\\tesseract-ocr。\n' +
        '  可用环境变量覆盖，如 DOC_EXTRACT_PDFINFO=<绝对路径>。'
    );
  }
  return name;
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    ...opts,
  });
}

/**
 * 外部命令（poppler）输出前缀必须是纯 ASCII。
 * 实测：poppler 读中文输入路径正常，但只要输出前缀含非 ASCII 字符就报
 * "I/O Error: Couldn't open image file"，并把路径按 UTF-8 字节逐字转义。
 * 故外部产物先落在 ASCII 工作目录，再由 Node 的 fs（宽字符 API）搬到目标目录。
 */
const ASCII_WORK = path.join(ROOT, 'tmp', `_extract_work_${process.pid}`);
const resetWork = () => {
  fs.rmSync(ASCII_WORK, { recursive: true, force: true });
  fs.mkdirSync(ASCII_WORK, { recursive: true });
};

// ---------------------------------------------------------------- 文本处理

/** tesseract 中文输出在每字之间插空格，须归一化，否则关键词匹配恒为 0 */
function normalize(s) {
  return s
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t\u00a0]+/g, '').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

const numericTokens = (s) => new Set(s.match(/[0-9][0-9A-Za-z,.:%]*/g) || []);

/** 双向集合差：任一侧独有的数字 token 都算分歧（OCR 交叉验证用） */
function diffNumbers(a, b) {
  const sa = numericTokens(a);
  const sb = numericTokens(b);
  const out = [];
  for (const x of sa) if (!sb.has(x)) out.push({ a: x, b: null });
  for (const y of sb) if (!sa.has(y)) out.push({ a: null, b: y });
  return out;
}

function parsePages(spec, total) {
  if (!spec) return null;
  const out = new Set();
  for (const part of String(spec).split(',')) {
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(part.trim());
    if (m) for (let i = Number(m[1]); i <= Number(m[2]); i++) out.add(i);
    else if (/^\d+$/.test(part.trim())) out.add(Number(part.trim()));
  }
  return [...out].filter((n) => n >= 1 && (!total || n <= total)).sort((a, b) => a - b);
}

// ---------------------------------------------------------------- PDF

function pdfPageCount(file) {
  const m = /^Pages:\s+(\d+)/m.exec(run(tool('pdfinfo'), [file]).stdout || '');
  return m ? Number(m[1]) : 0;
}

function pdfTextLayer(file) {
  const raw = run(tool('pdftotext'), ['-layout', file, '-']).stdout || '';
  return { raw, chars: raw.replace(/\s/g, '').length };
}

/** 渲染页图。先渲到 ASCII 工作目录，再搬到目标目录（中文名安全） */
function renderPages(file, outPagesDir, dpi, pages, total) {
  resetWork();
  const prefix = path.join(ASCII_WORK, 'p');
  const args = ['-r', String(dpi), '-png'];
  if (pages && pages.length) args.push('-f', String(pages[0]), '-l', String(pages[pages.length - 1]));
  args.push(file, prefix);
  const r = run(tool('pdftoppm'), args);
  let files = fs.readdirSync(ASCII_WORK).filter((f) => /^p-?\d*\.png$/i.test(f)).sort();
  if (!files.length) {
    throw new Error(`pdftoppm 渲染失败（exit ${r.status}）：${(r.stderr || '').trim().slice(0, 200)}`);
  }
  if (pages && pages.length) {
    const width = String(total || 99).length;
    const want = new Set(pages.map((n) => String(n).padStart(width, '0')));
    const filtered = files.filter((f) => {
      const m = /(\d+)\.png$/i.exec(f);
      return m && want.has(m[1]);
    });
    if (filtered.length) files = filtered;
  }
  fs.mkdirSync(outPagesDir, { recursive: true });
  const out = files.map((f) => {
    const dest = path.join(outPagesDir, f);
    fs.copyFileSync(path.join(ASCII_WORK, f), dest);
    return dest;
  });
  resetWork();
  return out;
}

function ocrEach(files, dir) {
  const out = [];
  for (let i = 0; i < files.length; i++) {
    const base = path.join(dir, `ocr${i}`);
    const r = run(tool('tesseract'), [files[i], base, '-l', 'chi_sim+eng', '--psm', '3']);
    const t = base + '.txt';
    out.push(r.status === 0 && fs.existsSync(t) ? fs.readFileSync(t, 'utf8') : '');
    if (!QUIET && files.length > 8 && (i + 1) % 5 === 0) {
      process.stdout.write(`\r     OCR ${i + 1}/${files.length}`);
    }
  }
  if (!QUIET && files.length > 8) process.stdout.write('\r' + ' '.repeat(24) + '\r');
  return out;
}

/** OCR 兜底：双通道交叉验证（实测无单一配置全对，必须交叉） */
function ocrDualChannel(file) {
  resetWork();
  const dirA = path.join(ASCII_WORK, 'A');
  const dirB = path.join(ASCII_WORK, 'B');
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });

  let ra = run(tool('pdfimages'), ['-j', file, path.join(dirA, 'p')]);
  let namesA = fs.readdirSync(dirA).filter((f) => /^p-\d+\.(jpe?g|png|ppm|tiff?)$/i.test(f)).sort();
  if (!namesA.length) {
    ra = run(tool('pdfimages'), ['-png', file, path.join(dirA, 'p')]);
    namesA = fs.readdirSync(dirA).filter((f) => /^p-\d+\.png$/i.test(f)).sort();
  }
  const textsA = namesA.length ? ocrEach(namesA.map((f) => path.join(dirA, f)), dirA) : [];

  const rb = run(tool('pdftoppm'), ['-r', '200', '-png', file, path.join(dirB, 'p')]);
  const namesB = fs.readdirSync(dirB).filter((f) => /^p-\d+\.png$/i.test(f)).sort();
  const textsB = namesB.length ? ocrEach(namesB.map((f) => path.join(dirB, f)), dirB) : [];

  resetWork();
  return {
    textsA,
    textsB,
    warnA: namesA.length ? '' : `pdfimages 未提取到内嵌图（exit ${ra.status}）`,
    warnB: namesB.length ? '' : `pdftoppm 未渲染页面（exit ${rb.status}）`,
  };
}

// ---------------------------------------------------------------- 主流程

function main() {
  const argv = process.argv.slice(2);
  QUIET = argv.includes('--quiet');
  const mode = argv.includes('--ocr') ? 'ocr' : 'vision';

  // 取值型参数（--out/--dpi/--pages 后面跟的值不算位置参数）
  const VALUE_FLAGS = new Set(['--out', '--dpi', '--pages']);
  const val = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  let fileArg = null;
  for (let i = 0; i < argv.length; i++) {
    if (VALUE_FLAGS.has(argv[i])) {
      i++;
      continue;
    }
    if (argv[i].startsWith('--')) continue;
    fileArg = argv[i];
    break;
  }

  if (!fileArg) {
    console.log(
      '用法: node scripts/doc-extract-text.js <文件> [--vision|--ocr] [--dpi 150]\n' +
        '                                      [--pages 1-5] [--out <目录>] [--quiet]\n\n' +
        '  --vision (默认) 渲染页图供模型读图，准确率最高\n' +
        '  --ocr          本地 tesseract 双通道兜底（模型无视觉能力时用）\n' +
        '  --dpi          渲染分辨率，默认 150（实测已足够清晰）\n' +
        '  --pages        只处理指定页，如 1-5 或 1,3,7'
    );
    process.exit(1);
  }
  const file = path.resolve(fileArg);
  if (!fs.existsSync(file)) die(`文件不存在：${file}`);

  const base = path.basename(file, path.extname(file));
  const outDir = path.resolve(val('--out', path.join(ROOT, 'tmp', `extract-${base}`)));
  fs.mkdirSync(outDir, { recursive: true });

  const ext = path.extname(file).toLowerCase();
  const dpi = Number(val('--dpi', 150));
  const t0 = Date.now();
  const meta = { file, ext, outDir, mode, dpi, channel: null, pages: 0 };
  const pagesDir = path.join(outDir, 'pages');

  // ---- 纯文本
  if (TEXT_EXT.has(ext)) {
    const txt = path.join(outDir, `${base}.txt`);
    fs.writeFileSync(txt, normalize(fs.readFileSync(file, 'utf8')), 'utf8');
    meta.channel = 'plain-text';
    return finish(meta, t0, txt, null, null);
  }

  // ---- Office/WPS：不属于本脚本职责
  if (OFFICE_EXT.has(ext)) {
    die(
      `Office/WPS 文档（${ext}）请走 tencent-local-office-edit（edsdk）通道：\n` +
        '  cd "E:/workbuddy/resources/app.asar.unpacked/resources/plugins/workbuddy-builtin/skills/tencent-local-office-edit"\n' +
        '  python3 edsdk.py call get_pool_status --json \'{"file_path":"<绝对路径>"}\'\n' +
        '  python3 edsdk.py call doc_resolve_document_structure --json \'{"file_id":"<uuid>","mode":"full","text_preview_length":200,"include_table_cells":true,"limit":0}\''
    );
  }

  // ---- 图片
  if (IMAGE_EXT.has(ext)) {
    meta.pages = 1;
    if (mode === 'vision') {
      meta.channel = 'vision-image';
      fs.mkdirSync(pagesDir, { recursive: true });
      const dest = path.join(pagesDir, 'p-01' + ext);
      fs.copyFileSync(file, dest);
      printVisionPrompt(meta, [dest], 1);
      return finish(meta, t0, null, null, null);
    }
    meta.channel = 'ocr-image';
    resetWork();
    const tmp = path.join(ASCII_WORK, 'p' + ext);
    fs.copyFileSync(file, tmp);
    const texts = ocrEach([tmp], ASCII_WORK);
    resetWork();
    return writeOcrResult(meta, t0, base, outDir, texts[0] || '');
  }

  // ---- PDF
  if (ext !== '.pdf') {
    die(`不支持的扩展名：${ext}（支持 pdf / 图片 / 文本；Office 走 edsdk 通道）`);
  }
  tool('pdfinfo');
  tool('pdftotext');
  meta.pages = pdfPageCount(file);
  const layer = pdfTextLayer(file);
  log(`▌ PDF，${meta.pages} 页，文本层有效字符 ${layer.chars}`);

  if (layer.chars > 50) {
    meta.channel = 'pdftotext';
    log('  → 电子版（含文本层），pdftotext -layout 无损提取');
    const rawPath = path.join(outDir, `${base}.raw.txt`);
    fs.writeFileSync(rawPath, layer.raw, 'utf8');
    const txt = path.join(outDir, `${base}.txt`);
    fs.writeFileSync(txt, normalize(layer.raw), 'utf8');
    return finish(meta, t0, txt, rawPath, null);
  }

  const pages = parsePages(val('--pages', null), meta.pages);
  log('  → 扫描件（文本层为空）');

  if (mode === 'vision') {
    meta.channel = 'vision-pages';
    log(`     渲染 ${dpi}dpi 页图${pages ? `（限第 ${pages.join(',')} 页）` : '（全部页）'}`);
    const imgs = renderPages(file, pagesDir, dpi, pages, meta.pages);
    meta.renderedPages = imgs.length;
    printVisionPrompt(meta, imgs, meta.pages);
    return finish(meta, t0, null, null, null);
  }

  meta.channel = 'ocr-dual';
  log('     通道A：pdfimages 直取内嵌原图（零重编码）');
  log('     通道B：pdftoppm 200dpi 重采样');
  const { textsA, textsB, warnA, warnB } = ocrDualChannel(file);
  if (warnA) log('     ⚠ ' + warnA);
  if (warnB) log('     ⚠ ' + warnB);
  return writeOcrResult(meta, t0, base, outDir, textsA.join('\n'), textsB.join('\n'));
}

// ---------------------------------------------------------------- 输出

function printVisionPrompt(meta, imgs, total) {
  log('');
  log('── 需要模型读图 ──────────────────────');
  log(`  页图目录 : ${path.join(meta.outDir, 'pages')}`);
  log(`  图片数   : ${imgs.length}`);
  log('');
  log('  请逐页 Read 读图，读完后把全文写入：');
  log(`    ${path.join(meta.outDir, path.basename(meta.file, path.extname(meta.file)) + '.txt')}`);
  log('  格式：每页以 "=== 第 N 页 ===" 起始，保留原文条款编号与全部数值。');
  log('');
  for (let i = 0; i < imgs.length; i++) {
    const m = /(\d+)\.(png|jpe?g)$/i.exec(imgs[i]);
    log(`    第 ${m ? Number(m[1]) : i + 1} 页  ${imgs[i]}`);
  }
  log('');
  log('  ⚠ 扫描件无文本层，模型读图是唯一可靠来源；');
  log('    金额 / 比例 / 日期 / 证照编号务必与原件核对，不要凭上下文推断。');
  const n = imgs.length;
  if (n > 20) log(`  ⚠ 共 ${n} 页，建议分批读取（每批 5-8 页），避免上下文过载。`);
}

function writeOcrResult(meta, t0, base, outDir, rawA, rawB) {
  const rawPath = path.join(outDir, `${base}.raw.txt`);
  const txtPath = path.join(outDir, `${base}.txt`);
  fs.writeFileSync(rawPath, rawA, 'utf8');
  const clean = normalize(rawA);
  fs.writeFileSync(txtPath, clean, 'utf8');

  let conflicts = [];
  if (rawB) {
    conflicts = diffNumbers(clean, normalize(rawB));
    const lines = ['# 数字分歧清单（通道A=原图 / 通道B=200dpi）', '', `文件：${meta.file}`, ''];
    if (!conflicts.length) lines.push('未发现数字分歧。');
    else {
      lines.push(`共 ${conflicts.length} 处，请回原件人工确认：`, '');
      for (const c of conflicts) lines.push(`- A: ${c.a ?? '(无)'}   ｜   B: ${c.b ?? '(无)'}`);
    }
    fs.writeFileSync(path.join(outDir, `${base}.conflicts.txt`), lines.join('\n') + '\n', 'utf8');
    meta.conflicts = conflicts.length;
  }
  return finish(meta, t0, txtPath, rawPath, conflicts);
}

function finish(meta, t0, txtPath, rawPath, conflicts) {
  meta.elapsedMs = Date.now() - t0;
  const base = path.basename(meta.file, path.extname(meta.file));
  fs.writeFileSync(path.join(meta.outDir, `${base}.meta.json`), JSON.stringify(meta, null, 2), 'utf8');
  log('');
  log('── 完成 ──────────────────────────────');
  log(`  通道 : ${meta.channel}`);
  if (meta.pages) log(`  页数 : ${meta.pages}`);
  log(`  耗时 : ${(meta.elapsedMs / 1000).toFixed(1)}s`);
  if (txtPath) log(`  正文 : ${txtPath}`);
  if (rawPath) log(`  原始 : ${rawPath}`);
  if (conflicts && conflicts.length) {
    log(`  分歧 : ${conflicts.length} 处 → ${path.join(meta.outDir, base + '.conflicts.txt')}`);
  }
}

try {
  main();
} catch (e) {
  die(e.message);
}
