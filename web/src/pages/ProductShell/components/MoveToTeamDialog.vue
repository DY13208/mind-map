<template>
  <el-dialog :visible.sync="shown" title="移至团队空间" width="460px">
    <p class="hint">
      将「{{ room ? room.title : '' }}」移入团队后，团队成员将获得对应协作权限。
    </p>
    <div v-loading="loading">
      <el-radio-group v-model="target" class="teamOptions">
        <div
          v-for="team in teams"
          :key="team.id"
          class="teamOption"
        >
          <el-radio :label="team.id">
            <strong>{{ team.name }}</strong>
            <small>{{ team.memberCount }} 位成员 · {{ team.roomCount }} 个脑图</small>
          </el-radio>
        </div>
      </el-radio-group>
      <p v-if="!loading && !teams.length" class="empty">暂无可用团队，请先创建团队空间</p>
    </div>
    <span slot="footer">
      <el-button @click="shown = false">取消</el-button>
      <el-button type="primary" :disabled="!target" @click="confirm">移入团队</el-button>
    </span>
  </el-dialog>
</template>
<script>
import teamService from '@/services/teamService'

export default {
  name: 'MoveToTeamDialog',
  props: { visible: Boolean, room: Object },
  data: () => ({ teams: [], target: '', loading: false }),
  computed: {
    shown: {
      get() {
        return this.visible
      },
      set(value) {
        this.$emit('update:visible', value)
      }
    }
  },
  watch: {
    async visible(value) {
      if (!value) return
      this.target = ''
      this.loading = true
      try {
        this.teams = await teamService.listSpaces()
        if (this.teams.length === 1) this.target = this.teams[0].id
      } catch (error) {
        this.teams = []
        this.$message.error(error.message || '加载团队失败')
      } finally {
        this.loading = false
      }
    }
  },
  methods: {
    confirm() {
      if (!this.target) return
      this.$emit('confirm', this.target)
      this.shown = false
    }
  }
}
</script>
<style lang="less" scoped>
.hint {
  margin: 0 0 14px;
  color: #61756d;
  font-size: 13px;
  line-height: 1.5;
}
.teamOptions {
  display: block;
  width: 100%;
}
.teamOption {
  padding: 12px;
  border-bottom: 1px solid #eef1ef;
  /deep/ .el-radio {
    display: flex;
    align-items: flex-start;
    width: 100%;
    white-space: normal;
  }
  /deep/ .el-radio__label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    line-height: 1.3;
  }
  strong {
    color: #17261f;
    font-weight: 600;
  }
  small {
    color: #7b8982;
  }
}
.empty {
  color: #7b8982;
  font-size: 13px;
  padding: 18px 0;
}
</style>
