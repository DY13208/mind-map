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
        <div :class="['resourceIcon', { room: isRoom, team: isTeam }]">
          <i
            :class="
              isTeam
                ? 'el-icon-office-building'
                : isRoom
                ? 'el-icon-document'
                : 'el-icon-folder'
            "
          />
        </div>
        <div>
          <h2>{{ resourceTitle }}</h2>
          <p>
            <strong>{{ resourceName }}</strong> · {{ resourceDescription }}
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
                :disabled="loadingDepartmentIds.includes(String(row.id))"
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
            <el-radio-group v-model="role" class="roleOptions">
              <el-radio-button
                v-for="option in roleOptions"
                :key="option.value"
                :label="option.value"
                ><strong>{{ option.title }}</strong
                ><small>{{ option.caption }}</small></el-radio-button
              >
            </el-radio-group>
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
              <div class="existingMeta">
                <span class="memberCount">{{ filteredMembers.length }} 人</span>
                <el-select
                  v-model="pageSize"
                  class="memberPageSize"
                  size="mini"
                  aria-label="每页显示人数"
                >
                  <el-option :value="10" label="10 条/页" />
                  <el-option :value="20" label="20 条/页" />
                  <el-option :value="50" label="50 条/页" />
                </el-select>
              </div>
            </div>
            <div class="existingSearch">
              <el-input
                v-model.trim="memberQuery"
                size="mini"
                prefix-icon="el-icon-search"
                clearable
                placeholder="搜索已有权限成员"
              />
            </div>
            <div class="existingList">
              <div v-if="filteredMembers.length" class="existingHead">
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
                ><span
                  v-if="isOwnerRole(member.role)"
                  class="ownerRoleLabel"
                  >所有者</span
                ><el-select
                  v-else
                  size="mini"
                  :value="member.role"
                  @change="updateRole(member, $event)"
                  ><el-option
                    v-for="option in memberRoleSelectOptions"
                    :key="option.value"
                    :label="option.label"
                    :value="option.value"/></el-select
                ><template v-if="isOwnerRole(member.role)">
                  <button
                    v-if="canTransferOwnership"
                    class="transferBtn"
                    type="button"
                    @click="openTransferDialog(member)"
                  >
                    转移所有权
                  </button>
                  <span v-else class="ownerBadge">所有者</span>
                </template>
                <button
                  v-else
                  class="removeBtn"
                  type="button"
                  @click="remove(member)"
                >
                  移除
                </button>
              </div>
              <p v-if="!filteredMembers.length && !loading" class="existingEmpty">
                {{
                  memberQuery
                    ? '未找到匹配的已有权限成员'
                    : '暂未添加成员'
                }}
              </p>
            </div>
            <el-pagination
              v-if="filteredMembers.length > pageSize"
              class="memberPager"
              small
              layout="prev, pager, next"
              :current-page.sync="page"
              :page-size="pageSize"
              :total="filteredMembers.length"
            />
          </section>
        </aside>
      </div>
    </div>
    <el-dialog
      :visible.sync="transferVisible"
      append-to-body
      width="420px"
      title="转移所有权"
      custom-class="ownershipTransferDialog"
      :close-on-click-modal="false"
    >
      <p class="transferHint">
        将「{{ resourceName }}」的所有者权限转移给{{ isTeam ? '其他团队成员' : '其他企业成员' }}。转移后你将保留管理/编辑权限，但不再是所有者。
      </p>
      <el-input
        v-model="transferQuery"
        clearable
        prefix-icon="el-icon-search"
        :placeholder="isTeam ? '搜索团队成员姓名或账号' : '搜索企业成员姓名或账号'"
        style="margin-bottom: 12px"
        @input="searchTransferCandidates"
      />
      <el-select
        v-model="transferTargetId"
        :loading="transferSearching"
        clearable
        placeholder="选择新的所有者"
        style="width: 100%"
      >
        <el-option
          v-for="candidate in transferCandidates"
          :key="candidate.id"
          :label="candidate.name || candidate.id"
          :value="String(candidate.id)"
        >
          <span>{{ candidate.name || candidate.id }}</span>
          <small style="float: right; color: #909399">{{
            candidate.transferContact ? '企业成员' : roleLabel(candidate.role)
          }}</small>
        </el-option>
      </el-select>
      <el-button
        v-if="transferNextCursor"
        type="text"
        :loading="transferSearching"
        @click="loadTransferContacts(true)"
      >加载更多成员</el-button>
      <p v-if="isTeam" class="transferHint">只能转移给已加入团队的成员。</p>
      <span slot="footer">
        <el-button @click="transferVisible = false">取消</el-button>
        <el-button
          type="primary"
          :disabled="!transferTargetId"
          :loading="busy"
          @click="confirmTransferOwnership"
          >确认转移</el-button
        >
      </span>
    </el-dialog>
    <span slot="footer" class="permissionFooter"
      ><span class="footerHint"
        ><i class="el-icon-success" /> {{ resourceLabel }}权限变更实时生效</span
      ><span
        ><el-button @click="shown = false">取消</el-button
        ><el-button
          type="primary"
          :disabled="!selectionCount"
          :loading="busy"
          @click="grantSelected"
          >{{ busy ? '正在保存授权…' : '保存授权' }}</el-button
        ></span
      ></span
    >
  </el-dialog>
</template>

<script>
import folderService from '@/services/folderService'
import shareService from '@/services/shareService'
import teamService from '@/services/teamService'
import { getCurrentUser } from '@/utils/auth'
export default {
  name: 'ShareFolderDialog',
  props: {
    visible: Boolean,
    folder: Object,
    room: Object,
    team: Object,
    resourceType: {
      type: String,
      default: 'folder',
      validator: value => ['folder', 'room', 'team'].includes(value)
    }
  },
  data: () => ({
    members: [],
    contacts: [],
    searchResults: [],
    departmentOptions: [],
    departmentTotals: {},
    loadedDepartmentIds: [],
    loadingDepartmentIds: [],
    departmentLoadTasks: {},
    query: '',
    memberQuery: '',
    searchTimer: null,
    searching: false,
    role: 'Viewer',
    loading: false,
    busy: false,
    page: 1,
    pageSize: 10,
    expandedDepartments: [],
    selectedDepartmentIds: [],
    selectedUserIds: [],
    autoSelectMembers: true,
    includeChildren: true,
    transferVisible: false,
    transferTargetId: '',
    transferQuery: '',
    transferContacts: [],
    transferNextCursor: null,
    transferSearching: false,
    transferSearchTimer: null,
    transferSearchVersion: 0
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
    isRoom() {
      return this.resourceType === 'room'
    },
    isTeam() {
      return this.resourceType === 'team'
    },
    resourceItem() {
      if (this.isTeam) return this.team
      return this.isRoom ? this.room : this.folder
    },
    resourceId() {
      const item = this.resourceItem || {}
      if (this.isRoom) return item.roomKey || item.id || ''
      return item.id || ''
    },
    resourceName() {
      const item = this.resourceItem || {}
      return item.title || item.name || ''
    },
    resourceLabel() {
      if (this.isTeam) return '团队'
      return this.isRoom ? '脑图' : '文件夹'
    },
    resourceTitle() {
      return `${this.resourceLabel}权限`
    },
    resourceDescription() {
      if (this.isTeam) return '权限将应用于整个团队空间与成员协作'
      return this.isRoom
        ? '权限仅应用于当前脑图'
        : '权限将应用于文件夹内现有及后续脑图'
    },
    roleOptions() {
      if (this.isTeam) {
        return [
          { value: 'member', title: '成员', caption: '参与团队协作' },
          { value: 'admin', title: '管理员', caption: '管理成员与内容' }
        ]
      }
      const options = [
        { value: 'Viewer', title: '可查看', caption: '仅查看内容' },
        { value: 'Editor', title: '可编辑', caption: '查看并编辑' }
      ]
      if (!this.isRoom) {
        options.push({
          value: 'Manager',
          title: '可管理',
          caption: '管理成员权限'
        })
      }
      return options
    },
    memberRoleSelectOptions() {
      if (this.isTeam) {
        return [
          { value: 'member', label: '成员' },
          { value: 'admin', label: '管理员' }
        ]
      }
      const options = [
        { value: 'Viewer', label: '可查看' },
        { value: 'Editor', label: '可编辑' }
      ]
      if (!this.isRoom) options.push({ value: 'Manager', label: '可管理' })
      return options
    },
    defaultRole() {
      return this.isTeam ? 'member' : 'Viewer'
    },
    currentUserId() {
      const user = getCurrentUser() || {}
      return String(user.id || user.userId || '').trim()
    },
    filteredMembers() {
      const term = this.memberQuery.trim().toLowerCase()
      if (!term) return this.members
      return this.members.filter(member =>
        [
          member.name,
          member.id,
          member.userId,
          member.wecomUserId,
          member.department,
          member.email,
          member.position
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(term)
      )
    },
    pagedMembers() {
      const start = (this.page - 1) * this.pageSize
      return this.filteredMembers.slice(start, start + this.pageSize)
    },
    transferCandidates() {
      const term = this.transferQuery.trim().toLowerCase()
      const candidates = new Map()
      const owners = new Set(this.members.filter(member => this.isOwnerRole(member.role))
        .map(member => String(member.id || member.userId || '')))
      const source = this.isTeam ? this.members : [
        ...this.members,
        ...this.transferContacts.map(contact => ({ ...contact, transferContact: true }))
      ]
      source.forEach(member => {
        const id = String(member.id || member.userId || '')
        if (!id || owners.has(id) || this.isCurrentUserMember(member)) return
        if (term && ![member.name, id, member.wecomUserId].some(value =>
          String(value || '').toLowerCase().includes(term))) return
        if (!candidates.has(id)) candidates.set(id, { ...member, id })
      })
      return Array.from(candidates.values())
    },
    canTransferOwnership() {
      if (!this.currentUserId) return false
      return this.members.some(
        member =>
          this.isOwnerRole(member.role) && this.isCurrentUserMember(member)
      )
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
        const departments = this.childDepartmentMap[parentId] || []
        departments
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
            const contacts = this.contactsByDepartment[root.id] || []
            contacts.forEach(contact =>
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
    memberQuery() {
      this.page = 1
    },
    pageSize() {
      this.page = 1
    },
    filteredMembers() {
      const max = Math.max(
        1,
        Math.ceil(this.filteredMembers.length / this.pageSize) || 1
      )
      if (this.page > max) this.page = max
    },
    autoSelectMembers(value) {
      if (!value) return
      this.selectedDepartmentIds.forEach(id => {
        this.toggleDepartmentMembers(id, true)
      })
    },
    includeChildren() {
      this.selectedDepartmentIds.forEach(id => {
        if (this.areDepartmentMembersSelected(id) || this.autoSelectMembers) {
          this.toggleDepartmentMembers(id, true)
        }
      })
    }
  },
  beforeDestroy() {
    clearTimeout(this.searchTimer)
    clearTimeout(this.transferSearchTimer)
    this.transferSearchVersion += 1
  },
  methods: {
    async resetAndLoad() {
      this.query = ''
      this.memberQuery = ''
      this.page = 1
      this.clearSelection()
      this.contacts = []
      this.searchResults = []
      this.departmentTotals = {}
      this.loadedDepartmentIds = []
      this.loadingDepartmentIds = []
      this.departmentLoadTasks = {}
      this.expandedDepartments = []
      this.transferVisible = false
      this.transferTargetId = ''
      this.role = this.defaultRole
      this.loading = true
      try {
        const [departments] = await Promise.all([
          teamService.listDepartments(),
          this.loadMembers()
        ])
        this.departmentOptions = departments
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
      if (this.loadedDepartmentIds.includes(id)) return true
      if (this.departmentLoadTasks[id]) return this.departmentLoadTasks[id]
      this.loadingDepartmentIds = this.loadingDepartmentIds.concat(id)
      const task = (async () => {
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
          return true
        } catch (error) {
          this.$message.error(error.message || '加载部门成员失败')
          return false
        } finally {
          this.loadingDepartmentIds = this.loadingDepartmentIds.filter(
            item => item !== id
          )
        }
      })()
      this.$set(this.departmentLoadTasks, id, task)
      try {
        return await task
      } finally {
        this.$delete(this.departmentLoadTasks, id)
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
    async ensureDepartmentTreeLoaded(id) {
      const ids = this.descendantDepartmentIds(id)
      const results = await Promise.all(
        ids.map(departmentId => this.loadDepartmentContacts(departmentId))
      )
      return results.every(result => result !== false)
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
      const ids = this.memberIdsForDepartment(id)
      return (
        ids.length > 0 && ids.every(item => this.selectedUserIds.includes(item))
      )
    },
    async toggleDepartmentMembers(id, checked) {
      const loaded = await this.ensureDepartmentTreeLoaded(id)
      if (!loaded) return
      const ids = this.memberIdsForDepartment(id)
      if (checked && !ids.length) {
        this.$message.warning('该部门暂无可选成员')
        return
      }
      this.selectedUserIds = checked
        ? Array.from(new Set(this.selectedUserIds.concat(ids)))
        : this.selectedUserIds.filter(item => !ids.includes(item))
    },
    async toggleRow(row, checked) {
      if (row.type === 'department') {
        const departmentId = String(row.id)
        this.selectedDepartmentIds = checked
          ? Array.from(new Set(this.selectedDepartmentIds.concat(departmentId)))
          : this.selectedDepartmentIds.filter(id => id !== departmentId)
        if (this.autoSelectMembers) {
          await this.toggleDepartmentMembers(departmentId, checked)
        }
        return
      }
      const id = String(row.id)
      this.selectedUserIds = checked
        ? Array.from(new Set(this.selectedUserIds.concat(id)))
        : this.selectedUserIds.filter(item => item !== id)
    },
    isRowSelected(row) {
      return row.type === 'department'
        ? this.selectedDepartmentIds.includes(String(row.id))
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
        !this.selectedDepartmentIds.includes(String(id)) &&
        count > 0 &&
        count < ids.length
      )
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
    isOwnerRole(role) {
      return String(role || '').toLowerCase() === 'owner'
    },
    isCurrentUserMember(member) {
      const me = this.currentUserId
      if (!me || !member) return false
      return [member.id, member.userId, member.wecomUserId]
        .filter(Boolean)
        .map(String)
        .includes(me)
    },
    roleLabel(role) {
      return (
        {
          Viewer: '可查看',
          Editor: '可编辑',
          Manager: '可管理',
          member: '成员',
          admin: '管理员',
          owner: '所有者',
          Member: '成员',
          Admin: '管理员',
          Owner: '所有者'
        }[role] || (this.isTeam ? '成员' : '可查看')
      )
    },
    openTransferDialog(member) {
      this.transferQuery = ''
      this.transferContacts = []
      this.transferNextCursor = null
      this.transferSearchVersion += 1
      clearTimeout(this.transferSearchTimer)
      if (this.isTeam && !this.transferCandidates.length) {
        this.$message.warning('请先添加其他成员，再转移所有权')
        return
      }
      this.transferTargetId =
        member && !this.isOwnerRole(member.role)
          ? String(member.id || member.userId || '')
          : ''
      this.transferVisible = true
      if (!this.isTeam) this.loadTransferContacts()
    },
    searchTransferCandidates() {
      clearTimeout(this.transferSearchTimer)
      this.transferSearchVersion += 1
      this.transferContacts = []
      this.transferNextCursor = null
      this.transferSearching = false
      if (this.isTeam) return
      this.transferSearchTimer = setTimeout(() => this.loadTransferContacts(), 250)
    },
    async loadTransferContacts(append = false) {
      if (append && (!this.transferNextCursor || this.transferSearching)) return
      const version = ++this.transferSearchVersion
      const resourceId = this.resourceId
      this.transferSearching = true
      try {
        const result = await teamService.listContacts({
          search: this.transferQuery.trim(),
          limit: 100,
          offset: append ? Number(this.transferNextCursor) : 0
        })
        if (version !== this.transferSearchVersion || resourceId !== this.resourceId || !this.transferVisible) return
        this.transferContacts = append ? [...this.transferContacts, ...result.list] : result.list
        this.transferNextCursor = result.nextCursor
      } catch (error) {
        if (version === this.transferSearchVersion && this.transferVisible)
          this.$message.error(error.message || '搜索成员失败')
      } finally {
        if (version === this.transferSearchVersion) this.transferSearching = false
      }
    },
    async confirmTransferOwnership() {
      if (!this.transferTargetId) return
      this.busy = true
      try {
        if (this.isTeam) {
          this.members = await teamService.transferOwnership(
            this.resourceId,
            this.transferTargetId
          )
        } else if (this.isRoom) {
          this.members = await shareService.transferOwnership(
            this.resourceId,
            this.transferTargetId
          )
        } else {
          this.members = await folderService.transferOwnership(
            this.resourceId,
            this.transferTargetId
          )
        }
        this.transferVisible = false
        this.transferTargetId = ''
        this.$emit('changed')
        this.$message.success(`${this.resourceLabel}所有权已转移`)
      } catch (error) {
        this.$message.error(error.message || '转移所有权失败')
      } finally {
        this.busy = false
      }
    },
    async grantSelected() {
      this.busy = true
      try {
        if (this.isTeam) await this.grantTeamSelection()
        else if (this.isRoom) await this.grantRoomSelection()
        else await this.grantFolderSelection()
        await this.loadMembers()
        this.clearSelection()
        this.$emit('changed')
        this.$message.success(`${this.resourceLabel}权限已更新`)
      } catch (error) {
        try {
          await this.loadMembers()
        } catch (_) {
          // Keep the original authorization error as the actionable message.
        }
        this.$message.error(error.message || '授权失败，请稍后重试')
      } finally {
        this.busy = false
      }
    },
    async grantFolderSelection() {
      await folderService.bulkSetMembers(this.resourceId, {
        departmentIds: this.selectedDepartmentIds,
        userIds: this.selectedUserIds,
        includeChildren: this.includeChildren,
        role: this.role.toLowerCase()
      })
    },
    async grantRoomSelection() {
      const departmentIds = Array.from(
        new Set(
          this.selectedDepartmentIds.reduce(
            (all, id) => all.concat(this.descendantDepartmentIds(id)),
            []
          )
        )
      )
      const loadResults = await Promise.all(
        departmentIds.map(id => this.loadDepartmentContacts(id))
      )
      if (loadResults.some(result => result === false))
        throw new Error('部分部门成员加载失败，请重试后再授权')

      const departmentUsers = this.selectedDepartmentIds.reduce(
        (all, id) => all.concat(this.memberIdsForDepartment(id)),
        []
      )
      const ownerIds = new Set(
        this.members
          .filter(member => String(member.role).toLowerCase() === 'owner')
          .map(member => String(member.id || member.userId))
      )
      const selectedIds = Array.from(
        new Set(this.selectedUserIds.concat(departmentUsers).map(String))
      )
      const userIds = selectedIds.filter(id => !ownerIds.has(id))
      if (!userIds.length) {
        if (selectedIds.length)
          throw new Error('所选成员已拥有所有者权限，无需重复授权')
        throw new Error('所选部门暂无可授权成员')
      }
      for (let index = 0; index < userIds.length; index += 5)
        await Promise.all(
          userIds
            .slice(index, index + 5)
            .map(id =>
              shareService.addMember(this.resourceId, id, this.role)
            )
        )
    },
    async grantTeamSelection() {
      const departmentIds = Array.from(
        new Set(
          this.selectedDepartmentIds.reduce(
            (all, id) => all.concat(this.descendantDepartmentIds(id)),
            []
          )
        )
      )
      const loadResults = await Promise.all(
        departmentIds.map(id => this.loadDepartmentContacts(id))
      )
      if (loadResults.some(result => result === false))
        throw new Error('部分部门成员加载失败，请重试后再授权')

      const departmentUsers = this.selectedDepartmentIds.reduce(
        (all, id) => all.concat(this.memberIdsForDepartment(id)),
        []
      )
      const ownerIds = new Set(
        this.members
          .filter(member => this.isOwnerRole(member.role || member.teamRole))
          .map(member =>
            String(member.wecomUserId || member.userId || member.id)
          )
      )
      const selectedIds = Array.from(
        new Set(this.selectedUserIds.concat(departmentUsers).map(String))
      )
      const userIds = selectedIds.filter(id => !ownerIds.has(id))
      if (!userIds.length) {
        if (selectedIds.length)
          throw new Error('所选成员已是团队所有者，无需重复授权')
        throw new Error('所选部门暂无可授权成员')
      }

      const existingByWecom = new Map(
        this.members.map(member => [
          String(member.wecomUserId || member.userId || member.id),
          member
        ])
      )
      const toAdd = userIds.filter(id => !existingByWecom.has(id))
      if (toAdd.length) await teamService.addMembers(this.resourceId, toAdd)

      if (this.role === 'admin') {
        await this.loadMembers()
        const refreshed = new Map(
          this.members.map(member => [
            String(member.wecomUserId || member.userId || member.id),
            member
          ])
        )
        for (const id of userIds) {
          const member = refreshed.get(id)
          if (!member || this.isOwnerRole(member.role || member.teamRole))
            continue
          if (String(member.role || member.teamRole).toLowerCase() === 'admin')
            continue
          await teamService.updateMemberRole(
            this.resourceId,
            member.id,
            'admin'
          )
        }
      }
    },
    async loadMembers() {
      if (this.isTeam) {
        this.members = await teamService.listMembers(this.resourceId)
        return
      }
      if (this.isRoom) {
        this.members = await shareService.getMembers(this.resourceId)
        return
      }
      const result = await folderService.getMembers(this.resourceId)
      const list = (result.list || []).slice()
      const owner = (this.folder && (this.folder.owner || this.folder.createdBy)) || {}
      const ownerId = String(
        owner.id || owner.userId || (this.folder && this.folder.createdById) || ''
      )
      if (
        ownerId &&
        !list.some(member => String(member.id || member.userId) === ownerId)
      ) {
        list.unshift({
          id: ownerId,
          userId: ownerId,
          name: owner.name || ownerId,
          avatar: owner.avatar || '',
          role: 'Owner',
          department: '所有者'
        })
      }
      this.members = list
    },
    async run(action) {
      this.busy = true
      try {
        await action()
        await this.loadMembers()
        this.$emit('changed')
        this.$message.success(`${this.resourceLabel}权限已更新`)
      } catch (error) {
        this.$message.error(error.message || '更新权限失败')
      } finally {
        this.busy = false
      }
    },
    updateRole(member, role) {
      return this.run(() => {
        if (this.isTeam)
          return teamService.updateMemberRole(
            this.resourceId,
            member.id,
            role
          )
        return this.isRoom
          ? shareService.updateMemberRole(this.resourceId, member.id, role)
          : folderService.updateMember(this.resourceId, member.id, role)
      })
    },
    remove(member) {
      return this.run(() => {
        if (this.isTeam)
          return teamService.removeMember(this.resourceId, member.id)
        return this.isRoom
          ? shareService.removeMember(this.resourceId, member.id)
          : folderService.removeMember(this.resourceId, member.id)
      })
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
.resourceIcon {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: #e8f4ef;
  color: #087854;
  display: grid;
  place-items: center;
  font-size: 18px;
}
.resourceIcon.room {
  background: #edf2fb;
  color: #3567a8;
}
.resourceIcon.team {
  background: #eef6f1;
  color: #0c9065;
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
.existingMeta {
  display: flex;
  align-items: center;
  gap: 8px;
}
.memberCount {
  color: #7b8982;
  font-size: 12px;
}
.memberPageSize {
  width: 76px;
}
.memberPageSize /deep/ .el-input__inner {
  height: 24px;
  padding: 0 20px 0 7px;
  color: #60706b;
  font-size: 12px;
  line-height: 24px;
}
.memberPageSize /deep/ .el-input__suffix {
  right: 3px;
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
.existingSearch {
  margin: 8px 0 0;
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
.transferBtn,
.removeBtn {
  border: 0;
  background: transparent;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.transferBtn {
  color: #087854;
}
.transferBtn:hover {
  color: #066646;
}
.removeBtn {
  color: #9a514b;
}
.ownerBadge {
  color: #7b8982;
  font-size: 11px;
  white-space: nowrap;
}
.ownerRoleLabel {
  width: 86px;
  color: #334b41;
  font-size: 12px;
  font-weight: 500;
}
.transferHint {
  margin: 0 0 14px;
  color: #52665f;
  font-size: 13px;
  line-height: 1.5;
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
