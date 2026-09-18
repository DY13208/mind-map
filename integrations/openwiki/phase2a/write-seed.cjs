const fs = require('fs')
const envText = fs.readFileSync('.env', 'utf8')
function get(k) {
  const m = envText.match(new RegExp('^' + k + '=(.*)$', 'm'))
  if (!m) return ''
  return m[1].trim().replace(/^['"]|['"]$/g, '')
}
const deepseek = get('DEEPSEEK_API_KEY')
if (!deepseek) {
  console.error('no DEEPSEEK_API_KEY')
  process.exit(1)
}
const openwikiEnv = [
  'OPENWIKI_PROVIDER=openai-compatible',
  'OPENWIKI_MODEL_ID=deepseek-chat',
  'OPENAI_COMPATIBLE_API_KEY=' + deepseek,
  'OPENAI_COMPATIBLE_BASE_URL=https://api.deepseek.com/v1',
  'OPENWIKI_OPENAI_COMPATIBLE_STREAMING=false',
  'DO_NOT_TRACK=1',
  'MCP_TOKEN=' + (get('MCP_TOKEN') || '')
].join('\n') + '\n'

const wikiGoal =
  'Phase 2A contract test: synthesize durable wiki pages from Mind Map MCP and Canonical knowledge for test rooms ow-p2a-room-a and ow-p2a-room-b only. Keep pages short. Preserve source markers.'

const onboarding = {
  version: 1,
  completedAt: new Date().toISOString(),
  modeId: 'personal',
  modeName: 'Personal',
  templateId: 'personal',
  templateName: 'Personal',
  wikiGoal,
  ingestionSchedule: { cron: '0 3 * * *', timezone: 'Asia/Shanghai' },
  sources: {
    'custom-mcp': {
      enabled: true,
      ingestionGoal:
        'Read Mind Map MCP tools and extract facts for ow-p2a-room-a / ow-p2a-room-b if available.'
    }
  },
  sourceInstances: [
    {
      id: 'custom-mcp-1',
      connectorId: 'custom-mcp',
      name: 'Mind Map MCP',
      enabled: true,
      ingestionGoal:
        'Prefer query_nodes/search_nodes for rooms ow-p2a-room-a and ow-p2a-room-b.'
    }
  ]
}

const seedDir = 'integrations/openwiki/phase2a/seed'
fs.mkdirSync(seedDir, { recursive: true })
fs.writeFileSync(seedDir + '/openwiki.env', openwikiEnv)
fs.writeFileSync(seedDir + '/onboarding.json', JSON.stringify(onboarding, null, 2))
fs.writeFileSync(seedDir + '/INSTRUCTIONS.md', wikiGoal + '\n')
fs.writeFileSync(
  seedDir + '/canonical-mcp.connector.json',
  JSON.stringify(
    {
      enabled: true,
      transport: {
        type: 'stdio',
        command: 'node',
        args: ['/runtime/canonical-mcp.cjs']
      },
      allowedTools: ['list_knowledge', 'read_knowledge'],
      readOnlyOperations: [
        { type: 'tool', name: 'list_knowledge', args: {} },
        {
          type: 'tool',
          name: 'read_knowledge',
          args: { roomId: 'ow-p2a-room-a', file: 'README.md' }
        },
        {
          type: 'tool',
          name: 'read_knowledge',
          args: { roomId: 'ow-p2a-room-a', file: 'branches/hiring-sop.md' }
        }
      ]
    },
    null,
    2
  )
)
console.log('seed ok')
