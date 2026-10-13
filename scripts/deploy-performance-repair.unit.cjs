'use strict'

const assert = require('node:assert/strict')
const {
  BACKUP_LABEL,
  BACKUP_BRIDGE_ENABLED_LABEL,
  BACKUP_SOURCE_IMAGE_LABEL,
  TARGET,
  activeCreateConfig,
  assertNoCodeLayerChanges,
  backupCreateConfig,
  createController,
  rollbackCreateConfig,
  validateHealth
} = require('./deploy-performance-repair.cjs')

function makeCurrentContainer() {
  return {
    Id: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    Name: '/mind-map-app-1',
    Image: 'sha256:old-image',
    State: { Running: true },
    Config: {
      Image: 'mind-map-app:old',
      Env: [
        'PRIVATE_TOKEN=must-stay-in-container-config',
        'COLLAB_V2=1',
        'COLLAB_MCP_DIRECT=0'
      ],
      Labels: {
        'com.docker.compose.project': 'mind-map',
        'com.docker.compose.service': 'app',
        'com.docker.compose.container-number': '1',
        'com.docker.compose.image': 'sha256:old-image',
        'com.docker.compose.replace': 'app-1',
        'custom.label': 'kept'
      },
      ExposedPorts: { '80/tcp': {} },
      Hostname: '0123456789ab',
      Volumes: { '/app/output': {} }
    },
    HostConfig: {
      Binds: ['D:/mind-map/output:/app/output'],
      Mounts: [{ Type: 'bind', Source: 'D:/mind-map/output', Target: '/app/output' }],
      PortBindings: { '80/tcp': [{ HostIp: '', HostPort: '8990' }] },
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      NetworkMode: 'mind-map_default',
      AutoRemove: false
    },
    NetworkSettings: {
      Networks: {
        'mind-map_default': {
          Aliases: ['mind-map-app-1', 'app', '0123456789ab'],
          IPAMConfig: null,
          Links: null,
          DriverOpts: null,
          GwPriority: 0,
          IPAddress: '172.24.0.7'
        }
      }
    },
    Mounts: [{ Type: 'bind', Source: 'D:/mind-map/output', Destination: '/app/output' }]
  }
}

function makeHealthResponse(enabled, ok = true, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return { ok, eventBridge: { enabled } }
    }
  }
}

function makeMockDocker(initial) {
  const containers = new Map([[TARGET, structuredClone(initial)]])
  const calls = []
  let nextId = 0
  function docker(args) {
    calls.push(args.slice())
    const [command, first, second] = args
    if (command === 'rename') {
      const container = containers.get(first)
      if (!container || containers.has(second)) throw new Error('mock rename failed')
      containers.delete(first)
      container.Name = '/' + second
      containers.set(second, container)
      return second
    }
    if (command === 'stop') {
      const name = args[args.length - 1]
      const container = containers.get(name)
      if (!container) throw new Error('mock stop target missing')
      container.State.Running = false
      return name
    }
    if (command === 'start') {
      const container = containers.get(first)
      if (!container) throw new Error('mock start target missing')
      container.State.Running = true
      return first
    }
    if (command === 'rm') {
      const name = args[args.indexOf('-f') >= 0 ? 2 : 1]
      if (!containers.has(name)) throw new Error('mock rm target missing')
      containers.delete(name)
      return name
    }
    throw new Error('unexpected docker command: ' + args.join(' '))
  }
  const engine = async (method, endpoint, config) => {
    calls.push(['engine', method, endpoint])
    if (method === 'GET' && endpoint.endsWith('/changes')) return [{ Path: '/tmp/runtime-cache', Kind: 0 }]
    if (method !== 'POST' || !endpoint.startsWith('/containers/create?name=')) {
      throw new Error('unexpected engine call: ' + method + ' ' + endpoint)
    }
    const name = decodeURIComponent(endpoint.split('name=')[1])
    const image = config.Image === 'mind-map-app:perf-repair-test'
      ? 'sha256:new-image'
      : config.Image
    const container = {
      Id: 'mock-created-' + (++nextId),
      Name: '/' + name,
      Image: image,
      Config: Object.fromEntries(Object.entries(config).filter(([key]) =>
        !['HostConfig', 'NetworkingConfig'].includes(key)
      )),
      HostConfig: structuredClone(config.HostConfig),
      State: { Running: false },
      NetworkSettings: { Networks: {} },
      Mounts: config.HostConfig.Mounts || []
    }
    containers.set(name, container)
    return { Id: container.Id }
  }
  const inspect = name => {
    const container = containers.get(name)
    if (!container) throw new Error('mock inspect target missing: ' + name)
    return container
  }
  return { docker, engine, inspect, containers, calls }
}

async function testHealthGuard() {
  assert.deepEqual(validateHealth(true, { ok: true, eventBridge: { enabled: false } }), {
    ok: true,
    eventBridgeEnabled: false
  })
  assert.throws(() => validateHealth(false, { ok: true, eventBridge: { enabled: true } }), /健康检查/)
  assert.throws(() => validateHealth(true, { ok: false, eventBridge: { enabled: true } }), /健康检查/)
  assert.throws(() => validateHealth(true, { ok: true, eventBridge: {} }), /明确/)
}

function testBackupAndRuntimeConfig() {
  const current = makeCurrentContainer()
  const backup = backupCreateConfig(current, false)
  assert.equal(backup.Image, current.Image)
  assert.equal(backup.Labels[BACKUP_LABEL], 'true')
  assert.equal(backup.Labels[BACKUP_SOURCE_IMAGE_LABEL], current.Image)
  assert.equal(backup.Labels[BACKUP_BRIDGE_ENABLED_LABEL], 'false')
  assert.equal(Object.keys(backup.Labels).some(key => key.startsWith('com.docker.compose.')), false)
  assert.equal(backup.HostConfig.NetworkMode, 'none')
  assert.deepEqual(backup.HostConfig.PortBindings, {})
  assert.equal(backup.HostConfig.RestartPolicy.Name, 'no')
  assert.deepEqual(backup.ExposedPorts, {})
  assert.deepEqual(backup.HostConfig.Mounts, current.HostConfig.Mounts)
  assert.deepEqual(backup.Env, current.Config.Env)
  assert.equal(backup.Env.some(entry => entry.startsWith('COLLAB_V2_EVENT_BRIDGE=')), false)

  const active = activeCreateConfig(current, 'mind-map-app:perf-repair-test', 'sha256:new-image', false)
  assert.equal(active.Labels['com.docker.compose.project'], 'mind-map')
  assert.equal(active.Labels['com.docker.compose.service'], 'app')
  assert.equal(active.Labels['com.docker.compose.image'], 'sha256:new-image')
  assert.deepEqual(active.HostConfig.PortBindings, current.HostConfig.PortBindings)
  assert.deepEqual(active.HostConfig.Mounts, current.HostConfig.Mounts)
  assert.equal(active.Env.find(entry => entry.startsWith('PRIVATE_TOKEN=')), current.Config.Env[0])
  assert.equal(active.Env.find(entry => entry.startsWith('COLLAB_V2_EVENT_BRIDGE=')), 'COLLAB_V2_EVENT_BRIDGE=0')
  assert.equal(active.Env.find(entry => entry.startsWith('COLLAB_MCP_DIRECT=')), 'COLLAB_MCP_DIRECT=0')

  const backupInspect = {
    Id: 'backup-id',
    Image: current.Image,
    Config: backup,
    HostConfig: backup.HostConfig
  }
  const restored = rollbackCreateConfig(activeContainer(current, active), backupInspect)
  assert.equal(restored.Image, current.Image)
  assert.deepEqual(restored.Env, backup.Env)
  assert.equal(restored.Labels['com.docker.compose.service'], 'app')
  assert.deepEqual(restored.HostConfig.PortBindings, current.HostConfig.PortBindings)
  assert.deepEqual(restored.HostConfig.Mounts, current.HostConfig.Mounts)
}

function activeContainer(current, config) {
  return {
    ...structuredClone(current),
    Id: 'abcdef012345abcdef012345abcdef012345abcdef012345abcdef0123456789',
    Name: '/' + TARGET,
    Image: 'sha256:new-image',
    Config: Object.fromEntries(Object.entries(config).filter(([key]) =>
      !['HostConfig', 'NetworkingConfig'].includes(key)
    )),
    HostConfig: config.HostConfig,
    NetworkSettings: {
      Networks: {
        'mind-map_default': {
          Aliases: [TARGET, 'app'],
          IPAMConfig: null,
          Links: null,
          DriverOpts: null,
          GwPriority: 0
        }
      }
    }
  }
}

function testCodeLayerGuard() {
  assert.doesNotThrow(() => assertNoCodeLayerChanges([
    { Path: '/tmp/nginx-cache', Kind: 0 },
    { Path: '/app/output/export.json', Kind: 1 }
  ]))
  assert.throws(() => assertNoCodeLayerChanges([
    { Path: '/usr/share/nginx/html/js/app.js', Kind: 0 }
  ]), /可写层变更/)
  assert.throws(() => assertNoCodeLayerChanges(null), /无法读取/)
}

async function testDryRunDoesNotMutate() {
  const mock = makeMockDocker(makeCurrentContainer())
  const controller = createController({
    ...mock,
    inspectImage: () => 'sha256:new-image',
    fetchImpl: async () => makeHealthResponse(false),
    now: () => new Date('2026-10-13T01:02:03.000Z')
  })
  const plan = await controller.dryRunDeploy('mind-map-app:perf-repair-test')
  assert.equal(plan.dryRun, true)
  assert.equal(plan.writableLayerCodeChanges, 0)
  assert.equal(plan.backupComposeLabels, 0)
  assert.equal(plan.composeManagedTarget, true)
  assert.equal(mock.calls.some(args => ['rename', 'stop', 'start', 'rm'].includes(args[0])), false)
  assert.equal(mock.calls.some(args => args[0] === 'engine' && args[1] === 'POST'), false)
}

async function testFailedDeployRestoresOldContainer() {
  const mock = makeMockDocker(makeCurrentContainer())
  let healthCalls = 0
  const controller = createController({
    ...mock,
    inspectImage: () => 'sha256:new-image',
    fetchImpl: async () => {
      healthCalls += 1
      if (healthCalls === 2) return makeHealthResponse(false, false, 503)
      return makeHealthResponse(false)
    },
    wait: async () => {},
    healthAttempts: 1,
    now: () => new Date('2026-10-13T01:02:03.000Z'),
    writeReport: async () => { throw new Error('report should not be written on failed deployment') }
  })

  await assert.rejects(controller.deploy('mind-map-app:perf-repair-test'), /健康检查/)
  const restored = mock.inspect(TARGET)
  assert.equal(restored.Image, 'sha256:old-image')
  assert.equal(restored.State.Running, true)
  assert.equal(mock.containers.has('mind-map-app-staging-perf-2026-10-13T01-02-03-000Z'), false)
  assert.equal(mock.containers.has('mind-map-app-rollback-perf-2026-10-13T01-02-03-000Z'), false)
  assert.equal(mock.containers.has('mind-map-app:perf-repair-test'), false)
  assert.equal(mock.calls.some(args => args.includes('-v')), false)
  assert.equal(mock.calls.some(args => args[0] === 'rename' && args[1] === TARGET), true)
  assert.equal(mock.calls.some(args => args[0] === 'start' && args[1] === TARGET), true)
}

async function testRollbackRebuildsManagedTargetAndKeepsBackup() {
  const original = makeCurrentContainer()
  const activeConfig = activeCreateConfig(original, 'mind-map-app:perf-repair-test', 'sha256:new-image', false)
  const mock = makeMockDocker(activeContainer(original, activeConfig))
  const backupName = 'mind-map-app-rollback-perf-2026-10-13T01-02-03-000Z'
  const backupSpec = backupCreateConfig(original, false)
  mock.containers.set(backupName, {
    Id: 'backup-container-id',
    Name: '/' + backupName,
    Image: original.Image,
    Config: Object.fromEntries(Object.entries(backupSpec).filter(([key]) =>
      !['HostConfig', 'NetworkingConfig'].includes(key)
    )),
    HostConfig: backupSpec.HostConfig,
    State: { Running: false },
    NetworkSettings: { Networks: {} },
    Mounts: original.Mounts
  })
  const controller = createController({
    ...mock,
    fetchImpl: async () => makeHealthResponse(false),
    wait: async () => {},
    healthAttempts: 1,
    now: () => new Date('2026-10-13T01:02:03.000Z')
  })

  const dryRun = await controller.dryRunRollback(backupName)
  assert.equal(dryRun.bridgeEnabled, false)
  const result = await controller.rollback(backupName)
  const restored = mock.inspect(TARGET)
  assert.equal(result.rolledBack, true)
  assert.equal(result.bridgeEnabled, false)
  assert.equal(restored.Image, original.Image)
  assert.equal(restored.State.Running, true)
  assert.equal(restored.Config.Labels['com.docker.compose.service'], 'app')
  assert.equal(restored.Config.Labels['com.docker.compose.image'], original.Image)
  assert.deepEqual(restored.Config.Env, original.Config.Env)
  assert.deepEqual(restored.HostConfig.PortBindings, original.HostConfig.PortBindings)
  assert.deepEqual(restored.HostConfig.Mounts, original.HostConfig.Mounts)
  assert.equal(mock.containers.has(backupName), true)
  assert.equal(mock.calls.some(args => args.includes('-v')), false)
}

async function main() {
  await testHealthGuard()
  testBackupAndRuntimeConfig()
  testCodeLayerGuard()
  await testDryRunDoesNotMutate()
  await testFailedDeployRestoresOldContainer()
  await testRollbackRebuildsManagedTargetAndKeepsBackup()
  console.log('deploy-performance-repair tests passed')
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
