import Vue from 'vue'
import vuexStore from '@/store'
import { parseJsonOffMainThread } from '@/utils/importTree'

const SIMPLE_MIND_MAP_DATA = 'SIMPLE_MIND_MAP_DATA'
const SIMPLE_MIND_MAP_SESSION = 'SIMPLE_MIND_MAP_SESSION'
const SIMPLE_MIND_MAP_CONFIG = 'SIMPLE_MIND_MAP_CONFIG'
const SIMPLE_MIND_MAP_LANG = 'SIMPLE_MIND_MAP_LANG'
const SIMPLE_MIND_MAP_LOCAL_CONFIG = 'SIMPLE_MIND_MAP_LOCAL_CONFIG'
const IDB_NAME = 'mind-map-local'
const IDB_STORE = 'drafts'
const IDB_KEY = 'current'

let mindMapData = null
let localSaveVersion = 0
let idb = null
let skipHeavyLocalDraft = false
const LOCAL_DRAFT_NODE_LIMIT = 400

function currentRoom() {
  try {
    const fromSearch = new URLSearchParams(window.location.search).get('room')
    if (fromSearch) return String(fromSearch).trim()
    const hash = String(window.location.hash || '')
    const query = hash.indexOf('?') >= 0 ? hash.slice(hash.indexOf('?') + 1) : ''
    const fromHash = new URLSearchParams(query).get('room')
    return String(fromHash || '').trim()
  } catch (e) {
    return ''
  }
}

function isCollabSession() {
  if (currentRoom()) return true
  const status = vuexStore.state.cooperateStatus
  return status === 'connected' || status === 'connecting'
}

function writeSession(session) {
  try {
    localStorage.setItem(SIMPLE_MIND_MAP_SESSION, JSON.stringify(session))
  } catch (e) {
    // ignore
  }
}

function clearLegacyLocalStorageTree() {
  try {
    localStorage.removeItem(SIMPLE_MIND_MAP_DATA)
  } catch (e) {
    // ignore
  }
}

function openDraftDb() {
  if (idb) return Promise.resolve(idb)
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE)
      }
    }
    req.onsuccess = () => {
      idb = req.result
      resolve(idb)
    }
    req.onerror = () => reject(req.error)
  })
}

async function readDraft() {
  const db = await openDraftDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly')
    const req = tx.objectStore(IDB_STORE).get(IDB_KEY)
    req.onsuccess = () => resolve(req.result || null)
    req.onerror = () => reject(req.error)
  })
}

async function writeDraft(data) {
  const db = await openDraftDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put(data, IDB_KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

function countTreeNodes(data) {
  const walk = node => {
    if (!node) return 0
    return 1 + (node.children || []).reduce((sum, child) => sum + walk(child), 0)
  }
  return walk(data && data.root)
}

function placeholderMap() {
  return {
    root: {
      data: { text: '根节点' },
      children: []
    },
    layout: 'logicalStructure',
    theme: {
      template: 'classic4',
      config: {}
    }
  }
}

function notifyPersistFailed() {
  Vue.prototype.$bus.$emit('localStorageExceeded')
}

// 获取缓存的思维导图数据
export const getData = () => {
  if (window.takeOverApp) {
    mindMapData = window.takeOverAppMethods.getMindMapData()
    return mindMapData
  }
  if (vuexStore.state.isHandleLocalFile) {
    return Vue.prototype.getCurrentData()
  }
  if (mindMapData) return mindMapData
  if (currentRoom()) return placeholderMap()
  let store = localStorage.getItem(SIMPLE_MIND_MAP_DATA)
  if (store === null) {
    return placeholderMap()
  }
  try {
    return JSON.parse(store)
  } catch (error) {
    return placeholderMap()
  }
}

export const getDataAsync = async () => {
  if (window.takeOverApp || vuexStore.state.isHandleLocalFile) {
    return getData()
  }
  if (mindMapData) return mindMapData
  if (currentRoom()) {
    skipHeavyLocalDraft = true
    mindMapData = placeholderMap()
    writeSession({ backend: 'collab', room: currentRoom(), at: Date.now() })
    clearLegacyLocalStorageTree()
    return mindMapData
  }
  skipHeavyLocalDraft = false
  try {
    const draft = await readDraft()
    if (draft && draft.root) {
      mindMapData = draft
      clearLegacyLocalStorageTree()
      return mindMapData
    }
  } catch (error) {
    console.log(error)
  }
  const store = localStorage.getItem(SIMPLE_MIND_MAP_DATA)
  if (store === null) {
    mindMapData = placeholderMap()
    return mindMapData
  }
  try {
    mindMapData = await parseJsonOffMainThread(store)
    writeDraft(mindMapData)
      .then(() => clearLegacyLocalStorageTree())
      .catch(() => {})
    return mindMapData
  } catch (error) {
    mindMapData = placeholderMap()
    return mindMapData
  }
}

export const storeData = data => {
  try {
    let originData = null
    if (window.takeOverApp) {
      originData = mindMapData
    } else {
      originData = mindMapData || getData()
    }
    if (!originData) {
      originData = {}
    }
    originData = {
      ...originData,
      ...data
    }
    if (window.takeOverApp) {
      mindMapData = originData
      window.takeOverAppMethods.saveMindMapData(originData)
      return
    }
    Vue.prototype.$bus.$emit('write_local_file', originData)
    if (vuexStore.state.isHandleLocalFile) {
      return
    }
    mindMapData = originData
    if (isCollabSession()) {
      skipHeavyLocalDraft = true
      writeSession({
        backend: 'collab',
        room: currentRoom(),
        at: Date.now()
      })
      clearLegacyLocalStorageTree()
      return
    }
    if (
      skipHeavyLocalDraft ||
      countTreeNodes(originData) > LOCAL_DRAFT_NODE_LIMIT
    ) {
      writeSession({ backend: 'memory', at: Date.now() })
      return
    }
    writeSession({ backend: 'local', at: Date.now() })
    const saveVersion = ++localSaveVersion
    return writeDraft(originData)
      .then(() => {
        if (saveVersion !== localSaveVersion) return
        clearLegacyLocalStorageTree()
      })
      .catch(error => {
        console.log(error)
        notifyPersistFailed()
      })
  } catch (error) {
    console.log(error)
    notifyPersistFailed()
  }
}

// 获取思维导图配置数据
export const getConfig = () => {
  if (window.takeOverApp) {
    window.takeOverAppMethods.getMindMapConfig()
    return
  }
  let config = localStorage.getItem(SIMPLE_MIND_MAP_CONFIG)
  if (config) {
    return JSON.parse(config)
  }
  return null
}

// 存储思维导图配置数据
export const storeConfig = config => {
  try {
    if (window.takeOverApp) {
      window.takeOverAppMethods.saveMindMapConfig(config)
      return
    }
    localStorage.setItem(SIMPLE_MIND_MAP_CONFIG, JSON.stringify(config))
  } catch (error) {
    console.log(error)
  }
}

// 存储语言
export const storeLang = lang => {
  if (window.takeOverApp) {
    window.takeOverAppMethods.saveLanguage(lang)
    return
  }
  localStorage.setItem(SIMPLE_MIND_MAP_LANG, lang)
}

// 获取存储的语言
export const getLang = () => {
  if (window.takeOverApp) {
    return window.takeOverAppMethods.getLanguage() || 'zh'
  }
  let lang = localStorage.getItem(SIMPLE_MIND_MAP_LANG)
  if (lang) {
    return lang
  }
  storeLang('zh')
  return 'zh'
}

// 存储本地配置
export const storeLocalConfig = config => {
  if (window.takeOverApp) {
    return window.takeOverAppMethods.saveLocalConfig(config)
  }
  localStorage.setItem(SIMPLE_MIND_MAP_LOCAL_CONFIG, JSON.stringify(config))
}

// 获取本地配置
export const getLocalConfig = () => {
  if (window.takeOverApp) {
    return window.takeOverAppMethods.getLocalConfig()
  }
  let config = localStorage.getItem(SIMPLE_MIND_MAP_LOCAL_CONFIG)
  if (config) {
    return JSON.parse(config)
  }
  return null
}
