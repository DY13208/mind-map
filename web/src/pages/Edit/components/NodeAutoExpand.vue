<template>
  <div
    v-show="showFloatingUi"
    class="flow-expand-wrap"
    :style="boxStyle"
    @click.stop
  >
    <button
      v-if="showBtn"
      type="button"
      class="flow-expand-btn"
      :class="{ isDark: isDark }"
      @click="onFlowExpandRequest(activeNode)"
    >
      {{ $t('toolbar.flowExpand') }}
    </button>
    <div
      v-else-if="busy"
      class="auto-expand"
      :class="{ isDark: isDark }"
    >
      <span class="dot" aria-hidden="true"></span>
      <span>{{ status || 'WorkBuddy 正在补充流程…' }}</span>
    </div>
  </div>
</template>

<script>
import { mapState } from 'vuex'
import { streamChat } from '@/utils/workbuddyChat'
import { plainText, isInvalidNodeData, findFlowAssignee } from '@/utils/flowSearch'
import {
  buildFlowExpandPrompt,
  resolveSopTemplate
} from '@/utils/flowExpandPrompt'
import { parseMindmapChildren, describeParseMiss } from '@/utils/mindmapChildrenParse'
import { dispatchTodo, appendTodoNote } from '@/utils/sendTodo'

const PLACEHOLDERS = [
  '',
  '分支主题',
  '子主题',
  '概要',
  '中心主题',
  'branch topic',
  'sub topic',
  'central topic'
]

function isPlaceholder(text) {
  return PLACEHOLDERS.includes(String(text || '').trim().toLowerCase())
}

function stripText(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim()
}

function insertChildTrees(mindMap, node, trees) {
  if (node.children && node.children.length) {
    mindMap.execCommand('REMOVE_NODE', [...node.children])
  }
  mindMap.execCommand('INSERT_MULTI_CHILD_NODE', [node], trees)
}

/** 在数据树中查找「代办人」节点文案 */
function findAssigneeInTrees(trees) {
  let found = null
  const walk = list => {
    ;(list || []).forEach(item => {
      if (found || !item || !item.data) return
      const text = stripText(item.data.text)
      if (/^代办人/.test(text) || /^待办人/.test(text)) {
        const idx = Math.max(text.indexOf('：'), text.indexOf(':'))
        found = {
          text,
          name: idx >= 0 ? text.slice(idx + 1).trim() : ''
        }
        return
      }
      walk(item.children)
    })
  }
  walk(trees)
  return found
}

/** 在已插入的导图节点上查找代办人 */
function findAssigneeLiveNode(root) {
  let found = null
  const walk = n => {
    if (found || !n) return
    const text = plainText(n)
    if (/^代办人/.test(text) || /^待办人/.test(text)) {
      found = n
      return
    }
    ;(n.children || []).forEach(walk)
  }
  ;(root.children || []).forEach(walk)
  return found
}

function applyFactsToTrees(trees, facts) {
  if (!facts || !trees) return trees
  const rules = []
  if (facts.department) {
    rules.push({
      keys: ['招聘部门', '所属部门', '部门'],
      value: `招聘部门：${facts.department}`
    })
  }
  if (facts.company) {
    rules.push({
      keys: ['公司主体', '公司'],
      value: `公司主体：${facts.company}`
    })
  }
  if (facts.position) {
    rules.push({
      keys: ['招聘岗位', '岗位名称', '岗位'],
      value: `招聘岗位：${facts.position}`
    })
  }
  if (facts.level) {
    rules.push({
      keys: ['职级'],
      value: `职级：${facts.level}`
    })
  }
  if (facts.city) {
    rules.push({
      keys: ['招聘城市', '工作地点', '城市'],
      value: `招聘城市：${facts.city}`
    })
  }
  if (!rules.length) return trees

  const walk = list => {
    ;(list || []).forEach(item => {
      if (!item || !item.data) return
      const raw = stripText(item.data.text)
      const label = raw.split(/[：:]/)[0].trim()
      for (const rule of rules) {
        if (rule.keys.some(k => label === k || label.startsWith(k))) {
          // 纠正明显错猜：IT部门 / 空部门
          const curVal = raw.includes('：') || raw.includes(':') ? raw : ''
          if (
            !curVal ||
            /IT部门|HR部门|待确认|待补充/.test(curVal) ||
            (facts.department &&
              rule.keys.some(k => ['招聘部门', '所属部门', '部门'].includes(k)) &&
              (/AI部/.test(curVal) &&
                facts.department !== 'AI部' &&
                /运营|电商|人事|财务/.test(facts.department))) ||
            (facts.department &&
              rule.keys.some(k => ['招聘部门', '所属部门', '部门'].includes(k)) &&
              !curVal.includes(facts.department) &&
              (/IT部门|HR部门|AI部/.test(curVal) || !/[：:]/.test(raw)))
          ) {
            item.data.text = rule.value
          }
          break
        }
      }
      walk(item.children)
    })
  }
  walk(trees)
  return trees
}

function ensureAssigneeInTrees(trees, assigneeName) {
  const hit = findAssigneeInTrees(trees)
  if (hit && hit.name) return trees
  const name = assigneeName || '部门负责人'
  const node = {
    data: { text: `代办人：${name}` },
    children: []
  }
  // 优先挂在「提供/模块」后面同级；否则挂到第一棵子树末尾；再否则作为顶层
  const attachAfterProvide = list => {
    if (!list || !list.length) return false
    for (let i = 0; i < list.length; i++) {
      const item = list[i]
      const label = stripText(item.data && item.data.text).split(/[：:]/)[0]
      if (/^(提供|模块|字段)$/.test(label)) {
        list.splice(i + 1, 0, node)
        return true
      }
      if (item.children && attachAfterProvide(item.children)) return true
    }
    return false
  }
  if (attachAfterProvide(trees)) return trees
  if (trees[0] && Array.isArray(trees[0].children)) {
    trees[0].children.push(node)
    return trees
  }
  trees.push(node)
  return trees
}

const ADD_CHILDREN_TOOL = {
  type: 'function',
  function: {
    name: 'add_mindmap_children',
    description:
      '把补充好的子节点树写回当前思维导图节点。必须调用。须含填满的数据字段，并在其后包含「代办人：xxx」。',
    parameters: {
      type: 'object',
      properties: {
        children: {
          type: 'array',
          description:
            '子节点列表。每项 {text, note?, children?}；须包含「代办人：具体人/角色」。',
          items: { type: 'object' }
        }
      },
      required: ['children']
    }
  }
}

export default {
  name: 'NodeAutoExpand',
  props: {
    mindMap: {
      type: Object,
      default: null
    }
  },
  data() {
    return {
      busy: false,
      status: '',
      node: null,
      activeNode: null,
      boxStyle: { left: '0px', top: '0px' },
      controller: null
    }
  },
  computed: {
    ...mapState({
      isDark: state => state.localConfig.isDark
    }),
    showBtn() {
      return !this.busy && !!this.activeNode && !this.activeNode.isRoot
    },
    showFloatingUi() {
      return this.showBtn || this.busy
    }
  },
  mounted() {
    this.$bus.$on('node_active', this.onBusNodeActive)
    this.$bus.$on('node_click', this.clearActiveNode)
    this.$bus.$on('draw_click', this.clearActiveNode)
    this.$bus.$on('node_flow_expand', this.onFlowExpandRequest)
    if (this.mindMap) {
      this.mindMap.on('node_active', this.onMindMapNodeActive)
    }
    document.body.appendChild(this.$el)
  },
  beforeDestroy() {
    this.$bus.$off('node_active', this.onBusNodeActive)
    this.$bus.$off('node_click', this.clearActiveNode)
    this.$bus.$off('draw_click', this.clearActiveNode)
    this.$bus.$off('node_flow_expand', this.onFlowExpandRequest)
    if (this.mindMap) {
      this.mindMap.off('node_active', this.onMindMapNodeActive)
    }
    if (this.controller) this.controller.abort()
    if (this.$el && this.$el.parentNode) {
      this.$el.parentNode.removeChild(this.$el)
    }
  },
  methods: {
    onBusNodeActive(...args) {
      this.syncActiveNode(args[1] || [])
    },
    onMindMapNodeActive(node, activeList) {
      this.syncActiveNode(activeList || (node ? [node] : []))
    },
    syncActiveNode(list) {
      if (this.busy) return
      const node = list && list.length === 1 ? list[0] : null
      if (!node || node.isRoot) {
        this.activeNode = null
        return
      }
      this.activeNode = node
      this.$nextTick(this.updatePos)
    },
    clearActiveNode() {
      if (this.busy) return
      this.activeNode = null
    },
    onFlowExpandRequest(node) {
      if (this.busy) {
        if (this.$message) this.$message.info('正在补齐中，请稍候…')
        return
      }
      const target =
        node ||
        this.activeNode ||
        (this.mindMap.renderer &&
          this.mindMap.renderer.activeNodeList &&
          this.mindMap.renderer.activeNodeList[0]) ||
        null
      if (!target || target.isRoot) {
        if (this.$message) {
          this.$message.warning('请先选中有效节点')
        }
        return
      }
      const text = plainText(target)
      if (isPlaceholder(text) || isInvalidNodeData(text)) {
        if (this.$message) {
          this.$message.warning('请先填写有效的节点内容')
        }
        return
      }
      this.expand(target)
    },
    finishBusy(delay = 1400) {
      setTimeout(() => this.resetBusyState(), delay)
    },
    resetBusyState() {
      this.busy = false
      this.status = ''
      this.node = null
      const list =
        (this.mindMap.renderer && this.mindMap.renderer.activeNodeList) || []
      this.syncActiveNode(list)
    },
    updatePos() {
      const target = this.busy ? this.node : this.activeNode
      if (!target || !target.getRect) return
      const rect = target.getRect()
      if (!rect) return
      let left = rect.x
      let top = rect.y + rect.height + 8
      const width = this.busy ? 280 : 96
      if (left + width > window.innerWidth) left = window.innerWidth - width - 12
      if (left < 12) left = 12
      if (top + 44 > window.innerHeight) top = Math.max(12, rect.y - 44)
      this.boxStyle = { left: `${left}px`, top: `${top}px` }
    },
    async expand(node) {
      this.node = node
      this.busy = true
      this.status = '正在组装导图上下文…'
      await this.$nextTick()
      this.updatePos()
      await new Promise(resolve => setTimeout(resolve, 30))

      this.controller =
        typeof AbortController !== 'undefined' ? new AbortController() : null

      try {
        let system
        let user
        let meta = {}
        try {
          const prompt = buildFlowExpandPrompt(this.mindMap, node)
          system = prompt.system
          user = prompt.user
          meta = prompt
        } catch (buildErr) {
          console.error('[flowExpand] build prompt failed', buildErr)
          throw new Error(
            '读取导图失败：' + ((buildErr && buildErr.message) || '未知错误')
          )
        }

        this.status = meta.hasTemplate
          ? `WorkBuddy 正在按 SOP「${meta.templateLabel}」实例化…`
          : '未命中 SOP，WorkBuddy 正在根据导图内容硬编流程…'
        this.$nextTick(this.updatePos)

        const callWb = async (compact = false) => {
          let sys = system
          let usr = user
          if (compact) {
            // 二次重试：进一步压缩用户提示，强制短 children
            usr = [
              user.slice(0, 20000),
              '',
              '【重试】上次未解析到工具参数。请再次调用 add_mindmap_children，',
              'children 尽量紧凑，但仍须含完整提供字段（字段名：值）与「代办人：xxx」。'
            ].join('\n')
          }
          return streamChat({
            messages: [
              { role: 'system', content: sys },
              { role: 'user', content: usr }
            ],
            stream: false,
            extra: {
              tools: [ADD_CHILDREN_TOOL],
              tool_choice: {
                type: 'function',
                function: { name: 'add_mindmap_children' }
              }
            },
            signal: this.controller && this.controller.signal,
            onEvent: label => {
              if (label) this.status = label
              this.$nextTick(this.updatePos)
            }
          })
        }

        let result = await callWb(false)
        let children = parseMindmapChildren(result)
        if (!children.length) {
          console.warn(
            '[flowExpand] first parse empty',
            describeParseMiss(result),
            result
          )
          this.status = '首次未解析到节点，正在压缩重试…'
          this.$nextTick(this.updatePos)
          result = await callWb(true)
          children = parseMindmapChildren(result)
        }
        if (!children.length) {
          const miss = describeParseMiss(result)
          console.warn('[flowExpand] empty children', miss, result)
          throw new Error(
            `WorkBuddy 未返回可解析节点（tool=${miss.toolCallCount}, content=${
              miss.contentPreview ? '有文本' : '空'
            }）。请再试一次；若持续失败请缩小 SOP 子树后重试`
          )
        }

        // 确保有「代办人：xxx」；没有则按 SOP/导图推断补上
        const { sopNode, templateNode } = resolveSopTemplate(this.mindMap, node)
        const fallbackAssignee = findFlowAssignee({
          sopNode,
          flowNode: templateNode || sopNode || node
        })
        children = ensureAssigneeInTrees(
          children,
          (fallbackAssignee && fallbackAssignee.name) ||
            (meta.facts && meta.facts.department
              ? `${meta.facts.department}负责人`
              : '部门负责人')
        )
        children = applyFactsToTrees(children, meta.facts)

        insertChildTrees(this.mindMap, node, children)
        await this.$nextTick()

        // 给代办人发待办并写备注
        this.status = '正在为代办人补充待办…'
        this.$nextTick(this.updatePos)
        const assigneeInfo = findAssigneeInTrees(children)
        const assigneeName =
          (assigneeInfo && assigneeInfo.name) ||
          (fallbackAssignee && fallbackAssignee.name) ||
          '部门负责人'
        const liveAssignee = findAssigneeLiveNode(node)
        const noteTarget = liveAssignee || node
        try {
          const todo = await dispatchTodo({
            assignee: { name: assigneeName },
            title: `处理：${plainText(node)}`,
            detail: `流程已实例化，请确认「提供」中的数据项并推进后续步骤。`,
            context: plainText(node),
            signal: this.controller && this.controller.signal,
            onEvent: label => {
              if (label) this.status = label
              this.$nextTick(this.updatePos)
            }
          })
          appendTodoNote(noteTarget, this.mindMap, {
            assignee: assigneeName,
            title: `处理：${plainText(node)}`,
            reply: todo.content
          })
        } catch (todoErr) {
          console.warn('[flowExpand] 代办发送失败', todoErr)
          appendTodoNote(noteTarget, this.mindMap, {
            assignee: assigneeName,
            title: `处理：${plainText(node)}`,
            reply: '待办接口未确认，请人工跟进'
          })
        }

        this.status = `已补充流程，代办人：${assigneeName}`
        if (this.$message) {
          this.$message.success(
            `已实例化并补充代办人「${assigneeName}」`
          )
        }
        this.finishBusy()
      } catch (err) {
        console.error('[flowExpand]', err)
        this.resetBusyState()
        if (err && err.name === 'AbortError') return
        const raw = (err && err.message) || String(err || '')
        const msg =
          (err && err.status >= 500) ||
          /Failed to fetch|NetworkError|ECONNREFUSED|Bad Gateway|<!DOCTYPE html>/i.test(
            raw
          )
            ? '连不上 WorkBuddy，请确认服务已启动（http://127.0.0.1:3000）'
            : raw || '流程补充失败'
        if (this.$message) this.$message.error(msg)
      } finally {
        this.controller = null
      }
    },
    stop() {
      if (this.controller) this.controller.abort()
    }
  }
}
</script>

<style lang="less" scoped>
.flow-expand-wrap {
  position: fixed;
  z-index: 5000;
  pointer-events: auto;
}

.flow-expand-btn {
  height: 32px;
  padding: 0 12px;
  border: 1px solid rgba(18, 104, 255, 0.35);
  border-radius: 8px;
  background: #fff;
  color: #1268ff;
  font-size: 13px;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.08);

  &:hover {
    background: #f3f7ff;
  }

  &.isDark {
    background: #2a2a2a;
    color: #7eb0ff;
    border-color: rgba(126, 176, 255, 0.35);
  }
}

.auto-expand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 280px;
  padding: 8px 12px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.96);
  color: #333;
  font-size: 12px;
  line-height: 1.4;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.1);
  border: 1px solid rgba(0, 0, 0, 0.06);

  &.isDark {
    background: rgba(40, 40, 40, 0.96);
    color: #ddd;
    border-color: rgba(255, 255, 255, 0.08);
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #1268ff;
    animation: pulse 1s ease-in-out infinite;
    flex-shrink: 0;
  }
}

@keyframes pulse {
  0%,
  100% {
    opacity: 0.35;
    transform: scale(0.85);
  }
  50% {
    opacity: 1;
    transform: scale(1);
  }
}
</style>
