import * as Y from 'yjs'
import { WebrtcProvider } from 'y-webrtc'
import {
  isSameObject,
  simpleDeepClone,
  getType,
  isUndef,
  transformTreeDataToObject,
  transformObjectToTreeData
} from '../utils/index'
import { applyObjectToYMap, migrateLegacyNodes } from './cooperateYjs'

// 协同插件
class Cooperate {
  constructor(opt) {
    this.opt = opt
    this.mindMap = opt.mindMap
    // yjs文档
    this.ydoc = new Y.Doc()
    // 共享数据
    this.ymap = null
    // 连接提供者
    this.provider = null
    // 感知数据
    this.awareness = null
    this.currentAwarenessData = []
    this.waitNodeUidMap = {} // 该列表中的uid对应的节点还未渲染完毕
    // 当前的平级对象类型的思维导图数据
    this.currentData = null
    // 用户信息
    this.userInfo = null
    // 是否正在重新设置思维导图数据
    this.isSetData = false
    // 尚未写入 ydoc 的本地数据，等同步完成后再决定推送还是采用远端
    this.pendingInitData = this.mindMap.opt.data
      ? simpleDeepClone(this.mindMap.opt.data)
      : null
    this.hasAppliedSync = false
    this.isApplyingRemote = false
    this.localOrigin = { source: 'simple-mind-map-cooperate' }
    // 绑定事件
    this.bindEvent()
  }

  // 初始化数据
  initData(data, { replace = false } = {}) {
    data = simpleDeepClone(data)
    // 解绑原来的数据
    if (this.ymap) {
      this.ymap.unobserveDeep(this.onObserve)
    }
    // 创建共享数据
    this.ymap = this.ydoc.getMap()
    // 思维导图树结构转平级对象结构
    this.currentData = transformTreeDataToObject(data)
    const previousData = this.ymap.toJSON()
    applyObjectToYMap(this.ymap, this.currentData, previousData, {
      origin: this.localOrigin,
      replace
    })
    this.currentData = simpleDeepClone(this.ymap.toJSON())
    // 监听数据同步
    this.onObserve = this.onObserve.bind(this)
    this.ymap.observeDeep(this.onObserve)
  }

  // 获取yjs doc实例
  getDoc() {
    return this.ydoc
  }

  // 设置连接提供者
  setProvider(provider, webrtcProviderConfig = {}) {
    this.disconnectProvider({ recreateDoc: false })
    const { roomName, signalingList, ...otherConfig } = webrtcProviderConfig
    this.hasAppliedSync = false
    this.provider =
      provider ||
      new WebrtcProvider(roomName, this.ydoc, {
        signaling: signalingList,
        ...otherConfig
      })
    this.awareness = this.provider.awareness

    // 监听状态同步事件
    this.onAwareness = this.onAwareness.bind(this)
    this.awareness.on('change', this.onAwareness)
    this.publishAwareness([])
    this.bindProviderSync()
  }

  // 等待文档同步后再决定采用远端数据还是推送本地数据
  bindProviderSync() {
    const apply = () => {
      if (this.hasAppliedSync) return
      this.hasAppliedSync = true
      this.applySyncedDoc()
    }
    if (this.provider && typeof this.provider.on === 'function') {
      this.provider.on('sync', isSynced => {
        if (isSynced !== false) apply()
      })
      this.provider.on('synced', synced => {
        if (synced !== false) apply()
      })
    }
    if (this.provider && this.provider.synced) {
      apply()
      return
    }
  }

  applySyncedDoc() {
    this.ymap = this.ydoc.getMap()
    migrateLegacyNodes(this.ymap)
    if (this.onObserve) {
      try {
        this.ymap.unobserveDeep(this.onObserve)
      } catch (e) {
        // ignore
      }
    }
    this.onObserve = this.onObserve.bind(this)
    this.ymap.observeDeep(this.onObserve)
    const remoteSize = [...this.ymap.keys()].length
    if (remoteSize > 0) {
      const data = this.ymap.toJSON()
      this.currentData = simpleDeepClone(data)
      const res = transformObjectToTreeData(data)
      if (res) {
        this.applyRemoteTree(res)
      }
      return
    }
    if (this.pendingInitData) {
      this.initData(this.pendingInitData, { replace: true })
    }
  }

  // 断开协同连接
  disconnectProvider({ recreateDoc = true } = {}) {
    if (this.awareness) {
      this.awareness.off('change', this.onAwareness)
      try {
        this.awareness.setLocalState(null)
      } catch (e) {
        // ignore
      }
    }
    if (this.provider && typeof this.provider.destroy === 'function') {
      this.provider.destroy()
    }
    this.provider = null
    this.awareness = null
    this.currentAwarenessData = []
    this.waitNodeUidMap = {}
    this.hasAppliedSync = false
    if (!recreateDoc) return
    if (this.ymap && this.onObserve) {
      this.ymap.unobserveDeep(this.onObserve)
    }
    this.ymap = null
    this.currentData = null
    try {
      this.pendingInitData = simpleDeepClone(this.mindMap.getData())
    } catch (e) {
      // ignore
    }
    if (this.ydoc) {
      this.ydoc.destroy()
    }
    this.ydoc = new Y.Doc()
  }

  // 绑定事件
  bindEvent() {
    // 监听思维导图改变
    this.onDataChange = this.onDataChange.bind(this)
    this.mindMap.on('data_change', this.onDataChange)

    // 监听思维导图节点激活事件
    this.onNodeActive = this.onNodeActive.bind(this)
    this.mindMap.on('node_active', this.onNodeActive)

    // 监听思维导图渲染完毕事件
    this.onNodeTreeRenderEnd = this.onNodeTreeRenderEnd.bind(this)
    this.mindMap.on('node_tree_render_end', this.onNodeTreeRenderEnd)

    // 监听设置思维导图数据事件
    this.onSetData = this.onSetData.bind(this)
    this.onBeforeSetData = this.onBeforeSetData.bind(this)
    this.mindMap.on('before_set_data', this.onBeforeSetData)
    this.mindMap.on('set_data', this.onSetData)
  }

  // 解绑事件
  unBindEvent() {
    this.disconnectProvider()
    this.mindMap.off('data_change', this.onDataChange)
    this.mindMap.off('node_active', this.onNodeActive)
    this.mindMap.off('node_tree_render_end', this.onNodeTreeRenderEnd)
    this.mindMap.off('before_set_data', this.onBeforeSetData)
    this.mindMap.off('set_data', this.onSetData)
  }

  // 数据同步时的处理，更新当前思维导图
  onObserve(events, transaction) {
    if (transaction && transaction.origin === this.localOrigin) return
    const hasLegacyNode = Array.from(this.ymap.values()).some(
      node => !(node instanceof Y.Map)
    )
    if (hasLegacyNode) {
      migrateLegacyNodes(this.ymap)
    }
    const data = this.ymap.toJSON()
    // 如果数据没有改变直接返回
    if (isSameObject(data, this.currentData)) return
    this.currentData = simpleDeepClone(data)
    // 平级对象转树结构
    const res = transformObjectToTreeData(data)
    if (!res) return
    this.applyRemoteTree(res)
  }

  // 概要不是树里的子节点，对端更新后需要再排一次版才会画出来
  applyRemoteTree(res) {
    this.isApplyingRemote = true
    const done = () => {
      this.isApplyingRemote = false
    }
    try {
      this.mindMap.updateData(res)
      this.mindMap.render(() => {
        this.mindMap.render(done)
      })
    } catch (err) {
      done()
      throw err
    }
  }

  // 当前思维导图改变后的处理，触发同步
  onDataChange(data) {
    if (this.isSetData || this.isApplyingRemote) return
    if (!this.ymap) {
      this.pendingInitData = data
      return
    }
    const res = transformTreeDataToObject(data)
    this.updateChanges(res)
  }

  // 找出更新点
  updateChanges(data) {
    const { beforeCooperateUpdate } = this.mindMap.opt
    const oldData = this.currentData || {}
    const createOrUpdateList = []
    Object.keys(data).forEach(uid => {
      if (!oldData[uid] || !isSameObject(oldData[uid], data[uid])) {
        createOrUpdateList.push({ uid, data: data[uid], oldData: oldData[uid] })
      }
    })
    if (beforeCooperateUpdate && createOrUpdateList.length > 0) {
      beforeCooperateUpdate({ type: 'createOrUpdate', list: createOrUpdateList, data })
    }
    const deleteList = Object.keys(oldData)
      .filter(uid => !data[uid])
      .map(uid => ({ uid, data: oldData[uid] }))
    if (beforeCooperateUpdate && deleteList.length > 0) {
      beforeCooperateUpdate({ type: 'delete', list: deleteList })
    }
    applyObjectToYMap(this.ymap, data, oldData, { origin: this.localOrigin })
    this.currentData = simpleDeepClone(this.ymap.toJSON())
  }

  // 节点激活状态改变后触发感知数据同步
  onNodeActive(node, nodeList) {
    this.publishAwareness(nodeList.map(item => item.uid))
  }

  // 节点树渲染完毕事件
  onNodeTreeRenderEnd() {
    Object.keys(this.waitNodeUidMap).forEach(uid => {
      const node = this.mindMap.renderer.findNodeByUid(uid)
      if (node) {
        node.addUser(this.waitNodeUidMap[uid])
      }
    })
    this.waitNodeUidMap = {}
  }

  onBeforeSetData() {
    this.isSetData = true
  }

  // 监听思维导图数据的重新设置事件
  onSetData(data) {
    this.pendingInitData = data
    if (this.ymap) {
      this.initData(data, { replace: true })
    }
    this.isSetData = false
  }

  // 设置用户信息
  /**
   * {
   *    id: '',     // 必传，用户唯一的id
   *    name: '',   // 用户名称。name和avatar两个只传一个即可，如果都传了，会显示avatar
   *    avatar: '', // 用户头像
   *    color: ''   // 如果没有传头像，那么会以一个圆形来显示名称的第一个字，文字的颜色为白色，圆的颜色可以通过该字段设置
   * }
   **/
  setUserInfo(userInfo) {
    if (
      getType(userInfo) !== 'Object' ||
      isUndef(userInfo.id) ||
      (isUndef(userInfo.name) && isUndef(userInfo.avatar))
    )
      return
    this.userInfo = userInfo || null
  }

  publishAwareness(nodeIdList = []) {
    if (!this.userInfo || !this.awareness) return
    this.awareness.setLocalStateField('user', {
      userInfo: { ...this.userInfo },
      nodeIdList
    })
  }

  // 监听感知数据同步事件
  onAwareness() {
    const walk = (list, callback) => {
      list.forEach(value => {
        const legacyKey = Object.keys(value).find(key => {
          return value[key] && value[key].userInfo
        })
        const data = value.user || (legacyKey && value[legacyKey])
        if (!data) return
        const userInfo = data.userInfo
        const nodeIdList = data.nodeIdList
        if (!userInfo || !nodeIdList) return
        nodeIdList.forEach(uid => {
          const node = this.mindMap.renderer.findNodeByUid(uid)
          callback(uid, node, userInfo)
        })
      })
    }
    // 清除之前的数据
    walk(this.currentAwarenessData, (uid, node, userInfo) => {
      if (node) {
        node.removeUser(userInfo)
      }
    })
    // 设置当前数据
    const data = Array.from(this.awareness.getStates().values())
    this.currentAwarenessData = data
    this.waitNodeUidMap = {}
    walk(data, (uid, node, userInfo) => {
      // 不显示自己
      if (this.userInfo && userInfo.id === this.userInfo.id) return
      if (node) {
        node.addUser(userInfo)
      } else {
        this.waitNodeUidMap[uid] = userInfo
      }
    })
  }

  // 插件被移除前做的事情
  beforePluginRemove() {
    this.unBindEvent()
  }

  // 插件被卸载前做的事情
  beforePluginDestroy() {
    this.unBindEvent()
  }
}

Cooperate.instanceName = 'cooperate'

export default Cooperate
