<template>
  <section class="productPage">
    <el-button
      type="text"
      icon="el-icon-arrow-left"
      @click="$router.push('/spaces')"
      >返回团队空间</el-button
    >
    <div v-if="error">
      <el-alert :title="error" type="error" :closable="false" /><el-button
        @click="load"
        >重试</el-button
      >
    </div>
    <div v-else v-loading="loading || busy" class="teamBody">
      <div v-if="team" class="teamHero">
        <div class="teamMark"><i class="el-icon-office-building" /></div>
        <div>
          <h1>{{ team.name }}</h1>
          <p v-if="team.description">{{ team.description }}</p>
          <span
            >{{ team.memberCount }} 位成员 · {{ team.roomCount }} 个脑图 ·
            {{ roleLabel }} · 更新于 {{ format(team.updatedAt) }}</span
          >
        </div>
        <div class="teamActions">
          <el-button
            icon="el-icon-files"
            @click="openInFiles"
            >在我的脑图查看</el-button
          >
          <el-button type="primary" icon="el-icon-plus" @click="createRoom"
            >新建脑图</el-button
          >
          <el-button
            icon="el-icon-user"
            :disabled="!canManage"
            @click="openContacts"
            >添加成员</el-button
          >
          <el-button
            icon="el-icon-setting"
            :disabled="!canManage"
            @click="openSettings"
            >团队设置</el-button
          >
        </div>
      </div>
      <el-tabs v-model="tab">
        <el-tab-pane label="脑图" name="rooms">
          <p v-if="folderId">
            <el-button type="text" @click="folderId = null"
              >全部团队脑图</el-button
            >
            / {{ folderName }}
          </p>
          <div class="roomGrid">
            <RoomCard
              v-for="room in visibleRooms"
              :key="room.id"
              :room="room"
              :allow-move-to-team="false"
              v-on="roomListeners"
            />
          </div>
          <EmptyState
            v-if="!loading && !visibleRooms.length"
            title="暂无脑图"
            description="此团队或文件夹中暂无脑图"
          />
        </el-tab-pane>
        <el-tab-pane label="成员" name="members" lazy
          ><div class="memberPanel">
            <TeamMemberList
              :members="members"
              @role="role"
              @remove="remove"
            /><EmptyState
              v-if="!members.length && !loading"
              title="暂无成员"
            /></div
        ></el-tab-pane>
      </el-tabs>
    </div>
    <RoomActionDialogs ref="actions" @changed="load" />
    <el-dialog
      :visible.sync="contactDialogVisible"
      custom-class="teamMemberPickerDialog"
      width="900px"
      :close-on-click-modal="false"
      :show-close="false"
    >
      <div v-loading="contactLoading || busy" class="memberPickerShell">
        <header class="memberPickerHeader">
          <div class="memberPickerIcon"><i class="el-icon-user" /></div>
          <div>
            <h2>添加团队成员</h2>
            <p>从企业微信通讯录选择成员加入「{{ team ? team.name : '' }}」</p>
          </div>
          <button class="memberPickerClose" type="button" aria-label="关闭" @click="contactDialogVisible = false">×</button>
        </header>
        <div class="memberPickerWorkspace">
          <section class="contactPickerPane" aria-label="企业微信成员">
            <div class="pickerPaneHeader">
              <div><h3>选择成员</h3><span>{{ contactTotal || contacts.length }} 位可选成员</span></div>
              <span v-if="contactHasMore" class="pickerHint">滚动加载</span>
            </div>
            <div class="contactSearch"><el-input v-model.trim="contactQuery" clearable prefix-icon="el-icon-search" placeholder="搜索姓名或部门" @input="loadContacts" /></div>
            <el-checkbox-group
              v-model="selectedContactIds"
              class="contactList"
              role="list"
              tabindex="0"
              @scroll.native="handleContactScroll"
            >
              <label v-for="contact in contacts" :key="contact.id" class="contactRow">
                <el-checkbox :label="contact.wecomUserId || contact.id" />
                <el-avatar :size="34" :src="contact.avatarUrl || ''">{{ contact.avatar }}</el-avatar>
                <span class="contactIdentity"><strong>{{ contact.name }}</strong><small>{{ contact.department || '未填写部门' }} · {{ contact.position || '未填写职位' }}</small></span>
              </label>
              <div v-if="contactLoadingMore" class="contactLoadState" role="status"><i class="el-icon-loading" /> 正在加载更多成员…</div>
              <button v-else-if="contactHasMore" type="button" class="contactLoadMore" @click="loadMoreContacts">加载更多成员</button>
              <p v-else-if="contacts.length" class="contactLoadState">已显示全部 {{ contactTotal || contacts.length }} 位成员</p>
            </el-checkbox-group>
            <EmptyState v-if="!contactLoading && !contacts.length" title="没有匹配的企业微信成员" />
          </section>
          <aside class="memberPickerSummary" aria-label="已选成员">
            <div class="pickerPaneHeader"><div><h3>已选成员</h3><span>{{ selectedContactIds.length }} 位</span></div><button v-if="selectedContactIds.length" type="button" @click="selectedContactIds = []">清空</button></div>
            <div v-if="selectedContacts.length" class="selectedContactList">
              <div v-for="contact in selectedContacts" :key="contact.wecomUserId || contact.id" class="selectedContactRow"><el-avatar :size="30" :src="contact.avatarUrl || ''">{{ contact.avatar }}</el-avatar><span><strong>{{ contact.name }}</strong><small>{{ contact.department || '企业微信成员' }}</small></span><button type="button" aria-label="移除" @click="removeSelectedContact(contact)">×</button></div>
            </div>
            <div v-else class="selectedContactEmpty"><i class="el-icon-user" /><span>从左侧选择要加入团队的成员</span></div>
          </aside>
        </div>
      </div>
      <span slot="footer" class="memberPickerFooter"><span><i class="el-icon-success" /> 选择后统一添加</span><span><el-button @click="contactDialogVisible = false">取消</el-button><el-button type="primary" :disabled="!selectedContactIds.length" :loading="busy" @click="addMembers">添加成员</el-button></span></span>
    </el-dialog>
    <el-dialog title="团队设置" :visible.sync="settingsVisible" width="520px">
      <el-form label-width="80px" @submit.native.prevent="saveSettings">
        <el-form-item label="团队名称"><el-input v-model="settingsForm.name" maxlength="60" /></el-form-item>
        <el-form-item label="团队描述"><el-input v-model="settingsForm.description" type="textarea" :rows="3" maxlength="200" /></el-form-item>
      </el-form>
      <span slot="footer">
        <el-button @click="settingsVisible = false">取消</el-button>
        <el-button type="primary" @click="saveSettings">保存</el-button>
      </span>
    </el-dialog>
  </section>
</template>
<script>
import teamService from '@/services/teamService'
import RoomCard from './components/RoomCard.vue'
import TeamMemberList from './components/TeamMemberList.vue'
import EmptyState from './components/EmptyState.vue'
import RoomActionDialogs from './components/RoomActionDialogs.vue'
export default {
  name: 'SpaceDetailPage',
  components: {
    RoomCard,
    TeamMemberList,
    EmptyState,
    RoomActionDialogs
  },
  data: () => ({
    team: null,
    rooms: [],
    members: [],
    folders: [],
    tab: 'rooms',
    folderId: null,
    folderQuery: '',
    loading: false,
    busy: false,
    error: '',
    requestId: 0,
    contactDialogVisible: false,
    contactLoading: false,
    contactLoadingMore: false,
    contactQuery: '',
    contacts: [],
    contactOffset: 0,
    contactNextCursor: null,
    contactTotal: 0,
    contactRequestId: 0,
    contactSearchTimer: null,
    selectedContactIds: [],
    settingsVisible: false,
    settingsForm: { name: '', description: '' }
  }),
  computed: {
    contactHasMore() {
      if (this.contactNextCursor) return true
      return this.contactTotal > this.contactOffset
    },
    selectedContacts() {
      const selected = new Set(this.selectedContactIds.map(String))
      return this.contacts.filter(contact => selected.has(String(contact.wecomUserId || contact.id)))
    },
    canManage() {
      return this.team && ['owner', 'admin'].includes(this.team.role)
    },
    roleLabel() {
      const role = this.team && this.team.role
      if (role === 'owner') return '所有者'
      if (role === 'admin') return '管理员'
      return '成员'
    },
    visibleRooms() {
      return this.rooms.filter(room =>
        this.folderId
          ? room.folderId === this.folderId
          : !room.folderId
      )
    },
    visibleFolders() {
      return this.folders.filter(folder =>
        folder.name.includes(this.folderQuery.trim())
      )
    },
    folderName() {
      const folder = this.folders.find(item => item.id === this.folderId)
      return folder ? folder.name : '根目录'
    },
    roomListeners() {
      return Object.fromEntries(
        [
          'open',
          'favorite',
          'rename',
          'move',
          'share',
          'history',
          'delete'
        ].map(action => [
          action,
          room => this.$refs.actions.handle(action, room)
        ])
      )
    }
  },
  watch: {
    '$route.params.id'() {
      this.folderId = null
      this.tab = 'rooms'
      this.load()
    }
  },
  created() {
    this.load()
  },
  beforeDestroy() {
    this.requestId++
    this.contactRequestId++
    clearTimeout(this.contactSearchTimer)
  },
  methods: {
    openInFiles() {
      this.$router.push({
        path: '/files',
        query: { team: this.$route.params.id }
      })
    },
    async load() {
      const request = ++this.requestId
      const id = this.$route.params.id
      this.loading = true
      this.error = ''
      try {
        const [team, rooms, members] = await Promise.all([
          teamService.getSpace(id),
          teamService.listRooms(id),
          teamService.listMembers(id)
        ])
        if (request === this.requestId)
          Object.assign(this, { team, rooms, members })
      } catch (error) {
        if (request === this.requestId) this.error = error.message
      } finally {
        if (request === this.requestId) this.loading = false
      }
    },
    openFolder(folder) {
      this.folderId = folder.id
      this.tab = 'rooms'
    },
    async createRoom() {
      try {
        const result = await this.$prompt('请输入脑图名称', '新建团队脑图', {
          inputValue: '未命名脑图',
          confirmButtonText: '创建',
          cancelButtonText: '取消'
        })
        await teamService.createRoom(this.$route.params.id, result.value, this.folderId)
        await this.load()
        this.$message.success('脑图已创建')
      } catch (error) {
        if (error !== 'cancel' && error !== 'close') this.$message.error(error.message || '创建脑图失败')
      }
    },
    async openContacts() {
      this.contactDialogVisible = true
      this.contactQuery = ''
      this.selectedContactIds = []
      await this.fetchContacts({ reset: true })
    },
    loadContacts() {
      clearTimeout(this.contactSearchTimer)
      this.contactSearchTimer = setTimeout(() => this.fetchContacts({ reset: true }), 250)
    },
    async fetchContacts({ reset = false } = {}) {
      if (!this.contactDialogVisible) return
      if (!reset && (this.contactLoading || this.contactLoadingMore)) return
      const request = ++this.contactRequestId
      if (reset) {
        this.contactOffset = 0
        this.contactNextCursor = null
        this.contactTotal = 0
        this.contactLoading = true
      } else {
        this.contactLoadingMore = true
      }
      try {
        const result = await teamService.listContacts({
          search: this.contactQuery,
          limit: 50,
          offset: reset ? 0 : this.contactOffset,
          cursor: reset ? null : this.contactNextCursor
        })
        if (request !== this.contactRequestId) return
        const existing = new Set(this.members.map(member => member.wecomUserId || member.userId || member.id))
        const incoming = result.list.filter(contact => !existing.has(contact.wecomUserId || contact.id))
        const selected = this.contacts.filter(contact => this.selectedContactIds.includes(contact.wecomUserId || contact.id))
        const merged = reset ? selected.concat(incoming) : this.contacts.concat(incoming)
        this.contacts = Array.from(new Map(merged.map(contact => [contact.wecomUserId || contact.id, contact])).values())
        this.contactOffset = (reset ? 0 : this.contactOffset) + result.list.length
        this.contactNextCursor = result.nextCursor
        this.contactTotal = result.total
      } catch (error) {
        this.$message.error(error.message)
      } finally {
        if (request === this.contactRequestId) {
          this.contactLoading = false
          this.contactLoadingMore = false
        }
      }
    },
    loadMoreContacts() {
      if (this.contactHasMore) this.fetchContacts()
    },
    removeSelectedContact(contact) {
      const id = contact.wecomUserId || contact.id
      this.selectedContactIds = this.selectedContactIds.filter(item => String(item) !== String(id))
    },
    handleContactScroll(event) {
      const el = event.target
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 72) this.loadMoreContacts()
    },
    async addMembers() {
      this.busy = true
      try {
        await teamService.addMembers(this.$route.params.id, this.selectedContactIds)
        this.contactDialogVisible = false
        await this.load()
        this.$message.success('成员已添加')
      } catch (error) {
        this.$message.error(error.message)
      } finally {
        this.busy = false
      }
    },
    openSettings() {
      this.settingsForm = { name: this.team.name, description: this.team.description || '' }
      this.settingsVisible = true
    },
    async saveSettings() {
      this.busy = true
      try {
        this.team = await teamService.updateSpace(this.$route.params.id, this.settingsForm)
        this.settingsVisible = false
        this.$message.success('团队设置已保存')
      } catch (error) {
        this.$message.error(error.message)
      } finally {
        this.busy = false
      }
    },
    format(value) {
      return new Date(value).toLocaleDateString('zh-CN')
    },
    async role(member, role) {
      await this.perform(() =>
        teamService.updateMemberRole(this.$route.params.id, member.id, role)
      )
    },
    async remove(member) {
      const confirmed = await this.$confirm(
        '移除团队成员「' + member.name + '」？',
        '移除成员'
      )
        .then(() => true)
        .catch(() => false)
      if (confirmed)
        await this.perform(() =>
          teamService.removeMember(this.$route.params.id, member.id)
        )
    },
    async perform(action) {
      if (this.busy) return
      this.busy = true
      try {
        await action()
        await this.load()
        this.$message.success('团队成员已更新')
      } catch (error) {
        this.$message.error(error.message)
      } finally {
        this.busy = false
      }
    }
  }
}
</script>
<style lang="less" scoped>
.teamBody {
  min-height: 240px;
}
.teamHero {
  display: flex;
  gap: 16px;
  align-items: center;
  margin: 18px 0 28px;
  .teamMark {
    width: 58px;
    height: 58px;
    border-radius: 15px;
    display: grid;
    place-items: center;
    background: #0d9066;
    color: white;
    font-size: 25px;
  }
  h1 {
    margin: 0;
    font-size: 25px;
  }
  p {
    margin: 6px 0;
    color: #63776f;
  }
  span {
    color: #76897f;
    font-size: 12px;
  }
  .teamActions {
    margin-left: auto;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
}
.roomGrid,
.folderGrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 14px;
}
.folderGrid {
  margin-top: 16px;
}
.memberPanel {
  max-width: 720px;
  background: white;
  border: 1px solid #e3e9e6;
  padding: 12px 20px;
  border-radius: 12px;
}
.contactList {
  flex: 1;
  min-height: 0;
  max-height: none;
  overflow-y: auto;
  overscroll-behavior: contain;
  margin: 0;
  padding: 6px 12px;
  scrollbar-gutter: stable;
}
.contactLoadMore {
  width: 100%;
  min-height: 40px;
  border: 0;
  background: transparent;
  color: var(--ui-primary);
  cursor: pointer;
  font-size: 13px;
  &:hover { background: var(--ui-primary-soft); }
}
.contactLoadState {
  margin: 0;
  padding: 12px;
  color: var(--ui-text-secondary);
  text-align: center;
  font-size: 12px;
}
.contactRow {
  min-height: 54px;
  display: flex;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid #eef1ef;
  cursor: pointer;
  .contactIdentity {
    display: flex;
    flex-direction: column;
    gap: 3px;
    strong { font-size: 13px; }
    small { color: #83918c; }
  }
}
.memberPickerShell {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  color: var(--ui-text);
}
.memberPickerHeader {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--ui-border);
  h2 { margin: 0; font-size: 18px; }
  p { margin: 3px 0 0; color: var(--ui-text-secondary); font-size: 12px; }
}
.memberPickerIcon {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border-radius: var(--ui-radius-md);
  background: var(--ui-primary-soft);
  color: var(--ui-primary);
  font-size: 18px;
}
.memberPickerClose {
  margin-left: auto;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: var(--ui-radius-sm);
  background: transparent;
  color: var(--ui-text-secondary);
  font-size: 24px;
  cursor: pointer;
  &:hover { background: var(--ui-surface-muted); color: var(--ui-text); }
}
.memberPickerWorkspace {
  display: grid;
  grid-template-columns: minmax(0, 1.12fr) minmax(280px, .88fr);
  flex: 1;
  min-height: 0;
  height: ~'min(560px, 68vh)';
  margin-top: 14px;
  overflow: hidden;
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-md);
}
.contactPickerPane,
.memberPickerSummary {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.contactPickerPane { border-right: 1px solid var(--ui-border); background: #fbfcfc; }
.memberPickerSummary { overflow-y: auto; background: var(--ui-surface); }
.pickerPaneHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 13px 16px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-surface);
  h3 { margin: 0; font-size: 13px; }
  span { color: var(--ui-text-muted); font-size: 12px; }
  button { border: 0; background: transparent; color: var(--ui-primary); font-size: 12px; cursor: pointer; }
  .pickerHint { color: var(--ui-text-muted); }
}
.contactSearch { padding: 10px 12px; border-bottom: 1px solid var(--ui-border); }
.selectedContactList { padding: 6px 12px; }
.selectedContactRow {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 48px;
  border-bottom: 1px solid #edf1ef;
  span { min-width: 0; flex: 1; }
  strong, small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  strong { font-size: 13px; font-weight: 500; }
  small { margin-top: 3px; color: var(--ui-text-muted); font-size: 11px; }
  button { border: 0; background: transparent; color: var(--ui-danger); font-size: 16px; cursor: pointer; }
}
.selectedContactEmpty {
  display: grid;
  place-items: center;
  align-content: center;
  gap: 8px;
  flex: 1;
  min-height: 140px;
  color: var(--ui-text-muted);
  font-size: 12px;
  i { color: #9caaa3; font-size: 22px; }
}
.memberPickerFooter {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--ui-text-secondary);
  font-size: 12px;
  i { color: var(--ui-primary); }
}
@media (max-width: 900px) {
  .memberPickerWorkspace {
    display: flex;
    flex-direction: column;
    height: calc(96vh - 170px);
    min-height: 0;
    overflow-y: auto;
  }
  .contactPickerPane { flex: 0 0 360px; min-height: 360px; border-right: 0; border-bottom: 1px solid var(--ui-border); }
  .memberPickerSummary { flex: 0 0 auto; min-height: 220px; overflow: visible; }
}
@media (prefers-reduced-motion: reduce) {
  .memberPickerShell *, .memberPickerShell *::before, .memberPickerShell *::after { transition-duration: .01ms !important; }
}
@media (max-width: 760px) {
  .teamHero { align-items: flex-start; flex-wrap: wrap; }
  .teamHero .teamActions { margin-left: 0; width: 100%; justify-content: flex-start; }
}
</style>
<style lang="less">
.teamMemberPickerDialog { display: flex; flex-direction: column; width: ~'min(900px, calc(100vw - 32px))' !important; max-height: 96vh; margin: 2vh auto 0 !important; border-radius: 12px; overflow: hidden; box-shadow: 0 20px 60px rgba(23, 38, 31, .16); }
.teamMemberPickerDialog .el-dialog__header { display: none; }
.teamMemberPickerDialog .el-dialog__body { flex: 1; min-height: 0; padding: 16px 18px 0; overflow: hidden; }
.teamMemberPickerDialog .el-dialog__footer { flex: 0 0 auto; padding: 10px 18px 14px; border-top: 1px solid #e7ece9; background: #fff; }
@media (max-width: 900px) { .teamMemberPickerDialog .el-dialog__body { overflow-y: auto; } .teamMemberPickerDialog .memberPickerShell { height: auto; } }
</style>
