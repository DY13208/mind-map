const { plain } = require('./leaveWorkflow/core')

const commitId = /^[a-f0-9]{40}$/
const failedChecks = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale'])

function mergeSetting(raw) {
  if (!raw) return null
  const config = JSON.parse(raw)
  if (!config || typeof config.roomId !== 'string' || !config.roomId ||
    !/^[\w-]+\/[\w.-]+$/.test(config.repository || '') || config.branch !== 'main' ||
    !Array.isArray(config.autoNodes) || !config.autoNodes.every(node => typeof node === 'string' && node)) {
    throw new Error('WORKFLOW_DEVELOPMENT_MERGE requires repository, branch, roomId and autoNodes')
  }
  return config
}

function mergeAllowed(config, task) {
  return !!config && task.room_id === config.roomId && task.route?.branch === config.branch &&
    task.route.repository?.toLowerCase() === config.repository.toLowerCase()
}

function mergeRequested(config, task) {
  return mergeAllowed(config, task) &&
    (!!task.merge_requested_at || config.autoNodes.includes(task.node_id))
}

function reviewedPull(pr, task, head, base) {
  return pr.state === 'open' && !pr.merged && pr.head?.sha === head && pr.base?.sha === base &&
    pr.head?.ref === 'codex/workflow-' + task.id && pr.base?.ref === task.route.branch &&
    [pr.head?.repo?.full_name, pr.base?.repo?.full_name].every(repo =>
      repo?.toLowerCase() === task.route.repository.toLowerCase())
}

function verdictOf(stdout) {
  const result = JSON.parse(stdout)
  if (result?.verdict !== 'approve' && result?.verdict !== 'block') throw new Error('Invalid review verdict')
  if (!Array.isArray(result.findings) || result.findings.length > 8 ||
    !result.findings.every(finding => typeof finding === 'string' && finding.trim() && finding.length <= 400) ||
    (result.verdict === 'approve') !== (result.findings.length === 0)) throw new Error('Invalid review findings')
  return result
}

async function checksFor(github, head) {
  const [status, checks] = await Promise.all([
    github('/commits/' + head + '/status?per_page=100'),
    github('/commits/' + head + '/check-runs?per_page=100&filter=latest')
  ])
  if (checks.total_count > checks.check_runs.length || status.total_count > status.statuses.length) {
    return 'waiting_checks'
  }
  if (['error', 'failure'].includes(status.state) ||
    checks.check_runs.some(check => failedChecks.has(check.conclusion))) return 'checks_failed'
  if (status.statuses.some(check => check.state !== 'success') ||
    checks.check_runs.some(check => check.status !== 'completed' ||
      !['success', 'neutral', 'skipped'].includes(check.conclusion))) return 'waiting_checks'
  return 'ready'
}

async function reviewAndMerge(task, pr, {
  number, github, readyForReview, execute, git, cwd, cleanEnv, agentEnv, agent, testRunner,
  validDiff, stillCurrent, save, signal, revise, maxRevisions = 2
}) {
  const head = pr.head.sha
  const base = pr.base.sha
  if (!commitId.test(head) || !commitId.test(base) || !reviewedPull(pr, task, head, base)) return
  const set = (state, extra = {}) => save({ state, head, base, ...extra })
  const previous = task.merge_review
  const same = previous?.head === head && previous?.base === base
  if (same && ['blocked', 'failed', 'merged'].includes(previous.state)) return
  const accepted = same && ['verified', 'waiting_checks', 'checks_failed', 'merging'].includes(previous.state)
  try {
    if (!await stillCurrent()) return await set('blocked', { findings: ['脑图规则或路由已更新，请按当前版本生成开发任务。'] })
    if (!accepted) {
      await set('reviewing')
      if (!testRunner) throw new Error('An isolated test runner is required for merging')
      await git(['init', '-q'])
      await git(['fetch', '--no-tags', 'https://github.com/' + task.route.repository + '.git',
        'refs/heads/' + task.route.branch + ':refs/heads/target',
        'refs/pull/' + number + '/head:refs/heads/review'])
      if (await git(['rev-parse', 'refs/heads/target']) !== base ||
        await git(['rev-parse', 'refs/heads/review']) !== head) return await set('changed')
      const range = base + '...' + head
      const paths = await git(['diff', '--no-renames', '--name-only', '-z', range, '--'])
      if (!paths || !validDiff(paths, task.route.paths)) {
        return await set('blocked', { findings: ['改动超出了此任务允许合入的 HRMS 后端范围。'] })
      }
      const diff = await git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=24', range, '--'])
      if (Buffer.byteLength(diff) > 115000 || /(?:^|\n)(?:Binary files |GIT binary patch)/.test(diff)) {
        return await set('blocked', { findings: ['变更超出自动审查可以完整检查的范围。'] })
      }
      await git(['checkout', '--detach', head])
      const joined = await git(['-c', 'user.name=Mind Map Workflow', '-c', 'user.email=workflow@users.noreply.github.com',
        'merge', '--no-ff', '--no-commit', base]).then(() => true, () => false)
      if (!joined) return await set('blocked', { findings: ['当前 PR 与主分支存在合并冲突。'] })
      const [runner, ...runnerArgs] = [...testRunner, ...task.route.test]
      try {
        await execute(runner, runnerArgs, { cwd, env: cleanEnv, signal, timeout: 15 * 60 * 1000 })
      } catch (error) {
        if (signal.aborted) throw error
        return await set('blocked', { findings: ['PR 与当前主分支合并后的代码未通过配置的回归测试。'] })
      }
      const rule = task.snapshot.map(node => ({
        text: plain(node.data?.text), note: plain(node.data?.note)
      }))
      const tests = []
      let testBytes = 0
      for (const arg of task.route.test) {
        if (!/^tests\/hrms\/[\w./-]+\.py$/.test(arg) || arg.split('/').includes('..')) continue
        const text = await git(['show', ':backend/' + arg]).catch(() => '')
        const bytes = Buffer.byteLength(text)
        if (!bytes || testBytes + bytes > 70000) continue
        tests.push({ path: 'backend/' + arg, text })
        testBytes += bytes
      }
      const stdout = await execute(agent[0], agent.slice(1), {
        cwd, env: agentEnv, signal, timeout: 4 * 60 * 1000,
        input: JSON.stringify({ mode: 'review', rule, diff, head, base, test: task.route.test, tests })
      })
      const result = verdictOf(stdout)
      if (result.verdict === 'block') {
        const revisions = Number(previous?.revisions) || 0
        const revisedHeads = Array.isArray(previous?.revisedHeads)
          ? previous.revisedHeads.filter(item => commitId.test(String(item)))
          : []
        const findings = result.findings.slice(0, 8)
        if (!revise || revisions >= maxRevisions || revisedHeads.includes(head)) {
          return await set('blocked', { findings, revisions, revisedHeads })
        }
        await set('revising', {
          findings, revisions: revisions + 1, revisedHeads: [...revisedHeads, head].slice(-8)
        })
        try {
          await revise({ head, base, number, findings })
        } catch (error) {
          if (signal.aborted) throw error
          console.error('[workflow-merge] revision failed', task.id, error.code || error.message)
          return await set('blocked', {
            findings: [...findings, '自动修正未完成：' + String(error.message || '未知原因').slice(0, 160)].slice(0, 8),
            revisions, revisedHeads
          })
        }
        return
      }
      await set('verified')
    }

    let current = await github('/pulls/' + number)
    if (!reviewedPull(current, task, head, base)) return await set('changed')
    if (current.draft) {
      await readyForReview(current.node_id, head, base)
      current = await github('/pulls/' + number)
    }
    if (!reviewedPull(current, task, head, base)) return await set('changed')
    const checks = await checksFor(github, head)
    if (checks !== 'ready') {
      if (previous?.state !== checks || !same) await set(checks)
      return
    }
    if (current.draft || current.mergeable !== true || !['clean', 'unstable'].includes(current.mergeable_state)) {
      if (previous?.state !== 'waiting_checks' || !same) await set('waiting_checks')
      return
    }
    const latest = await github('/pulls/' + number)
    if (!reviewedPull(latest, task, head, base)) return await set('changed')
    if (!await stillCurrent()) return await set('blocked', { findings: ['脑图规则或路由已更新，请按当前版本生成开发任务。'] })
    await set('merging')
    const result = await github('/pulls/' + number + '/merge', {
      method: 'PUT',
      body: { sha: head, merge_method: 'squash', commit_title: '实现脑图规则 ' + task.version.slice(0, 12) + ' (#' + number + ')' }
    })
    if (!result.merged || !commitId.test(result.sha)) throw new Error('GitHub did not confirm the merge')
    await set('merged', { commit: result.sha })
  } catch (error) {
    if (signal.aborted) throw error
    console.error('[workflow-merge]', task.id, error.code || error.message)
    if ([405, 409, 422].includes(error.status)) return await set('waiting_checks')
    await set('failed')
  }
}

module.exports = { mergeSetting, mergeAllowed, mergeRequested, reviewAndMerge, verdictOf }
