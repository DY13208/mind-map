import {
  copyRenderTree,
  simpleDeepClone,
  isSameObject,
  transformTreeDataToObject
} from '../../utils'
import { ERROR_TYPES } from '../../constants/constant'
import pkg from '../../../package.json'
import { undoTrace } from '../../utils/collabTrace'
import { isPersonalViewCommand } from '../../utils/personalViewCommands'
import { createContentTreeView } from '../../utils/contentTreeView'

//  命令类
class Command {
  //  构造函数
  constructor(opt = {}) {
    this.opt = opt
    this.mindMap = opt.mindMap
    this.commands = {}
    this.history = [] // 字符串形式存储
    this.activeHistoryIndex = 0
    this._historyByteLengths = []
    this.historyBytes = 0
    this._historyDiscardedEntries = 0
    this._execDepth = 0
    this._commandNames = []
    this._contentChange = null
    this.contentRevision = 0
    // 注册快捷键
    this.registerShortcutKeys()
    this.originAddHistory = this.addHistory.bind(this)
    this._historyTimer = null
    this.addHistory = (...args) => {
      if (this._historyTimer || this.mindMap._destroyed) return
      this._historyTimer = setTimeout(() => {
        try { this.originAddHistory(...args) }
        finally { this._historyTimer = null }
      }, this.mindMap.opt.addHistoryTime)
    }
    // 是否暂停收集历史数据
    this.isPause = false
  }

  // 暂停收集历史数据
  pause() {
    this.isPause = true
  }

  // 恢复收集历史数据
  recovery() {
    this.isPause = false
  }

  destroy() {
    clearTimeout(this._historyTimer)
    this._historyTimer = null
    this.isPause = true
    this.clearHistory()
    this.commands = {}
    this._contentChange = null
    this._contentView = null
    this._contentViewRoot = null
    this._commandNames = []
  }

  //  清空历史数据
  clearHistory() {
    this.history = []
    this._historyByteLengths = []
    this.historyBytes = 0
    this._historyDiscardedEntries = 0
    this.activeHistoryIndex = 0
    this.mindMap.emit('back_forward', 0, 0, this.getHistoryStatus())
  }

  getHistoryStatus() {
    const maxCount = Math.max(1, Number(this.mindMap.opt.maxHistoryCount) || 100)
    const maxBytes = Math.max(1, Number(this.mindMap.opt.maxHistoryBytes) || 32 * 1024 * 1024)
    const currentTooLarge = (this._historyByteLengths[this.activeHistoryIndex] || 0) > maxBytes
    return { undoSteps: this.activeHistoryIndex, redoSteps: Math.max(0, this.history.length - this.activeHistoryIndex - 1),
      retainedEntries: this.history.length, historyBytes: this.historyBytes, maxCount, maxBytes,
      discardedEntries: this._historyDiscardedEntries, currentTooLarge,
      limited: currentTooLarge || this._historyDiscardedEntries > 0 }
  }

  //  注册快捷键
  registerShortcutKeys() {
    this.mindMap.keyCommand.addShortcut('Control+z', () => {
      const cooperate = this.mindMap.cooperate
      undoTrace('keyboard', {
        key: 'Control+z',
        command: 'BACK',
        v2: !!(cooperate && cooperate.collabV2Adapter),
        historyLength: this.history.length,
        historyIndex: this.activeHistoryIndex
      })
      this.mindMap.execCommand('BACK')
    })
    this.mindMap.keyCommand.addShortcut('Control+y', () => {
      const cooperate = this.mindMap.cooperate
      undoTrace('keyboard', {
        key: 'Control+y',
        command: 'FORWARD',
        v2: !!(cooperate && cooperate.collabV2Adapter),
        historyLength: this.history.length,
        historyIndex: this.activeHistoryIndex
      })
      this.mindMap.execCommand('FORWARD')
    })
  }

  //  执行命令
  exec(name, ...args) {
    if (this.mindMap._destroyed) return
    if (this.mindMap.opt.readonly) {
      const data = name === 'SET_NODE_DATA' ? args[1] : null
      const allowed = {
        SET_NODE_ACTIVE: true,
        CLEAR_ACTIVE_NODE: true,
        SET_NODE_EXPAND: true,
        EXPAND_ALL: true,
        UNEXPAND_ALL: true,
        UNEXPAND_TO_LEVEL: true,
        GO_TARGET_NODE: true,
        SELECT_ALL: true,
        RETURN_CENTER: true,
        BACK: true,
        FORWARD: true
      }
      const expandOnly =
        name === 'SET_NODE_DATA' &&
        data &&
        typeof data === 'object' &&
        Object.keys(data).length > 0 &&
        Object.keys(data).every(key => key === 'expand' || key === 'isActive')
      if (!allowed[name] && !expandOnly) {
        return
      }
    }
    if (this.commands[name]) {
      const contentCommand = !['BACK', 'FORWARD', 'SET_NODE_ACTIVE', 'CLEAR_ACTIVE_NODE', 'SELECT_ALL', 'GO_TARGET_NODE', 'RETURN_CENTER'].includes(name) && !isPersonalViewCommand(name, args)
      const before = new Map()
      const collectBefore = value => {
        if (Array.isArray(value)) value.forEach(collectBefore)
        else if (value && value.nodeData) before.set(value, { data: { ...value.nodeData.data }, parent: value.parent })
      }
      if (contentCommand && this.usesV2History()) {
        args.forEach(collectBefore)
        if (!before.size) (this.mindMap.renderer.activeNodeList || []).forEach(collectBefore)
      }
      this._execDepth++
      this._commandNames.push(name)
      try {
      this.mindMap.emit('beforeExecCommand', name, ...args)
      if (name === 'BACK' || name === 'FORWARD') {
        const cooperate = this.mindMap.cooperate
        const top = this.history[this.activeHistoryIndex]
        undoTrace('command.exec', {
          name,
          v2: !!(cooperate && cooperate.collabV2Adapter),
          historyLength: this.history.length,
          historyIndex: this.activeHistoryIndex,
          topType: top ? 'snapshot' : 'empty'
        })
      }
      this.commands[name].forEach(fn => {
        fn(...args)
      })
      this.mindMap.emit('afterExecCommand', name, ...args)
      if (contentCommand) {
        const collect = value => {
          if (Array.isArray(value)) value.forEach(collect)
          else if (value && value.nodeData) {
            const previous = before.get(value)
            const data = value.nodeData.data
            if (!previous || previous.parent !== value.parent ||
              Object.keys(data).some(key => data[key] !== previous.data[key]) ||
              Object.keys(previous.data).some(key => !(key in data))) this.recordContentChange({ nodes: [value] })
          }
        }
        args.forEach(collect)
        if (!args.some(arg => arg && (arg.nodeData || Array.isArray(arg)))) {
          ;(this.mindMap.renderer.activeNodeList || []).forEach(collect)
        }
      }
      // Personal expand state is persisted separately. Serializing a whole
      // room snapshot here is costly and must not create a content undo step.
      if (this.mindMap.cooperate && this.mindMap.cooperate.httpCollabMode &&
          isPersonalViewCommand(name, args)) return
      if (
        ['BACK', 'FORWARD', 'SET_NODE_ACTIVE', 'CLEAR_ACTIVE_NODE'].includes(
          name
        )
      ) {
        return
      }
      if (!this.usesV2History()) this.addHistory()
      } finally {
        this._commandNames.pop()
        this._execDepth--
        if (!this._execDepth) this.flushContentChange()
      }
    }
  }

  usesV2History() {
    return !!(this.mindMap.cooperate && this.mindMap.cooperate.collabV2Adapter)
  }

  isCountableNode(node) {
    for (let current = node; current; current = current.parent) {
      if (current.isGeneralization) return false
    }
    return true
  }

  recordContentChange({ nodes = [], added = [], removed = [], source = 'local', countable = true } = {}) {
    if (!this.usesV2History() || this.mindMap._destroyed) return
    const cooperate = this.mindMap.cooperate
    if (source === 'local' && (cooperate.isApplyingRemote || cooperate.isSetData || cooperate.httpReplacing)) return
    if (!this._contentChange) this._contentChange = { nodes: new Map(), added: [], removed: [], source, commands: new Set() }
    // A hydrated range and the local command that requested it can finish in
    // one turn. Keep that local edit eligible for collaboration persistence.
    if (source === 'local') this._contentChange.source = 'local'
    ;(this._commandNames.length ? this._commandNames : [source === 'remote' ? 'REMOTE_APPLY' : 'ASYNC_APPLY']).forEach(name => this._contentChange.commands.add(name))
    const wrap = node => {
      const ordinary = countable && this.isCountableNode(node)
      return { tree: node.nodeData || node, countable: ordinary }
    }
    nodes.forEach(node => {
      const entry = wrap(node)
      if (entry.tree && entry.tree.data) this._contentChange.nodes.set(entry.tree.data.uid, entry)
    })
    this._contentChange.added.push(...added.map(wrap))
    this._contentChange.removed.push(...removed.map(wrap))
    if (!this._execDepth && !this.isPause) {
      Promise.resolve().then(() => { if (!this._execDepth) this.flushContentChange() })
    }
  }

  notifyTreeChange(commandName = 'SET_DATA') {
    if (!this.usesV2History() || this.mindMap._destroyed) return
    this._contentChange = null
    const root = this.mindMap.renderer.renderTree
    this._contentViewRoot = root
    this._contentView = createContentTreeView(root, pkg.version)
    const change = { full: true, source: 'load', commands: [commandName],
      revision: ++this.contentRevision, contentRevision: this.contentRevision }
    this.mindMap.emit('content_change', change)
    this.mindMap.emit('data_change', this._contentView, change)
  }

  flushContentChange() {
    if (this._execDepth || this.isPause || this.mindMap._destroyed || !this._contentChange) return
    const pending = this._contentChange
    this._contentChange = null
    if (!pending.nodes.size && !pending.added.length && !pending.removed.length) return
    const affected = new Set(pending.nodes.keys())
    const visit = entry => {
      if (!entry || !entry.data) return
      affected.add(entry.data.uid)
      ;(entry.children || []).forEach(visit)
    }
    ;[...pending.added, ...pending.removed].forEach(entry => visit(entry.tree))
    const change = { incremental: true, revision: ++this.contentRevision, contentRevision: this.contentRevision,
      commands: Array.from(pending.commands), affectedUids: Array.from(affected), source: pending.source,
      nodes: Array.from(pending.nodes.values()), added: pending.added, removed: pending.removed }
    this.mindMap.emit('before_content_change', change)
    const expose = entry => ({ tree: createContentTreeView(entry.tree, pkg.version), countable: entry.countable })
    const publicChange = { ...change, nodes: change.nodes.map(expose), added: change.added.map(expose), removed: change.removed.map(expose) }
    this.mindMap.emit('content_change', publicChange)
    const root = this.mindMap.renderer.renderTree
    if (this._contentViewRoot !== root) {
      this._contentViewRoot = root
      this._contentView = createContentTreeView(root, pkg.version)
    }
    this.mindMap.emit('data_change', this._contentView, publicChange)
  }

  //  添加命令
  add(name, fn) {
    if (this.commands[name]) {
      this.commands[name].push(fn)
    } else {
      this.commands[name] = [fn]
    }
  }

  //  移除命令
  remove(name, fn) {
    if (!this.commands[name]) {
      return
    }
    if (!fn) {
      this.commands[name] = []
      delete this.commands[name]
    } else {
      let index = this.commands[name].find(item => {
        return item === fn
      })
      if (index !== -1) {
        this.commands[name].splice(index, 1)
      }
    }
  }

  //  添加回退数据
  addHistory() {
    if (this.mindMap._destroyed) return
    if (this.usesV2History()) {
      this.flushContentChange()
      return
    }
    if (this.mindMap.opt.readonly || this.isPause) {
      return
    }
    this.mindMap.emit('beforeAddHistory')
    const lastDataStr =
      this.history.length > 0 ? this.history[this.activeHistoryIndex] : null
    const data = this.getCopyData()
    const dataStr = JSON.stringify(data)
    // 此次数据和上次一样则不重复添加
    if (lastDataStr && lastDataStr === dataStr) {
      return
    }
    this.emitDataUpdatesEvent(lastDataStr, dataStr)
    // 删除当前历史指针后面的数据
    if (this._historyByteLengths.length !== this.history.length) {
      this._historyByteLengths = this.history.map(value => new TextEncoder().encode(value).length)
    }
    this.history = this.history.slice(0, this.activeHistoryIndex + 1)
    this._historyByteLengths = this._historyByteLengths.slice(0, this.activeHistoryIndex + 1)
    this.history.push(dataStr)
    this._historyByteLengths.push(new TextEncoder().encode(dataStr).length)
    this.historyBytes = this._historyByteLengths.reduce((total, bytes) => total + bytes, 0)
    const maxCount = Math.max(1, Number(this.mindMap.opt.maxHistoryCount) || 100)
    const maxBytes = Math.max(1, Number(this.mindMap.opt.maxHistoryBytes) || 32 * 1024 * 1024)
    // One current state remains usable even if that single snapshot exceeds
    // the byte budget. Older states are evicted oldest-first.
    while (this.history.length > 1 && (this.history.length > maxCount || this.historyBytes > maxBytes)) {
      this.history.shift()
      this.historyBytes -= this._historyByteLengths.shift()
      this._historyDiscardedEntries++
    }
    this.activeHistoryIndex = this.history.length - 1
    this.mindMap.emit('data_change', data)
    this.mindMap.emit(
      'back_forward',
      this.activeHistoryIndex,
      this.history.length,
      this.getHistoryStatus()
    )
  }

  //  回退
  back(step = 1) {
    if (this.mindMap.opt.readonly) {
      return
    }
    if (this.activeHistoryIndex - step >= 0) {
      const lastDataStr = this.history[this.activeHistoryIndex]
      this.activeHistoryIndex -= step
      this.mindMap.emit(
        'back_forward',
        this.activeHistoryIndex,
        this.history.length,
        this.getHistoryStatus()
      )
      const dataStr = this.history[this.activeHistoryIndex]
      const data = JSON.parse(dataStr)
      this.emitDataUpdatesEvent(lastDataStr, dataStr)
      return data
    }
  }

  //  前进
  forward(step = 1) {
    if (this.mindMap.opt.readonly) {
      return
    }
    let len = this.history.length
    if (this.activeHistoryIndex + step <= len - 1) {
      const lastDataStr = this.history[this.activeHistoryIndex]
      this.activeHistoryIndex += step
      this.mindMap.emit(
        'back_forward',
        this.activeHistoryIndex,
        this.history.length,
        this.getHistoryStatus()
      )
      const dataStr = this.history[this.activeHistoryIndex]
      const data = JSON.parse(dataStr)
      this.emitDataUpdatesEvent(lastDataStr, dataStr)
      return data
    }
  }

  //  获取渲染树数据副本
  getCopyData() {
    if (!this.mindMap.renderer.renderTree) return null
    const res = copyRenderTree({}, this.mindMap.renderer.renderTree, true)
    res.smmVersion = pkg.version
    return res
  }

  // 移除节点数据中的uid
  removeDataUid(data) {
    data = simpleDeepClone(data)
    let walk = root => {
      delete root.data.uid
      if (root.children && root.children.length > 0) {
        root.children.forEach(item => {
          walk(item)
        })
      }
    }
    walk(data)
    return data
  }

  // 派发思维导图更新明细事件
  emitDataUpdatesEvent(lastDataStr, dataStr) {
    try {
      // 如果data_change_detail没有监听者，那么不进行计算，节省性能
      const eventName = 'data_change_detail'
      const count = this.mindMap.event.listenerCount(eventName)
      if (count > 0 && lastDataStr && dataStr) {
        const lastData = JSON.parse(lastDataStr)
        const data = JSON.parse(dataStr)
        const lastDataObj = simpleDeepClone(transformTreeDataToObject(lastData))
        const dataObj = simpleDeepClone(transformTreeDataToObject(data))
        const res = []
        const walkReplace = (root, obj) => {
          if (root.children && root.children.length > 0) {
            root.children.forEach((childUid, index) => {
              root.children[index] =
                typeof childUid === 'string'
                  ? obj[childUid]
                  : obj[childUid.data.uid]
              walkReplace(root.children[index], obj)
            })
          }
          return root
        }
        // 找出新增的或修改的
        Object.keys(dataObj).forEach(uid => {
          // 新增的或已经存在的，如果数据发生了改变
          if (!lastDataObj[uid]) {
            res.push({
              action: 'create',
              data: walkReplace(dataObj[uid], dataObj)
            })
          } else if (!isSameObject(lastDataObj[uid], dataObj[uid])) {
            res.push({
              action: 'update',
              oldData: walkReplace(lastDataObj[uid], lastDataObj),
              data: walkReplace(dataObj[uid], dataObj)
            })
          }
        })
        // 找出删除的
        Object.keys(lastDataObj).forEach(uid => {
          if (!dataObj[uid]) {
            res.push({
              action: 'delete',
              data: walkReplace(lastDataObj[uid], lastDataObj)
            })
          }
        })
        this.mindMap.emit(eventName, res)
      }
    } catch (error) {
      this.mindMap.opt.errorHandler(
        ERROR_TYPES.DATA_CHANGE_DETAIL_EVENT_ERROR,
        error
      )
    }
  }
}

export default Command
