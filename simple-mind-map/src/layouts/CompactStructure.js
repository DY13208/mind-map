import LogicalStructure from './LogicalStructure'
import compactLayoutConfig from './compactLayoutConfig'
import { asyncRun } from '../utils'

// Keep parents in a compact column. Pack each parent's immediate children as
// one group, without reserving the height of its more distant descendants.
class CompactStructure extends LogicalStructure {
  constructor(renderer) {
    super(renderer)
    this.compactConfig = compactLayoutConfig
    this.busXByNode = new Map()
    this.obstacleRightByNode = new Map()
  }

  getMarginX() {
    return this.compactConfig.levelGap
  }

  getMarginY(layerIndex) {
    return layerIndex === 1
      ? this.compactConfig.siblingGap
      : this.compactConfig.childGap
  }

  doLayout(callback) {
    asyncRun([
      () => this.computedBaseValue(),
      () => this.computedTopValue(),
      () => callback(this.root)
    ])
  }

  computedBaseValue() {
    super.computedBaseValue()
    const levels = []
    const queue = [{ node: this.root, depth: 0 }]
    for (let i = 0; i < queue.length; i++) {
      const { node, depth } = queue[i]
      if (!node) continue
      if (!levels[depth]) levels[depth] = []
      levels[depth].push(node)
      if (node.getData('expand') !== false) {
        const children = node.children || []
        children.forEach(child => {
          queue.push({ node: child, depth: depth + 1 })
        })
      }
    }
    this.levels = levels
  }

  nodeHeight(node) {
    const height = Number(node.height)
    return Math.max(
      Number.isFinite(height) ? height : 0,
      this.compactConfig.nodeMinHeight
    )
  }

  computedTopValue() {
    const levels = this.levels || []
    this.obstacleRightByNode = new Map()
    this.busXByNode = new Map()
    for (let depth = 1; depth < levels.length; depth++) {
      const parents = levels[depth - 1] || []
      const groups = []
      parents.forEach(parent => {
        const children = parent.getData('expand') === false
          ? []
          : parent.children || []
        if (!children.length) return
        const gap = depth === 1
          ? this.compactConfig.siblingGap
          : this.compactConfig.childGap
        const height = children.reduce((sum, child) => {
          return sum + this.nodeHeight(child)
        }, 0) + (children.length - 1) * gap
        const groupTop = parent.top + parent.height / 2 - height / 2
        let top = groupTop
        children.forEach(child => {
          if (!child.hasCustomPosition()) child.top = top
          top += this.nodeHeight(child) + gap
        })
        groups.push({ parent, children, height, top: groupTop })
      })
      // Root children stay fixed. Every later sibling group moves together,
      // keeping its own vertical bus and its children visually associated.
      if (depth > 1) this.packGroups(groups)
      const obstacles = levels.slice(0, depth).flat()
      this.positionChildGroups(obstacles, groups)
      // Finalize this level's corridors before placing its grandchildren.
      this.assignConnectorLanes(depth - 1)
    }
  }

  // Place each branch beside its own parent. Nodes in the branch's Y range
  // reserve space for both the child nodes and distinct connector lanes.
  positionChildGroups(obstacles, groups) {
    const nodeUseLineStyle = this.mindMap.themeConfig.nodeUseLineStyle
    const spans = groups.map(({ parent, children }) => {
      const sourceY = parent.top + parent.height / 2 +
        (nodeUseLineStyle && !parent.isRoot ? parent.height / 2 : 0)
      const childYs = children.map(child => {
        return child.top + child.height / 2 +
          (nodeUseLineStyle ? child.height / 2 : 0)
      })
      return {
        min: childYs.reduce((min, y) => Math.min(min, y), sourceY),
        max: childYs.reduce((max, y) => Math.max(max, y), sourceY)
      }
    })
    const { alwaysShowExpandBtn, notShowExpandBtn } = this.mindMap.opt
    groups.forEach((group, index) => {
      const { parent, children } = group
      const top = children.reduce((min, child) => Math.min(min, child.top), parent.top)
      const bottom = children.reduce((max, child) => {
        return Math.max(max, child.top + child.height)
      }, parent.top + parent.height)
      const obstacleRight = obstacles.reduce((right, node) => {
        if (node.top >= bottom || node.top + node.height <= top) return right
        const badgeWidth = node.getData('expand') === false &&
          typeof node.getExpandBtnOuterWidth === 'function'
          ? node.getExpandBtnOuterWidth()
          : 0
        return Math.max(right, node.left + node.width + badgeWidth)
      }, parent.left + parent.width)
      this.obstacleRightByNode.set(parent, obstacleRight)
      const overlapping = spans.filter(span => {
        return span.min < spans[index].max && span.max > spans[index].min
      }).length
      const expandReserve = alwaysShowExpandBtn && !notShowExpandBtn &&
        parent.layerIndex > 0 ? parent.expandBtnSize || 0 : 0
      const gap = Math.max(
        this.compactConfig.levelGap,
        expandReserve + this.compactConfig.connectorMargin * 2 +
          overlapping * this.compactConfig.connectorLaneGap
      )
      const childLeft = obstacleRight + gap
      children.forEach(child => {
        if (!child.hasCustomPosition()) child.left = childLeft
      })
    })
  }

  // Different parents need separate bus lanes. Order those lanes by the
  // actual parent/child Y coordinates, minimizing crossings between another
  // branch's horizontal arm and this branch's vertical trunk.
  assignConnectorLanes(onlyDepth = null) {
    if (onlyDepth === null) this.busXByNode = new Map()
    const nodeUseLineStyle = this.mindMap.themeConfig.nodeUseLineStyle
    const levels = this.levels || []
    levels.forEach((nodes, depth) => {
      if (onlyDepth !== null && depth !== onlyDepth) return
      const routes = nodes.filter(node => {
        return node.getData('expand') !== false && node.children && node.children.length
      }).map(node => {
        const sourceY = node.top + node.height / 2 +
          (nodeUseLineStyle && !node.isRoot ? node.height / 2 : 0)
        const childYs = node.children.map(child => {
          return child.top + child.height / 2 +
            (nodeUseLineStyle ? child.height / 2 : 0)
        })
        return {
          node,
          childLeft: node.children.reduce((min, child) => Math.min(min, child.left), Infinity),
          sourceY,
          childYs,
          minY: childYs.reduce((min, y) => Math.min(min, y), sourceY),
          maxY: childYs.reduce((max, y) => Math.max(max, y), sourceY)
        }
      })
      if (!routes.length) return
      const inRange = (y, route) => y >= route.minY && y <= route.maxY
      const costCache = new Map()
      const crossingCost = (leftRoute, rightRoute) => {
        let row = costCache.get(leftRoute)
        if (!row) {
          row = new Map()
          costCache.set(leftRoute, row)
        }
        if (row.has(rightRoute)) return row.get(rightRoute)
        const sourceCrossing = inRange(rightRoute.sourceY, leftRoute) ? 1 : 0
        const childCrossings = leftRoute.childYs.reduce((count, y) => {
          return count + (inRange(y, rightRoute) ? 1 : 0)
        }, 0)
        const cost = sourceCrossing + childCrossings
        row.set(rightRoute, cost)
        return cost
      }
      const ordered = []
      routes.forEach(route => {
        let bestPosition = ordered.length
        let cost = ordered.reduce((sum, other) => {
          return sum + crossingCost(other, route)
        }, 0)
        let bestCost = cost
        for (let position = ordered.length - 1; position >= 0; position--) {
          const other = ordered[position]
          cost += crossingCost(route, other) - crossingCost(other, route)
          if (cost < bestCost) {
            bestCost = cost
            bestPosition = position
          }
        }
        ordered.splice(bestPosition, 0, route)
      })
      let changed = true
      while (changed) {
        changed = false
        for (let i = 0; i < ordered.length - 1; i++) {
          if (crossingCost(ordered[i + 1], ordered[i]) <
            crossingCost(ordered[i], ordered[i + 1])) {
            const current = ordered[i]
            ordered[i] = ordered[i + 1]
            ordered[i + 1] = current
            changed = true
          }
        }
      }
      const { alwaysShowExpandBtn, notShowExpandBtn } = this.mindMap.opt
      const placed = []
      const crossingCount = (vertical, horizontal) => {
        if (horizontal.y <= vertical.minY || horizontal.y >= vertical.maxY) return 0
        return vertical.busX > Math.min(horizontal.from, horizontal.to) &&
          vertical.busX < Math.max(horizontal.from, horizontal.to) ? 1 : 0
      }
      const arms = route => [
        { y: route.sourceY, from: route.sourceRight, to: route.busX },
        ...route.childYs.map(y => ({ y, from: route.busX, to: route.childLeft }))
      ]
      ordered.forEach(route => {
        const { node } = route
        const expandBtnSize = alwaysShowExpandBtn && !notShowExpandBtn && depth > 0
          ? node.expandBtnSize || 0
          : 0
        route.sourceRight = node.left + node.width + expandBtnSize
        const obstacleRight = this.obstacleRightByNode.get(node) || node.left + node.width
        const minX = Math.max(route.sourceRight, obstacleRight) +
          this.compactConfig.connectorMargin
        let best = null
        let attempts = 0
        while (attempts <= placed.length + 2) {
          const maxX = route.childLeft - this.compactConfig.connectorMargin
          const middle = (minX + maxX) / 2
          const candidates = [middle, minX, maxX]
          placed.forEach(other => {
            const markers = [other.busX, other.sourceRight, other.childLeft]
            markers.forEach(x => {
              candidates.push(
                x - this.compactConfig.connectorLaneGap,
                x + this.compactConfig.connectorLaneGap
              )
            })
          })
          candidates.forEach(x => {
            if (x < minX || x > maxX) return
            const nearby = placed.some(other => {
              return route.minY < other.maxY && route.maxY > other.minY &&
                Math.abs(x - other.busX) < this.compactConfig.connectorLaneGap
            })
            if (nearby) return
            route.busX = x
            const routeArms = arms(route)
            const collisions = placed.reduce((count, other) => {
              const otherArms = arms(other)
              return count + otherArms.reduce((sum, arm) => sum + crossingCount(route, arm), 0) +
                routeArms.reduce((sum, arm) => sum + crossingCount(other, arm), 0)
            }, 0)
            const score = collisions * 10000 + Math.abs(x - middle)
            if (!best || score < best.score) best = { x, score, collisions }
          })
          if (best && best.collisions === 0) break
          if (node.children.some(child => child.hasCustomPosition())) break
          const previousX = placed.reduce((max, other) => {
            return route.minY < other.maxY && route.maxY > other.minY
              ? Math.max(max, other.busX)
              : max
          }, minX)
          const requiredLeft = previousX + this.compactConfig.connectorLaneGap +
            this.compactConfig.connectorMargin
          const shift = Math.max(
            this.compactConfig.connectorLaneGap,
            requiredLeft - route.childLeft
          )
          route.childLeft += shift
          node.children.forEach(child => { child.left += shift })
          best = null
          attempts++
        }
        route.busX = best
          ? best.x
          : Math.max(minX, route.childLeft - this.compactConfig.connectorMargin)
        this.busXByNode.set(node, route.busX)
        placed.push(route)
      })
    })
  }

  // Project sibling groups to the nearest non-overlapping positions. Only
  // immediate children occupy space here; grandchildren are placed separately.
  packGroups(groups) {
    if (groups.length < 2) return
    const offsets = [0]
    for (let i = 1; i < groups.length; i++) {
      offsets[i] = offsets[i - 1] + groups[i - 1].height + this.compactConfig.groupGap
    }
    const blocks = []
    groups.forEach((group, index) => {
      const fixedChild = group.children.find(child => child.hasCustomPosition())
      const fixedOffset = fixedChild
        ? group.children.slice(0, group.children.indexOf(fixedChild)).reduce((sum, child) => {
          return sum + this.nodeHeight(child) + this.compactConfig.childGap
        }, 0)
        : 0
      const weight = fixedChild ? 1000000 : 1
      const desiredTop = fixedChild ? fixedChild.top - fixedOffset : group.top
      const desired = desiredTop - offsets[index]
      blocks.push({ start: index, end: index, weight, sum: desired * weight })
      while (blocks.length > 1) {
        const last = blocks[blocks.length - 1]
        const prev = blocks[blocks.length - 2]
        if (prev.sum / prev.weight <= last.sum / last.weight) break
        prev.end = last.end
        prev.weight += last.weight
        prev.sum += last.sum
        blocks.pop()
      }
    })
    blocks.forEach(block => {
      const base = block.sum / block.weight
      for (let i = block.start; i <= block.end; i++) {
        let top = base + offsets[i]
        groups[i].children.forEach(child => {
          if (!child.hasCustomPosition()) child.top = top
          top += this.nodeHeight(child) + this.compactConfig.childGap
        })
      }
    })
  }

  // The elbow sits in the gap between complete depth columns. The inherited
  // elbow would use each parent's width and could run through a wider sibling.
  renderLineStraight(node, lines, style) {
    if (!node.children.length) return []
    const { left, top, width, height, layerIndex } = node
    const { alwaysShowExpandBtn, notShowExpandBtn } = this.mindMap.opt
    const expandBtnSize = alwaysShowExpandBtn && !notShowExpandBtn && layerIndex > 0
      ? node.expandBtnSize
      : 0
    const childLeft = node.children[0] && node.children[0].left
    const busX = this.busXByNode.has(node)
      ? this.busXByNode.get(node)
      : Number.isFinite(childLeft)
        ? left + width + (childLeft - left - width) / 2
        : left + width + this.compactConfig.levelGap / 2
    const nodeUseLineStyle = this.mindMap.themeConfig.nodeUseLineStyle
    const y1 = top + height / 2 + (nodeUseLineStyle && !node.isRoot ? height / 2 : 0)
    const x1 = left + width + expandBtnSize
    const trunkX = Math.max(x1, busX)
    const branches = []
    node.children.forEach((item, index) => {
      if (this.renderReversedHorizontalLine(
        node, item, lines[index], style, 'straight', false
      )) return
      const y2 = item.top + item.height / 2 + (nodeUseLineStyle ? item.height / 2 : 0)
      const x2 = item.left + (nodeUseLineStyle ? item.width : 0)
      branches.push({ item, index, x2, y2 })
    })
    if (!branches.length) return
    const topY = branches.reduce((min, branch) => Math.min(min, branch.y2), y1)
    const bottomY = branches.reduce((max, branch) => Math.max(max, branch.y2), y1)
    branches.forEach(({ item, index, x2, y2 }, branchIndex) => {
      // The first child owns the shared trunk. Other children draw only their
      // horizontal branch, so the same vertical segment is never painted twice.
      const path = branchIndex === 0
        ? `M ${x1},${y1} L ${trunkX},${y1} M ${trunkX},${topY} L ${trunkX},${bottomY} M ${trunkX},${y2} L ${x2},${y2}`
        : `M ${trunkX},${y2} L ${x2},${y2}`
      this.setLineStyle(style, lines[index], path, item)
    })
  }
}

export default CompactStructure
