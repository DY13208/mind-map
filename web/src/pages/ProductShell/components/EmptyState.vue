<template
  ><div class="emptyState">
    <div class="emptyIcon"><i :class="icon" /></div>
    <h3>{{ title }}</h3>
    <p>{{ description }}</p>
    <el-button v-if="action" type="primary" @click="$emit('action')">{{
      action
    }}</el-button>
  </div></template
>
<script>
export default {
  name: 'EmptyState',
  props: {
    title: String,
    description: String,
    action: String,
    icon: { type: String, default: 'el-icon-document' }
  }
}
</script>
<style lang="less" scoped>
.emptyState {
  text-align: center;
  padding: 70px 20px;
  color: #7b8b85;
  .emptyIcon {
    margin: auto;
    width: 62px;
    height: 62px;
    border-radius: 18px;
    background: #eaf5f0;
    display: grid;
    place-items: center;
    color: #0b8f64;
    font-size: 27px;
  }
  h3 {
    color: #344b42;
    margin: 17px 0 7px;
  }
  p {
    margin: 0 0 18px;
    font-size: 13px;
  }
}
</style>
