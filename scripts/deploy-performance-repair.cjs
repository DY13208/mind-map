// Recreate only the mind-map app while preserving its effective runtime config.
// The retained rollback container is detached from Compose and never started.
'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const TARGET = 'mind-map-app-1'
const HEALTH_URL = 'http://127.0.0.1:8990/api/health'
const BACKUP_LABEL = 'mind-map.performance-repair.backup'
const BACKUP_SOURCE_IMAGE_LABEL = 'mind-map.performance-repair.source-image'
const BACKUP_BRIDGE_ENABLED_LABEL = 'mind-map.performance-repair.event-bridge-enabled'
const CODE_PATHS = ['/app/simple-mind-map', '/usr/share/nginx/html']

function cloneJson(value) {
  if (value == null) return value
  return JSON.parse(JSON.stringify(value))
}

function stampNow(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

function parseEnvironment(entries) {
  const env = new Map()
  for (const entry of entries || []) {
    const text = String(entry)
    const separator = text.indexOf('=')
    if (separator < 0) env.set(text, '')
    else env.set(text.slice(0, separator), text.slice(separator + 1))
  }
  return env
}

function validateHealth(statusOk, data) {
  if (!statusOk || !data || data.ok !== true) {
    throw new Error('当前应用健康检查未通过，停止性能修复部署')
  }
  if (!data.eventBridge || typeof data.eventBridge.enabled !== 'boolean') {
    throw new Error('健康检查未返回明确的 eventBridge.enabled，停止性能修复部署')
  }
  return {
    ok: true,
    eventBridgeEnabled: data.eventBridge.enabled
  }
}

function normalizedContainerPath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized || '/'
}

function isCodePathChange(changePath) {
  const changed = normalizedContainerPath(changePath)
  return CODE_PATHS.some(root => changed === root || changed.startsWith(root + '/'))
}

function assertNoCodeLayerChanges(changes) {
  if (!Array.isArray(changes)) {
    throw new Error('无法读取旧容器可写层变更，停止部署')
  }
  const codeChanges = changes
    .filter(change => change && isCodePathChange(change.Path))
    .map(change => normalizedContainerPath(change.Path))
  if (codeChanges.length) {
    throw new Error('旧容器在代码目录存在可写层变更，停止部署：' + codeChanges.join(', '))
  }
  return codeChanges
}

function blankComposeLabels(labels) {
  return Object.fromEntries(
    Object.entries(labels || {}).map(([key, value]) => [
      key,
      key.startsWith('com.docker.compose.') ? '' : value
    ])
  )
}

function blankBackupMarkers(labels) {
  return {
    ...(labels || {}),
    [BACKUP_LABEL]: '',
    [BACKUP_SOURCE_IMAGE_LABEL]: '',
    [BACKUP_BRIDGE_ENABLED_LABEL]: ''
  }
}

function composeLabelSummary(labels) {
  const entries = Object.entries(labels || {})
    .filter(([key]) => key.startsWith('com.docker.compose.'))
    .sort(([left], [right]) => left.localeCompare(right))
  return {
    blankKeys: entries
      .filter(([, value]) => value == null || String(value) === '')
      .map(([key]) => key),
    activeComposeLabels: Object.fromEntries(
      entries.filter(([, value]) => value != null && String(value) !== '')
    )
  }
}

function emptyPortBindings() {
  return {}
}

function backupCreateConfig(current, bridgeEnabled) {
  if (!current || !current.Config || !current.HostConfig || !current.Image) {
    throw new Error('旧容器配置不完整，不能建立回滚备份')
  }
  if (typeof bridgeEnabled !== 'boolean') {
    throw new Error('旧容器健康检查未提供明确的 eventBridge.enabled，不能建立回滚备份')
  }
  const config = cloneJson(current.Config)
  config.Image = current.Image
  config.ExposedPorts = {}
  config.Labels = blankComposeLabels(config.Labels)
  config.Labels[BACKUP_LABEL] = 'true'
  config.Labels[BACKUP_SOURCE_IMAGE_LABEL] = current.Image
  config.Labels[BACKUP_BRIDGE_ENABLED_LABEL] = String(bridgeEnabled)
  if (config.Hostname === String(current.Id || '').slice(0, 12)) config.Hostname = ''

  const hostConfig = cloneJson(current.HostConfig)
  hostConfig.NetworkMode = 'none'
  hostConfig.PortBindings = emptyPortBindings()
  hostConfig.PublishAllPorts = false
  hostConfig.RestartPolicy = { Name: 'no', MaximumRetryCount: 0 }
  hostConfig.AutoRemove = false
  delete hostConfig.ContainerIDFile
  return { ...config, HostConfig: hostConfig }
}

function networkEndpoints(current) {
  const networks = (current.NetworkSettings && current.NetworkSettings.Networks) || {}
  const endpoints = {}
  const containerName = String(current.Name || '').replace(/^\//, '')
  const shortId = String(current.Id || '').slice(0, 12)
  for (const [name, network] of Object.entries(networks)) {
    const ipam = network && network.IPAMConfig
    if (ipam && (ipam.IPv4Address || ipam.IPv6Address)) {
      throw new Error('检测到固定容器 IP；该部署助手不会在旧容器仍连接时复用固定 IP')
    }
    const endpoint = {}
    const aliases = (network && network.Aliases) || []
    if (aliases.length) {
      endpoint.Aliases = aliases.filter(alias =>
        alias !== current.Id && alias !== shortId && alias !== containerName
      )
    }
    if (network && Array.isArray(network.Links) && network.Links.length) {
      endpoint.Links = network.Links.slice()
    }
    if (network && network.DriverOpts && Object.keys(network.DriverOpts).length) {
      endpoint.DriverOpts = cloneJson(network.DriverOpts)
    }
    if (network && Number.isFinite(Number(network.GwPriority))) {
      endpoint.GwPriority = Number(network.GwPriority)
    }
    endpoints[name] = endpoint
  }
  return Object.keys(endpoints).length ? { EndpointsConfig: endpoints } : undefined
}

function activeCreateConfig(current, image, imageId, bridgeEnabled) {
  const config = cloneJson(current.Config)
  const env = parseEnvironment(config.Env)
  if (!bridgeEnabled) {
    // Preserve the old effective protocol state across a source default change.
    env.set('COLLAB_V2_EVENT_BRIDGE', '0')
    env.set('COLLAB_MCP_DIRECT', '0')
  }
  config.Image = image
  config.Env = Array.from(env, ([key, value]) => key + '=' + value)
  config.Labels = {
    ...blankBackupMarkers(config.Labels),
    'com.docker.compose.image': imageId
  }
  if (config.Hostname === String(current.Id || '').slice(0, 12)) config.Hostname = ''
  const createConfig = {
    ...config,
    HostConfig: cloneJson(current.HostConfig)
  }
  const networking = networkEndpoints(current)
  if (networking) createConfig.NetworkingConfig = networking
  else delete createConfig.NetworkingConfig
  return createConfig
}

function rollbackCreateConfig(current, backup) {
  const config = cloneJson(backup.Config)
  config.Image = backup.Image
  config.ExposedPorts = cloneJson(current.Config.ExposedPorts || config.ExposedPorts || {})
  config.Labels = {
    ...(backup.Config.Labels || {}),
    ...(current.Config.Labels || {}),
    'com.docker.compose.image': backup.Image
  }
  config.Labels = blankBackupMarkers(config.Labels)
  if (config.Hostname === String(backup.Id || '').slice(0, 12)) config.Hostname = ''
  if (config.Hostname === String(current.Id || '').slice(0, 12)) config.Hostname = ''
  const createConfig = {
    ...config,
    HostConfig: cloneJson(current.HostConfig)
  }
  const networking = networkEndpoints(current)
  if (networking) createConfig.NetworkingConfig = networking
  else delete createConfig.NetworkingConfig
  return createConfig
}

function assertManagedApp(container) {
  if (!container || container.Config?.Labels?.['com.docker.compose.service'] !== 'app') {
    throw new Error('目标不是 Compose 管理的 mind-map app 容器')
  }
}

function assertRollbackBackup(container, name) {
  if (!/^mind-map-app-rollback-perf-[0-9TZ-]+$/.test(name || '')) {
    throw new Error('只允许使用性能修复生成的回滚容器')
  }
  if (!container || container.Config?.Labels?.[BACKUP_LABEL] !== 'true') {
    throw new Error('回滚容器缺少性能修复备份标记')
  }
  const labels = container.Config.Labels || {}
  const composeLabels = composeLabelSummary(labels)
  if (Object.keys(composeLabels.activeComposeLabels).length) {
    throw new Error('回滚容器仍带有 Compose 管理标签，停止回滚')
  }
  if (container.Config.Labels[BACKUP_SOURCE_IMAGE_LABEL] !== container.Image) {
    throw new Error('回滚容器镜像与备份来源记录不一致')
  }
  if (!['true', 'false'].includes(container.Config.Labels[BACKUP_BRIDGE_ENABLED_LABEL])) {
    throw new Error('回滚容器缺少明确的 eventBridge.enabled 备份记录')
  }
  if (container.State?.Running) throw new Error('回滚备份容器必须保持停止状态')
  const host = container.HostConfig || {}
  if (host.NetworkMode !== 'none' || Object.keys(host.PortBindings || {}).length || host.PublishAllPorts !== false) {
    throw new Error('回滚备份容器仍连接网络或占用端口')
  }
  const networks = Object.keys(container.NetworkSettings?.Networks || {})
  if (networks.some(network => network !== 'none')) {
    throw new Error('回滚备份容器仍连接生产网络')
  }
  if (host.RestartPolicy?.Name !== 'no') {
    throw new Error('回滚备份容器必须禁用自动重启')
  }
  return composeLabels
}

function engineRequest(socketPath, method, endpoint, data, httpModule = http) {
  return new Promise((resolve, reject) => {
    const body = data === undefined ? null : JSON.stringify(data)
    const request = httpModule.request({
      socketPath,
      path: endpoint,
      method,
      headers: body
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        : {}
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        if (response.statusCode >= 400) {
          return reject(new Error('Docker ' + method + ' ' + endpoint.split('?')[0] + ' failed (' + response.statusCode + ')'))
        }
        const text = Buffer.concat(chunks).toString()
        try {
          resolve(text ? JSON.parse(text) : null)
        } catch (error) {
          reject(new Error('Docker returned invalid JSON for ' + endpoint.split('?')[0]))
        }
      })
    })
    request.on('error', reject)
    if (body) request.write(body)
    request.end()
  })
}

function createController(deps) {
  const docker = deps.docker
  const inspect = deps.inspect || (name => JSON.parse(docker(['inspect', name]))[0])
  const engine = deps.engine
  const fetchImpl = deps.fetchImpl || fetch
  const wait = deps.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const writeReport = deps.writeReport || ((file, contents) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(contents, null, 2))
  })
  const root = deps.root || path.resolve(__dirname, '..')
  const now = deps.now || (() => new Date())
  const attempts = deps.healthAttempts || 40
  const retryDelayMs = deps.healthRetryDelayMs == null ? 500 : deps.healthRetryDelayMs

  function inspectImageId(image) {
    const result = deps.inspectImage
      ? deps.inspectImage(image)
      : JSON.parse(docker(['image', 'inspect', image]))[0]?.Id
    if (!result) throw new Error('无法解析目标镜像 ID')
    return typeof result === 'string' ? result : result.Id
  }

  async function readHealth() {
    const response = await fetchImpl(HEALTH_URL, { signal: AbortSignal.timeout(1500) })
    let data
    try {
      data = await response.json()
    } catch (_) {
      throw new Error('健康检查未返回有效 JSON，停止性能修复部署')
    }
    return validateHealth(response.ok, data)
  }

  async function waitForHealth(expectedBridge) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const health = await readHealth()
        if (health.eventBridgeEnabled === expectedBridge) return health
      } catch (_) {}
      if (attempt + 1 < attempts) await wait(retryDelayMs)
    }
    throw new Error('新应用未通过健康检查或协作开关状态不符')
  }

  async function getDeploymentPlan(image) {
    if (!/^mind-map-app:perf-repair-[a-zA-Z0-9.-]+$/.test(image || '')) {
      throw new Error('镜像必须符合 mind-map-app:perf-repair-<revision> 格式')
    }
    const current = inspect(TARGET)
    assertManagedApp(current)
    if (!current.State?.Running) throw new Error('当前 app 容器未运行，停止部署')
    const health = await readHealth()
    const imageId = inspectImageId(image)
    const changes = await engine('GET', '/containers/' + encodeURIComponent(current.Id) + '/changes')
    assertNoCodeLayerChanges(changes)
    const stamp = stampNow(now())
    const backupName = 'mind-map-app-rollback-perf-' + stamp
    const stagingName = 'mind-map-app-staging-perf-' + stamp
    const backupConfig = backupCreateConfig(current, health.eventBridgeEnabled)
    const activeConfig = activeCreateConfig(current, image, imageId, health.eventBridgeEnabled)
    return {
      current,
      image,
      imageId,
      health,
      backupName,
      stagingName,
      backupConfig,
      activeConfig,
      changes
    }
  }

  async function getRollbackPlan(backupName) {
    const current = inspect(TARGET)
    assertManagedApp(current)
    const currentHealth = await readHealth()
    const backup = inspect(backupName)
    assertRollbackBackup(backup, backupName)
    const config = rollbackCreateConfig(current, backup)
    return {
      current,
      currentHealth,
      backup,
      config,
      expectedBridge: backup.Config.Labels[BACKUP_BRIDGE_ENABLED_LABEL] === 'true',
      imageId: backup.Image
    }
  }

  async function createContainer(name, config) {
    const response = await engine('POST', '/containers/create?name=' + encodeURIComponent(name), config)
    if (!response || !response.Id) throw new Error('Docker 未返回新容器 ID')
    return response.Id
  }

  function removeContainer(name, force = false) {
    docker(['rm', ...(force ? ['-f'] : []), name])
  }

  function tryInspect(name) {
    try {
      return inspect(name)
    } catch (_) {
      return null
    }
  }

  function tryRemoveContainer(name, force = false) {
    try {
      removeContainer(name, force)
      return null
    } catch (error) {
      return error
    }
  }

  async function deploy(image) {
    const plan = await getDeploymentPlan(image)
    let backupCreated = false
    let backupCreateAttempted = false
    let backupId = null
    let backupComposeLabels = null
    let stagingRenameAttempted = false
    let activeCreateAttempted = false
    let healthPassed = false
    let stagingCleanupAttempted = false
    let committed = false
    try {
      backupCreateAttempted = true
      backupId = await createContainer(plan.backupName, plan.backupConfig)
      backupCreated = true
      backupComposeLabels = assertRollbackBackup(inspect(plan.backupName), plan.backupName)

      stagingRenameAttempted = true
      docker(['rename', TARGET, plan.stagingName])
      activeCreateAttempted = true
      await createContainer(TARGET, plan.activeConfig)
      docker(['stop', '-t', '10', plan.stagingName])
      docker(['start', TARGET])

      const health = await waitForHealth(plan.health.eventBridgeEnabled)
      if (inspect(TARGET).Image !== plan.imageId) throw new Error('新容器镜像 ID 与目标镜像不一致')
      healthPassed = true
      // The independent old-image backup is retained; the duplicate Compose
      // identity on the staging container is removed only after both gates pass.
      stagingCleanupAttempted = true
      removeContainer(plan.stagingName)
      committed = true

      const report = {
        at: now().toISOString(),
        container: TARGET,
        imageTag: image,
        imageId: plan.imageId,
        rollbackContainer: plan.backupName,
        previousImageId: plan.current.Image,
        backupArtifact: {
          source: 'original-container-image',
          imageId: plan.current.Image,
          writableLayerIncluded: false,
          codeLayerChanges: 'none',
          composeLabels: backupComposeLabels
        },
        health,
        preserved: {
          environment: true,
          ports: true,
          mounts: true,
          networks: true,
          eventBridgeEnabled: plan.health.eventBridgeEnabled
        },
        rollbackCommand: 'node scripts/deploy-performance-repair.cjs --rollback ' + plan.backupName
      }
      let reportWritten = true
      try {
        await writeReport(path.join(root, 'output', 'performance-repair-20261013', 'deployment.json'), report)
      } catch (_) {
        reportWritten = false
      }
      return {
        deployed: true,
        imageId: plan.imageId,
        rollbackContainer: plan.backupName,
        bridgeEnabled: plan.health.eventBridgeEnabled,
        reportWritten
      }
    } catch (error) {
      if (committed) {
        error.deploymentCommitted = true
        throw error
      }

      let recoveryError = null
      const active = tryInspect(TARGET)
      const staged = tryInspect(plan.stagingName)
      const activeIsNew = active && active.Id !== plan.current.Id &&
        (active.Image === plan.imageId || active.Config?.Image === plan.image)
      if (!staged && activeIsNew && healthPassed && stagingCleanupAttempted) {
        // The remove request may have lost its response after Docker completed it.
        // The new target already passed health and image gates; retain the backup.
        committed = true
        return {
          deployed: true,
          imageId: plan.imageId,
          rollbackContainer: plan.backupName,
          bridgeEnabled: plan.health.eventBridgeEnabled,
          reportWritten: false,
          cleanupWarning: '旧 staging 容器已移除，但 Docker 未确认删除响应'
        }
      }

      if (staged && staged.Id === plan.current.Id) {
        try {
          if (active && active.Id !== plan.current.Id) {
            if (activeCreateAttempted && activeIsNew) removeContainer(TARGET, true)
            else throw new Error('目标名称被其他容器占用，未删除未知容器')
          }
          if (tryInspect(TARGET)) throw new Error('旧容器恢复目标名称仍被占用')
          docker(['rename', plan.stagingName, TARGET])
          const restored = inspect(TARGET)
          if (!restored.State?.Running) docker(['start', TARGET])
          const recovered = inspect(TARGET)
          if (recovered.Image !== plan.current.Image) throw new Error('恢复后的旧容器镜像 ID 不一致')
          await waitForHealth(plan.health.eventBridgeEnabled)
        } catch (restoreError) {
          recoveryError = restoreError
        }
      } else {
        if (active && active.Id === plan.current.Id) {
          try {
            if (!active.State?.Running) docker(['start', TARGET])
            await waitForHealth(plan.health.eventBridgeEnabled)
          } catch (restoreError) {
            recoveryError = restoreError
          }
        } else if (stagingRenameAttempted) {
          recoveryError = recoveryError || new Error('未找到可恢复的旧 app 容器')
        }
      }

      if (!recoveryError && backupId && (backupCreated || backupCreateAttempted)) {
        const backup = tryInspect(plan.backupName)
        if (backup) {
          try {
            if (backup.Id !== backupId) throw new Error('回滚备份名称已被其他容器占用，未删除未知容器')
            const currentAtTarget = tryInspect(TARGET)
            const staging = tryInspect(plan.stagingName)
            const oldAppRestored = currentAtTarget?.Id === plan.current.Id && !staging
            if (!oldAppRestored) {
              assertRollbackBackup(backup, plan.backupName)
              if (backup.Image !== plan.current.Image) throw new Error('新建回滚备份镜像不匹配')
            }
            recoveryError = tryRemoveContainer(plan.backupName) || null
          } catch (backupError) {
            recoveryError = backupError
          }
        }
      }
      if (recoveryError) {
        throw new Error(error.message + '；自动恢复未完成：' + recoveryError.message)
      }
      throw error
    }
  }

  async function rollback(backupName) {
    const plan = await getRollbackPlan(backupName)
    const stamp = stampNow(now())
    const candidateName = 'mind-map-app-restore-perf-' + stamp
    const rejectedName = 'mind-map-app-rejected-perf-' + stamp
    let candidateCreateAttempted = false
    let currentRenameAttempted = false
    let candidatePromoteAttempted = false
    let committed = false
    try {
      candidateCreateAttempted = true
      await createContainer(candidateName, plan.config)
      currentRenameAttempted = true
      docker(['rename', TARGET, rejectedName])
      docker(['stop', '-t', '10', rejectedName])
      candidatePromoteAttempted = true
      docker(['rename', candidateName, TARGET])
      docker(['start', TARGET])
      const health = await waitForHealth(plan.expectedBridge)
      if (inspect(TARGET).Image !== plan.imageId) throw new Error('回滚容器镜像 ID 与备份不一致')
      removeContainer(rejectedName)
      committed = true
      return {
        rolledBack: true,
        restoredImage: plan.imageId,
        backupContainer: backupName,
        bridgeEnabled: plan.expectedBridge,
        health
      }
    } catch (error) {
      if (committed) {
        error.rollbackCommitted = true
        throw error
      }
      let recoveryError = null
      let targetNow = tryInspect(TARGET)
      if (targetNow && targetNow.Id !== plan.current.Id) {
        const isOurRestoredCandidate = targetNow.Image === plan.imageId &&
          targetNow.Config?.Labels?.['com.docker.compose.service'] === 'app'
        if (candidatePromoteAttempted && isOurRestoredCandidate) {
          recoveryError = tryRemoveContainer(TARGET, true) || recoveryError
        } else {
          recoveryError = new Error('回滚目标名称被其他容器占用，未删除未知容器')
        }
      }

      const candidate = tryInspect(candidateName)
      if (candidate && candidateCreateAttempted && candidate.Image === plan.imageId) {
        recoveryError = tryRemoveContainer(candidateName, true) || recoveryError
      }

      const rejected = tryInspect(rejectedName)
      if (rejected && rejected.Id === plan.current.Id) {
        try {
          if (tryInspect(TARGET)) throw new Error('活动容器恢复目标名称仍被占用')
          docker(['rename', rejectedName, TARGET])
          targetNow = inspect(TARGET)
          if (!targetNow.State?.Running) docker(['start', TARGET])
          await waitForHealth(plan.currentHealth.eventBridgeEnabled)
        } catch (restoreError) {
          recoveryError = restoreError
        }
      } else {
        targetNow = tryInspect(TARGET)
        if (targetNow && targetNow.Id === plan.current.Id) {
          try {
            if (!targetNow.State?.Running) docker(['start', TARGET])
            await waitForHealth(plan.currentHealth.eventBridgeEnabled)
          } catch (restoreError) {
            recoveryError = restoreError
          }
        } else if (currentRenameAttempted) {
          recoveryError = recoveryError || new Error('未找到可恢复的活动 app 容器')
        }
      }
      if (recoveryError) {
        throw new Error(error.message + '；活动容器自动恢复未完成：' + recoveryError.message)
      }
      throw error
    }
  }

  async function dryRunDeploy(image) {
    const plan = await getDeploymentPlan(image)
    return {
      dryRun: true,
      container: TARGET,
      imageTag: image,
      imageId: plan.imageId,
      bridgeEnabled: plan.health.eventBridgeEnabled,
      backupContainer: plan.backupName,
      backupSourceImage: plan.current.Image,
      writableLayerCodeChanges: 0,
      composeManagedTarget: plan.activeConfig.Labels['com.docker.compose.service'] === 'app',
      backupComposeLabels: composeLabelSummary(plan.backupConfig.Labels),
      preserved: {
        environment: true,
        ports: Object.keys(plan.current.HostConfig.PortBindings || {}).length,
        mounts: (plan.current.Mounts || []).length,
        networks: Object.keys((plan.current.NetworkSettings && plan.current.NetworkSettings.Networks) || {})
      }
    }
  }

  async function dryRunRollback(backupName) {
    const plan = await getRollbackPlan(backupName)
    return {
      dryRun: true,
      container: TARGET,
      backupContainer: backupName,
      restoredImage: plan.imageId,
      bridgeEnabled: plan.expectedBridge,
      composeManagedTarget: plan.config.Labels['com.docker.compose.service'] === 'app',
      composeLabels: composeLabelSummary(plan.config.Labels),
      ports: Object.keys(plan.config.HostConfig.PortBindings || {}).length,
      mounts: Object.keys(plan.config.HostConfig.Mounts || {}).length + (plan.current.Mounts || []).length,
      networks: Object.keys((plan.current.NetworkSettings && plan.current.NetworkSettings.Networks) || {})
    }
  }

  function inspectSummary() {
    const current = inspect(TARGET)
    return {
      container: TARGET,
      image: current.Image,
      running: current.State.Running,
      networks: Object.keys(current.NetworkSettings.Networks || {}),
      mounts: (current.Mounts || []).length
    }
  }

  return { deploy, rollback, dryRunDeploy, dryRunRollback, inspectSummary }
}

function runtimeDependencies() {
  const docker = args => execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
  const host = docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])
  if (!host.startsWith('npipe:////./pipe/')) {
    throw new Error('This deployment helper requires the local Windows Docker engine')
  }
  const socketPath = '\\\\.\\pipe\\' + host.slice('npipe:////./pipe/'.length)
  return {
    docker,
    engine: (method, endpoint, data) => engineRequest(socketPath, method, endpoint, data)
  }
}

async function main(argv = process.argv.slice(2)) {
  const deps = runtimeDependencies()
  const controller = createController(deps)
  if (argv[0] === '--inspect') {
    await deps.engine('GET', '/version')
    console.log(JSON.stringify(controller.inspectSummary(), null, 2))
    return
  }
  if (argv[0] === '--dry-run' && argv[1] === '--deploy') {
    console.log(JSON.stringify(await controller.dryRunDeploy(argv[2]), null, 2))
    return
  }
  if (argv[0] === '--dry-run' && argv[1] === '--rollback') {
    console.log(JSON.stringify(await controller.dryRunRollback(argv[2]), null, 2))
    return
  }
  if (argv[0] === '--deploy') {
    console.log(JSON.stringify(await controller.deploy(argv[1])))
    return
  }
  if (argv[0] === '--rollback') {
    console.log(JSON.stringify(await controller.rollback(argv[1])))
    return
  }
  throw new Error('Use --inspect, --dry-run --deploy mind-map-app:perf-repair-<revision>, --deploy mind-map-app:perf-repair-<revision>, --dry-run --rollback <backup-container>, or --rollback <backup-container>')
}

module.exports = {
  TARGET,
  BACKUP_LABEL,
  BACKUP_BRIDGE_ENABLED_LABEL,
  BACKUP_SOURCE_IMAGE_LABEL,
  assertNoCodeLayerChanges,
  activeCreateConfig,
  backupCreateConfig,
  createController,
  isCodePathChange,
  networkEndpoints,
  parseEnvironment,
  rollbackCreateConfig,
  validateHealth
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
