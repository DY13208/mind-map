<template>
  <div class="profilePage">
    <div class="profileTop">
      <button type="button" class="profileBack" aria-label="返回首页" @click="goBack">
        <i class="el-icon-arrow-left" aria-hidden="true"></i><span>返回首页</span>
      </button>
    </div>
    <section v-if="profile" class="profileCard" aria-label="个人信息">
      <UserAvatar :person="profile" :size="64" fallback="我" />
      <div class="profileMeta">
        <h1>{{ profile.name }}</h1>
        <p><span class="metaLabel">账号</span>{{ profile.id }}</p>
      </div>
    </section>
    <p v-else-if="profileError" class="profileError">{{ profileError }}</p>

    <h2 class="sectionTitle">编辑活动</h2>
    <ContributionSkyline :data="activity" :end-date="endDate" :note="activityNote" />
  </div>
</template>

<script>
import productService from '@/services/productService'
import UserAvatar from '@/components/UserAvatar.vue'
import ContributionSkyline from '@/components/ContributionSkyline.vue'

export default {
  name: 'ProfilePage',
  components: { UserAvatar, ContributionSkyline },
  data() {
    return {
      profile: null,
      profileError: '',
      activity: [],
      endDate: null,
      activityNote: ''
    }
  },
  async created() {
    try {
      this.profile = await productService.getProfile()
    } catch (err) {
      this.profileError = (err && err.message) || '无法获取用户信息'
    }
    this.loadActivity()
  },
  methods: {
    async loadActivity() {
      try {
        const res = await productService.getMyActivity(371)
        this.activity = Array.isArray(res && res.days) ? res.days : []
        if (res && res.today) this.endDate = res.today
        if (!this.activity.length) this.activityNote = '暂无编辑记录，开始编辑脑图后这里会点亮。'
      } catch (err) {
        this.activity = []
        this.activityNote = '编辑活动暂时无法加载，稍后刷新重试。'
      }
    },
    goBack() {
      this.$router.push('/files')
    }
  }
}
</script>

<style lang="less" scoped>
.profilePage {
  max-width: 1080px;
  margin: 0 auto;
  padding: 20px 28px 40px;
  color: #1f2328;
}
.profileTop {
  margin-bottom: 14px;
}
.profileBack {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px 6px 6px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #52665f;
  font-size: 13px;
  cursor: pointer;
  &:hover {
    background: #e8f4ef;
    color: #087854;
  }
  &:focus-visible {
    outline: 2px solid #087854;
    outline-offset: 2px;
  }
}
.profileCard {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 20px 22px;
  border: 1px solid #e5e7eb;
  border-radius: 14px;
  background: #fff;
  margin-bottom: 24px;
}
.profileMeta {
  min-width: 0;
  h1 {
    margin: 0 0 6px;
    font-size: 22px;
    overflow-wrap: anywhere;
  }
  p {
    margin: 0;
    font-size: 13px;
    color: #6b7280;
    overflow-wrap: anywhere;
  }
}
.metaLabel {
  margin-right: 8px;
  padding: 2px 6px;
  border-radius: 4px;
  background: #f1f3f4;
  color: #64727d;
  font-size: 12px;
}
.sectionTitle {
  font-size: 15px;
  margin: 0 0 10px;
}
.profileError {
  color: #9a6641;
  font-size: 13px;
}
@media (max-width: 560px) {
  .profilePage {
    padding: 14px 14px 30px;
  }
}
</style>
<style lang="less">
body.isDark .profilePage {
  color: #e6e8eb;
  .profileCard {
    background: #1f2329;
    border-color: #3a3d42;
  }
  .profileMeta p {
    color: #9aa0a6;
  }
  .metaLabel {
    background: #2c3036;
    color: #b4bac0;
  }
  .profileBack {
    color: #b4bac0;
    &:hover {
      background: #2c3036;
      color: #4cc596;
    }
  }
}
</style>
