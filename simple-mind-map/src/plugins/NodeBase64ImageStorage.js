import { walk, createUid } from '../utils/index'

// 修改base64格式的节点图片在数据中的存储方式
// 将base64格式的图片以key-map的形式存储在根节点的imgMap字段里，其他节点只保存key，避免不同的节点引用相同的图片重复存储的问题，普通url格式的图片不处理
class NodeBase64ImageStorage {
  constructor(opt) {
    this.opt = opt
    this.mindMap = opt.mindMap
    this._imageByUid = new Map()
    this._imageRefs = new Map()
    this._imageKeysByValue = new Map()
    this.bindEvent()
    this.onBeforeAddHistory()
  }

  bindEvent() {
    this.onBeforeAddHistory = this.onBeforeAddHistory.bind(this)
    this.mindMap.on('beforeAddHistory', this.onBeforeAddHistory)
    this.onContentChange = this.onContentChange.bind(this)
    this.onSetData = this.onBeforeAddHistory
    this.mindMap.on('before_content_change', this.onContentChange)
    this.mindMap.on('set_data', this.onSetData)
  }

  unBindEvent() {
    this.mindMap.off('beforeAddHistory', this.onBeforeAddHistory)
    this.mindMap.off('before_content_change', this.onContentChange)
    this.mindMap.off('set_data', this.onSetData)
    this._imageByUid.clear()
    this._imageRefs.clear()
    this._imageKeysByValue.clear()
    this._imageTree = null
  }

  isBase64ImgUrl(url) {
    return /^data:/.test(url)
  }

  isImageKey(url) {
    return /^smm_img_key_/.test(url)
  }

  createImageKey() {
    return 'smm_img_key_' + createUid()
  }

  storeNodeImage(node) {
    const tree = this.mindMap.renderer.renderTree
    const data = (node.nodeData || node).data
    if (!tree || !data) return
    const imgMap = tree.data.imgMap || (tree.data.imgMap = {})
    const uid = data.uid
    let image = data.image
    if (image && this.isBase64ImgUrl(image)) {
      let key = this._imageKeysByValue.get(image)
      if (!key || !Object.prototype.hasOwnProperty.call(imgMap, key)) {
        key = this.createImageKey()
        imgMap[key] = image
        this._imageKeysByValue.set(image, key)
      }
      data.image = image = key
    }
    const previous = this._imageByUid.get(uid)
    const next = image && this.isImageKey(image) && Object.prototype.hasOwnProperty.call(imgMap, image) ? image : null
    if (previous === next) return
    this.releaseImage(uid, imgMap)
    if (next) {
      this._imageByUid.set(uid, next)
      this._imageRefs.set(next, (this._imageRefs.get(next) || 0) + 1)
    }
  }

  releaseImage(uid, imgMap) {
    const previous = this._imageByUid.get(uid)
    if (!previous) return
    this._imageByUid.delete(uid)
    const count = (this._imageRefs.get(previous) || 1) - 1
    if (count > 0) this._imageRefs.set(previous, count)
    else {
      this._imageRefs.delete(previous)
      if (this._imageKeysByValue.get(imgMap[previous]) === previous) this._imageKeysByValue.delete(imgMap[previous])
      delete imgMap[previous]
    }
  }

  onContentChange(change) {
    const root = this.mindMap.renderer.renderTree
    if (!root) return
    const imgMap = root.data.imgMap || (root.data.imgMap = {})
    const removedUids = new Set()
    const visit = (tree, fn) => {
      if (!tree || !tree.data) return
      fn(tree)
      ;(tree.children || []).forEach(child => visit(child, fn))
    }
    ;(change.removed || []).forEach(entry => visit(entry.tree, tree => {
      removedUids.add(tree.data.uid)
      this.releaseImage(tree.data.uid, imgMap)
    }))
    ;(change.added || []).forEach(entry => { if (entry.countable) visit(entry.tree, tree => this.storeNodeImage(tree)) })
    ;(change.nodes || []).forEach(entry => { if (entry.countable && !removedUids.has(entry.tree.data.uid)) this.storeNodeImage(entry.tree) })
  }

  // Full loads and explicit native snapshots keep the complete cleanup path.
  // Ordinary V2 notifications update the indexed, affected ranges above.
  onBeforeAddHistory() {
    const renderTree = this.mindMap.renderer.renderTree
    if (!renderTree) return
    const imgMap = renderTree.data.imgMap || (renderTree.data.imgMap = {})
    this._imageTree = renderTree
    this._imageByUid = new Map()
    this._imageRefs = new Map()
    this._imageKeysByValue = new Map(Object.keys(imgMap).map(key => [imgMap[key], key]))
    walk(renderTree, null, node => this.storeNodeImage(node))
    Object.keys(imgMap).forEach(key => {
      if (!this._imageRefs.has(key)) {
        if (this._imageKeysByValue.get(imgMap[key]) === key) this._imageKeysByValue.delete(imgMap[key])
        delete imgMap[key]
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

NodeBase64ImageStorage.instanceName = 'nodeBase64ImageStorage'

export default NodeBase64ImageStorage
