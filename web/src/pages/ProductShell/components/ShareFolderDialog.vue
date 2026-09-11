<template>
  <el-dialog
    :visible.sync="shown"
    custom-class="folderPermissionDialog"
    width="1080px"
    :close-on-click-modal="false"
    :show-close="false"
  >
    <div v-loading="loading || busy" class="permissionDialogBody">
      <header class="permissionHeader">
        <div class="folderIcon"><i class="el-icon-folder" /></div>
        <div>
          <h2>文件夹权限</h2>
          <p>
            <strong>{{ folder ? folder.name : '' }}</strong> ·
            权限将应用于文件夹内现有及后续脑图
          </p>
        </div>
        <button
          class="closeBtn"
          type="button"
          aria-label="关闭"
          @click="shown = false"
        >
          ×
        </button>
      </header>
      <div class="permissionWorkspace">
        <section class="organizationPane" aria-label="组织成员选择">
          <div class="paneHeader">
            <div>
              <h3>选择部门与成员</h3>
              <span>{{ departmentOptions.length }} 个部门 · 成员按需加载</span>
            </div>
            <button
              v-if="expandedDepartments.length"
              type="button"
              @click="collapseAllDepartments"
            >
              全部收起
            </button>
          </div>
          <div class="treeToolbar">
            <el-input
              v-model.trim="query"
              size="small"
              prefix-icon="el-icon-search"
              clearable
              placeholder="搜索部门或成员"
            />
          </div>
          <div v-loading="searching" class="organizationTree" role="tree">
            <div
              v-for="row in visibleRows"
              :key="row.key"
              :class="['treeRow', row.type, { selected: isRowSelected(row) }]"
              :style="{ paddingLeft: `${10 + row.level * 18}px` }"
              role="treeitem"
            >
              <button
                v-if="row.type === 'department' && row.hasChildren"
                class="expandBtn"
                type="button"
                :aria-label="
                  expandedDepartments.includes(row.id) ? '收起部门' : '展开部门'
                "
                @click="toggleDepartment(row.id)"
              >
                <i
                  :class="
                    expandedDepartments.includes(row.id)
                      ? 'el-icon-arrow-down'
                      : 'el-icon-arrow-right'
                  "
                /></button
              ><span v-else class="expandSpacer" />
              <el-checkbox
                :value="isRowSelected(row)"
                :indeterminate="
                  row.type === 'department' && isDepartmentPartial(row.id)
                "
                @change="toggleRow(row, $event)"
              />
              <span v-if="row.type === 'department'" class="treeIcon"
                ><i class="el-icon-office-building"/></span
              ><span v-else class="memberAvatar">{{
                avatarText(row.contact)
              }}</span>
              <span class="treeLabel"
                ><strong>{{ row.name }}</strong
                ><small v-if="row.type === 'department'">{{
                  departmentCountLabel(row.id)
                }}</small
                ><small v-else>{{
                  row.contact.position || '成员'
                }}</small></span
              >
              <el-checkbox
                v-if="row.type === 'department'"
                class="departmentMemberToggle"
                :value="areDepartmentMembersSelected(row.id)"
                @change="toggleDepartmentMembers(row.id, $event)"
                >勾选全部成员</el-checkbox
              ><span
                v-if="row.type === 'member' && inheritedByDepartment(row)"
                class="inheritedTag"
                >随部门</span
              >
            </div>
            <div v-if="!visibleRows.length" class="treeEmpty">
              <i
                :class="query ? 'el-icon-search' : 'el-icon-office-building'"
              /><span>{{
                query ? '未找到匹配的部门或成员' : '企业通讯录暂无可选成员'
              }}</span>
            </div>
          </div>
        </section>
        <aside class="permissionDetailPane" aria-label="授权设置与预览">
          <section class="detailSection selectedSection">
            <div class="detailTitle">
              <h3>已选对象</h3>
              <button
                v-if="selectionCount"
                type="button"
                @click="clearSelection"
              >
                清空
              </button>
            </div>
            <div v-if="selectedEntities.length" class="selectedList">
              <div
                v-for="item in selectedEntities"
                :key="item.key"
                class="selectedItem"
              >
                <span :class="['selectedIcon', item.type]"
                  ><i
                    :class="
                      item.type === 'department'
                        ? 'el-icon-office-building'
                        : 'el-icon-user'
                    "/></span
                ><span
                  ><strong>{{ item.name }}</strong
                  ><small>{{ item.caption }}</small></span
                ><button
                  type="button"
                  aria-label="移除"
                  @click="removeSelection(item)"
                >
                  ×
                </button>
              </div>
            </div>
            <div v-else class="selectionEmpty">
              <i class="el-icon-user" /><span>从左侧选择部门或成员</span>
            </div>
          </section>
          <section class="detailSection">
            <h3>权限级别</h3>
            <el-radio-group v-model="role" class="roleOptions"
              ><el-radio-button label="Viewer"
                ><strong>可查看</strong
                ><small>仅查看内容</small></el-radio-button
              ><el-radio-button label="Editor"
                ><strong>可编辑</strong
                ><small>查看并编辑</small></el-radio-button
              ><el-radio-button label="Manager"
                ><strong>可管理</strong
                ><small>管理成员权限</small></el-radio-button
              ></el-radio-group
            >
          </section>
          <section class="detailSection previewSection">
            <h3>应用设置</h3>
            <div class="applicationSettings">
              <el-checkbox v-model="autoSelectMembers"
                >勾选部门时自动选中全部成员</el-checkbox
              ><el-checkbox v-model="includeChildren"
                >部门授权包含下属部门</el-checkbox
              >
            </div>
            <div class="grantStats">
              <div>
                <i class="el-icon-office-building" /><span
                  >部门<strong>{{ selectedDepartmentIds.length }}</strong
                  ><small>个</small></span
                >
              </div>
              <div>
                <i class="el-icon-user" /><span
                  >成员<strong>{{ selectedUserIds.length }}</strong
                  ><small>人</small></span
                >
              </div>
            </div>
            <div class="previewBox">
              <i class="el-icon-circle-check" />
              <p v-if="selectionCount">
                <strong>{{ selectionSummary }}</strong
                ><span>将获得「{{ roleLabel(role) }}」权限</span>
              </p>
              <p v-else>
                <strong>尚未选择授权对象</strong
                ><span>选择后可在此确认影响范围</span>
              </p>
            </div>
          </section>
          <section class="detailSection existingSection">
            <div class="detailTitle">
              <h3>已有权限</h3>
              <span>{{ members.length }} 人</span>
            </div>
            <div class="existingList">
              <div v-if="members.length" class="existingHead">
                <span>对象</span><span>权限</span><span>操作</span>
              </div>
              <div
                v-for="member in pagedMembers"
                :key="member.id"
                class="existingRow"
              >
                <span class="memberAvatar small">{{ avatarText(member) }}</span
                ><span class="existingIdentity"
                  ><strong>{{ member.name || member.id }}</strong
                  ><small>{{ member.department || '成员' }}</small></span
                ><el-select
                  size="mini"
                  :value="member.role"
                  :disabled="String(member.role).toLowerCase() === 'owner'"
                  @change="updateRole(member, $event)"
                  ><el-option label="可查看" value="Viewer"/><el-option
                    label="可编辑"
                    value="Editor"/><el-option
                    label="可管理"
                    value="Manager"/></el-select
                ><button
                  v-if="String(member.role).toLowerCase() !== 'owner'"
                  class="removeBtn"
                  type="button"
                  @click="remove(member)"
                >
                  移除
                </button>
              </div>
              <p v-if="!members.length && !loading" class="existingEmpty">
                暂未添加成员
              </p>
            </div>
            <el-pagination
              v-if="members.length > pageSize"
              class="memberPager"
              small
              layout="prev, pager, next"
              :current-page.sync="page"
              :page-size="pageSize"
              :total="members.length"
            />
          </section>
        </aside>
      </div>
    </div>
    <span slot="footer" class="permissionFooter"
      ><span class="footerHint"
        ><i class="el-icon-success" /> 权限变更实时生效</span
      ><span
        ><el-button @click="shown = false">取消</el-button
        ><el-button
          type="primary"
          :disabled="!selectionCount"
          :loading="busy"
          @click="grantSelected"
          >保存授权</el-button
        ></span
      ></span
    >
  </el-dialog>
</template>

<script>
import folderService from '@/services/folderService'
import teamService from '@/services/teamService'
export default {
  name: 'ShareFolderDialog',
  props: { visible: Boolean, folder: Object },
  data: () => ({
    members: [],
    contacts: [],
    searchResults: [],
    departmentOptions: [],
    departmentTotals: {},
    loadedDepartmentIds: [],
    loadingDepartmentIds: [],
    query: '',
    searchTimer: null,
    searching: false,
    role: 'Viewer',
    loading: false,
    busy: false,
    page: 1,
    pageSize: 4,
    expandedDepartments: [],
    selectedDepartmentIds: [],
    selectedUserIds: [],
    autoSelectMembers: true,
    includeChildren: true
  }),
  computed: {
    shown: {
      get() {
        return this.visible
      },
      set(value) {
        this.$emit('update:visible', value)
      }
    },
    folderId() {
      return (this.folder && this.folder.id) || ''
    },
    pagedMembers() {
      const start = (this.page - 1) * this.pageSize
      return this.members.slice(start, start + this.pageSize)
    },
    departmentMap() {
      return this.departmentOptions.reduce((map, item) => {
        map[item.id] = item
        return map
      }, {})
    },
    childDepartmentMap() {
      return this.departmentOptions.reduce((map, item) => {
        const parent = item.parentId || '0'
        if (!map[parent]) map[parent] = []
        map[parent].push(item)
        return map
      }, {})
    },
    contactsByDepartment() {
      return this.contacts.reduce((map, contact) => {
        const ids = (contact.departmentIds && contact.departmentIds.length
          ? contact.departmentIds
          : [contact.departmentId || '0']
        ).map(String)
        ids.forEach(id => {
          if (!map[id]) map[id] = []
          if (
            !map[id].some(
              item =>
                String(item.userId || item.id) ===
                String(contact.userId || contact.id)
            )
          )
            map[id].push(contact)
        })
        return map
      }, {})
    },
    visibleRows() {
      const term = this.query.toLowerCase()
      if (term)
        return this.departmentOptions
          .filter(item => item.name.toLowerCase().includes(term))
          .map(item => ({
            ...item,
            type: 'department',
            key: `d-${item.id}`,
            level: 0,
            hasChildren: true
          }))
          .concat(
            this.searchResults.map(item => ({
              id: item.userId || item.id,
              name: item.name,
              contact: item,
              type: 'member',
              key: `search-${item.userId || item.id}`,
              level: 0
            }))
          )
      const rows = []
      const walk = (parentId, level) => {
        ;(this.childDepartmentMap[parentId] || [])
          .slice()
          .sort((a, b) => a.order - b.order)
          .forEach(department => {
            const people = this.contactsByDepartment[department.id] || []
            rows.push({
              ...department,
              type: 'department',
              key: `d-${department.id}`,
              level,
              hasChildren: true
            })
            if (this.expandedDepartments.includes(department.id)) {
              people.forEach(contact =>
                rows.push({
                  id: contact.userId || contact.id,
                  name: contact.name,
                  contact,
                  type: 'member',
                  key: `m-${contact.userId || contact.id}-${department.id}`,
                  level: level + 1
                })
              )
              walk(department.id, level + 1)
            }
          })
      }
      const roots = this.departmentOptions.filter(
        item =>
          item.parentId === '0' ||
          !this.departmentOptions.some(parent => parent.id === item.parentId)
      )
      roots.forEach(root => {
        if (!rows.some(row => row.id === root.id)) {
          rows.push({
            ...root,
            type: 'department',
            key: `d-${root.id}`,
            level: 0,
            hasChildren: true
          })
          if (this.expandedDepartments.includes(root.id)) {
            ;(this.contactsByDepartment[root.id] || []).forEach(contact =>
              rows.push({
                id: contact.userId || contact.id,
                name: contact.name,
                contact,
                type: 'member',
                key: `m-${contact.userId || contact.id}-${root.id}`,
                level: 1
              })
            )
            walk(root.id, 1)
          }
        }
      })
      return rows
    },
    selectedEntities() {
      const departments = this.selectedDepartmentIds
        .map(id => this.departmentMap[id])
        .filter(Boolean)
        .map(item => ({
          key: `d-${item.id}`,
          id: item.id,
          type: 'department',
          name: item.name,
          caption: this.departmentSelectionCaption(item.id)
        }))
      const people = this.selectedUserIds
        .map(id =>
          this.contacts.find(item => String(item.userId || item.id) === id)
        )
        .filter(Boolean)
        .map(item => ({
          key: `m-${item.userId || item.id}`,
          id: String(item.userId || item.id),
          type: 'member',
          name: item.name,
          caption: item.department || item.position || '成员'
        }))
      return departments.concat(people)
    },
    selectionCount() {
      return this.selectedDepartmentIds.length + this.selectedUserIds.length
    },
    selectionSummary() {
      const parts = []
      if (this.selectedDepartmentIds.length)
        parts.push(`${this.selectedDepartmentIds.length} 个部门`)
      if (this.selectedUserIds.length)
        parts.push(`${this.selectedUserIds.length} 位成员`)
      return parts.join('、')
    }
  },
  watch: {
    visible(value) {
      if (value) this.resetAndLoad()
    },
    query() {
      this.searchContacts()
    },
    members() {
      const max = Math.max(1, Math.ceil(this.members.length / this.pageSize))
      if (this.page > max) this.page = max
    }
  },
  beforeDestroy() {
    clearTimeout(this.searchTimer)
  },
  methods: {
    async resetAndLoad() {
      this.query = ''
      this.page = 1
      this.clearSelection()
      this.contacts = []
      this.searchResults = []
      this.departmentTotals = {}
      this.loadedDepartmentIds = []
      this.loadingDepartmentIds = []
      this.expandedDepartments = []
      this.loading = true
      try {
        const [departments, memberResult] = await Promise.all([
          teamService.listDepartments(),
          folderService.getMembers(this.folderId)
        ])
        this.departmentOptions = departments
        this.members = memberResult.list
      } catch (error) {
        this.$message.error(error.message || '加载权限数据失败')
      } finally {
        this.loading = false
      }
    },
    cacheContacts(items) {
      const map = new Map(
        this.contacts.map(item => [String(item.userId || item.id), item])
      )
      items.forEach(item => map.set(String(item.userId || item.id), item))
      this.contacts = Array.from(map.values())
    },
    async loadDepartmentContacts(id) {
      id = String(id)
      if (
        this.loadedDepartmentIds.includes(id) ||
        this.loadingDepartmentIds.includes(id)
      )
        return
      this.loadingDepartmentIds = this.loadingDepartmentIds.concat(id)
      try {
        const items = []
        let offset = 0
        let total = 0
        let nextCursor = null
        const limit = 100
        while (offset < 1000) {
          const result = await teamService.listContacts({
            departmentId: id,
            limit,
            offset,
            cursor: nextCursor
          })
          items.push(...result.list)
          const reportedTotal = Number(result.total)
          total = reportedTotal > 0 ? reportedTotal : items.length
          nextCursor = result.nextCursor
          offset += result.list.length
          if (
            !result.list.length ||
            (!nextCursor && result.list.length < limit) ||
            (reportedTotal > 0 && offset >= reportedTotal)
          )
            break
        }
        this.cacheContacts(items)
        this.$set(this.departmentTotals, id, total)
        this.loadedDepartmentIds = this.loadedDepartmentIds.concat(id)
      } catch (error) {
        this.$message.error(error.message || '加载部门成员失败')
      } finally {
        this.loadingDepartmentIds = this.loadingDepartmentIds.filter(
          item => item !== id
        )
      }
    },
    searchContacts() {
      clearTimeout(this.searchTimer)
      const term = this.query.trim()
      if (!term) {
        this.searchResults = []
        this.searching = false
        return
      }
      this.searching = true
      this.searchTimer = setTimeout(async () => {
        try {
          const result = await teamService.listContacts({
            search: term,
            limit: 100
          })
          if (this.query.trim() === term) {
            this.searchResults = result.list
            this.cacheContacts(result.list)
          }
        } catch (error) {
          if (this.query.trim() === term)
            this.$message.error(error.message || '搜索成员失败')
        } finally {
          if (this.query.trim() === term) this.searching = false
        }
      }, 250)
    },
    async toggleDepartment(id) {
      if (this.expandedDepartments.includes(id)) {
        this.expandedDepartments = this.expandedDepartments.filter(
          item => item !== id
        )
        return
      }
      this.expandedDepartments = this.expandedDepartments.concat(id)
      await this.loadDepartmentContacts(id)
    },
    collapseAllDepartments() {
      this.expandedDepartments = []
    },
    descendantDepartmentIds(id) {
      const ids = [String(id)]
      if (!this.includeChildren) return ids
      for (let index = 0; index < ids.length; index += 1)
        (this.childDepartmentMap[ids[index]] || []).forEach(item => {
          if (!ids.includes(item.id)) ids.push(item.id)
        })
      return ids
    },
    memberIdsForDepartment(id) {
      const ids = this.descendantDepartmentIds(id)
      return this.contacts
        .filter(contact =>
          (contact.departmentIds || [contact.departmentId])
            .map(String)
            .some(item => ids.includes(item))
        )
        .map(contact => String(contact.userId || contact.id))
    },
    departmentMemberCount(id) {
      return new Set(this.memberIdsForDepartment(id)).size
    },
    departmentCountLabel(id) {
      const key = String(id)
      if (this.loadingDepartmentIds.includes(key)) return '加载中…'
      if (Object.prototype.hasOwnProperty.call(this.departmentTotals, key))
        return this.departmentTotals[key] > 0
          ? `${this.departmentTotals[key]} 人`
          : '暂无成员'
      return '展开加载成员'
    },
    areDepartmentMembersSelected(id) {
      if (
        this.autoSelectMembers &&
        this.selectedDepartmentIds.includes(String(id))
      )
        return true
      const ids = this.memberIdsForDepartment(id)
      return (
        ids.length > 0 && ids.every(item => this.selectedUserIds.includes(item))
      )
    },
    async toggleDepartmentMembers(id, checked) {
      if (!this.loadedDepartmentIds.includes(String(id)))
        await this.loadDepartmentContacts(id)
      const ids = this.memberIdsForDepartment(id)
      this.selectedUserIds = checked
        ? Array.from(new Set(this.selectedUserIds.concat(ids)))
        : this.selectedUserIds.filter(item => !ids.includes(item))
    },
    isRowSelected(row) {
      return row.type === 'department'
        ? this.selectedDepartmentIds.includes(row.id)
        : this.selectedUserIds.includes(String(row.id)) ||
            this.inheritedByDepartment(row)
    },
    inheritedByDepartment(row) {
      return (
        this.autoSelectMembers &&
        this.selectedDepartmentIds.some(id =>
          this.memberIdsForDepartment(id).includes(String(row.id))
        )
      )
    },
    isDepartmentPartial(id) {
      const ids = this.memberIdsForDepartment(id)
      const count = ids.filter(item => this.selectedUserIds.includes(item))
        .length
      return (
        !this.selectedDepartmentIds.includes(id) &&
        count > 0 &&
        count < ids.length
      )
    },
    toggleRow(row, checked) {
      if (row.type === 'department') {
        this.selectedDepartmentIds = checked
          ? Array.from(new Set(this.selectedDepartmentIds.concat(row.id)))
          : this.selectedDepartmentIds.filter(id => id !== row.id)
      } else {
        const id = String(row.id)
        this.selectedUserIds = checked
          ? Array.from(new Set(this.selectedUserIds.concat(id)))
          : this.selectedUserIds.filter(item => item !== id)
      }
    },
    departmentSelectionCaption(id) {
      const count = this.departmentTotals[String(id)]
      return `${count == null ? '成员按需加载' : `${count} 位成员`}${
        this.includeChildren ? '，含下属部门' : ''
      }`
    },
    clearSelection() {
      this.selectedDepartmentIds = []
      this.selectedUserIds = []
    },
    removeSelection(item) {
      if (item.type === 'department')
        this.toggleRow({ type: 'department', id: item.id }, false)
      else
        this.selectedUserIds = this.selectedUserIds.filter(id => id !== item.id)
    },
    avatarText(item) {
      return String((item && item.name) || '企').slice(0, 1)
    },
    roleLabel(role) {
      return (
        { Viewer: '可查看', Editor: '可编辑', Manager: '可管理' }[role] ||
        '可查看'
      )
    },
    async grantSelected() {
      this.busy = true
      try {
        for (const id of this.selectedDepartmentIds)
          await folderService.bulkSetMembers(this.folderId, {
            departmentId: id,
            includeChildren: this.includeChildren,
            role: this.role.toLowerCase()
          })
        const departmentUsers = new Set(
          this.selectedDepartmentIds.reduce(
            (all, id) => all.concat(this.memberIdsForDepartment(id)),
            []
          )
        )
        for (const id of this.selectedUserIds.filter(
          item => !departmentUsers.has(item)
        ))
          await folderService.setMember(this.folderId, id, this.role)
        await this.loadMembers()
        this.clearSelection()
        this.$emit('changed')
        this.$message.success('文件夹权限已更新')
      } catch (error) {
        this.$message.error(error.message || '授权失败，请稍后重试')
      } finally {
        this.busy = false
      }
    },
    async loadMembers() {
      this.members = (await folderService.getMembers(this.folderId)).list
    },
    async run(action) {
      this.busy = true
      try {
        await action()
        await this.loadMembers()
        this.$emit('changed')
        this.$message.success('文件夹权限已更新')
      } catch (error) {
        this.$message.error(error.message || '更新权限失败')
      } finally {
        this.busy = false
      }
    },
    updateRole(member, role) {
      return this.run(() =>
        folderService.updateMember(this.folderId, member.id, role)
      )
    },
    remove(member) {
      return this.run(() =>
        folderService.removeMember(this.folderId, member.id)
      )
    }
  }
}
</script>

<style lang="less" scoped>
.permissionDialogBody {
  color: #17261f;
}
.permissionHeader {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 14px;
  border-bottom: 1px solid #e7ece9;
}
.folderIcon {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: #e8f4ef;
  color: #087854;
  display: grid;
  place-items: center;
  font-size: 18px;
}
.permissionHeader h2 {
  margin: 0;
  font-size: 18px;
}
.permissionHeader p {
  margin: 3px 0 0;
  color: #66756e;
  font-size: 12px;
}
.permissionHeader p strong {
  color: #334b41;
}
.closeBtn {
  margin-left: auto;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #66756e;
  font-size: 24px;
  cursor: pointer;
}
.closeBtn:hover {
  background: #f1f5f3;
  color: #17261f;
}
.permissionWorkspace {
  display: grid;
  grid-template-columns: minmax(0, 1.08fr) minmax(390px, 0.92fr);
  height: ~'min(650px,72vh)';
  margin-top: 14px;
  border: 1px solid #dfe7e3;
  border-radius: 10px;
  overflow: hidden;
}
.organizationPane {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid #dfe7e3;
  background: #fbfcfc;
  overflow: hidden;
}
.paneHeader,
.detailTitle {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.paneHeader {
  padding: 13px 16px;
  border-bottom: 1px solid #e7ece9;
  background: #fff;
}
.paneHeader h3,
.detailSection h3 {
  margin: 0;
  font-size: 13px;
}
.paneHeader span {
  display: block;
  margin-top: 2px;
  color: #7b8982;
  font-size: 12px;
}
.paneHeader button,
.detailTitle button {
  border: 0;
  background: transparent;
  color: #087854;
  font-size: 12px;
  cursor: pointer;
}
.treeToolbar {
  padding: 10px 12px;
  border-bottom: 1px solid #e7ece9;
}
.selectionOptions {
  display: flex;
  gap: 18px;
  margin-top: 9px;
}
.selectionOptions /deep/ .el-checkbox__label {
  padding-left: 6px;
  color: #52665f;
  font-size: 12px;
}
.organizationTree {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 6px;
}
.treeRow {
  min-height: 38px;
  display: flex;
  align-items: center;
  padding-right: 10px;
  border-radius: 6px;
  color: #334b41;
}
.treeRow:hover {
  background: #f1f5f3;
}
.treeRow.selected {
  background: #e8f4ef;
}
.expandBtn,
.expandSpacer {
  flex: 0 0 22px;
  width: 22px;
  height: 28px;
  display: grid;
  place-items: center;
}
.expandBtn {
  border: 0;
  background: transparent;
  color: #66756e;
  cursor: pointer;
  border-radius: 4px;
}
.treeIcon,
.memberAvatar {
  flex: 0 0 26px;
  width: 26px;
  height: 26px;
  margin-left: 7px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  background: #eef3f1;
  color: #52665f;
}
.memberAvatar {
  border-radius: 50%;
  background: #dfece6;
  color: #087854;
  font-size: 12px;
  font-weight: 600;
}
.memberAvatar.small {
  margin-left: 0;
  width: 28px;
  height: 28px;
  flex-basis: 28px;
}
.treeLabel {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: baseline;
  gap: 7px;
  margin-left: 8px;
}
.treeLabel strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 500;
}
.treeLabel small {
  flex-shrink: 0;
  color: #7b8982;
  font-size: 12px;
}
.inheritedTag {
  padding: 2px 6px;
  border-radius: 4px;
  background: #fff;
  color: #087854;
  font-size: 11px;
}
.treeEmpty,
.selectionEmpty {
  display: grid;
  place-items: center;
  align-content: center;
  gap: 8px;
  height: 100%;
  min-height: 82px;
  color: #7b8982;
  font-size: 12px;
}
.treeEmpty i,
.selectionEmpty i {
  font-size: 22px;
  color: #9caaa3;
}
.permissionDetailPane {
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  background: #fff;
}
.detailSection {
  padding: 13px 16px;
  border-bottom: 1px solid #e7ece9;
}
.detailSection h3 {
  margin-bottom: 10px;
}
.detailTitle h3 {
  margin: 0;
}
.detailTitle > span {
  color: #7b8982;
  font-size: 12px;
}
.selectedSection {
  min-height: 118px;
}
.selectedList {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 10px;
  max-height: 88px;
  overflow: auto;
}
.selectedItem {
  max-width: 100%;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 6px;
  border: 1px solid #dfe7e3;
  border-radius: 7px;
  background: #fbfcfc;
}
.selectedIcon {
  width: 24px;
  height: 24px;
  border-radius: 5px;
  display: grid;
  place-items: center;
  background: #eef3f1;
  color: #52665f;
}
.selectedIcon.department {
  background: #e8f4ef;
  color: #087854;
}
.selectedItem > span:nth-child(2) {
  min-width: 0;
}
.selectedItem strong,
.selectedItem small {
  display: block;
  max-width: 145px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.selectedItem strong {
  font-size: 12px;
}
.selectedItem small {
  color: #7b8982;
  font-size: 11px;
}
.selectedItem button {
  border: 0;
  background: transparent;
  color: #7b8982;
  cursor: pointer;
  font-size: 16px;
}
.selectionEmpty {
  grid-auto-flow: column;
  justify-content: center;
}
.roleOptions {
  width: 100%;
  display: flex;
}
.roleOptions /deep/ .el-radio-button {
  flex: 1;
}
.roleOptions /deep/ .el-radio-button__inner {
  width: 100%;
  padding: 8px 4px;
  border-color: #dfe7e3;
  color: #52665f;
  box-shadow: none;
}
.roleOptions
  /deep/
  .el-radio-button__orig-radio:checked
  + .el-radio-button__inner {
  background: #e8f4ef;
  border-color: #087854;
  color: #087854;
  box-shadow: -1px 0 0 0 #087854;
}
.roleOptions strong,
.roleOptions small {
  display: block;
}
.roleOptions small {
  margin-top: 3px;
  font-size: 10px;
  font-weight: 400;
}
.previewBox {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border: 1px solid #dfe7e3;
  border-radius: 7px;
  background: #f7f9f8;
}
.previewBox i {
  color: #087854;
  font-size: 18px;
}
.previewBox p {
  margin: 0;
}
.previewBox strong,
.previewBox span {
  display: block;
  font-size: 12px;
}
.previewBox span {
  margin-top: 2px;
  color: #66756e;
  font-size: 11px;
}
.previewSection .el-button {
  width: 100%;
  margin-top: 9px;
  background: #087854;
  border-color: #087854;
}
.existingSection {
  border-bottom: 0;
}
.existingList {
  margin-top: 8px;
}
.existingRow {
  min-height: 40px;
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid #edf1ef;
}
.existingRow /deep/ .el-select {
  width: 86px;
}
.existingIdentity {
  min-width: 0;
  flex: 1;
}
.existingIdentity strong,
.existingIdentity small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.existingIdentity strong {
  font-size: 12px;
  font-weight: 500;
}
.existingIdentity small {
  color: #7b8982;
  font-size: 11px;
}
.removeBtn {
  border: 0;
  background: transparent;
  color: #9a514b;
  font-size: 11px;
  cursor: pointer;
}
.existingEmpty {
  text-align: center;
  color: #7b8982;
  font-size: 12px;
}
.memberPager {
  margin-top: 8px;
  text-align: right;
}
.footerHint {
  margin-right: 12px;
  color: #7b8982;
  font-size: 12px;
}
/deep/ .el-checkbox__input.is-checked .el-checkbox__inner,
/deep/ .el-checkbox__input.is-indeterminate .el-checkbox__inner {
  background-color: #087854;
  border-color: #087854;
}
@media (max-width: 900px) {
  .permissionWorkspace {
    grid-template-columns: 1fr;
    height: ~'min(720px,78vh)';
    overflow-y: auto;
  }
  .organizationPane {
    min-height: 390px;
    border-right: 0;
    border-bottom: 1px solid #dfe7e3;
  }
  .permissionDetailPane {
    overflow: visible;
  }
}
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    transition-duration: 0.01ms !important;
  }
}
</style>
<style lang="less" scoped>
.applicationSettings {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-bottom: 10px;
}
.applicationSettings /deep/ .el-checkbox__label {
  font-size: 12px;
  color: #334b41;
}
.grantStats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 8px;
}
.grantStats > div {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border: 1px solid #dfe7e3;
  border-radius: 7px;
  background: #f7f9f8;
}
.grantStats i {
  font-size: 20px;
  color: #087854;
}
.grantStats span {
  font-size: 11px;
  color: #66756e;
}
.grantStats strong {
  margin-left: 8px;
  font-size: 18px;
  color: #17261f;
}
.grantStats small {
  margin-left: 3px;
}
.previewSection > .el-button {
  display: none;
}
.existingList {
  border: 1px solid #e7ece9;
  border-radius: 7px;
  overflow: hidden;
}
.existingHead {
  display: grid;
  grid-template-columns: 1fr 86px 40px;
  gap: 8px;
  padding: 6px 8px 6px 42px;
  background: #f1f5f3;
  color: #66756e;
  font-size: 11px;
}
.existingRow {
  padding: 0 8px;
}
.removeBtn {
  width: 32px;
  padding: 0;
  color: #c0443c;
}
.permissionFooter {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.footerHint {
  color: #66756e;
}
.footerHint i {
  color: #087854;
}
.permissionFooter .el-button--primary {
  background: #087854;
  border-color: #087854;
}
.permissionFooter .el-button--primary:hover {
  background: #066646;
  border-color: #066646;
}
.departmentMemberToggle {
  margin-left: auto;
}
.departmentMemberToggle /deep/ .el-checkbox__label {
  padding-left: 5px;
  color: #66756e;
  font-size: 11px;
}
.treeToolbar {
  padding-bottom: 10px;
}
</style>
<style lang="less">
.folderPermissionDialog {
  display: flex;
  flex-direction: column;
  width: min(1080px, calc(100vw - 32px)) !important;

  height: 96vh;
  max-height: 96vh;

  margin: 2vh auto 0 !important;
  border-radius: 12px;
  overflow: hidden;
}
.folderPermissionDialog .el-dialog__header {
  display: none;
}
.folderPermissionDialog .el-dialog__body {
  flex: 1;
  min-height: 0;
  padding: 16px 18px 0;
  overflow: hidden;
}
.folderPermissionDialog .permissionDialogBody {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.folderPermissionDialog .permissionWorkspace {
  flex:1;
  min-height:0;
  overflow:hidden;
}
.folderPermissionDialog .el-dialog__footer {
  flex: 0 0 auto;
  padding: 10px 18px 14px;
  border-top: 1px solid #e7ece9;
  background: #fff;
}
@media (max-width: 900px) {
  .folderPermissionDialog {
    max-height: 96vh;
  }
  .folderPermissionDialog .el-dialog__body {
    overflow-y: auto;
  }
  .folderPermissionDialog .permissionDialogBody {
    height: auto;
  }
  .folderPermissionDialog .permissionWorkspace {
    display: flex;
    flex-direction: column;
    flex: none;
    height: calc(96vh - 150px);
    min-height: 0;
    overflow-y: auto;
  }
  .folderPermissionDialog .organizationPane {
    min-height: 360px;
    flex: 0 0 360px;
  }
  .folderPermissionDialog .permissionDetailPane {
    flex: 0 0 auto;
    overflow: visible;
  }
}
</style>
