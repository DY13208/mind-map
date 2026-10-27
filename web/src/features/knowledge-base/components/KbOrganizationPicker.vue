<template>
  <div class="kb-organization-picker">
    <div v-if="structureError" class="kb-org-error" role="alert">{{ structureError }} <el-button type="text" :disabled="disabled" @click="loadStructure">重新加载组织架构</el-button></div>
    <div v-loading="structureLoading" class="kb-org-panes">
      <section aria-label="部门选择">
        <strong>组织架构</strong>
        <el-input v-model="departmentQuery" size="small" clearable placeholder="筛选部门" aria-label="筛选部门" :disabled="disabled" />
        <div class="kb-org-tree-scroll">
          <el-tree ref="tree" :data="tree" node-key="id" show-checkbox check-strictly :props="treeProps" :filter-node-method="filterDepartment" :expand-on-click-node="false" :default-expanded-keys="tree.map(d => d.id)" empty-text="暂无部门" @check="checkDepartments" @node-click="browseDepartment" />
        </div>
        <el-checkbox v-model="includeChildren" :disabled="disabled" @change="refreshSelection">包含下属部门</el-checkbox>
      </section>
      <section aria-label="部门成员选择">
        <strong>{{ activeDepartment ? activeDepartment.name + ' · 当前成员' : '点击部门查看成员' }}</strong>
        <p v-if="browseError" class="kb-org-error" role="alert">{{ browseError }} <el-button type="text" @click="browseDepartment(activeDepartment)">重试</el-button></p>
        <div v-loading="browsing" class="kb-org-members">
          <el-checkbox v-for="member in browsedMembers" :key="member.id" :value="selectedIds.has(member.id)" :disabled="disabled || selectionLoading" @change="toggleMember(member, $event)">{{ member.name }} <small>{{ member.id }}</small></el-checkbox>
          <p v-if="activeDepartment && !browsing && !browseError && !browsedMembers.length">该部门暂无成员</p>
        </div>
      </section>
    </div>
    <label class="kb-org-search-label">也可搜索并选择个别成员</label>
    <el-select v-model="explicitIds" multiple filterable remote reserve-keyword :remote-method="searchMembers" :loading="searching" :disabled="disabled || selectionLoading" placeholder="输入姓名或账号搜索" style="width:100%" @change="publish">
      <el-option v-for="member in contacts" :key="member.id" :value="member.id" :label="member.name + '（' + member.id + '）'" />
    </el-select>
    <p v-if="searchError" class="kb-org-error" role="alert">{{ searchError }}</p>
    <p v-if="selectionError" class="kb-org-error" role="alert">{{ selectionError }} <el-button type="text" :disabled="disabled" @click="refreshSelection">重新读取部门成员</el-button></p>
    <p class="kb-org-summary" role="status">{{ selectionLoading ? '正在读取所选部门的全部成员…' : '本次已选 ' + selected.length + ' 位成员（已去重）' }}</p>
    <div class="kb-org-selected"><el-tag v-for="member in selected" :key="member.id" size="small" :closable="!disabled && !selectionLoading" @close="toggleMember(member, false)">{{ member.name }}</el-tag></div>
    <p class="kb-org-note">仅给本次选中的当前成员授权。部门之后新增成员需要再次授权。</p>
  </div>
</template>
<script>
import teamService from '@/services/teamService'
import { departmentTree, departmentScope, loadDepartmentMembers, mergeMembers } from '../services/kbOrganization'

export default {
  name: 'KbOrganizationPicker',
  props: { disabled: Boolean },
  data() {
    return { departments: [], tree: [], departmentIds: [], departmentQuery: '', includeChildren: true, activeDepartment: null, browsedMembers: [], groupMembers: [], contacts: [], explicitIds: [], excludedIds: [], selected: [], structureLoading: false, structureError: '', browsing: false, browseError: '', selectionLoading: false, selectionError: '', searching: false, searchError: '', structureSeq: 0, browseSeq: 0, selectSeq: 0, searchSeq: 0 }
  },
  computed: {
    selectedIds() { return new Set(this.selected.map(m => m.id)) },
    treeProps() { return { label: 'name', children: 'children', disabled: () => this.disabled } }
  },
  watch: {
    departmentQuery(value) { if (this.$refs.tree) this.$refs.tree.filter(value) }
  },
  created() { this.loadStructure() },
  beforeDestroy() { this.structureSeq++; this.browseSeq++; this.selectSeq++; this.searchSeq++ },
  methods: {
    async loadStructure() {
      const seq = ++this.structureSeq
      this.structureLoading = true; this.structureError = ''; this.$emit('loading', true)
      try {
        const departments = await teamService.listDepartments()
        const tree = departmentTree(departments)
        if (seq !== this.structureSeq) return
        this.departments = departments; this.tree = tree
      } catch (e) { if (seq === this.structureSeq) this.structureError = e.message || '组织架构加载失败' }
      finally {
        if (seq === this.structureSeq) { this.structureLoading = false; this.$emit('loading', this.selectionLoading); this.$emit('error', this.structureError || this.selectionError) }
      }
    },
    filterDepartment(query, data) { return !query || String(data.name).includes(query) },
    checkDepartments() {
      this.departmentIds = this.$refs.tree.getCheckedKeys().map(String)
      this.refreshSelection()
    },
    async browseDepartment(department) {
      if (!department || this.disabled) return
      const seq = ++this.browseSeq
      this.activeDepartment = department; this.browsedMembers = []; this.browseError = ''; this.browsing = true
      try {
        const members = await loadDepartmentMembers(teamService, [department.id])
        if (seq === this.browseSeq) this.browsedMembers = members
      } catch (e) { if (seq === this.browseSeq) this.browseError = e.message || '部门成员加载失败' }
      finally { if (seq === this.browseSeq) this.browsing = false }
    },
    async refreshSelection() {
      const seq = ++this.selectSeq
      this.selectionLoading = true; this.selectionError = ''; this.groupMembers = []; this.publish(); this.$emit('loading', true)
      try {
        const scope = departmentScope(this.departments, this.departmentIds, this.includeChildren)
        const members = await loadDepartmentMembers(teamService, scope)
        if (seq !== this.selectSeq) return
        this.groupMembers = members; this.publish()
      } catch (e) { if (seq === this.selectSeq) { this.selectionError = e.message || '部门成员加载失败'; this.publish() } }
      finally {
        if (seq === this.selectSeq) { this.selectionLoading = false; this.$emit('loading', this.structureLoading); this.$emit('error', this.structureError || this.selectionError) }
      }
    },
    toggleMember(member, checked) {
      if (checked) {
        this.contacts = Array.from(new Map(this.contacts.concat(member).map(m => [m.id, m])).values())
        this.explicitIds = Array.from(new Set(this.explicitIds.concat(member.id)))
        this.excludedIds = this.excludedIds.filter(id => id !== member.id)
      } else {
        this.explicitIds = this.explicitIds.filter(id => id !== member.id)
        this.excludedIds = Array.from(new Set(this.excludedIds.concat(member.id)))
      }
      this.publish()
    },
    publish() {
      const individuals = this.explicitIds.map(id => this.contacts.find(m => m.id === id) || { id, name: id })
      this.selected = mergeMembers(this.groupMembers, individuals, this.excludedIds.filter(id => !this.explicitIds.includes(id)))
      this.$emit('input', this.selectionError ? [] : this.selected.slice())
    },
    async searchMembers(query) {
      const seq = ++this.searchSeq
      this.searchError = ''
      if (!String(query || '').trim()) { this.searching = false; return }
      this.searching = true
      try {
        const result = await teamService.listContacts({ search: query.trim(), limit: 30 })
        if (seq !== this.searchSeq) return
        const selected = this.contacts.filter(c => this.explicitIds.includes(c.id))
        this.contacts = Array.from(new Map(selected.concat((result.list || []).map(c => ({ id: String(c.userId || c.id), name: c.name || c.userId || c.id }))).map(c => [c.id, c])).values())
      } catch (e) { if (seq === this.searchSeq) this.searchError = e.message || '搜索失败，请重试' }
      finally { if (seq === this.searchSeq) this.searching = false }
    }
  }
}
</script>
<style scoped lang="less">
.kb-org-panes { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.kb-org-panes section { min-width: 0; border: 1px solid var(--ui-border, #ddd); border-radius: 6px; padding: 10px; }
.kb-org-panes strong { display: block; margin-bottom: 8px; line-height: 1.5; }
.kb-org-tree-scroll, .kb-org-members { height: 200px; overflow: auto; }
.kb-org-members .el-checkbox { display: block; margin: 5px 0; }
.kb-org-members small, .kb-org-note { color: var(--ui-text-muted, #666); font-size: 12px; }
.kb-org-search-label { display: block; margin: 12px 0 6px; }
.kb-org-summary { margin: 8px 0; }
.kb-org-selected { max-height: 96px; overflow: auto; display: flex; flex-wrap: wrap; gap: 4px; }
.kb-org-note { margin-bottom: 0; line-height: 1.6; }
.kb-org-error { color: var(--ui-danger, #c43b3b); font-size: 12px; }
@media (max-width: 600px) { .kb-org-panes { grid-template-columns: minmax(0, 1fr); } .kb-org-tree-scroll, .kb-org-members { height: 140px; } }
</style>
