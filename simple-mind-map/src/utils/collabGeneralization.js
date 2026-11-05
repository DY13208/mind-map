/* global module:readonly */

function snapshotValue(value) {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object') return value
  try {
    return JSON.parse(JSON.stringify(value))
  } catch (err) {
    return value
  }
}

function listGeneralization(generalization) {
  if (generalization == null) return []
  return Array.isArray(generalization) ? generalization : [generalization]
}

// 渲染态标记，绝不能持久化：
//   inserting    —— MindMapNode 渲染完见它会 delete + active() + 触发
//                   node_dblclick 自动进入编辑。一旦存进 generalization，
//                   每次刷新都会自动弹编辑框，节点被顶掉。
//   isActive     —— 会话内选中态
//   resetRichText—— 一次性重解析富文本的开关
const EPHEMERAL_KEYS = ['inserting', 'isActive', 'resetRichText']

function stripEphemeralFields(target) {
  if (!target || typeof target !== 'object') return target
  EPHEMERAL_KEYS.forEach(key => {
    delete target[key]
  })
  return target
}

// generalization.children 里存的是渲染树节点 { data, children }，需要逐层清。
function stripEphemeralTree(node) {
  if (!node || typeof node !== 'object') return node
  const copy = { ...node }
  stripEphemeralFields(copy)
  if (copy.data && typeof copy.data === 'object') {
    copy.data = stripEphemeralFields({ ...copy.data })
    if (Array.isArray(copy.data.children)) {
      copy.data.children = copy.data.children.map(stripEphemeralTree)
    }
  }
  if (Array.isArray(copy.children)) {
    copy.children = copy.children.map(stripEphemeralTree)
  }
  return copy
}

function stripEphemeralGen(item) {
  if (!item || typeof item !== 'object') return item
  const copy = stripEphemeralFields(snapshotValue(item) || {})
  if (Array.isArray(copy.children)) {
    copy.children = copy.children.map(stripEphemeralTree)
  }
  return copy
}

function generalizationSignature(generalization) {
  const list = listGeneralization(generalization).filter(Boolean)
  if (!list.length) return ''
  return list
    .map(item => {
      if (!item || typeof item !== 'object') return String(item || '')
      try {
        return JSON.stringify(stripEphemeralGen(item))
      } catch (err) {
        return String(item.uid || '')
      }
    })
    .join('|')
}

function ownerGeneralizationPayload(generalization) {
  const list = listGeneralization(generalization).filter(Boolean)
  if (!list.length) return null
  return list.map(stripEphemeralGen)
}

function mergeVirtualEditIntoOwner(ownerGeneralization, virtualUid, patch = {}) {
  const list = listGeneralization(ownerGeneralization).filter(Boolean)
  if (!list.length || !virtualUid) return ownerGeneralizationPayload(ownerGeneralization)
  const incoming = { ...(snapshotValue(patch) || {}) }
  delete incoming.generalization
  delete incoming.uid
  delete incoming.__fv
  delete incoming.parent
  delete incoming.parentUid
  delete incoming.parent_uid
  delete incoming.index
  delete incoming.position
  const next = list.map(item => {
    if (!item || item.uid !== virtualUid) return stripEphemeralGen(item)
    return stripEphemeralGen({ ...item, ...incoming, uid: virtualUid })
  })
  return next.length ? next : null
}

const api = {
  snapshotValue,
  listGeneralization,
  generalizationSignature,
  ownerGeneralizationPayload,
  mergeVirtualEditIntoOwner
}

module.exports = api
module.exports.default = api
