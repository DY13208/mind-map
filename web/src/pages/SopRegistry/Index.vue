<template>
  <div class="sopPage" :class="{ isDark: isDark }">
    <header class="sopHeader">
      <div class="left">
        <el-button size="mini" @click="goBack">返回导图</el-button>
        <h1>SOP 台账</h1>
      </div>
      <div class="right">
        <span class="spaceLabel">空间</span>
        <el-select
          v-model="roomKey"
          size="small"
          filterable
          clearable
          placeholder="选择抽取空间"
          class="spaceSelect"
          :loading="spacesLoading"
          @change="onSpaceChange"
        >
          <el-option
            v-for="item in spaceOptions"
            :key="item.room_key"
            :label="item.label"
            :value="item.room_key"
          ></el-option>
        </el-select>
        <el-button
          size="mini"
          type="primary"
          :loading="pullLoading"
          :disabled="!roomKey"
          @click="refreshRoomList"
        >
          刷新
        </el-button>
      </div>
    </header>

    <p class="hint">
      双击卡片打开导图 / 历史 / 产物；运行与产物写入节点并回写备注摘要，与导图页协同同步。
    </p>
    <div class="statusLine" v-if="statusText">{{ statusText }}</div>

    <div v-if="!roomKey" class="emptyState">请先选择空间</div>
    <div v-else-if="!pullLoading && !sops.length" class="emptyState">
      该空间未找到 SOP
    </div>
    <div v-else class="cardGrid">
      <article
        class="sopCard"
        v-for="item in sops"
        :key="item.rowKey"
        title="双击编辑并同步"
        @dblclick="openSubtree(item)"
      >
        <h2 class="cardTitle">{{ item.title }}</h2>
        <div class="cardMeta">
          <span class="metaChip">出现 {{ item.occurrenceCount || 1 }} 次</span>
          <span class="metaChip">{{
            (item.frequency && item.frequency.label) || '频率未知'
          }}</span>
        </div>
        <div class="cardBlock">
          <div class="blockLabel">最近运行</div>
          <div class="blockBody">{{ latestRunLabel(item) }}</div>
        </div>
        <div class="cardBlock">
          <div class="blockLabel">最新产物</div>
          <div class="blockBody">{{ latestDelLabel(item) }}</div>
        </div>
      </article>
    </div>

    <el-dialog
      :title="dialogTitle"
      :visible.sync="dialogVisible"
      width="90%"
      top="4vh"
      append-to-body
      :close-on-click-modal="false"
      :destroy-on-close="false"
      :custom-class="'sopMindDialog' + (isDark ? ' isDark' : '')"
      @opened="onDialogOpened"
      @closed="onDialogClosed"
    >
      <el-tabs v-model="dialogTab" class="dialogTabs">
        <el-tab-pane label="导图" name="map">
          <div class="syncBar">
            <span class="syncDot" :class="syncStatus"></span>
            <span>{{ syncLabel }}</span>
            <span class="syncTip">编辑会同步到房间；导图页也会收到更新</span>
          </div>
          <div class="mindWrap" v-loading="subtreeLoading">
            <div v-if="subtreeError" class="emptyState">{{ subtreeError }}</div>
            <div
              v-show="!subtreeError"
              ref="mindMapContainer"
              class="mindMapContainer"
            ></div>
          </div>
        </el-tab-pane>
        <el-tab-pane label="历史" name="runs">
          <div class="ledgerPane" v-loading="ledgerSaving">
            <div class="addForm">
              <el-input
                v-model="runForm.at"
                size="small"
                placeholder="时间（如 2026-09-04 18:00）"
                class="formField"
              ></el-input>
              <el-input
                v-model="runForm.result"
                size="small"
                placeholder="结果（完成 / 失败…）"
                class="formField short"
              ></el-input>
              <el-input
                v-model="runForm.note"
                size="small"
                placeholder="备注"
                class="formField"
              ></el-input>
              <el-button
                type="primary"
                size="small"
                :disabled="!activeSopUid"
                @click="submitRun"
              >
                追加运行
              </el-button>
            </div>
            <ul class="ledgerList" v-if="activeLedger.runs.length">
              <li v-for="r in activeLedger.runs" :key="r.id">
                <span class="liMain">{{
                  [r.at, r.result, r.note].filter(Boolean).join(' · ')
                }}</span>
                <span class="liActor" v-if="r.actor">{{ r.actor }}</span>
              </li>
            </ul>
            <div v-else class="paneEmpty">暂无运行记录</div>
          </div>
        </el-tab-pane>
        <el-tab-pane label="产物" name="dels">
          <div class="ledgerPane" v-loading="ledgerSaving">
            <div class="addForm">
              <el-input
                v-model="delForm.name"
                size="small"
                placeholder="产物名称"
                class="formField"
              ></el-input>
              <el-input
                v-model="delForm.uri_or_path"
                size="small"
                placeholder="链接或 COS 路径"
                class="formField wide"
              ></el-input>
              <el-select v-model="delForm.kind" size="small" class="formField short">
                <el-option label="链接" value="link"></el-option>
                <el-option label="文件" value="file"></el-option>
                <el-option label="COS" value="cos"></el-option>
              </el-select>
              <el-button size="mini" @click="fillCosHint">填路径提示</el-button>
              <el-button
                type="primary"
                size="small"
                :disabled="!activeSopUid"
                @click="submitDeliverable"
              >
                追加产物
              </el-button>
            </div>
            <p class="cosHint" v-if="cosHint">建议路径：{{ cosHint }}</p>
            <ul class="ledgerList" v-if="activeLedger.deliverables.length">
              <li v-for="d in activeLedger.deliverables" :key="d.id">
                <span class="liMain">
                  <a
                    v-if="isHttp(d.uri_or_path)"
                    :href="d.uri_or_path"
                    target="_blank"
                    rel="noopener"
                    >{{ d.name }}</a
                  >
                  <template v-else>{{ d.name }}</template>
                  <span class="liPath" v-if="d.uri_or_path && !isHttp(d.uri_or_path)">
                    {{ d.uri_or_path }}
                  </span>
                </span>
                <span class="liKind">{{ d.kind }}</span>
              </li>
            </ul>
            <div v-else class="paneEmpty">暂无产物</div>
          </div>
        </el-tab-pane>
      </el-tabs>
    </el-dialog>
  </div>
</template>

<script>
import { mapState, mapMutations } from 'vuex'
import { io } from 'socket.io-client'
import MindMap from 'simple-mind-map'
import Drag from 'simple-mind-map/src/plugins/Drag.js'
import Select from 'simple-mind-map/src/plugins/Select.js'
import TouchEvent from 'simple-mind-map/src/plugins/TouchEvent.js'
import Cooperate from 'simple-mind-map/src/plugins/Cooperate.js'
import exampleData from 'simple-mind-map/example/exampleData'
import { createCollaborationAdapter } from 'simple-mind-map/bin/collabV2/adapter'
import { getLocalConfig } from '@/api'
import { getCurrentUser } from '@/utils/auth'
import { roomFromLocation } from '@/utils/roomLocation'
import { getRuntimeConfig } from '@/utils/runtimeConfig'
import {
  listFiles,
  getFileSubtree,
  getFileExport,
  getFileNodes,
  locateFileNode,
  getMapOperations,
  getMapVersion,
  addFileNode,
  patchFileNode,
  deleteFileNode,
  replaceFileTree,
  undoMapOperation,
  redoMapOperation
} from '@/utils/fileApi'
import {
  listRoomDRegistrySops,
  dedupeSopsForRegistry,
  fillDefaultCpda
} from '@/utils/sopRegistryPrompt'
import {
  normalizeLedger,
  mergeLedgerSources,
  latestRunText,
  latestDeliverableText,
  addRunToLedger,
  addDeliverableToLedger,
  persistSopLedger,
  suggestCosPath,
  readLedgerFromNodeLike
} from '@/utils/sopLedger'

MindMap.usePlugin(Drag)
  .usePlugin(Select)
  .usePlugin(TouchEvent)
  .usePlugin(Cooperate)

const V2_CLIENT_KEY = 'mind-map-collab-v2-client'

function tabClientId() {
  try {
    let id = sessionStorage.getItem(V2_CLIENT_KEY)
    if (!id || !String(id).trim()) {
      id =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      sessionStorage.setItem(V2_CLIENT_KEY, id)
    }
    return String(id).trim()
  } catch (e) {
    return `c_${Date.now()}`
  }
}

function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim()
}

function toMindMapTree(tree) {
  if (!tree) return null
  const data = (tree && tree.data) || {}
  const uid = data.uid || tree.uid || ''
  const rawText = stripHtml(data.text || tree.text || '')
  const note = data.note || tree.note || ''
  const children = (tree.children || [])
    .map(child => toMindMapTree(child))
    .filter(Boolean)
  return {
    data: {
      ...data,
      text: rawText || '(空)',
      expand: true,
      ...(uid ? { uid } : {}),
      ...(note ? { note: String(note) } : {}),
      ...(data.sopLedger ? { sopLedger: data.sopLedger } : {})
    },
    children
  }
}

export default {
  name: 'SopRegistryPage',
  data() {
    return {
      sops: [],
      statusText: '',
      pullLoading: false,
      spacesLoading: false,
      roomKey: '',
      spaceOptions: [],
      dialogVisible: false,
      dialogTitle: '',
      dialogTab: 'map',
      activeSop: null,
      activeSopUid: '',
      activeLedger: {
        frequency: { label: '未知', cron_hint: null },
        runs: [],
        deliverables: []
      },
      ledgerSaving: false,
      runForm: { at: '', result: '完成', note: '' },
      delForm: { name: '', uri_or_path: '', kind: 'link' },
      cosHint: '',
      subtreeLoading: false,
      subtreeError: '',
      pendingRoot: null,
      pendingVersion: 0,
      previewMindMap: null,
      collabV2Adapter: null,
      syncStatus: 'idle'
    }
  },
  computed: {
    ...mapState({
      isDark: state => state.localConfig.isDark
    }),
    syncLabel() {
      if (this.subtreeLoading) return '加载中…'
      if (this.syncStatus === 'live') return '已协同同步'
      if (this.syncStatus === 'connecting') return '正在连接协同…'
      if (this.syncStatus === 'error') return '协同异常（本地仍可改）'
      return '未连接协同'
    },
    userInfo() {
      const user = getCurrentUser() || {}
      return {
        id: String(user.id || user.userId || 'local').replace(/^wecom:/, ''),
        name: user.name || '用户',
        color: user.color || '#409EFF'
      }
    }
  },
  watch: {
    isDark() {
      this.setBodyDark()
    },
    dialogTab(val) {
      if (val === 'map' && this.previewMindMap) {
        this.$nextTick(() => {
          try {
            const view = this.previewMindMap && this.previewMindMap.view
            if (view && typeof view.fit === 'function') view.fit()
            if (typeof window !== 'undefined') {
              window.dispatchEvent(new Event('resize'))
            }
          } catch (e) {
            /* ignore */
          }
        })
      }
    },
    '$route.query.room'(val) {
      const next = String(val || '').trim()
      if (next !== this.roomKey) {
        this.roomKey = next
        this.refreshRoomList()
      }
    }
  },
  async created() {
    this.initLocalConfig()
    this.setBodyDark()
    this.roomKey = roomFromLocation(this.$route) || ''
    await this.loadSpaces()
    if (this.roomKey) this.refreshRoomList()
    else this.statusText = '请选择空间'
  },
  beforeDestroy() {
    this.teardownPreview()
  },
  methods: {
    ...mapMutations(['setLocalConfig']),
    initLocalConfig() {
      const config = getLocalConfig()
      if (config) {
        this.setLocalConfig({
          ...this.$store.state.localConfig,
          ...config
        })
      }
    },
    setBodyDark() {
      this.isDark
        ? document.body.classList.add('isDark')
        : document.body.classList.remove('isDark')
    },
    goBack() {
      const q = {}
      if (this.roomKey) q.room = this.roomKey
      this.$router.push({ path: '/', query: q })
    },
    spaceOptionLabel(item) {
      const key = item.room_key || item.roomKey || ''
      const title = item.title || item.name || ''
      if (title && title !== key) return `${title}（${key}）`
      return key || title || '未命名'
    },
    async loadSpaces() {
      this.spacesLoading = true
      try {
        const data = await listFiles({ limit: 200, offset: 0 })
        const list = data.list || []
        this.spaceOptions = list
          .map(item => ({
            room_key: item.room_key || item.roomKey || '',
            title: item.title || item.name || '',
            label: this.spaceOptionLabel(item)
          }))
          .filter(item => item.room_key)
        if (
          this.roomKey &&
          !this.spaceOptions.some(s => s.room_key === this.roomKey)
        ) {
          this.spaceOptions.unshift({
            room_key: this.roomKey,
            title: this.roomKey,
            label: this.roomKey
          })
        }
      } catch (err) {
        this.spaceOptions = this.roomKey
          ? [
              {
                room_key: this.roomKey,
                title: this.roomKey,
                label: this.roomKey
              }
            ]
          : []
      } finally {
        this.spacesLoading = false
      }
    },
    onSpaceChange(val) {
      const room = String(val || '').trim()
      this.$router.replace({
        path: '/sop',
        query: room ? { room } : {}
      })
      if (room) this.refreshRoomList()
      else {
        this.sops = []
        this.statusText = '请选择空间'
      }
    },
    formatRuns(runs) {
      return (runs || [])
        .slice(0, 3)
        .map(r => [r.at, r.result, r.note].filter(Boolean).join(' '))
        .join('；')
    },
    formatDeliverables(list) {
      return (list || [])
        .slice(0, 4)
        .map(d => d.name || d.uri_or_path)
        .filter(Boolean)
        .join('、')
    },
    latestRunLabel(item) {
      const runs =
        (item && item.sopLedger && item.sopLedger.runs) ||
        (item && item.runs) ||
        []
      return latestRunText(runs)
    },
    latestDelLabel(item) {
      const dels =
        (item && item.sopLedger && item.sopLedger.deliverables) ||
        (item && item.deliverables) ||
        []
      return latestDeliverableText(dels)
    },
    isHttp(uri) {
      return /^https?:\/\//i.test(String(uri || ''))
    },
    resetLedgerForms() {
      const now = new Date()
      const pad = n => String(n).padStart(2, '0')
      const at = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
        now.getDate()
      )} ${pad(now.getHours())}:${pad(now.getMinutes())}`
      this.runForm = { at, result: '完成', note: '' }
      this.delForm = { name: '', uri_or_path: '', kind: 'link' }
      this.cosHint = ''
    },
    fillCosHint() {
      const hint = suggestCosPath(
        this.roomKey,
        (this.activeSop && this.activeSop.id) || 'SOP',
        this.delForm.name || 'file'
      )
      this.cosHint = hint
      if (!this.delForm.uri_or_path) {
        this.delForm.uri_or_path = hint
        this.delForm.kind = 'cos'
      }
    },
    async saveActiveLedger() {
      if (!this.roomKey || !this.activeSopUid) {
        throw new Error('缺少房间或节点')
      }
      this.ledgerSaving = true
      try {
        await persistSopLedger(
          this.roomKey,
          this.activeSopUid,
          {
            id: (this.activeSop && this.activeSop.id) || '',
            title: (this.activeSop && this.activeSop.title) || ''
          },
          this.activeLedger
        )
        // 同步回列表卡片
        const idx = this.sops.findIndex(
          s => this.resolveSopUid(s) === this.activeSopUid || s === this.activeSop
        )
        if (idx >= 0) {
          const next = {
            ...this.sops[idx],
            runs: this.activeLedger.runs,
            deliverables: this.activeLedger.deliverables,
            frequency: this.activeLedger.frequency,
            sopLedger: normalizeLedger(this.activeLedger)
          }
          this.$set(this.sops, idx, next)
          this.activeSop = next
        }
        this.$message.success('已写入节点台账')
      } finally {
        this.ledgerSaving = false
      }
    },
    async submitRun() {
      try {
        this.activeLedger = addRunToLedger(this.activeLedger, {
          ...this.runForm,
          actor: this.userInfo.name
        })
        await this.saveActiveLedger()
        this.resetLedgerForms()
      } catch (err) {
        this.$message.error((err && err.message) || '保存失败')
      }
    },
    async submitDeliverable() {
      if (!this.delForm.name && !this.delForm.uri_or_path) {
        this.$message.warning('请填写产物名称或路径')
        return
      }
      try {
        this.activeLedger = addDeliverableToLedger(
          this.activeLedger,
          this.delForm
        )
        await this.saveActiveLedger()
        this.resetLedgerForms()
      } catch (err) {
        this.$message.error((err && err.message) || '保存失败')
      }
    },
    resolveSopUid(item) {
      if (!item) return ''
      if (item.uid) return item.uid
      if (item.uids && item.uids.length) return item.uids[0]
      const fromSource =
        item.sources && item.sources.map(s => s.uid).find(Boolean)
      return fromSource || ''
    },
    useCollabV2() {
      return getRuntimeConfig().collabV2 !== false
    },
    teardownPreview() {
      const cooperate = this.previewMindMap && this.previewMindMap.cooperate
      if (this.collabV2Adapter) {
        try {
          if (cooperate && typeof cooperate.setCollabV2Adapter === 'function') {
            cooperate.setCollabV2Adapter(null)
          }
          if (this.collabV2Adapter.disconnect) this.collabV2Adapter.disconnect()
        } catch (e) {
          /* ignore */
        }
        this.collabV2Adapter = null
      }
      if (this.previewMindMap) {
        try {
          this.previewMindMap.destroy()
        } catch (e) {
          /* ignore */
        }
        this.previewMindMap = null
      }
      this.syncStatus = 'idle'
    },
    enableHttpCollab(version) {
      const mindMap = this.previewMindMap
      const cooperate = mindMap && mindMap.cooperate
      const roomKey = this.roomKey
      if (!cooperate || !roomKey) return
      cooperate.setHttpCollab({
        roomKey,
        version: Number(version) || 0,
        fetchSubtree: (uid, options) => getFileSubtree(roomKey, uid, options),
        fetchDeepSubtree: (uid, options) =>
          getFileSubtree(roomKey, uid, {
            deep: true,
            maxNodes: 800,
            ...(options || {})
          }),
        fetchExportTree: () => getFileExport(roomKey),
        fetchNodes: uids => getFileNodes(roomKey, uids),
        fetchLocate: uid => locateFileNode(roomKey, uid),
        fetchOperations: after => getMapOperations(roomKey, after),
        fetchVersion: () => getMapVersion(roomKey),
        undoOperation: operationId => undoMapOperation(roomKey, operationId),
        redoOperation: operationId => redoMapOperation(roomKey, operationId),
        patchNode: (uid, body) =>
          patchFileNode(roomKey, uid, {
            ...(body || {}),
            confirm_sop_change: true
          }),
        addNode: body =>
          addFileNode(roomKey, {
            ...(body || {}),
            confirm_sop_change: true
          }),
        deleteNode: (uid, options) =>
          deleteFileNode(roomKey, uid, {
            ...(options || {}),
            confirm_sop_change: true
          }),
        replaceTree: (tree, extra) =>
          replaceFileTree(roomKey, tree, {
            allowFullTree: true,
            source: 'sop-registry',
            confirm_sop_change: true,
            ...(extra || {})
          })
      })
    },
    ensureCollabV2() {
      if (this.collabV2Adapter) return this.collabV2Adapter
      const cooperate = this.previewMindMap && this.previewMindMap.cooperate
      const clientId = tabClientId()
      const user = this.userInfo
      const adapter = createCollaborationAdapter({
        clientId,
        name: user.name,
        color: user.color,
        createSocket: () => {
          const cfg = getRuntimeConfig()
          const raw = String(cfg.collabApi || '')
            .replace(/^ws/i, 'http')
            .replace(/\/$/, '')
            .replace(/\/collab$/i, '')
          return io(raw || window.location.origin, {
            path: '/collab-v2',
            auth: {
              clientId,
              userId: user.id
            },
            withCredentials: true,
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionAttempts: 8,
            reconnectionDelay: 800,
            reconnectionDelayMax: 15000
          })
        },
        httpSync: async ({ afterRevision }) => {
          const api = getRuntimeConfig().collabApi || ''
          const roomKey = encodeURIComponent(this.roomKey || '')
          const res = await fetch(
            `${api}/api/collab-v2/ops?roomKey=${roomKey}&afterRevision=${Number(
              afterRevision
            ) || 0}`,
            { credentials: 'include', headers: { Accept: 'application/json' } }
          )
          return res.json().catch(() => ({ ok: false }))
        },
        onRemoteOperation: op => {
          if (
            cooperate &&
            typeof cooperate.applyV2RemoteOperation === 'function'
          ) {
            return cooperate.applyV2RemoteOperation(op)
          }
        },
        onReloadRequired: () => {
          if (
            cooperate &&
            typeof cooperate.recoverHttpCollab === 'function'
          ) {
            return cooperate.recoverHttpCollab(
              this.collabV2Adapter &&
                this.collabV2Adapter.getStatus().lastServerRevision
            )
          }
        },
        onRejected: () => {
          this.syncStatus = 'error'
        },
        onLockDenied: owner => {
          this.$message.warning(
            (owner && owner.name ? owner.name : '同事') + ' 正在编辑该节点'
          )
        }
      })
      this.collabV2Adapter = adapter
      if (cooperate && typeof cooperate.setCollabV2Adapter === 'function') {
        cooperate.setCollabV2Adapter(adapter)
      }
      return adapter
    },
    async connectCollabV2(version) {
      if (!this.useCollabV2()) {
        this.syncStatus = 'live'
        return
      }
      this.syncStatus = 'connecting'
      try {
        const adapter = this.ensureCollabV2()
        const ver = Number(version) || 0
        adapter.setLastServerRevision(ver)
        await adapter.connect({
          roomKey: this.roomKey,
          userId: this.userInfo.id,
          clientId: adapter.getClientId && adapter.getClientId(),
          lastServerRevision: ver
        })
        this.syncStatus = 'live'
      } catch (err) {
        console.warn('[sopRegistry] collab v2 connect failed', err)
        this.syncStatus = 'error'
      }
    },
    mountPreviewMindMap(root, version) {
      this.teardownPreview()
      const el = this.$refs.mindMapContainer
      if (!el || !root) return
      el.innerHTML = ''
      const theme = (exampleData && exampleData.theme) || {}
      this.previewMindMap = new MindMap({
        el,
        data: root,
        fit: true,
        readonly: false,
        layout: (exampleData && exampleData.layout) || 'logicalStructure',
        theme: theme.template || 'default',
        themeConfig: theme.config || {},
        mousewheelAction: 'zoom',
        enableFreeDrag: false,
        initRootNodePosition: ['center', 'center'],
        onlyOneEnableActiveNodeOnCooperate: true
      })
      const cooperate = this.previewMindMap.cooperate
      if (cooperate) {
        if (typeof cooperate.setPreviewApplied === 'function') {
          cooperate.setPreviewApplied(true)
        }
        this.enableHttpCollab(version)
        if (typeof cooperate.markTreeUids === 'function') {
          cooperate.markTreeUids(root)
        }
        if (typeof cooperate.seedPreviewHydration === 'function') {
          cooperate.seedPreviewHydration(root)
        }
        if (typeof cooperate.setPreviewApplied === 'function') {
          cooperate.setPreviewApplied(false)
        }
      }
      this.$nextTick(() => {
        try {
          if (this.previewMindMap && this.previewMindMap.view) {
            this.previewMindMap.view.fit()
          }
        } catch (e) {
          /* ignore */
        }
        this.connectCollabV2(version)
      })
    },
    onDialogOpened() {
      if (this.pendingRoot && !this.subtreeError) {
        this.$nextTick(() => {
          setTimeout(
            () =>
              this.mountPreviewMindMap(this.pendingRoot, this.pendingVersion),
            60
          )
        })
      }
    },
    onDialogClosed() {
      this.teardownPreview()
      this.pendingRoot = null
      this.pendingVersion = 0
      this.subtreeError = ''
      this.activeSop = null
      this.activeSopUid = ''
      this.dialogTab = 'map'
      if (this.roomKey) this.refreshRoomList()
    },
    async openSubtree(item) {
      const uid = this.resolveSopUid(item)
      if (!this.roomKey) {
        this.$message.warning('请先选择空间')
        return
      }
      if (!uid) {
        this.$message.warning('找不到该 SOP 对应的节点')
        return
      }
      this.activeSop = item
      this.activeSopUid = uid
      this.activeLedger = mergeLedgerSources(readLedgerFromNodeLike(item), {
        frequency: item.frequency,
        runs: item.runs,
        deliverables: item.deliverables
      })
      this.resetLedgerForms()
      this.dialogTab = 'map'
      this.dialogTitle = (item.title || 'SOP') + '（可编辑 · 协同同步）'
      this.dialogVisible = true
      this.subtreeLoading = true
      this.subtreeError = ''
      this.pendingRoot = null
      this.pendingVersion = 0
      this.teardownPreview()
      try {
        const data = await getFileSubtree(this.roomKey, uid, {
          deep: true,
          maxNodes: 2000
        })
        const tree = (data && data.tree) || data
        const root = toMindMapTree(tree)
        if (!root) {
          this.subtreeError = '未拉取到子树'
          return
        }
        // 子树根上可能有更新的 sopLedger
        const nodeData = (root && root.data) || {}
        if (nodeData.sopLedger || nodeData.note) {
          this.activeLedger = mergeLedgerSources(
            readLedgerFromNodeLike(nodeData),
            {
              frequency: item.frequency,
              runs: item.runs,
              deliverables: item.deliverables
            }
          )
        }
        this.pendingRoot = root
        this.pendingVersion = Number((data && data.version) || 0)
        if (this.dialogVisible) {
          this.$nextTick(() => {
            setTimeout(
              () => this.mountPreviewMindMap(root, this.pendingVersion),
              60
            )
          })
        }
      } catch (err) {
        console.error('[sopRegistry subtree]', err)
        this.subtreeError = (err && err.message) || '加载子树失败'
      } finally {
        this.subtreeLoading = false
      }
    },
    async refreshRoomList() {
      const roomKey = String(this.roomKey || '').trim()
      if (!roomKey) {
        this.sops = []
        this.statusText = '请选择空间'
        return
      }
      this.pullLoading = true
      this.statusText = '正在抽取 SOP…'
      try {
        const result = await listRoomDRegistrySops(roomKey)
        const unique = dedupeSopsForRegistry(
          fillDefaultCpda({ sops: result.sops || [] }).sops
        )
        this.sops = unique
        const space =
          (this.spaceOptions.find(s => s.room_key === roomKey) || {}).label ||
          roomKey
        this.statusText = `「${space}」共 ${unique.length} 条 SOP`
      } catch (err) {
        console.error('[sopRegistry page]', err)
        this.$message.error((err && err.message) || '读取失败')
        this.statusText = '读取失败'
      } finally {
        this.pullLoading = false
      }
    }
  }
}
</script>

<style lang="less" scoped>
.sopPage {
  min-height: 100vh;
  padding: 16px 20px 28px;
  background: #f5f7fa;
  box-sizing: border-box;

  &.isDark {
    background: #1a1d21;
    color: #e5eaf3;

    .sopHeader h1 {
      color: #e5eaf3;
    }

    .hint,
    .statusLine,
    .spaceLabel,
    .emptyState {
      color: #909399;
    }

    .sopCard {
      background: #262a2e;
      border-color: rgba(255, 255, 255, 0.08);

      .cardTitle {
        color: #e5eaf3;
      }

      .metaChip {
        background: rgba(255, 255, 255, 0.06);
        color: #c0c4cc;
      }

      .blockLabel {
        color: #909399;
      }

      .blockBody {
        color: #dcdfe6;
      }
    }
  }

  .sopHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 8px;

    .left,
    .right {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 600;
      color: #303133;
    }

    .spaceLabel {
      font-size: 13px;
      color: #606266;
    }

    .spaceSelect {
      width: 280px;
    }
  }

  .hint,
  .statusLine {
    margin: 0 0 10px;
    font-size: 13px;
    color: #909399;
    line-height: 1.5;
  }

  .emptyState {
    margin-top: 48px;
    text-align: center;
    color: #909399;
    font-size: 14px;
  }

  .cardGrid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 14px;
    margin-top: 8px;
  }

  .sopCard {
    background: #fff;
    border: 1px solid #ebeef5;
    border-radius: 10px;
    padding: 16px;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
    cursor: pointer;
    user-select: none;
    transition: box-shadow 0.15s ease, transform 0.15s ease;

    &:hover {
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.06);
      transform: translateY(-1px);
    }

    .cardTitle {
      margin: 0 0 10px;
      font-size: 16px;
      font-weight: 600;
      color: #303133;
      line-height: 1.4;
      word-break: break-word;
    }

    .cardMeta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 12px;
    }

    .metaChip {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 12px;
      background: #f0f2f5;
      color: #606266;
    }

    .cardBlock {
      margin-top: 10px;
    }

    .blockLabel {
      font-size: 12px;
      color: #909399;
      margin-bottom: 4px;
    }

    .blockBody {
      font-size: 13px;
      color: #606266;
      line-height: 1.5;
      word-break: break-word;
    }
  }
}
</style>

<style lang="less">
.sopMindDialog {
  .el-dialog__body {
    padding: 8px 16px 16px;
  }

  .dialogTabs {
    .el-tabs__header {
      margin-bottom: 10px;
    }
  }

  .syncBar {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
    font-size: 12px;
    color: #606266;

    .syncDot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #c0c4cc;

      &.connecting {
        background: #e6a23c;
      }
      &.live {
        background: #67c23a;
      }
      &.error {
        background: #f56c6c;
      }
    }

    .syncTip {
      margin-left: auto;
      color: #909399;
    }
  }

  .mindWrap {
    position: relative;
    height: 68vh;
    min-height: 400px;
    border: 1px solid #ebeef5;
    border-radius: 8px;
    overflow: hidden;
    background: #fafbfc;
  }

  .mindMapContainer {
    width: 100%;
    height: 100%;
  }

  .ledgerPane {
    min-height: 360px;
    max-height: 68vh;
    overflow: auto;
  }

  .addForm {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin-bottom: 12px;

    .formField {
      width: 180px;

      &.short {
        width: 110px;
      }

      &.wide {
        width: 280px;
        flex: 1;
        min-width: 180px;
      }
    }
  }

  .cosHint {
    margin: 0 0 10px;
    font-size: 12px;
    color: #909399;
    word-break: break-all;
  }

  .ledgerList {
    list-style: none;
    margin: 0;
    padding: 0;

    li {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 0;
      border-bottom: 1px solid #ebeef5;
      font-size: 13px;
      color: #606266;
    }

    .liMain {
      flex: 1;
      word-break: break-word;
      line-height: 1.5;

      a {
        color: #409eff;
      }
    }

    .liPath,
    .liActor,
    .liKind {
      flex-shrink: 0;
      font-size: 12px;
      color: #909399;
    }

    .liPath {
      display: block;
      margin-top: 4px;
    }
  }

  .paneEmpty {
    padding: 48px 0;
    text-align: center;
    color: #909399;
    font-size: 14px;
  }

  .emptyState {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #909399;
    z-index: 2;
  }

  &.isDark {
    background: #1f2329;

    .el-dialog__title,
    .syncBar {
      color: #e5eaf3;
    }

    .mindWrap {
      background: #1a1d21;
      border-color: rgba(255, 255, 255, 0.08);
    }

    .ledgerList li {
      border-bottom-color: rgba(255, 255, 255, 0.08);
      color: #dcdfe6;
    }
  }
}
</style>
