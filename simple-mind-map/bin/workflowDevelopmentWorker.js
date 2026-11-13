const { execFile } = require('node:child_process')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { createInterface } = require('node:readline')
const { setTimeout: delay } = require('node:timers/promises')
const { Pool } = require('pg')
const { initSchema, validPath, validRoute } = require('./workflowDevelopment')
const { plain } = require('./leaveWorkflow/core')
const { marker } = require('./leaveWorkflow/workflowCore')
const { deploymentSetting, pollDeployments } = require('./workflowDeployment')
const { mergeSetting } = require('./workflowMerge')

const lock = 'mind-map-workflow-development'
const agentEvents = new Set(['model_wait', 'search_done', 'context_read', 'patch_check', 'patch_retry', 'model_retry', 'response_retry'])

function run(command, args, { input, onOutputLine, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, {
      timeout: 120000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, ...options
    }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr, stdout }))
      else resolve(stdout.trimEnd())
    })
    if (onOutputLine) createInterface({ input: child.stdout, terminal: false, crlfDelay: Infinity }).on('line', onOutputLine)
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

function agentProgress(line) {
  if (line.length > 512) return null
  let item
  try { item = JSON.parse(line) } catch (_) { return null }
  if (item?.type !== 'workflow_progress' || !agentEvents.has(item.event) ||
    !Number.isInteger(item.round) || item.round < 1 || item.round > 100) return null
  const { event, round, count } = item
  const counted = event === 'context_read' || event === 'search_done'
  if (counted && (!Number.isInteger(count) || count < 0 || count > 100)) return null
  return { event, round, ...(counted ? { count } : {}) }
}

function projectEnv(directory) {
  const names = /^(path|pathext|systemroot|windir|temp|tmp|lang|lc_\w+|home|userprofile|localappdata|appdata|comspec|uv_cache_dir)$/i
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => names.test(key))),
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_GLOBAL: path.join(directory, 'empty.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GH_CONFIG_DIR: path.join(directory, 'empty-gh-config')
  }
}

function agentProcessEnv(directory) {
  return {
    ...projectEnv(directory),
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(workflow_development_workbuddy_\w+|workflow_development_codebuddy_(?:model|schema)|codebuddy_api_key|codebuddy_base_url)$/i.test(key)))
  }
}

function commandSetting(name) {
  const command = JSON.parse(process.env[name] || 'null')
  if (command !== null && (!Array.isArray(command) || !command.length ||
    !command.every(arg => typeof arg === 'string' && arg && !arg.includes('\0')))) {
    throw new Error(name + ' must be a JSON command array')
  }
  return command
}

async function githubCredential(route) {
  if (!validRoute(route)) throw new Error('Invalid stored route')
  const output = await run('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\npath=' + route.repository + '.git\n\n',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    timeout: 10000
  })
  const password = output.split(/\r?\n/).find(line => line.startsWith('password='))
  if (!password?.slice(9)) throw new Error('No cached GitHub credential for ' + route.repository)
  return password.slice(9)
}

function checkPaths(paths, allowed) {
  if (!paths.length) throw Object.assign(new Error('No staged changes'), { code: 'AGENT_EMPTY' })
  if (paths.some(file => !allowed.some(base => file === base || file.startsWith(base + '/')))) {
    throw Object.assign(new Error('Change set is outside the configured paths'), { code: 'AGENT_SCOPE' })
  }
}

function taskTarget(task) {
  const { route, snapshot } = task
  const root = snapshot.find(node => node.parent === null)
  const markers = snapshot.filter(node => node.parent === root?.uid)
    .map(node => marker(node.data.text)).filter(Boolean)
  const key = markers.length === 1 ? markers[0][1].trim() : plain(root?.data?.text)
  const current = JSON.parse(process.env.WORKFLOW_DEVELOPMENT_ROUTES || '{}')
  const configured = Object.hasOwn(current, key) ? current[key] : null
  const target = route.target || (configured?.repository === route.repository && configured.branch === route.branch
    ? configured.target : null)
  if (!target || ![target.formSourceId, target.attachmentField].every(value =>
    typeof value === 'string' && /^[\w.-]{1,100}$/.test(value))) return undefined
  const entryPaths = Array.isArray(target.entryPaths) ? target.entryPaths.filter(file =>
    validPath(file) && route.paths.some(base => file === base || file.startsWith(base + '/'))).slice(0, 8) : []
  const entryHints = Array.isArray(target.entryHints) ? target.entryHints.filter(text =>
    typeof text === 'string' && text.trim() && text.length <= 600).slice(0, 4) : []
  return {
    formSourceId: target.formSourceId, attachmentField: target.attachmentField, entryPaths,
    ...(entryHints.length ? { entryHints } : {})
  }
}

async function processTask(db, task, { agent, token, testRunner, execute = run }, signal) {
  const { id, route } = task
  if (!validRoute(route)) throw new Error('Invalid stored route')
  const branch = 'codex/workflow-' + id
  const root = await mkdtemp(path.join(tmpdir(), 'mind-map-workflow-'))
  const cwd = path.join(root, 'checkout')
  const env = projectEnv(root)
  const git = (args, options = {}) => execute('git', ['-c', 'core.hooksPath=' + path.join(root, 'disabled-hooks'), ...args], {
    cwd, env, signal, ...options
  })
  const remote = (args, options = {}) => git(args, {
    ...options,
    env: {
      ...env, GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: 'Authorization: Basic ' + Buffer.from('x-access-token:' + token).toString('base64'),
      GIT_CONFIG_KEY_1: 'http.followRedirects', GIT_CONFIG_VALUE_1: 'false'
    }
  })
  const github = async (suffix, body) => {
    const response = await fetch('https://api.github.com/repos/' + route.repository + '/pulls' + suffix, {
      method: body ? 'POST' : 'GET',
      headers: {
        Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json', 'User-Agent': 'mind-map-workflow-development'
      },
      body: body && JSON.stringify(body), redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)])
    })
    if (!response.ok) throw new Error('GitHub returned HTTP ' + response.status)
    return response.json()
  }
  const remoteUrl = 'https://github.com/' + route.repository + '.git'
  const update = async stage => {
    await db.query('update workflow_development_tasks set stage=$2,updated_at=now() where id=$1', [id, stage])
  }
  const appendProgress = async item => {
    try {
      await db.query(`update workflow_development_tasks set progress =
        (case when jsonb_array_length(progress) >= 24 then progress - 0 else progress end)
        || jsonb_build_array($2::jsonb || jsonb_build_object('at', now()))
        where id=$1 and status='developing'`, [id, item])
    } catch (error) {
      console.error('[workflow-development] progress update failed:', id, error.code || error.name)
    }
  }
  const findPr = async () => {
    const query = new URLSearchParams({ state: 'all', head: route.repository.split('/')[0] + ':' + branch })
    const result = await github('?' + query)
    return result.find(pr => pr.head.ref === branch &&
      pr.head.repo?.full_name.toLowerCase() === route.repository.toLowerCase())?.html_url
  }
  const complete = pr => db.query(`update workflow_development_tasks
    set status='pr_created', stage=null, failure=null, pr_url=$2, updated_at=now() where id=$1`, [id, pr])

  try {
    await update('checkout')
    const priorPr = await findPr()
    if (priorPr) return await complete(priorPr)
    const link = new URL(task.node_link, process.env.WORKFLOW_DEVELOPMENT_APP_URL || process.env.AUTH_APP_ORIGIN)
    if (!['http:', 'https:'].includes(link.protocol)) throw new Error('Invalid rule link')
    const branchRef = 'refs/heads/' + branch
    const remoteBranch = (await remote(['ls-remote', '--heads', remoteUrl, branchRef], { cwd: root })).split(/\s/)[0]
    if (remoteBranch && remoteBranch !== task.tested_commit) {
      throw new Error('Remote task branch no longer matches the tested commit')
    }
    let testResult = task.test_result
    if (!remoteBranch) {
      await remote(['clone', '--single-branch', '--depth=50', '--branch', route.branch, '--', remoteUrl, cwd], { cwd: root })
      await git(['switch', '-c', branch])
      const baseCommit = await git(['rev-parse', 'HEAD'])
      const checkBase = async () => {
        if (await git(['rev-parse', 'HEAD']) !== baseCommit ||
          await git(['symbolic-ref', '--short', 'HEAD']) !== branch) {
          throw new Error('Task branch or base was modified')
        }
      }
      await update('agent')
      const agentEnv = agentProcessEnv(root)
      let writes = Promise.resolve()
      try {
        await execute(agent[0], agent.slice(1), {
          cwd, env: agentEnv, signal, timeout: 15 * 60 * 1000,
          input: JSON.stringify({
            id, version: task.version, rule: task.snapshot, paths: route.paths, test: route.test,
            target: taskTarget(task)
          }),
          onOutputLine(line) {
            const event = agentProgress(line)
            if (event) writes = writes.then(() => appendProgress(event))
          }
        })
      } finally {
        await writes
      }
      await checkBase()
      await git(['add', '-A', '--', '.'])
      const staged = (await git(['diff', '--cached', '--name-only', '--no-renames', '-z']))
        .split('\0').filter(Boolean)
      checkPaths(staged, route.paths)
      await appendProgress({ event: 'patch_applied', count: staged.length })
      const stagedTree = await git(['write-tree'])
      await update('test')
      const started = Date.now()
      const [testCommand, ...testArgs] = testRunner ? [...testRunner, ...route.test] : route.test
      await execute(testCommand, testArgs, { cwd, env, signal, timeout: 15 * 60 * 1000 })
      await checkBase()
      await git(['add', '-A', '--', '.'])
      if (await git(['write-tree']) !== stagedTree) throw new Error('Tests modified the staged changes')
      await git(['-c', 'user.name=Mind Map Workflow', '-c', 'user.email=workflow@users.noreply.github.com',
        '-c', 'commit.gpgsign=false', 'commit', '-m', 'Implement workflow rule ' + task.version.slice(0, 12)])
      const commit = await git(['rev-parse', 'HEAD'])
      testResult = { command: route.test, exitCode: 0, durationMs: Date.now() - started }
      await appendProgress({ event: 'test_passed', durationMs: testResult.durationMs })
      await db.query(`update workflow_development_tasks
        set tested_commit=$2,test_result=$3,stage='push',updated_at=now() where id=$1`, [id, commit, testResult])
      await remote(['push', '--', remoteUrl, 'HEAD:' + branchRef])
    }
    await update('pr')
    const body = [
      '规则节点 ' + link.href,
      '规则版本 `' + task.version + '`',
      '测试命令 `' + JSON.stringify(testResult.command).replaceAll('`', '\\u0060') + '`',
      '测试通过，退出码 0，耗时 ' + testResult.durationMs + ' ms'
    ].join('\n\n')
    const existing = await findPr()
    const pr = existing || (await github('', {
      draft: true, base: route.branch, head: branch, title: '实现脑图规则 ' + task.version.slice(0, 12), body
    })).html_url
    if (!pr) throw new Error('GitHub did not return a PR URL')
    await complete(pr)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

const stageFailures = {
  checkout: '读取目标仓库失败，请检查仓库权限、目标分支或任务分支。',
  agent: '开发 Agent 执行失败，未能生成可测试的代码修改。',
  test: '测试未通过，或测试改动了待提交文件。',
  push: '推送任务分支失败，请检查仓库权限。',
  pr: '创建草稿 PR 失败，请检查仓库权限和脑图公开地址。'
}
const agentFailures = {
  AGENT_PROVIDER: '模型调用失败，请检查 CodeBuddy CLI 登录状态或模型连接。',
  AGENT_TIMEOUT: 'CodeBuddy 模型请求超时，自动重试后仍未完成。',
  AGENT_RATELIMIT: 'CodeBuddy 模型请求受到限流，请稍后重试。',
  AGENT_RESPONSE: '模型未返回可解析的开发结果。',
  AGENT_CONTEXT: '模型在允许的轮次内未完成代码上下文读取。',
  AGENT_RULE: '模型需要更明确的规则行为或数据字段才能生成修改。',
  AGENT_LOCATION: '模型在配置的代码目录内未找到可实现该规则的入口。',
  AGENT_PATCH: '模型生成的补丁无法应用到目标分支。',
  AGENT_SCOPE: '模型修改了配置目录之外的文件。',
  AGENT_EMPTY: '模型未产生可提交的文件修改。'
}

async function main() {
  const agent = commandSetting('WORKFLOW_DEVELOPMENT_AGENT')
  const testRunner = commandSetting('WORKFLOW_DEVELOPMENT_TEST_RUNNER')
  const token = process.env.WORKFLOW_DEVELOPMENT_GITHUB_TOKEN
  const credentialHelper = process.env.WORKFLOW_DEVELOPMENT_GITHUB_AUTH === 'git-credential'
  const deployment = deploymentSetting(process.env.WORKFLOW_DEVELOPMENT_DEPLOYMENT)
  const merge = mergeSetting(process.env.WORKFLOW_DEVELOPMENT_MERGE)
  if (!agent || (!token && !credentialHelper)) {
    throw new Error('Set WORKFLOW_DEVELOPMENT_AGENT and a GitHub token or Git credential helper')
  }
  const pool = new Pool({ connectionTimeoutMillis: 8000 })
  pool.on('error', () => {})
  const stop = new AbortController()
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => stop.abort())
  const deployments = deployment
    ? pollDeployments(pool, deployment, {
      getToken: route => token || githubCredential(route), execute: run, projectEnv, agentProcessEnv,
      merge, agent, testRunner
    }, stop.signal)
    : Promise.resolve()
  try {
    while (!stop.signal.aborted) {
      let db
      try {
        await initSchema(pool)
        db = await pool.connect()
        const controller = new AbortController()
        db.on('error', () => controller.abort())
        const signal = AbortSignal.any([controller.signal, stop.signal])
        const { rows: [lease] } = await db.query('select pg_try_advisory_lock(hashtext($1)) as acquired', [lock])
        if (lease.acquired) {
          const { rows: [task] } = await db.query(`update workflow_development_tasks
            set status='developing', stage='checkout', progress='[]', updated_at=now()
            where id=(select id from workflow_development_tasks where status in ('queued','developing')
              order by created_at,id limit 1) returning *`)
          if (task) {
            try {
              const githubToken = token || await githubCredential(task.route)
              await processTask(db, task, { agent, token: githubToken, testRunner }, signal)
            } catch (error) {
              if (!signal.aborted) {
                const launcherCode = String(error.stderr || '').match(/^\[workflow-development-agent\] (AGENT_[A-Z]+)\s*$/m)?.[1]
                const diagnostic = launcherCode || error.code || error.name
                const detail = Object.hasOwn(agentFailures, diagnostic) ? agentFailures[diagnostic] : null
                console.error('[workflow-development]', task.id, diagnostic)
                await db.query(`update workflow_development_tasks set status='failed',
                  failure=coalesce(case when stage='agent' then $3::text end,($2::jsonb)->>stage,'开发任务失败。'),
                  updated_at=now() where id=$1`, [task.id, stageFailures, detail])
              }
            }
          }
        }
      } catch (error) {
        console.error('[workflow-development] queue unavailable:', error.code || error.name)
      } finally {
        if (db) db.release(true)
      }
      if (!stop.signal.aborted) await delay(3000, undefined, { signal: stop.signal }).catch(() => {})
    }
  } finally {
    stop.abort()
    await deployments
    await pool.end()
  }
}

if (require.main === module) main().catch(error => {
  console.error('[workflow-development]', error.message)
  process.exitCode = 1
})

module.exports = { run, checkPaths, processTask, githubCredential }
