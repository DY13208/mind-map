/**
 * 将内置「SOP 输出规则」脑图克隆到当前用户空间（全员可开、可复制）。
 */
import roomService from '@/services/roomService'
import teamService from '@/services/teamService'
import { replaceFileTree } from '@/utils/fileApi'
import { prepareImportedTree } from '@/utils/importTree'
import { SOP_OUTPUT_RULES_META } from '@/utils/sopOutputRules'

function toReplaceTree(parsed) {
  const source =
    parsed && parsed.data && (parsed.data.root || parsed.data.data)
      ? parsed.data
      : parsed
  const prepared = prepareImportedTree(source)
  const data = prepared && prepared.data
  return (data && data.root) || data
}

/**
 * @param {{ folderId?: string|null, teamId?: string|null, title?: string }} [options]
 * @returns {Promise<{ roomKey: string, title: string, room: any }>}
 */
export async function cloneSopOutputRulesTemplate(options = {}) {
  const url = SOP_OUTPUT_RULES_META.templateJsonUrl
  const res = await fetch(url, { credentials: 'same-origin' })
  if (!res.ok) {
    throw new Error(`无法加载内置输出规则模板（HTTP ${res.status}）`)
  }
  const payload = await res.json()
  const tree = toReplaceTree(payload)
  if (!tree) throw new Error('内置输出规则模板内容为空')

  const title =
    String(options.title || SOP_OUTPUT_RULES_META.title || 'SOP 输出规则').slice(
      0,
      60
    ) || 'SOP 输出规则'

  const room = options.teamId
    ? await teamService.createRoom(
        options.teamId,
        title,
        options.folderId || null
      )
    : await roomService.createRoom(title, options.folderId || null)

  const roomKey = room && (room.roomKey || room.key)
  if (!roomKey) throw new Error('创建脑图未返回 roomKey')

  await replaceFileTree(roomKey, tree, {
    allowFullTree: true,
    source: 'import'
  })

  return { roomKey, title, room }
}

export function getSopOutputRulesTemplateUrls() {
  return {
    xmind: SOP_OUTPUT_RULES_META.templateXmindUrl,
    json: SOP_OUTPUT_RULES_META.templateJsonUrl,
    version: SOP_OUTPUT_RULES_META.version,
    title: SOP_OUTPUT_RULES_META.title
  }
}
