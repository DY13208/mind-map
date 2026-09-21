/**
 * Start-Docker / openclaw-docker：把仓库内「良策 → OpenClaw」可版本化内容
 * 注入到容器 workspace（AGENTS 片段 + SOP 输出规则等）。
 *
 * 用法：
 *   node scripts/openclaw-inject-workspace.js
 *
 * 扩展：往 docker/openclaw/inject/workspace/ 丢文件即可，启动时会覆盖注入到
 * /home/node/.openclaw/workspace/（同名文件会被仓库版本盖住；勿放密钥）。
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync, execSync } = require('child_process')
const { pathToFileURL } = require('url')

const ROOT = path.resolve(__dirname, '..')
const INJECT_ROOT = path.join(ROOT, 'docker', 'openclaw', 'inject')
const INJECT_WORKSPACE = path.join(INJECT_ROOT, 'workspace')
const AGENTS_SNIPPET = path.join(INJECT_ROOT, 'AGENTS.liangce.md')
const RULES_JS = path.join(ROOT, 'web', 'src', 'utils', 'sopOutputRules.js')
const RULES_FILENAME = 'LIANGCE_SOP_RULES.md'

const MARK_BEGIN = '<!-- BEGIN LIANGCE_INJECT -->'
const MARK_END = '<!-- END LIANGCE_INJECT -->'

function hasDocker() {
  try {
    execSync('docker info', { stdio: 'ignore', windowsHide: true })
    return true
  } catch (e) {
    return false
  }
}

function composePsId() {
  const r = spawnSync(
    'docker',
    ['compose', '-f', 'docker-compose.yml', 'ps', '-aq', 'openclaw-gateway'],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true }
  )
  if (r.status !== 0) return ''
  return String(r.stdout || '')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)[0] || ''
}

function dockerCp(src, destSpec) {
  const r = spawnSync('docker', ['cp', src, destSpec], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true
  })
  return {
    ok: r.status === 0,
    detail: String(r.stderr || r.stdout || '')
      .trim()
      .slice(0, 400)
  }
}

function dockerExec(id, args) {
  const r = spawnSync('docker', ['exec', id, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true
  })
  return {
    ok: r.status === 0,
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || '')
  }
}

async function buildSopRulesMarkdown() {
  if (!fs.existsSync(RULES_JS)) {
    return {
      ok: false,
      reason: `缺少 ${path.relative(ROOT, RULES_JS)}`
    }
  }
  let mod
  try {
    mod = await import(pathToFileURL(RULES_JS).href)
  } catch (err) {
    return {
      ok: false,
      reason: `加载 sopOutputRules 失败：${(err && err.message) || err}`
    }
  }
  const meta = mod.SOP_OUTPUT_RULES_META || {}
  const common = mod.COMMON_RUN_RULES || {}
  const cats = mod.OUTPUT_CATEGORY_RULES || {}
  const formatAll =
    typeof mod.formatOutputRulesBlock === 'function'
      ? mod.formatOutputRulesBlock(['html', 'md', 'xlsx', 'json'])
      : ''

  const lines = [
    `# 良策 SOP 输出规则（Start-Docker 自动注入）`,
    '',
    `> 来源：\`web/src/utils/sopOutputRules.js\` · v${meta.version || '?'}`,
    `> 本文件由 \`scripts/openclaw-inject-workspace.js\` 在 Start-Docker 时生成/覆盖。`,
    `> 执行 SOP / 写 output/*.html 时必须遵守；与台账前端提示词同源。`,
    '',
    formatAll ||
      [
        `## ${common.title || '通用规则'}`,
        common.rules || '',
        '',
        ...Object.values(cats).flatMap(cat => [
          `## ${cat.title}`,
          cat.rules || '',
          ''
        ])
      ].join('\n'),
    ''
  ]
  return { ok: true, text: lines.join('\n'), version: meta.version || '' }
}

function defaultAgentsSnippet(version) {
  return [
    MARK_BEGIN,
    '',
    '## 良策 SOP（Start-Docker 注入 · 勿手改本段）',
    '',
    `- 完整输出规则见工作区根目录 \`${RULES_FILENAME}\`（v${version || 'latest'}，与台账 \`sopOutputRules.js\` 同源）。`,
    '- 跑「制定…目标」类 SOP、写 `output/*.html` 时：主视觉必须是**目标金额看板**（历史 vs 目标、B2B 推导、敏感度/分配）。',
    '- **禁止**把整页做成「GMV 达成进度执行单」壳；禁止「目标金额已填、进度状态列整列红待接入」。',
    '- 「跟踪进度」缺实际数：只对「累计实际 / 完成率」等缺数字段标「待接入」；有日销等替代口径须先算完成率。',
    '- 产物落到 `/home/node/.openclaw/workspace/output/`（宿主机 `./output`）；每次新建带时间戳文件，禁止覆盖历史产物。',
    '- **附件挂载**：产物必须 MCP `upload_attachment` 挂到节点（等同工具栏「附件」），禁止只写路径或「请拖到节点」到 note。',
    '',
    MARK_END,
    ''
  ].join('\n')
}

function readAgentsSnippet(version) {
  if (fs.existsSync(AGENTS_SNIPPET)) {
    let text = fs.readFileSync(AGENTS_SNIPPET, 'utf8').replace(/^\uFEFF/, '')
    if (!text.includes(MARK_BEGIN)) {
      text = `${MARK_BEGIN}\n\n${text.trim()}\n\n${MARK_END}\n`
    }
    return text.replace(/\{\{\s*VERSION\s*\}\}/g, version || 'latest')
  }
  return defaultAgentsSnippet(version)
}

function upsertMarkedSection(original, snippet) {
  const src = String(original || '')
  const block = String(snippet || '').trim() + '\n'
  const begin = src.indexOf(MARK_BEGIN)
  const end = src.indexOf(MARK_END)
  if (begin >= 0 && end > begin) {
    const afterEnd = end + MARK_END.length
    const before = src.slice(0, begin).replace(/\s*$/, '\n\n')
    const after = src.slice(afterEnd).replace(/^\s*/, '\n')
    return before + block + after
  }
  const trimmed = src.replace(/\s*$/, '')
  return `${trimmed}\n\n${block}`
}

function prepareStaging(rulesText, version) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-inject-'))
  const ws = path.join(staging, 'workspace')
  fs.mkdirSync(ws, { recursive: true })

  if (fs.existsSync(INJECT_WORKSPACE)) {
    const walk = (dir, rel = '') => {
      for (const name of fs.readdirSync(dir)) {
        if (name === '.gitkeep' || name === '.DS_Store') continue
        const from = path.join(dir, name)
        const toRel = rel ? path.join(rel, name) : name
        const st = fs.statSync(from)
        if (st.isDirectory()) {
          fs.mkdirSync(path.join(ws, toRel), { recursive: true })
          walk(from, toRel)
        } else {
          fs.mkdirSync(path.dirname(path.join(ws, toRel)), { recursive: true })
          fs.copyFileSync(from, path.join(ws, toRel))
        }
      }
    }
    walk(INJECT_WORKSPACE)
  }

  fs.writeFileSync(path.join(ws, RULES_FILENAME), rulesText, 'utf8')
  fs.writeFileSync(
    path.join(staging, 'agents.snippet.md'),
    readAgentsSnippet(version),
    'utf8'
  )
  return staging
}

/**
 * @returns {{ ok: boolean, skipped?: boolean, reason?: string, files?: string[], version?: string, detail?: string }}
 */
async function injectOpenclawWorkspace(opts = {}) {
  const quiet = !!opts.quiet
  const log = msg => {
    if (!quiet) console.log(msg)
  }

  if (!hasDocker()) {
    return { ok: false, reason: 'Docker 不可用' }
  }

  const id = composePsId()
  if (!id) {
    return {
      ok: false,
      reason: '找不到 openclaw-gateway 容器（请先 create/up）'
    }
  }

  const built = await buildSopRulesMarkdown()
  if (!built.ok) return built

  const staging = prepareStaging(built.text, built.version)
  const files = []
  try {
    // 整目录拷入 workspace（覆盖同名托管文件）
    const cp = dockerCp(
      `${staging}/workspace/.`,
      `${id}:/home/node/.openclaw/workspace/`
    )
    if (!cp.ok) {
      return {
        ok: false,
        reason: 'docker cp workspace 失败',
        detail: cp.detail
      }
    }
    files.push(RULES_FILENAME)
    if (fs.existsSync(INJECT_WORKSPACE)) {
      const list = fs.readdirSync(INJECT_WORKSPACE).filter(
        n => n !== '.gitkeep' && n !== '.DS_Store'
      )
      files.push(...list)
    }

    // 合并 AGENTS.md 托管段
    const read = dockerExec(id, [
      'sh',
      '-c',
      'cat /home/node/.openclaw/workspace/AGENTS.md 2>/dev/null || true'
    ])
    const snippet = fs.readFileSync(
      path.join(staging, 'agents.snippet.md'),
      'utf8'
    )
    const nextAgents = upsertMarkedSection(read.stdout || '', snippet)
    const agentsLocal = path.join(staging, 'AGENTS.md')
    fs.writeFileSync(agentsLocal, nextAgents, 'utf8')
    const cpAgents = dockerCp(
      agentsLocal,
      `${id}:/home/node/.openclaw/workspace/AGENTS.md`
    )
    if (!cpAgents.ok) {
      return {
        ok: false,
        reason: '写入 AGENTS.md 失败',
        detail: cpAgents.detail
      }
    }
    files.push('AGENTS.md(托管段)')

    dockerExec(id, [
      'sh',
      '-c',
      'chown -R node:node /home/node/.openclaw/workspace/AGENTS.md /home/node/.openclaw/workspace/' +
        RULES_FILENAME +
        ' 2>/dev/null || true'
    ])

    log(
      `  OpenClaw workspace 已注入：${files.join('、')}（规则 v${built.version || '?'}）`
    )
    return {
      ok: true,
      files,
      version: built.version,
      containerId: id
    }
  } finally {
    try {
      fs.rmSync(staging, { recursive: true, force: true })
    } catch (e) {
      /* ignore */
    }
  }
}

module.exports = {
  injectOpenclawWorkspace,
  buildSopRulesMarkdown,
  INJECT_WORKSPACE,
  RULES_FILENAME,
  MARK_BEGIN,
  MARK_END
}

if (require.main === module) {
  injectOpenclawWorkspace()
    .then(r => {
      if (!r.ok) {
        console.error(JSON.stringify(r, null, 2))
        process.exit(1)
      }
      console.log(JSON.stringify({ ok: true, ...r }, null, 2))
    })
    .catch(err => {
      console.error(err)
      process.exit(1)
    })
}
