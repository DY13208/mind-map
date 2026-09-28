<template>
  <section class="graphServicePage">
    <iframe
      class="graphFrame"
      :src="url"
      title="Wiki Knowledge Graph"
      data-testid="graph-service-frame"
    />
  </section>
</template>

<script>
import { getGraphServiceUrl } from '@/utils/runtimeConfig'

export default {
  name: 'GraphServicePage',
  computed: {
    url() {
      return getGraphServiceUrl()
    }
  }
}
</script>

<style lang="less" scoped>
.graphServicePage {
  height: 100vh;
  height: 100dvh;
  margin: 0;
  padding: 0;
  background: #111;
}
.graphFrame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: #111;
}
</style>
