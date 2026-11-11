const { mkdir, mkdtemp, readFile, writeFile, rename, rm } = require('node:fs/promises')
const { randomUUID } = require('node:crypto')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { describe, initSchema, validPath, validRoute } = require('./workflowDevelopment')
const { subtree } = require('./leaveWorkflow/service')
const { mergeRequested, reviewAndMerge } = require('./workflowMerge')

const revisionLabel = 'org.opencontainers.image.revision'
const managedLabel = 'mind-map.workflow-deployment'
const sha = /^[0-9a-f]{40}$/
const digest = /^sha256:[0-9a-f]{64}$/
const composeFiles = ['docker-compose.local-postgres.yaml', 'docker-compose.runtime.yaml', 'docker-compose.production-web.yaml']
const terminal = ['deployed', 'closed', 'superseded', 'deploy_failed', 'rolled_back', 'rollback_failed']
const backendRoots = ['backend/app/plugin/module_hrms/', 'backend/tests/hrms/']
const sameRepo = (left, right) => typeof left === 'string' && left.toLowerCase() === right.toLowerCase()

function deploymentSetting(raw) {
  if (!raw) return null
  const value = JSON.parse(raw)
  if (!value || !/^[\w-]+\/[\w.-]+$/.test(value.repository || '') ||
    !validPath(value.repository) || value.branch !== 'main' ||
    typeof value.composeDir !== 'string' || !path.isAbsolute(value.composeDir)) {
    throw new Error('WORKFLOW_DEVELOPMENT_DEPLOYMENT must identify the HRMS repository, main branch and absolute Compose directory')
  }
  return value
}

function pullNumber(task, config) {
  if (!validRoute(task.route) || !sameRepo(task.route.repository, config.repository) ||
    task.route.branch !== config.branch) return null
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)$/.exec(task.pr_url || '')
  return match && sameRepo(match[1], config.repository) ? match[2] : null
}

function deploymentFiles(diff, allowed) {
  return diff.split('\0').filter(Boolean).every(file =>
    validPath(file) && backendRoots.some(root => file.startsWith(root)) &&
    !file.split('/').some(part => /^(?:alembic|migrations?)$/i.test(part)) &&
    allowed.some(base => file === base || file.startsWith(base + '/')))
}

function composeArgs(config, args) {
  return [
    'compose', '--project-name', 'yr-hrms', '--project-directory', config.composeDir,
    '--env-file', path.join(config.composeDir, '.env.local'),
    ...composeFiles.flatMap(file => ['-f', path.join(config.composeDir, file)]),
    ...args
  ]
}

async function readObject(execute, kind, name, signal) {
  try {
    return JSON.parse(await execute('docker', [kind, 'inspect', '--format', '{{json .}}', name], { signal }))
  } catch (error) {
    if (/no such (?:object|image|container|network)|network \S+ not found/i.test(error.stderr || '')) return null
    throw error
  }
}

function verifyProduction(container, config) {
  const labels = container?.Config.Labels || {}
  if (labels['com.docker.compose.project'] !== 'yr-hrms' ||
    labels['com.docker.compose.service'] !== 'backend' ||
    path.normalize(labels['com.docker.compose.project.working_dir'] || '') !== path.normalize(config.composeDir) ||
    !digest.test(container.Image)) throw new Error('The current HRMS backend does not match the configured Compose project')
  return container
}

async function switchProduction(config, image, tag, execute) {
  await execute('docker', composeArgs(config, [
    'up', '-d', '--no-build', '--pull', 'never', '--no-deps', '--wait', '--wait-timeout', '180', 'backend'
  ]), { env: { ...process.env, IMAGE_TAG: tag }, timeout: 210000 })
  const active = verifyProduction(await readObject(execute, 'container', 'yr-hrms-backend'), config)
  if (active.Image !== image || active.State.Health?.Status !== 'healthy') {
    throw new Error('The running HRMS backend image or health status does not match the deployment')
  }
}

async function persistImageTag(config, tag) {
  const file = path.join(config.composeDir, '.env.local')
  const original = await readFile(file, 'utf8')
  const assignment = /^(?:export[ \t]+)?IMAGE_TAG[ \t]*=[^\r\n]*/m
  const ending = original.includes('\r\n') ? '\r\n' : '\n'
  const value = 'IMAGE_TAG=' + tag
  const updated = assignment.test(original) ? original.replace(assignment, value)
    : original + (original.endsWith('\n') ? '' : ending) + value + ending
  if (original === updated) return
  const temporary = file + '.workflow-' + randomUUID()
  try {
    await writeFile(temporary, updated, { flag: 'wx', mode: 0o600 })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

async function finishSwitch({ config, state, commit, image, previous, execute, save }) {
  const checkActive = async () => {
    const active = await readObject(execute, 'container', 'yr-hrms-backend')
    if (active && ![image, previous].includes(verifyProduction(active, config).Image)) {
      throw new Error('The HRMS backend image changed during deployment')
    }
  }
  await checkActive()
  try {
    if (state === 'rolling_back') throw new Error('Resuming interrupted rollback')
    await switchProduction(config, image, 'workflow-' + commit, execute)
  } catch (error) {
    console.error('[workflow-deployment] rollout failed:', commit, error.code || error.message)
    if (state !== 'rolling_back') await save({ state: 'rolling_back', commit, image, previous })
    try {
      await checkActive()
      const tag = 'workflow-rollback-' + previous.slice(7)
      await execute('docker', ['tag', previous, 'yr-hrms-backend:' + tag])
      await switchProduction(config, previous, tag, execute)
      await save({ state: 'rolled_back', commit })
    } catch (rollbackError) {
      console.error('[workflow-deployment] rollback failed:', commit, rollbackError.code || rollbackError.message)
      await save({ state: 'rollback_failed', commit })
    }
    return
  }
  await persistImageTag(config, 'workflow-' + commit)
  await save({ state: 'deployed', commit })
}

async function removePreview(execute, name) {
  for (const container of [name + '-proxy', name, name + '-redis']) {
    const existing = await readObject(execute, 'container', container)
    if (existing?.Config.Labels?.[managedLabel] === name) {
      await execute('docker', ['rm', '-f', '-v', container])
    }
  }
  const network = await readObject(execute, 'network', name)
  if (network?.Labels?.[managedLabel] === name) {
    await execute('docker', ['network', 'rm', name])
  }
}

async function startPreview(execute, name, image, root, signal) {
  await removePreview(execute, name)
  await execute('docker', ['network', 'create', '--internal', '--label', managedLabel + '=' + name, name], { signal })
  await execute('docker', [
    'run', '-d', '--name', name + '-redis', '--network', name, '--network-alias', 'redis',
    '--pull', 'never', '--user', '999:999', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--label', managedLabel + '=' + name,
    '--entrypoint', 'redis-server', 'redis:7-alpine', '--save', '', '--appendonly', 'no'
  ], { signal })
  await execute('docker', [
    'run', '-d', '--name', name, '--network', name, '--network-alias', 'preview',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '768m',
    '--label', managedLabel + '=' + name,
    '-e', 'DATABASE_TYPE=sqlite', '-e', 'DATABASE_NAME=/tmp/preview',
    '-e', 'DATABASE_AUTO_CREATE=true', '-e', 'REDIS_ENABLE=true',
    '-e', 'REDIS_HOST=redis', '-e', 'REDIS_PASSWORD=',
    '-e', 'APP_LOG_DIR=/tmp/hrms-logs', '-e', 'SERVER_HOST=0.0.0.0', '-e', 'SERVER_PORT=6101',
    '-e', 'SM4_KEY=01010101010101010101010101010101',
    image
  ], { signal })
  // The backend is reachable only through the fixed reverse proxy on host loopback.
  const proxy = name + '-proxy'
  const proxyConfig = path.join(root, 'preview-nginx.conf')
  await writeFile(proxyConfig, `pid /tmp/nginx.pid;
error_log stderr;
events {}
http {
  access_log off;
  client_body_temp_path /tmp/client_body;
  proxy_temp_path /tmp/proxy;
  fastcgi_temp_path /tmp/fastcgi;
  uwsgi_temp_path /tmp/uwsgi;
  scgi_temp_path /tmp/scgi;
  server {
    listen 8080;
    location / { proxy_pass http://preview:6101; }
  }
}
`, { flag: 'wx' })
  await execute('docker', [
    'create', '--name', proxy, '--pull', 'never', '--user', '101:101', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--label', managedLabel + '=' + name,
    '-p', '127.0.0.1::8080', '--entrypoint', 'nginx', 'nginx:1.27-alpine',
    '-c', '/tmp/preview-nginx.conf', '-g', 'daemon off;'
  ], { signal })
  await execute('docker', ['network', 'connect', name, proxy], { signal })
  await execute('docker', ['cp', proxyConfig, proxy + ':/tmp/preview-nginx.conf'], { signal })
  await execute('docker', ['start', proxy], { signal })
  const port = /^127\.0\.0\.1:([0-9]+)$/.exec(await execute('docker', ['port', proxy, '8080/tcp'], { signal }))
  if (!port) throw new Error('Preview port is not bound to host loopback')
  const origin = 'http://127.0.0.1:' + port[1]
  for (let attempt = 0; attempt < 40; attempt++) {
    const container = await readObject(execute, 'container', name, signal)
    if (!container?.State.Running) throw new Error('The isolated HRMS preview exited during startup')
    const response = await fetch(origin + '/openapi.json', {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)])
    }).catch(() => null)
    const spec = response?.ok ? await response.json().catch(() => null) : null
    if (Object.keys(spec?.paths || {})
      .some(route => route.endsWith('/approval/forms/{form_id}/start'))) return origin + '/docs'
    await delay(1000, undefined, { signal })
  }
  throw new Error('The isolated HRMS preview did not expose the approval API')
}

async function reconcileDeployment(db, task, config, {
  execute, token, merge, agent, testRunner, projectEnv, agentProcessEnv
}, signal) {
  const number = pullNumber(task, config)
  if (!number) return
  const name = 'hrms-workflow-preview-' + task.id
  const previousRun = task.deployment || {}
  const save = deployment => db.query(`update workflow_development_tasks
    set deployment=$2,updated_at=now() where id=$1`, [task.id, deployment])
  const githubRequest = async (url, { method, body } = {}) => {
    const response = await fetch(url, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)])
    })
    if (!response.ok) throw Object.assign(new Error('GitHub HTTP ' + response.status), { status: response.status })
    return response.json()
  }
  const github = (suffix, options) => githubRequest('https://api.github.com/repos/' + config.repository + suffix, options)
  const checkoutGit = root => args => execute('git', [
    '-c', 'core.hooksPath=' + path.join(root, 'disabled-hooks'), ...args
  ], {
    cwd: root, signal, timeout: 180000, env: {
      ...projectEnv(root), GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: 'Authorization: Basic ' + Buffer.from('x-access-token:' + token).toString('base64'),
      GIT_CONFIG_KEY_1: 'http.followRedirects', GIT_CONFIG_VALUE_1: 'false'
    }
  })
  if (['deploying', 'rolling_back'].includes(previousRun.state) && sha.test(previousRun.commit) &&
    digest.test(previousRun.image) && digest.test(previousRun.previous)) {
    return finishSwitch({ ...previousRun, config, execute, save })
  }
  const pr = await github('/pulls/' + number)
  if (!sameRepo(pr.base.repo.full_name, config.repository) || pr.base.ref !== config.branch ||
    pr.head.ref !== 'codex/workflow-' + task.id ||
    (!pr.merged && !sameRepo(pr.head.repo?.full_name, config.repository))) return
  if (pr.state === 'closed' && !pr.merged) {
    await removePreview(execute, name)
    return save({ state: 'closed' })
  }
  const commit = pr.merged ? pr.merge_commit_sha : pr.head.sha
  if (!sha.test(commit) || !sha.test(pr.base.sha)) throw new Error('GitHub did not provide full commit IDs')
  const mainCommit = async () => (await github('/branches/' + config.branch)).commit.sha
  if (pr.merged && await mainCommit() !== commit) {
    await removePreview(execute, name)
    return save({ state: 'superseded', commit })
  }
  if (!pr.merged && previousRun.commit === commit) {
    if (previousRun.state === 'preview_failed') return
    if (previousRun.state === 'preview_ready' &&
      (await readObject(execute, 'container', name, signal))?.State.Running &&
      (await readObject(execute, 'container', name + '-proxy', signal))?.State.Running &&
      (await readObject(execute, 'container', name + '-redis', signal))?.State.Running) {
      if (mergeRequested(merge, task)) {
        const cwd = await mkdtemp(path.join(tmpdir(), 'mind-map-hrms-review-'))
        try {
          await reviewAndMerge(task, pr, {
            number, github, execute, agent, testRunner, signal, cwd,
            git: checkoutGit(cwd), cleanEnv: projectEnv(cwd), agentEnv: agentProcessEnv(cwd),
            validDiff: deploymentFiles,
            async stillCurrent() {
              const nodes = await subtree(db, task.room_id, task.node_id)
              const rules = describe(nodes, task.room_id, task.node_id,
                JSON.parse(process.env.WORKFLOW_DEVELOPMENT_ROUTES || '{}'))
              return rules.version === task.version && !rules.missing.length &&
                sameRepo(rules.route?.repository, task.route.repository) &&
                rules.route.branch === task.route.branch
            },
            save: result => db.query(`update workflow_development_tasks
              set merge_review=$2,updated_at=now() where id=$1`, [task.id, result]),
            async revise({ head: target, number: prNumber, findings }) {
              const work = await mkdtemp(path.join(tmpdir(), 'mind-map-hrms-revise-'))
              const dir = path.join(work, 'checkout')
              try {
                await mkdir(dir, { recursive: true })
                const git = checkoutGit(dir)
                await git(['init', '-q'])
                await git(['fetch', '--no-tags', 'https://github.com/' + config.repository + '.git',
                  'refs/pull/' + prNumber + '/head:refs/heads/revise'])
                if (await git(['rev-parse', 'refs/heads/revise']) !== target) {
                  throw new Error('PR head changed before the revision')
                }
                await git(['checkout', 'refs/heads/revise'])
                await execute(agent[0], agent.slice(1), {
                  cwd: dir, env: agentProcessEnv(dir), signal, timeout: 15 * 60 * 1000,
                  input: JSON.stringify({
                    id: task.id, version: task.version, rule: task.snapshot,
                    paths: task.route.paths, test: task.route.test,
                    target: task.route.target, feedback: findings
                  })
                })
                await git(['add', '-A', '--', '.'])
                const staged = await git(['diff', '--cached', '--name-only', '--no-renames', '-z'])
                if (!deploymentFiles(staged, task.route.paths)) {
                  throw new Error('Revision touched files outside the HRMS backend scope')
                }
                const [runner, ...runnerArgs] = [...(testRunner || []), ...task.route.test]
                await execute(runner, runnerArgs, { cwd: dir, env: projectEnv(dir), signal, timeout: 15 * 60 * 1000 })
                await git(['-c', 'user.name=Mind Map Workflow',
                  '-c', 'user.email=workflow@users.noreply.github.com', '-c', 'commit.gpgsign=false',
                  'commit', '-m', 'Revise per AI review ' + String(task.version || '').slice(0, 12)])
                const commit = await git(['rev-parse', 'HEAD'])
                if (commit === target) throw new Error('Revision produced no new commit')
                await git(['push', '--', 'https://github.com/' + config.repository + '.git',
                  'HEAD:refs/heads/codex/workflow-' + task.id])
              } finally {
                await rm(work, { recursive: true, force: true }).catch(() => {})
              }
            },
            async readyForReview(id, head, base) {
              const result = await githubRequest('https://api.github.com/graphql', {
                method: 'POST',
                body: {
                  query: 'mutation($id:ID!) { markPullRequestReadyForReview(input:{pullRequestId:$id}) { pullRequest { isDraft headRefOid baseRefOid } } }',
                  variables: { id }
                }
              })
              const pull = result.data?.markPullRequestReadyForReview?.pullRequest
              if (result.errors?.length || pull?.isDraft !== false ||
                pull.headRefOid !== head || pull.baseRefOid !== base) {
                throw new Error('GitHub did not confirm the reviewed draft')
              }
            }
          })
        } finally {
          await rm(cwd, { recursive: true, force: true }).catch(() => {})
        }
      }
      return
    }
  }

  const root = await mkdtemp(path.join(tmpdir(), 'mind-map-hrms-deploy-'))
  const git = checkoutGit(root)
  let switching = false
  try {
    await save({ state: 'preview_building', commit })
    await removePreview(execute, name)
    await git(['init', '-q'])
    await git(['fetch', '--no-tags', 'https://github.com/' + config.repository + '.git',
      'refs/heads/' + config.branch + ':refs/heads/target',
      ...(pr.merged ? [] : ['refs/pull/' + number + '/head:refs/heads/review'])])
    if (await git(['rev-parse', pr.merged ? 'refs/heads/target' : 'refs/heads/review']) !== commit) {
      throw new Error('GitHub ref changed during checkout')
    }
    let production
    let base = pr.base.sha + '...' + commit
    if (pr.merged) {
      production = verifyProduction(await readObject(execute, 'container', 'yr-hrms-backend', signal), config)
      const installed = production.Config.Labels[revisionLabel]
      if (!/^[0-9a-f]{7,40}$/.test(installed || '')) throw new Error('Running image has no Git revision')
      await git(['merge-base', '--is-ancestor', installed, commit])
      base = installed + '..' + commit
    }
    if (!deploymentFiles(await git(['diff', '--name-only', '--no-renames', '-z', base, '--']), task.route.paths)) {
      throw new Error('Change set contains files outside the supported HRMS backend deployment scope')
    }
    await git(['checkout', '--detach', commit])
    const imageName = 'yr-hrms-backend:workflow-' + commit
    let image = await readObject(execute, 'image', imageName, signal)
    if (!image || image.Config.Labels?.[revisionLabel] !== commit) {
      await execute('docker', ['build', '--label', revisionLabel + '=' + commit,
        '-f', path.join(root, 'docker', 'backend', 'Dockerfile'), '-t', imageName, root
      ], { signal, timeout: 20 * 60 * 1000 })
      image = await readObject(execute, 'image', imageName, signal)
    }
    if (!image || !digest.test(image.Id) || image.Config.Labels?.[revisionLabel] !== commit) {
      throw new Error('Built image does not match the checked-out commit')
    }
    const previewUrl = await startPreview(execute, name, image.Id, root, signal)
    if (!pr.merged) return await save({ state: 'preview_ready', commit, previewUrl })

    if (await mainCommit() !== commit) {
      await removePreview(execute, name)
      return await save({ state: 'superseded', commit })
    }
    const active = verifyProduction(await readObject(execute, 'container', 'yr-hrms-backend', signal), config)
    if (active.Image !== production.Image || active.State.Health?.Status !== 'healthy') {
      throw new Error('The existing HRMS backend changed or is unhealthy before deployment')
    }
    await removePreview(execute, name)
    if (active.Image === image.Id) {
      await persistImageTag(config, 'workflow-' + commit)
      return await save({ state: 'deployed', commit })
    }
    const journal = { state: 'deploying', commit, image: image.Id, previous: active.Image }
    await execute('docker', ['tag', active.Image, 'yr-hrms-backend:workflow-rollback-' + active.Image.slice(7)], { signal })
    await save(journal)
    switching = true
    await finishSwitch({ ...journal, config, execute, save })
  } catch (error) {
    if (switching || signal.aborted) throw error
    console.error('[workflow-deployment]', task.id, error.stderr?.trim().split('\n').slice(-3).join(' ').slice(0, 500) ||
      error.code || error.message)
    await removePreview(execute, name).catch(() => {})
    await save({ state: pr.merged ? 'deploy_failed' : 'preview_failed', commit })
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

async function pollDeployments(pool, config, options, stop) {
  while (!stop.aborted) {
    let db
    try {
      await initSchema(pool)
      db = await pool.connect()
      const controller = new AbortController()
      db.on('error', () => controller.abort())
      const signal = AbortSignal.any([stop, controller.signal])
      const { rows: [lease] } = await db.query("select pg_try_advisory_lock(hashtext('mind-map-hrms-deployment')) as acquired")
      if (lease.acquired) {
        const { rows: [task] } = await db.query(`update workflow_development_tasks
          set deployment_checked_at=now() where id=(select id from workflow_development_tasks
            where status='pr_created' and lower(route->>'repository')=lower($1)
            and route->>'branch'=$2 and pr_url is not null
            and not (coalesce(deployment->>'state','') = any($3::text[]))
            and (deployment_checked_at is null or deployment_checked_at < now() - interval '30 seconds')
            order by (coalesce(deployment->>'state','') in ('deploying','rolling_back')) desc,
              deployment_checked_at nulls first, created_at desc limit 1)
          returning *`, [config.repository, config.branch, terminal])
        if (task && pullNumber(task, config)) {
          await reconcileDeployment(db, task, config, { ...options, token: await options.getToken(task.route) }, signal)
        }
      }
    } catch (error) {
      if (!stop.aborted) console.error('[workflow-deployment] monitor:', error.code || error.message)
    } finally {
      if (db) db.release(true)
    }
    if (!stop.aborted) await delay(5000, undefined, { signal: stop }).catch(() => {})
  }
}

module.exports = { deploymentSetting, deploymentFiles, pullNumber, pollDeployments, finishSwitch, startPreview, removePreview }
