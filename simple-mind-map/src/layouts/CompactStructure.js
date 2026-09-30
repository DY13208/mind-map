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
    this.armOffsetsByNode = new Map()
    this.placedConnectorRoutes = []
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
    const tasks = [
      () => this.computedBaseValue(),
      () => this.computedTopValue(),
      () => callback(this.root)
    ]
    if (this.renderer._syncLayoutForResize) {
      this.renderer._syncLayoutForResize = false
      tasks.forEach(task => task())
    } else {
      asyncRun(tasks)
    }
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
    this.armOffsetsByNode = new Map()
    this.placedConnectorRoutes = []
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
    if (onlyDepth === null || onlyDepth === 0) {
      this.busXByNode = new Map()
      this.armOffsetsByNode = new Map()
      this.placedConnectorRoutes = []
    }
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
      const placed = this.placedConnectorRoutes
      const crossingCount = (vertical, horizontal) => {
        if (horizontal.y <= vertical.minY || horizontal.y >= vertical.maxY) return 0
        return vertical.busX > Math.min(horizontal.from, horizontal.to) &&
          vertical.busX < Math.max(horizontal.from, horizontal.to) ? 1 : 0
      }
      const arms = route => [
        { y: route.sourceY + (route.sourceOffset || 0), from: route.sourceRight, to: route.busX },
        ...route.childYs.map((y, index) => ({
          y: y + ((route.childOffsets || [])[index] || 0),
          from: route.busX,
          to: route.childLeft
        }))
      ]
      const armConflict = (arm, other) => {
        const left = Math.max(Math.min(arm.from, arm.to), Math.min(other.from, other.to))
        const right = Math.min(Math.max(arm.from, arm.to), Math.max(other.from, other.to))
        return right - left > 1 && Math.abs(arm.y - other.y) < 3
      }
      const visibleNodes = levels.slice(0, depth + 2).flat()
      const hitsNode = (segment, target) => {
        const left = target.left + 1
        const right = target.left + target.width - 1
        const top = target.top + 1
        const bottom = target.top + target.height - 1
        if (segment.y1 === segment.y2) {
          return segment.y1 > top && segment.y1 < bottom &&
            Math.max(segment.x1, segment.x2) > left &&
            Math.min(segment.x1, segment.x2) < right
        }
        return segment.x1 > left && segment.x1 < right &&
          Math.max(segment.y1, segment.y2) > top &&
          Math.min(segment.y1, segment.y2) < bottom
      }
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
          visibleNodes.forEach(other => {
            if (other === node || node.children.includes(other)) return
            candidates.push(
              other.left - this.compactConfig.connectorMargin,
              other.left + other.width + this.compactConfig.connectorMargin
            )
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
            const nodeCollisions = visibleNodes.filter(other => {
              return other !== node && !node.children.includes(other) &&
                hitsNode({ x1: x, y1: route.minY, x2: x, y2: route.maxY }, other)
            }).length
            const lineCollisions = placed.reduce((count, other) => {
              const otherArms = arms(other)
              return count + otherArms.reduce((sum, arm) => sum + crossingCount(route, arm), 0) +
                routeArms.reduce((sum, arm) => sum + crossingCount(other, arm), 0)
            }, 0)
            const collisions = nodeCollisions + lineCollisions
            const score = nodeCollisions * 100000 + lineCollisions * 10000 + Math.abs(x - middle)
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
        // Coincident horizontal arms cannot be separated by moving the vertical
        // bus alone. Give only the colliding arms a short local dogleg.
        // Moving a bus cannot solve collinear arms. Keep lane selection about
        // trunk crossings, then resolve horizontal overlap at the arm itself.
        const existingArms = placed.flatMap(arms)
        const offsets = [0]
        for (let distance = 6; distance <= 60; distance += 6) {
          offsets.push(-distance, distance)
        }
        const chooseOffset = (arm, target, isSource) => {
          const obstacles = visibleNodes.filter(other => other !== node && other !== target)
          for (const offset of offsets) {
            const candidate = { ...arm, y: arm.y + offset }
            if (existingArms.some(other => armConflict(candidate, other))) continue
            const stubX = isSource
              ? Math.min(route.busX - 2, arm.from + 6)
              : Math.max(route.busX + 2, arm.to - 6)
            const useDogleg = offset !== 0 && (isSource
              ? stubX > arm.from : stubX < arm.to)
            if (offset !== 0 && !useDogleg) continue
            const segments = useDogleg
              ? isSource
                ? [
                    { x1: arm.from, y1: arm.y, x2: stubX, y2: arm.y },
                    { x1: stubX, y1: arm.y, x2: stubX, y2: candidate.y },
                    { x1: stubX, y1: candidate.y, x2: arm.to, y2: candidate.y }
                  ]
                : [
                    { x1: arm.from, y1: candidate.y, x2: stubX, y2: candidate.y },
                    { x1: stubX, y1: candidate.y, x2: stubX, y2: arm.y },
                    { x1: stubX, y1: arm.y, x2: arm.to, y2: arm.y }
                  ]
              : [{ x1: arm.from, y1: arm.y, x2: arm.to, y2: arm.y }]
            if (segments.some(segment => obstacles.some(other => hitsNode(segment, other)))) {
              continue
            }
            if (placed.some(other => segments.some(segment => {
              return segment.y1 === segment.y2 && crossingCount(other, {
                y: segment.y1, from: segment.x1, to: segment.x2
              })
            }))) continue
            return offset
          }
          return 0
        }
        route.sourceOffset = chooseOffset({
          y: route.sourceY,
          from: route.sourceRight,
          to: route.busX
        }, null, true)
        route.childOffsets = route.childYs.map((y, index) => chooseOffset({
          y,
          from: route.busX,
          to: route.childLeft
        }, node.children[index], false))
        const routedYs = [route.sourceY + route.sourceOffset,
          ...route.childYs.map((y, index) => y + route.childOffsets[index])]
        route.minY = Math.min(...routedYs)
        route.maxY = Math.max(...routedYs)
        this.armOffsetsByNode.set(node, {
          source: route.sourceOffset,
          children: route.childOffsets
        })
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
    const armOffsets = this.armOffsetsByNode.get(node) || { source: 0, children: [] }
    const branches = []
    node.children.forEach((item, index) => {
      if (this.renderReversedHorizontalLine(
        node, item, lines[index], style, 'straight', false
      )) return
      const y2 = item.top + item.height / 2 + (nodeUseLineStyle ? item.height / 2 : 0)
      const x2 = item.left + (nodeUseLineStyle ? item.width : 0)
      branches.push({ item, index, x2, y2,
        offset: armOffsets.children[index] || 0 })
    })
    if (!branches.length) return
    const sourceY = y1 + armOffsets.source
    const topY = branches.reduce((min, branch) => Math.min(min, branch.y2 + branch.offset), sourceY)
    const bottomY = branches.reduce((max, branch) => Math.max(max, branch.y2 + branch.offset), sourceY)
    branches.forEach(({ item, index, x2, y2, offset }, branchIndex) => {
      // The first child owns the shared trunk. Other children draw only their
      // horizontal branch, so the same vertical segment is never painted twice.
      const sourceStubX = Math.min(trunkX - 2, x1 + 6)
      const sourceArm = armOffsets.source && sourceStubX > x1
        ? `M ${x1},${y1} L ${sourceStubX},${y1} L ${sourceStubX},${sourceY} L ${trunkX},${sourceY}`
        : `M ${x1},${y1} L ${trunkX},${y1}`
      const childArmY = y2 + offset
      const childStubX = Math.max(trunkX + 2, x2 - 6)
      const childArm = offset && childStubX < x2
        ? `M ${trunkX},${childArmY} L ${childStubX},${childArmY} L ${childStubX},${y2} L ${x2},${y2}`
        : `M ${trunkX},${y2} L ${x2},${y2}`
      const path = branchIndex === 0
        ? `${sourceArm} M ${trunkX},${topY} L ${trunkX},${bottomY} ${childArm}`
        : childArm
      this.setLineStyle(style, lines[index], path, item)
    })
  }
}

export default CompactStructure
