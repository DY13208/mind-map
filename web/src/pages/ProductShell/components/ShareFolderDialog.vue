<template>
  <component
    :is="embedded ? 'section' : 'el-dialog'"
    :class="{ permissionEmbedded: embedded, permissionReadOnly: readOnly }"
    :visible.sync="shown"
    custom-class="folderPermissionDialog"
    width="1080px"
    :close-on-click-modal="false"
    :show-close="false"
  >
    <div v-loading="loading || busy" :class="['permissionDialogBody', 'mobilePermission-' + mobilePermissionView]">
      <header class="permissionHeader">
        <div :class="['resourceIcon', { room: isRoom, team: isTeam }]">
          <i
            :class="
              adapter && adapter.icon
                ? adapter.icon
                : isTeam
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
          v-if="!embedded"
          class="closeBtn"
          type="button"
          aria-label="关闭"
          @click="shown = false"
        >
          ×
        </button>
      </header>
      <nav class="mobilePermissionTabs" aria-label="权限工作视图">
        <button :class="{ active: mobilePermissionView === 'existing' }" @click="mobilePermissionView = 'existing'">已有权限</button>
        <button v-if="!readOnly" :class="{ active: mobilePermissionView === 'add' }" @click="mobilePermissionView = 'add'">添加授权 · {{ selectionCount }}</button>
      </nav>
      <div class="permissionWorkspace">
        <section v-if="!readOnly" class="organizationPane" aria-label="组织成员选择">
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
              :class="['treeRow', row.type, { selected: isRowSelected(row), authorized: !!rowPermission(row) }]"
              :style="{ paddingLeft: `${isMobileViewport ? Math.min(10 + row.level * 14, 66) : 10 + row.level * 18}px` }"
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
                :disabled="row.type === 'member' && isOwnerMember(row.contact)"
                :aria-label="`选择${row.name}`"
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
              <button
                v-if="rowPermission(row)"
                type="button"
                :class="['permissionBadge', rowPermission(row).tone]"
                :aria-label="`${row.name}已有权限：${rowPermission(row).label}`"
                @click="inspectRowPermission(row)"
              ><i class="el-icon-check" />{{ rowPermission(row).label }}</button>
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
          <div class="treeLegend"><span><i class="el-icon-check" /> 徽标表示已有权限</span><span>勾选表示本次授权对象</span></div>
        </section>
        <aside class="permissionDetailPane" aria-label="授权设置与预览">
          <section v-if="!readOnly" class="detailSection selectedSection">
            <div class="detailTitle">
              <h3>已选对象 <span class="selectionCount">{{ selectionCount }}</span></h3>
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
              <i class="el-icon-user" /><span>选择部门或成员后，在此确认本次授权对象</span>
            </div>
          </section>
          <section v-if="!readOnly" class="detailSection">
            <h3>{{ isRoom ? '本次单独授权' : '本次授权的目标权限' }}</h3>
            <el-radio-group v-model="role" class="roleOptions">
              <el-radio-button
                v-for="option in roleOptions"
                :key="option.value"
                :label="option.value"
                :disabled="option.disabled"
                ><strong>{{ option.title }}</strong
                ><small>{{ option.caption }}</small></el-radio-button
              >
            </el-radio-group>
          </section>
          <section v-if="!readOnly" class="detailSection previewSection">
            <h3>授权范围</h3>
            <div class="applicationSettings">
              <el-checkbox v-model="autoSelectMembers"
                >勾选部门时自动选中全部成员</el-checkbox
              ><el-checkbox v-model="includeChildren"
                >部门授权包含下属部门</el-checkbox
              ><el-tooltip
                v-if="adapter"
                content="暂不可用：文件知识库尚未支持按部门或团队整体授权，保存时按所选成员逐人授权，部门后续新成员不会自动获得权限"
                placement="top"
                ><span class="adapterDisabledOption"
                  ><el-checkbox :value="false" disabled
                    >按部门/团队整体授权（暂不可用）</el-checkbox
                  ></span
                ></el-tooltip
              >
            </div>
            <div class="previewBox">
              <i class="el-icon-circle-check" />
              <p v-if="selectionCount">
                <strong>{{ selectionSummary }}</strong
                ><span>将设为「{{ roleLabel(role) }}」 · {{ pendingChangeSummary }}</span>
              </p>
              <p v-else>
                <strong>尚未选择授权对象</strong
                ><span>选择后可在此确认影响范围</span>
              </p>
            </div>
          </section>
          <section ref="existingSection" class="detailSection existingSection">
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
            <div class="permissionFilters" role="tablist" aria-label="按权限筛选">
              <button v-for="filter in roleFilters" :key="filter.value" type="button"
                role="tab" :aria-selected="roleFilter === filter.value"
                :class="['permissionFilter', { active: roleFilter === filter.value }]"
                @click="roleFilter = filter.value"
              >{{ filter.label }} <span>{{ filter.count }}</span></button>
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
                <span>对象</span><span>{{ isRoom ? '单独设置' : '权限' }}</span><span>操作</span>
              </div>
              <div
                v-for="member in pagedMembers"
                :key="member.id"
                class="existingRow"
              >
                <span class="memberAvatar small">{{ avatarText(member) }}</span
                ><span class="existingIdentity"
                  ><strong>{{ member.name || member.id }}</strong
                  ><small>{{ member.department || '成员' }}<template v-if="memberSourceLabel(member)"> · {{ memberSourceLabel(member) }}</template></small></span
                ><span
                  v-if="isOwnerRole(member.role) || readOnly || (adapter && member.inheritedOnly)"
                  class="ownerRoleLabel"
                  >{{ roleLabel(member.role) }}</span
                ><button v-else-if="isMobileViewport" type="button" class="mobileMemberRole" :aria-label="`修改${member.name || member.id}的权限`" @click="mobileRoleMember = member">{{ roleLabel(editableMemberRole(member)) || '跟随继承' }} <i class="el-icon-arrow-down" /></button><el-select
                  v-else
                  size="mini"
                  :class="['memberRoleSelect', String(member.role).toLowerCase()]"
                  :value="editableMemberRole(member)"
                  :aria-label="`修改${member.name || member.id}的权限`"
                  @change="updateRole(member, $event)"
                  ><el-option
                    v-for="option in memberRoleSelectOptions"
                    :key="option.value"
                    :label="option.label"
                    :value="option.value" :disabled="option.disabled"/></el-select
                ><template v-if="isOwnerRole(member.role)">
                  <button
                    v-if="!readOnly && canTransferOwnership"
                    class="transferBtn"
                    type="button"
                    @click="openTransferDialog(member)"
                  >
                    转移所有权
                  </button>
                  <span v-else class="ownerBadge">所有者</span>
                </template>
                <button
                  v-else-if="!readOnly"
                  class="removeBtn"
                  :disabled="isInheritedOnly(member)"
                  :title="isInheritedOnly(member) ? '该成员的权限来自文件夹或团队继承，请到来源处调整' : '移除单独授权，之后按继承权限生效'"
                  :aria-label="`移除${member.name || member.id}的单独授权`"
                  type="button"
                  @click="remove(member)"
                >
                  移除单独授权
                </button>
              </div>
              <p v-if="!filteredMembers.length && !loading" class="existingEmpty">
                {{
                  memberQuery || roleFilter
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
    <el-drawer :visible="!!mobileRoleMember" direction="btt" size="auto" :with-header="false" append-to-body custom-class="mobileActionSheet" @close="mobileRoleMember = null">
      <header><strong>{{ mobileRoleMember && mobileRoleMember.name }} · 权限</strong><button aria-label="关闭权限选项" @click="mobileRoleMember = null"><i class="el-icon-close" /></button></header>
      <div class="mobileActionGrid"><button v-for="option in memberRoleSelectOptions" :key="option.value" :disabled="option.disabled || busy" @click="updateRole(mobileRoleMember, option.value); mobileRoleMember = null">{{ option.label }}</button></div>
    </el-drawer>
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
    <span v-if="!readOnly" slot="footer" class="permissionFooter"
      ><span class="footerHint"
        ><i class="el-icon-success" /> {{ loadFailed ? '加载失败，请关闭后重试' : isFolderManager ? '可管理人员可新增可查看、可编辑；可管理仍仅限所有者' : '勾选授权保存后生效；列表修改即时生效' }}</span
      ><span
        ><el-button v-if="!embedded" @click="shown = false">取消</el-button
        ><el-button
          type="primary"
          :disabled="!selectionCount || loadFailed"
          :loading="busy"
          @click="grantSelected"
          >{{ busy ? '正在保存授权…' : '保存授权' }}</el-button
        ></span
      ></span
    >
  </component>
</template>

<script>
import folderService from '@/services/folderService'
import mobileViewport from '@/utils/mobileViewport'
import shareService from '@/services/shareService'
import teamService from '@/services/teamService'
import { getCurrentUser } from '@/utils/auth'
export default {
  name: 'ShareFolderDialog',
  mixins: [mobileViewport],
  props: {
    visible: Boolean,
    embedded: Boolean,
    readOnly: Boolean,
    folder: Object,
    room: Object,
    team: Object,
    resourceType: {
      type: String,
      default: 'folder',
      validator: value => ['folder', 'room', 'team'].includes(value)
    },
    // Optional data adapter for non-mind-map resources (File KB). null keeps the
    // folder/room/team service calls exactly as before.
    adapter: {
      type: Object,
      default: null
    }
  },
  data: () => ({
    mobilePermissionView: 'existing',
    mobileRoleMember: null,
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
    role: 'Manager',
    roleFilter: '',
    loadVersion: 0,
    loadFailed: false,
    loading: false,
    busy: false,
    page: 1,
    pageSize: 10,
    expandedDepartments: [],
    selectedDepartmentIds: [],
    selectedUserIds: [],
    explicitUserIds: [],
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
      if (this.adapter) return this.adapter.label || '资源'
      if (this.isTeam) return '团队'
      return this.isRoom ? '脑图' : '文件夹'
    },
    resourceTitle() {
      return `${this.resourceLabel}权限`
    },
    resourceDescription() {
      if (this.adapter) return this.adapter.description || ''
      if (this.isTeam) return '权限将应用于整个团队空间与成员协作'
      return this.isRoom
        ? '修改当前脑图的成员设置；单独设置优先于文件夹和团队继承'
        : '权限应用于直属现有及后续脑图；子文件夹需要单独授权'
    },
    roleOptions() {
      if (this.adapter) return this.adapter.roleOptions
      if (this.isTeam) {
        return [
          { value: 'member', title: '成员', caption: '参与团队协作' },
          { value: 'admin', title: '管理员', caption: '管理成员与内容' }
        ]
      }
      return [
        { value: 'Viewer', title: '可查看', caption: '仅查看内容' },
        { value: 'Editor', title: '可编辑', caption: '查看并编辑' },
        { value: 'Manager', title: '可管理', caption: '管理成员权限', disabled: this.isFolderManager }
      ]
    },
    memberRoleSelectOptions() {
      if (this.isRoom) {
        return [
          { value: 'Inherit', label: '跟随继承' },
          ...this.roleOptions.map(option => ({ ...option, label: option.title }))
        ]
      }
      return this.roleOptions.map(option => ({ ...option, label: option.title }))
    },
    defaultRole() {
      if (this.adapter) return this.adapter.defaultRole || 'Viewer'
      return this.isTeam ? 'member' : this.isFolderManager ? 'Editor' : 'Manager'
    },
    isFolderManager() {
      return !this.adapter && !this.isRoom && !this.isTeam && this.members.some(member =>
        this.isCurrentUserMember(member) && String(member.role).toLowerCase() === 'manager') && !this.canTransferOwnership
    },
    memberByIdentity() {
      const map = new Map()
      this.members.forEach(member => {
        this.identityKeys(member).forEach(key => map.set(key, member))
      })
      return map
    },
    roleFilters() {
      const filters = this.isTeam
        ? [{ value: 'member', label: '成员' }, { value: 'admin', label: '管理员' }]
        : [{ value: 'viewer', label: '可查看' }, { value: 'editor', label: '可编辑' }, { value: 'manager', label: '可管理' }]
      return [{ value: '', label: '全部', count: this.members.length },
        ...filters.concat({ value: 'owner', label: '所有者' }).map(filter => ({
          ...filter, count: this.members.filter(member => String(member.role).toLowerCase() === filter.value).length
        }))]
    },
    selectedMemberChanges() {
      const ids = new Set(this.selectedUserIds)
      this.selectedDepartmentIds.forEach(id => this.memberIdsForDepartment(id).forEach(userId => ids.add(userId)))
      return Array.from(ids).map(id => ({ id, member: this.memberByIdentity.get(id) }))
        .filter(item => !item.member || !this.isOwnerRole(item.member.role))
    },
    selectionFullyLoaded() {
      return this.selectedDepartmentIds.every(id => this.descendantDepartmentIds(id).every(departmentId =>
        this.loadedDepartmentIds.includes(departmentId) &&
        (this.contactsByDepartment[departmentId] || []).length >= (this.departmentTotals[departmentId] || 0)
      ))
    },
    pendingChangeSummary() {
      const changes = this.selectedMemberChanges
      const changed = changes.filter(item => this.needsRoleChange(item.member))
      const existing = changed.filter(item => item.member).length
      const unchanged = changes.length - changed.length
      return `${changed.length - existing} 人新增、${existing} 人调整${unchanged ? `，${unchanged} 人无变更` : ''}${this.selectedDepartmentIds.length ? '（部门范围以保存时为准）' : ''}`
    },
    currentUserId() {
      const user = getCurrentUser() || {}
      return String(user.id || user.userId || '').trim()
    },
    filteredMembers() {
      const term = this.memberQuery.trim().toLowerCase()
      const members = this.members.filter(member => !this.roleFilter || String(member.role).toLowerCase() === this.roleFilter)
      if (!term) return members
      return members.filter(member =>
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
      this.mobileRoleMember = null
      this.mobilePermissionView = 'existing'
      if (value) this.resetAndLoad()
      else { this.loadVersion += 1; clearTimeout(this.searchTimer) }
    },
    resourceId() {
      if (this.visible) this.resetAndLoad()
    },
    resourceType() {
      if (this.visible) this.resetAndLoad()
    },
    roleFilter() { this.page = 1 },
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
    includeChildren(value, previous) {
      this.syncDepartmentScope(previous)
    }
  },
  beforeDestroy() {
    clearTimeout(this.searchTimer)
    clearTimeout(this.transferSearchTimer)
    this.transferSearchVersion += 1
    this.loadVersion += 1
  },
  mounted() {
    if (this.visible) this.resetAndLoad()
  },
  methods: {
    async resetAndLoad() {
      const version = ++this.loadVersion
      this.loadFailed = false
      this.members = []
      this.departmentOptions = []
      this.roleFilter = ''
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
          this.readOnly ? Promise.resolve([]) : teamService.listDepartments(),
          this.loadMembers()
        ])
        if (version !== this.loadVersion) return
        this.departmentOptions = departments
        this.role = this.defaultRole
      } catch (error) {
        if (version !== this.loadVersion) return
        this.loadFailed = true
        this.$message.error(error.message || '加载权限数据失败')
      } finally {
        if (version === this.loadVersion) this.loading = false
      }
    },
    cacheContacts(items) {
      const map = new Map(
        this.contacts.map(item => [String(item.userId || item.id), item])
      )
      items.forEach(item => map.set(String(item.userId || item.id), item))
      this.contacts = Array.from(map.values())
      if (this.adapter && typeof this.adapter.noteContacts === 'function') this.adapter.noteContacts(items)
    },
    async loadDepartmentContacts(id) {
      id = String(id)
      const version = this.loadVersion
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
          if (version !== this.loadVersion) return false
          this.cacheContacts(items)
          this.$set(this.departmentTotals, id, total)
          this.loadedDepartmentIds = this.loadedDepartmentIds.concat(id)
          return true
        } catch (error) {
          if (version === this.loadVersion) this.$message.error(error.message || '加载部门成员失败')
          return false
        } finally {
          if (version === this.loadVersion) this.loadingDepartmentIds = this.loadingDepartmentIds.filter(
            item => item !== id
          )
        }
      })()
      this.$set(this.departmentLoadTasks, id, task)
      try {
        return await task
      } finally {
        if (version === this.loadVersion) this.$delete(this.departmentLoadTasks, id)
      }
    },
    searchContacts() {
      clearTimeout(this.searchTimer)
      const term = this.query.trim()
      const version = this.loadVersion
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
          if (version === this.loadVersion && this.query.trim() === term) {
            this.searchResults = result.list
            this.cacheContacts(result.list)
          }
        } catch (error) {
          if (version === this.loadVersion && this.query.trim() === term)
            this.$message.error(error.message || '搜索成员失败')
        } finally {
          if (version === this.loadVersion && this.query.trim() === term) this.searching = false
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
    descendantDepartmentIds(id, includeChildren = this.includeChildren) {
      const ids = [String(id)]
      if (!includeChildren) return ids
      for (let index = 0; index < ids.length; index += 1)
        (this.childDepartmentMap[ids[index]] || []).forEach(item => {
          if (!ids.includes(item.id)) ids.push(item.id)
        })
      return ids
    },
    async syncDepartmentScope(previous) {
      const version = this.loadVersion
      const departments = this.selectedDepartmentIds.slice()
      const oldDepartments = new Set(departments.reduce((ids, id) =>
        ids.concat(this.descendantDepartmentIds(id, previous)), []))
      const previousAutoUsers = this.contacts.filter(contact =>
        (contact.departmentIds || [contact.departmentId]).map(String).some(id => oldDepartments.has(id))
      ).map(contact => String(contact.userId || contact.id))
      const shouldSelect = this.autoSelectMembers || (previousAutoUsers.length > 0 &&
        previousAutoUsers.every(id => this.selectedUserIds.includes(id)))
      if (!shouldSelect) return
      const loaded = await Promise.all(departments.map(id => this.ensureDepartmentTreeLoaded(id)))
      if (version !== this.loadVersion || loaded.some(result => !result)) return
      const nextAutoUsers = departments.reduce((ids, id) => ids.concat(this.memberIdsForDepartment(id)), [])
      this.selectedUserIds = Array.from(new Set(this.selectedUserIds.filter(id =>
        !previousAutoUsers.includes(id) || this.explicitUserIds.includes(id)
      ).concat(nextAutoUsers)))
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
        .filter(contact => !this.isOwnerMember(contact))
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
      const version = this.loadVersion
      const loaded = await this.ensureDepartmentTreeLoaded(id)
      if (!loaded || version !== this.loadVersion) return
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
      if (this.isOwnerMember(row.contact)) return
      const id = String(row.id)
      this.explicitUserIds = checked
        ? Array.from(new Set(this.explicitUserIds.concat(id)))
        : this.explicitUserIds.filter(item => item !== id)
      // A member exclusion turns a department selection into explicit members,
      // otherwise the department payload would silently grant that member again.
      if (!checked) this.selectedDepartmentIds = this.selectedDepartmentIds.filter(
        departmentId => !this.memberIdsForDepartment(departmentId).includes(id)
      )
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
      this.explicitUserIds = []
    },
    removeSelection(item) {
      if (item.type === 'department')
        this.toggleRow({ type: 'department', id: item.id }, false)
      else
        this.toggleRow({ type: 'member', id: item.id, contact: this.contacts.find(contact => String(contact.userId || contact.id) === item.id) }, false)
    },
    identityKeys(item) {
      return [item && item.id, item && item.userId, item && item.wecomUserId].filter(Boolean).map(String)
    },
    existingMember(contact) {
      return this.identityKeys(contact).map(id => this.memberByIdentity.get(id)).find(Boolean)
    },
    isOwnerMember(contact) {
      const member = this.existingMember(contact)
      return member && this.isOwnerRole(member.role)
    },
    rowPermission(row) {
      if (row.type === 'member') {
        const member = this.existingMember(row.contact)
        return member ? { label: this.roleLabel(member.role), tone: String(member.role).toLowerCase() } : null
      }
      const allContacts = this.contactsByDepartment[row.id] || []
      const contacts = allContacts.filter(contact => !this.isOwnerMember(contact))
      const authorized = contacts.map(contact => this.existingMember(contact)).filter(Boolean)
      if (!authorized.length) return null
      const roles = new Set(authorized.map(member => String(member.role).toLowerCase()))
      // Department grants are expanded into member grants by the server. Never
      // present a partially loaded department as if it had its own ACL record.
      const complete = this.loadedDepartmentIds.includes(String(row.id)) && allContacts.length >= (this.departmentTotals[row.id] || 0)
      return complete && authorized.length === contacts.length && roles.size === 1
        ? { label: `全员${this.roleLabel(authorized[0].role)}`, tone: Array.from(roles)[0] }
        : { label: `${roles.size > 1 ? '混合权限 · ' : ''}${authorized.length} 人已授权`, tone: 'mixed' }
    },
    inspectRowPermission(row) {
      this.mobilePermissionView = 'existing'
      this.memberQuery = row.type === 'member' ? row.name : ''
      this.roleFilter = ''
      this.$nextTick(() => this.$refs.existingSection.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
    },
    roleSelectValue(raw) {
      const value = String(raw || '').trim().toLowerCase()
      if (!value) return ''
      if (value === 'viewer') return 'Viewer'
      if (value === 'editor') return 'Editor'
      if (value === 'manager') return 'Manager'
      if (value === 'owner') return 'Owner'
      return ''
    },
    editableMemberRole(member) {
      if (this.isRoom) {
        // Per-file setting first (override model), then the legacy direct grant.
        const current = member.aclV2 ? member.overrideRole : member.directRole
        return this.roleSelectValue(current) || 'Inherit'
      }
      const role = member.role
      const option = this.roleOptions.find(item => String(item.value).toLowerCase() === String(role).toLowerCase())
      return option ? option.value : role
    },
    isInheritedOnly(member) {
      if (this.adapter) return !!(member && member.inheritedOnly)
      if (!this.isRoom) return false
      const hasPerFileSetting = member.aclV2 ? !!member.overrideRole : !!member.directRole
      return !hasPerFileSetting && !!(member.folderRole || member.teamRole)
    },
    inheritedSourceLabel(member) {
      if (member.folderRole) return '文件夹继承'
      if (member.teamRole) return '团队继承'
      return ''
    },
    memberSourceLabel(member) {
      if (this.adapter) return (member && member.sourceLabel) || ''
      if (!this.isRoom) return ''
      const parts = []
      const actual = String(member.role || '').toLowerCase()
      if (actual && actual !== 'owner') parts.push(`实际${this.roleLabel(member.role)}`)
      if (member.aclV2) {
        if (member.overrideRole) {
          const inherited = this.inheritedSourceLabel(member)
          parts.push(inherited ? `本图单独设置，覆盖${inherited}` : '本图单独设置')
        } else {
          parts.push(this.inheritedSourceLabel(member) || '无有效来源')
        }
      } else if (member.directRole) {
        const inherited = this.inheritedSourceLabel(member)
        parts.push(inherited ? `历史直接授权，与${inherited}取较高权限` : '历史直接授权')
      } else {
        parts.push(this.inheritedSourceLabel(member) || '无有效来源')
      }
      return parts.filter(Boolean).join(' · ')
    },
    needsRoleChange(member) {
      if (!member) return true
      if (this.isOwnerRole(member.role)) return false
      if (this.isTeam && this.role === 'member') return false
      const existing = this.isRoom ? this.editableMemberRole(member) : member.role
      return String(existing || '').toLowerCase() !== String(this.role).toLowerCase()
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
          Owner: '所有者',
          viewer: '可查看', editor: '可编辑', manager: '可管理'
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
      if (this.readOnly || !this.transferTargetId) return
      const version = this.loadVersion
      const resourceId = this.resourceId
      this.busy = true
      try {
        let members
        if (this.adapter) {
          members = await this.adapter.transferOwnership(this.transferTargetId)
        } else if (this.isTeam) {
          members = await teamService.transferOwnership(
            resourceId,
            this.transferTargetId
          )
        } else if (this.isRoom) {
          members = await shareService.transferOwnership(
            resourceId,
            this.transferTargetId
          )
        } else {
          members = await folderService.transferOwnership(
            resourceId,
            this.transferTargetId
          )
        }
        if (version !== this.loadVersion) return
        this.members = members
        this.transferVisible = false
        this.transferTargetId = ''
        this.$emit('changed')
        this.$message.success(`${this.resourceLabel}所有权已转移`)
      } catch (error) {
        if (version === this.loadVersion) this.$message.error(error.message || '转移所有权失败')
      } finally {
        this.busy = false
      }
    },
    async grantSelected() {
      if (this.readOnly || this.busy || this.loading || this.loadFailed || !this.selectionCount) return
      if (this.selectionFullyLoaded && !this.selectedMemberChanges.some(item => this.needsRoleChange(item.member))) {
        this.$message.info('所选成员权限未变化，无需保存')
        return
      }
      const version = this.loadVersion
      this.busy = true
      try {
        let result
        if (this.adapter) result = await this.grantAdapterSelection()
        else if (this.isTeam) result = await this.grantTeamSelection()
        else if (this.isRoom) result = await this.grantRoomSelection()
        else result = await this.grantFolderSelection()
        if (version !== this.loadVersion) return
        await this.loadMembers()
        if (version !== this.loadVersion) return
        this.clearSelection()
        this.$emit('changed')
        if (result && result.changed === 0) this.$message.info('所选成员权限已一致，无需变更')
        else this.$message.success(`${this.resourceLabel}权限已更新`)
      } catch (error) {
        if (version !== this.loadVersion) return
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
      return folderService.bulkSetMembers(this.resourceId, {
        departmentIds: this.selectedDepartmentIds,
        userIds: this.selectedUserIds.filter(id => this.needsRoleChange(this.memberByIdentity.get(id))),
        includeChildren: this.includeChildren,
        role: this.role.toLowerCase(),
        onlyChanges: true
      }, { includeSummary: true })
    },
    // Same expansion as rooms: departments become per-user grants through the adapter.
    async grantAdapterSelection() {
      const version = this.loadVersion
      const role = this.role
      const departmentIds = Array.from(new Set(this.selectedDepartmentIds.reduce(
        (all, id) => all.concat(this.descendantDepartmentIds(id)), [])))
      const loadResults = await Promise.all(departmentIds.map(id => this.loadDepartmentContacts(id)))
      if (loadResults.some(result => result === false)) throw new Error('部分部门成员加载失败，请重试后再授权')
      if (version !== this.loadVersion) throw new Error('授权对象已切换，请重新选择')
      const departmentUsers = this.selectedDepartmentIds.reduce(
        (all, id) => all.concat(this.memberIdsForDepartment(id)), [])
      const ownerIds = new Set(this.members.filter(member => this.isOwnerRole(member.role))
        .map(member => String(member.id || member.userId)))
      const selectedIds = Array.from(new Set(this.selectedUserIds.concat(departmentUsers).map(String)))
      const userIds = selectedIds.filter(id => !ownerIds.has(id) && this.needsRoleChange(this.memberByIdentity.get(id)))
      if (!userIds.length) {
        if (selectedIds.length) return { changed: 0 }
        throw new Error('所选部门暂无可授权成员')
      }
      for (let index = 0; index < userIds.length; index += 5) {
        if (version !== this.loadVersion) throw new Error('授权对象已切换，请重新选择')
        await Promise.all(userIds.slice(index, index + 5).map(id => this.adapter.grant(id, role)))
      }
      return { changed: userIds.length }
    },
    async grantRoomSelection() {
      const resourceId = this.resourceId
      const version = this.loadVersion
      const role = this.role
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
      if (version !== this.loadVersion) throw new Error('授权对象已切换，请重新选择')

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
      const userIds = selectedIds.filter(id => !ownerIds.has(id) && this.needsRoleChange(this.memberByIdentity.get(id)))
      if (!userIds.length) {
        if (selectedIds.length) return { changed: 0 }
        throw new Error('所选部门暂无可授权成员')
      }
      for (let index = 0; index < userIds.length; index += 5) {
        if (version !== this.loadVersion) throw new Error('授权对象已切换，请重新选择')
        await Promise.all(
          userIds
            .slice(index, index + 5)
            .map(id =>
              shareService.addMember(resourceId, id, role)
            )
        )
      }
      return { changed: userIds.length }
    },
    async grantTeamSelection() {
      const version = this.loadVersion
      const resourceId = this.resourceId
      const role = this.role
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
      if (version !== this.loadVersion) throw new Error('授权对象已切换，请重新选择')

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
      if (toAdd.length) await teamService.addMembers(resourceId, toAdd)

      if (role === 'admin') {
        if (version !== this.loadVersion) return
        await this.loadMembers()
        const refreshed = new Map(
          this.members.map(member => [
            String(member.wecomUserId || member.userId || member.id),
            member
          ])
        )
        for (const id of userIds) {
          if (version !== this.loadVersion) return
          const member = refreshed.get(id)
          if (!member || this.isOwnerRole(member.role || member.teamRole))
            continue
          if (String(member.role || member.teamRole).toLowerCase() === 'admin')
            continue
          await teamService.updateMemberRole(
            resourceId,
            member.id,
            'admin'
          )
        }
      }
    },
    async loadMembers() {
      const version = this.loadVersion
      const resourceId = this.resourceId
      const folder = this.folder
      let list
      if (this.adapter) list = await this.adapter.listMembers()
      else if (this.isTeam) list = await teamService.listMembers(resourceId)
      else if (this.isRoom) list = await shareService.getMembers(resourceId)
      else {
        const result = await folderService.getMembers(resourceId)
        list = (result.list || []).slice()
        const owner = (folder && (folder.owner || folder.createdBy)) || {}
        const ownerId = String(owner.id || owner.userId || (folder && folder.createdById) || '')
        if (ownerId && !list.some(member => this.identityKeys(member).includes(ownerId))) {
          list.unshift({ id: ownerId, userId: ownerId, name: owner.name || ownerId, role: 'Owner', department: '所有者' })
        }
      }
      if (version === this.loadVersion && resourceId === this.resourceId) this.members = list
    },
    async run(action, requestedRole, removedId) {
      if (this.readOnly || this.busy || this.loadFailed) return
      const version = this.loadVersion
      const requested = String(requestedRole || '').toLowerCase()
      this.busy = true
      try {
        const updated = await action()
        if (version !== this.loadVersion) return
        await this.loadMembers()
        if (version !== this.loadVersion) return
        this.$emit('changed')
        if (this.isRoom && removedId) {
          const remaining = this.members.find(member => member.id === removedId)
          if (remaining && (remaining.folderRole || remaining.teamRole)) {
            this.$message.warning(`已移除单独授权；该成员仍有继承权限（实际${this.roleLabel(remaining.role)}），如需收回请在来源文件夹或团队调整`)
          } else {
            this.$message.success('已移除该成员的本图授权')
          }
        } else if (this.isRoom && requested === 'inherit') {
          const remaining =
            updated && this.members.find(member => member.id === (updated.user_id || updated.userId))
          if (remaining && remaining.role) {
            const source = this.inheritedSourceLabel(remaining)
            this.$message.success(`已恢复继承，实际为${this.roleLabel(remaining.role)}${source ? ` · ${source}` : ''}`)
          } else {
            this.$message.success('已恢复继承，该成员当前无继承权限')
          }
        } else {
          this.$message.success(`${this.resourceLabel}权限已更新`)
        }
      } catch (error) {
        if (version === this.loadVersion) this.$message.error(error.message || '更新权限失败')
      } finally {
        this.busy = false
      }
    },
    updateRole(member, role) {
      if (String(role).toLowerCase() === String(this.editableMemberRole(member)).toLowerCase()) return
      return this.run(() => {
        if (this.adapter) return this.adapter.updateRole(member, role)
        if (this.isTeam)
          return teamService.updateMemberRole(
            this.resourceId,
            member.id,
            role
          )
        return this.isRoom
          ? shareService.updateMemberRole(this.resourceId, member.id, role)
          : folderService.updateMember(this.resourceId, member.id, role)
      }, role)
    },
    remove(member) {
      return this.run(() => {
        if (this.adapter) return this.adapter.remove(member)
        if (this.isTeam)
          return teamService.removeMember(this.resourceId, member.id)
        return this.isRoom
          ? shareService.removeMember(this.resourceId, member.id)
          : folderService.removeMember(this.resourceId, member.id)
      }, null, member.id)
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
.adapterDisabledOption {
  display: inline-flex;
  cursor: not-allowed;
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
  width: calc(100vw - 32px) !important;
  max-width: 1080px;

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
    overflow: hidden;
  }
  .folderPermissionDialog .permissionDialogBody {
    height: 100%;
  }
  .folderPermissionDialog .permissionWorkspace {
    display: flex;
    flex-direction: column;
    flex: 1;
    height: auto;
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
<style lang="less" scoped>
.permissionDetailPane { display: flex; flex-direction: column; overflow-x: hidden; overflow-y: auto; }
.detailSection { flex: 0 0 auto; padding: 12px 16px; }
.selectedSection { min-height: 0; }
.selectionCount { margin-left: 5px; padding: 2px 7px; background: #f0f3f2; border-radius: 12px; color: #66756e; font-size: 11px; font-weight: 500; }
.selectionEmpty { min-height: 36px; }
.selectedList { max-height: 70px; margin-top: 8px; }
.selectedItem small { max-width: 180px; }
.roleOptions { gap: 4px; padding: 4px; border-radius: 9px; background: #f3f5f4; box-sizing: border-box; }
.roleOptions /deep/ .el-radio-button__inner { border: 0 !important; border-radius: 6px !important; background: transparent; box-shadow: none !important; padding: 8px 4px; }
.roleOptions /deep/ .el-radio-button__orig-radio:checked + .el-radio-button__inner { background: #fff; color: #087854; box-shadow: 0 1px 5px #193e2114 !important; }
.applicationSettings { flex-direction: row; flex-wrap: wrap; gap: 7px 12px; }
.applicationSettings /deep/ .el-checkbox { margin-right: 0; }
.previewBox { border: 0; background: #f6f9f7; }
.previewSection h3 { display: none; }
.existingSection { flex: 1 0 auto; min-height: 0; display: flex; flex-direction: column; }
.existingSection > * { flex-shrink: 0; }
// Keep at least five complete member rows visible, even when grant settings
// fill the pane. Short windows scroll the pane instead of crushing the list.
.existingList { flex: 1 0 300px; min-height: 300px; overflow: auto; border: 1px solid #e7ece9; }
.existingHead { position: sticky; top: 0; z-index: 1; }
.existingRow { min-height: 52px; }
.existingIdentity strong { font-size: 13px; }
.existingIdentity small { margin-top: 4px; }
.permissionFilters { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 12px; }
.permissionFilter { padding: 5px 8px; border: 1px solid #e2e7e4; border-radius: 20px; background: #fff; color: #66756e; cursor: pointer; font-size: 12px; }
.permissionFilter span { margin-left: 3px; font-variant-numeric: tabular-nums; opacity: .8; }
.permissionFilter.active { background: #23342c; border-color: #23342c; color: #fff; }
.permissionFilter:hover:not(.active) { border-color: #9cbcad; color: #087854; }
.treeRow { min-height: 46px; gap: 0; }
.treeLabel { flex-direction: column; align-items: flex-start; gap: 2px; padding: 5px 0; }
.treeLabel small { font-size: 11px; }
.permissionBadge { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 3px; padding: 3px 6px; margin: 0 3px 0 6px; border: 0; border-radius: 12px; background: #f0f2f4; color: #66717d; font-size: 11px; cursor: pointer; white-space: nowrap; }
.permissionBadge.editor { background: #eaf2ff; color: #3268ae; }
.permissionBadge.manager, .permissionBadge.admin { background: #e6f5ed; color: #087854; }
.permissionBadge.owner { background: #f4f0e8; color: #8b6d35; }
.permissionBadge:hover { filter: brightness(.96); }
.treeLegend { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 5px; padding: 10px 12px; border-top: 1px solid #e7ece9; background: #fff; font-size: 11px; color: #7b8982; }
.treeLegend i { color: #087854; }
.removeBtn:disabled { color: #8b9691; cursor: help; }
.permissionFooter .el-button--primary.is-disabled { background: #c5d9cf; border-color: #c5d9cf; color: #fff; cursor: not-allowed; }
.memberRoleSelect.viewer /deep/ .el-input__inner { color: #66717d; background: #f5f6f7; border-color: #edf0f2; }
.memberRoleSelect.editor /deep/ .el-input__inner { color: #3268ae; background: #f0f6ff; border-color: #e4edfa; }
.memberRoleSelect.manager /deep/ .el-input__inner, .memberRoleSelect.admin /deep/ .el-input__inner { color: #087854; background: #f0f9f4; border-color: #dfeee5; }
button:focus-visible { outline: 2px solid #087854; outline-offset: 2px; }
@media (max-width: 900px) {
  .permissionDetailPane { overflow: visible; display: block; }
  .existingSection { min-height: 280px; }
  .existingList { max-height: 320px; flex: none; }
  .permissionHeader p { line-height: 1.5; }
  .permissionBadge { font-size: 10px; }
  .treeRow.department { flex-wrap: wrap; }
  .departmentMemberToggle { margin-left: 50px; margin-bottom: 7px; }
  .footerHint { max-width: 48%; line-height: 1.5; font-size: 11px; }
  .permissionFooter .el-button { padding: 9px 11px; }
}
</style>

<style lang="less">
.permissionEmbedded {
  .permissionWorkspace { height: ~"min(580px, calc(100vh - 400px))"; min-height: 340px; }
  .permissionFooter { padding: 14px 0 0; }
  .permissionHeader h2 { font-size: 15px; }
  .permissionHeader p { line-height: 1.6; }
}
.permissionReadOnly .permissionWorkspace { grid-template-columns: 1fr; }
@media (max-width: 900px) {
  .permissionEmbedded .permissionWorkspace { height: 58vh; min-height: 320px; }
}
</style>

<style lang="less">
// Both the editor's embedded permissions and the workspace dialogs use this UI.
body.isDark, .productShell--dark {
  .permissionEmbedded, .folderPermissionDialog {
    color-scheme: dark;
    background: #262b30;
    .permissionDialogBody { color: #e8eef4; }
    .permissionHeader, .permissionWorkspace, .organizationPane,
    .paneHeader, .treeToolbar, .detailSection, .existingList,
    .existingRow, .treeLegend, .selectedItem, .el-dialog__footer {
      border-color: #424c57;
    }
    .organizationPane { background: #23282e; }
    .paneHeader, .permissionDetailPane, .treeLegend, .el-dialog__footer {
      background: #262b30;
    }
    .permissionHeader h2, .paneHeader h3, .detailSection h3,
    .existingIdentity strong, .selectedItem strong, .previewBox strong,
    .ownerRoleLabel, .grantStats strong { color: #e8eef4; }
    .permissionHeader p, .permissionHeader p strong, .paneHeader span,
    .treeLabel small, .treeEmpty, .selectionEmpty, .selectedItem small,
    .selectedItem button, .previewBox span, .existingIdentity small,
    .memberCount, .ownerBadge, .existingEmpty, .treeLegend,
    .footerHint, .transferHint, .detailTitle > span, .grantStats span,
    .expandBtn, .closeBtn, .el-checkbox__label { color: #acbac8; }
    .treeEmpty i, .selectionEmpty i { color: #acbac8; }
    .treeRow { color: #e8eef4; }
    .treeRow:hover, .closeBtn:hover { background: #343e49; }
    .treeRow.selected, .previewBox, .selectedItem, .grantStats > div {
      background: #293b37;
    }
    .existingHead, .roleOptions, .selectionCount, .treeIcon, .selectedIcon {
      background: #323c47;
      color: #acbac8;
    }
    .resourceIcon, .resourceIcon.team, .memberAvatar,
    .selectedIcon.department, .inheritedTag {
      background: #28463d;
      color: #74dfbd;
    }
    .resourceIcon.room { background: #2b3d56; color: #a7cdff; }
    .paneHeader button, .detailTitle button, .previewBox i,
    .treeLegend i, .footerHint i, .grantStats i, .transferBtn { color: #74dfbd; }
    .permissionFilter, .el-input__inner {
      background: #29313b;
      border-color: #526170;
      color: #dce5ee;
    }
    .el-input__inner::placeholder, .el-input__icon { color: #acbac8; }
    .el-input__inner:focus { border-color: #74dfbd; }
    .permissionFilter.active { background: #284f43; border-color: #74dfbd; color: #b5f5df; }
    .permissionFilter:hover:not(.active) { border-color: #74dfbd; color: #b5f5df; }
    .roleOptions .el-radio-button__inner {
      background: transparent; color: #dce5ee;
    }
    .roleOptions .el-radio-button__orig-radio:checked + .el-radio-button__inner {
      background: #285745; color: #c5f9e6; box-shadow: none !important;
    }
    .roleOptions .el-radio-button.is-disabled .el-radio-button__inner {
      background: #30363d; color: #97a4b1;
    }
    .permissionBadge, .memberRoleSelect.viewer .el-input__inner {
      background: #323c47; border-color: #526170; color: #c5d1dd;
    }
    .permissionBadge.editor, .memberRoleSelect.editor .el-input__inner {
      background: #293e59; border-color: #49658a; color: #a7cdff;
    }
    .permissionBadge.manager, .permissionBadge.admin,
    .memberRoleSelect.manager .el-input__inner, .memberRoleSelect.admin .el-input__inner {
      background: #28463d; border-color: #497b69; color: #9be8cd;
    }
    .permissionBadge.owner { background: #493f2d; color: #efd098; }
    .removeBtn { color: #ffaaa4; }
    .removeBtn:disabled { color: #97a4b1; }
    .el-checkbox__inner { background: #29313b; border-color: #8292a2; }
    .permissionFooter .el-button--primary.is-disabled {
      background: #384b45; border-color: #50685f; color: #b3c4bd;
    }
    .el-loading-mask { background: rgba(35, 40, 46, .9); }
    button:focus-visible { outline-color: #74dfbd; }
  }
}
</style>
