<template>
  <svg
    class="mindMapPreview"
    viewBox="0 0 320 160"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <rect width="320" height="160" fill="#f3f7f5" />
    <g v-for="(line, index) in lines" :key="'l' + index">
      <path
        :d="line"
        fill="none"
        stroke="#9ac8b6"
        stroke-width="1.4"
      />
    </g>
    <g v-for="(node, index) in nodes" :key="'n' + index">
      <rect
        :x="node.x"
        :y="node.y"
        :width="node.w"
        :height="node.h"
        :rx="node.root ? 8 : 5"
        :fill="node.root ? '#0c9065' : '#ffffff'"
        :stroke="node.root ? '#0c9065' : '#9ac8b6'"
        stroke-width="1.2"
      />
      <text
        :x="node.x + node.w / 2"
        :y="node.y + node.h / 2 + 0.5"
        text-anchor="middle"
        dominant-baseline="middle"
        :fill="node.root ? '#ffffff' : '#244038'"
        :font-size="node.root ? 11 : 10"
        font-family="Segoe UI, PingFang SC, Microsoft YaHei, sans-serif"
      >
        {{ node.label }}
      </text>
    </g>
  </svg>
</template>

<script>
function clip(text, max) {
  const value = String(text || '').trim() || '未命名'
  return value.length > max ? value.slice(0, max - 1) + '…' : value
}

function evenlySpace(count, top, bottom, boxH) {
  if (count <= 0) return []
  if (count === 1) return [(top + bottom - boxH) / 2]
  const span = bottom - top - boxH
  const step = span / (count - 1)
  return Array.from({ length: count }, (_, i) => top + step * i)
}

function curve(fromX, fromY, toX, toY) {
  const mx = (fromX + toX) / 2
  return `M ${fromX} ${fromY} C ${mx} ${fromY}, ${mx} ${toY}, ${toX} ${toY}`
}

function layoutSketch(sketch) {
  const root = sketch || { text: '未命名', children: [] }
  // Card is short: only render root + first-level children to avoid stacking.
  const children = Array.isArray(root.children) ? root.children.slice(0, 4) : []
  const nodes = []
  const lines = []
  const rootBox = {
    x: 118,
    y: 66,
    w: 84,
    h: 28,
    label: clip(root.text, 8),
    root: true
  }
  nodes.push(rootBox)

  if (!children.length) return { nodes, lines }

  const left = children.filter((_, i) => i % 2 === 0).slice(0, 2)
  const right = children.filter((_, i) => i % 2 === 1).slice(0, 2)
  const boxH = 22
  const boxW = 78

  const placeSide = (list, side) => {
    const ys = evenlySpace(list.length, 18, 142, boxH)
    list.forEach((child, index) => {
      const box = {
        x: side === 'left' ? 22 : 220,
        y: ys[index],
        w: boxW,
        h: boxH,
        label: clip(child.text, 8),
        root: false
      }
      nodes.push(box)
      const fromX = side === 'left' ? rootBox.x : rootBox.x + rootBox.w
      const toX = side === 'left' ? box.x + box.w : box.x
      lines.push(
        curve(fromX, rootBox.y + rootBox.h / 2, toX, box.y + box.h / 2)
      )
    })
  }

  placeSide(left, 'left')
  placeSide(right, 'right')
  return { nodes, lines }
}

export default {
  name: 'MindMapPreview',
  props: {
    sketch: {
      type: Object,
      default: () => ({ text: '未命名', children: [] })
    }
  },
  computed: {
    layout() {
      return layoutSketch(this.sketch)
    },
    nodes() {
      return this.layout.nodes
    },
    lines() {
      return this.layout.lines
    }
  }
}
</script>

<style lang="less" scoped>
.mindMapPreview {
  width: 100%;
  height: 100%;
  display: block;
}
</style>
