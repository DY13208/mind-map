import Vue from 'vue'
import MindMap from '../../../simple-mind-map/index.js'
import Intent from '../../src/pages/Edit/components/LeaveIntentTrigger.vue'
import ElementUI from 'element-ui'
import 'element-ui/lib/theme-chalk/index.css'
import Request from '../../src/components/LeaveRequestDialog.vue'
import Policy from '../../src/components/LeavePolicyDialog.vue'
import Inbox from '../../src/components/LeaveInbox.vue'
import Contextmenu from '../../src/pages/Edit/components/Contextmenu.vue'
Vue.use(ElementUI)
Vue.prototype.$bus = new Vue()
Vue.prototype.$store = { state: { isReadonly: false, localConfig: {}, roomCanShare: true } }
Vue.prototype.$t = key => ({'contextmenu.insertChildNode':'插入子节点','contextmenu.insertSiblingNode':'插入同级节点','contextmenu.unExpandNodeChild':'收起所有下级节点','contextmenu.expandNodeChild':'展开所有下级节点','contextmenu.expandTo':'展开到'}[key] || key)
Vue.prototype.$i18n = { locale: 'zh' }
Vue.prototype.$route = { query: { room: 'personal' } }
Vue.prototype.$router = { push: () => Promise.resolve() }
const actor = location.pathname.slice(1) || 'applicant'
new Vue({
  components: { Request, Policy, Inbox, Intent, Contextmenu },
  data: () => ({ actor, map: null, syncError: '' }),
  async mounted() {
    if (actor !== 'applicant') return
    this.saved = ''
    this.writes = Promise.resolve()
    this.insertedAnchors = new Set()
    const tree = await this.tree()
    this.map = new MindMap({
      el: this.$refs.canvas,
      data: tree,
      fit: true,
      layout: 'logicalStructure'
    })
    this.map.on('node_active', (...args) =>
      this.$bus.$emit('node_active', ...args)
    )
    for (const event of ['node_contextmenu','node_click','draw_click','svg_mousedown','mouseup'])
      this.map.on(event, (...args)=>this.$bus.$emit(event,...args))
    this.map.on('data_change', () => {
      const walk = node => {
        const data = node.data || {}
        if (data.approvalSource && !this.insertedAnchors.has(data.uid)) {
          this.insertedAnchors.add(data.uid)
          this.writes = this.writes.then(async()=>{
            const parent = this.map.renderer.findNodeByUid(data.uid).parent
            const response = await fetch('/actor/applicant/fixture/node',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({uid:data.uid,parentUid:parent.getData('uid'),text:data.text,approvalSource:data.approvalSource})})
            if (!response.ok) throw new Error('测试申请节点保存失败')
          }).catch(e=>{this.syncError=e.message})
        }
        ;(node.children||[]).forEach(walk)
      }
      walk(this.map.getData())
    })
    this.map.on('hide_text_edit', (element, list, node) => {
      if (!node) return
      const payload = {
        uid: node.getData('uid'),
        parentUid: node.parent && node.parent.getData('uid'),
        text: node.getData('text')
      }
      this.writes = this.writes
        .then(async () => {
          const response = await fetch('/actor/applicant/fixture/node', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          })
          if (!response.ok) throw new Error('测试节点保存失败')
        })
        .catch(e => {
          this.syncError = e.message
        })
    })
    this.timer = setInterval(() => this.syncTree(), 600)
    window.addEventListener('mindmap:leave-changed', this.syncTree)
  },
  beforeDestroy() {
    clearInterval(this.timer)
    window.removeEventListener('mindmap:leave-changed', this.syncTree)
    if (this.map) this.map.destroy()
  },
  methods: {
    async tree() {
      const r = await fetch('/actor/applicant/fixture/tree')
      return (await r.json()).tree
    },
    async syncTree() {
      if (
        !this.map ||
        this.syncing ||
        this.map.renderer.textEdit.isShowTextEdit()
      )
        return
      this.syncing = true
      try {
        await this.writes
        if (this.map.renderer.textEdit.isShowTextEdit()) return
        const data = await this.tree(),
          signature = JSON.stringify(data)
        if (
          signature === this.saved ||
          this.map.renderer.textEdit.isShowTextEdit()
        )
          return
        this.saved = signature
        const active = this.map.renderer.activeNodeList[0]
        this.map.setData(data)
        this.map.render(() => {
          if (active)
            this.map.execCommand('GO_TARGET_NODE', active.getData('uid'))
          else this.map.view.fit()
        })
      } catch (e) {
        this.syncError = e.message
      } finally {
        this.syncing = false
      }
    },
    policy() {
      window.dispatchEvent(new CustomEvent('mindmap:leave-policy'))
    }
  },
  template: `<main><nav><a href="/applicant">申请人</a><a href="/manager">部门负责人</a><a href="/ssc">SSC</a><a href="/ceo">抄送人</a><a href="/owner">管理员</a></nav><header><small>WCPD · 隔离验证环境</small><h1>脑图业务审批</h1><p>当前身份：{{actor}} · 使用临时数据库；人员为测试身份。</p><el-button v-if="actor==='owner'" @click="policy">配置请假流程</el-button></header><section v-if="actor==='applicant'" style="position:relative;margin:20px 5vw;background:white;border-radius:12px;border:1px solid #e5eaf0"><p style="padding:12px 20px;margin:0">在不同节点输入“我要请假”“我要签合同”或“我要关停渠道”，再直接编辑资料子节点。{{syncError}}</p><div ref="canvas" style="height:620px"></div><Intent v-if="map" :mind-map="map"/><Contextmenu v-if="map" :mind-map="map"/></section><section class="workspace"><Inbox/></section><Request :user-id="actor"/><Policy/></main>`
}).$mount('#app')
