// View-only graph manipulation. Graph data and brain-map content are untouched.
class GraphInteraction {
  constructor() { this.reset(); }
  reset() { this.x = 0; this.y = 0; this.scale = 1; this.gesture = null; }
  toWorld(x, y) { return { x: (x - this.x) / this.scale, y: (y - this.y) / this.scale }; }
  begin(x, y, node) {
    this.gesture = { x, y, node, nodeX: node?.x, nodeY: node?.y,
      viewX: this.x, viewY: this.y, moved: false };
  }
  move(x, y) {
    const gesture = this.gesture;
    if (!gesture) return false;
    const dx = x - gesture.x, dy = y - gesture.y;
    if (!gesture.moved && Math.hypot(dx, dy) < 4) return false;
    gesture.moved = true;
    if (gesture.node) {
      const node = gesture.node;
      node.x = node.targetX = gesture.nodeX + dx / this.scale;
      node.y = node.targetY = gesture.nodeY + dy / this.scale;
      node.pinned = true;
    } else {
      this.x = gesture.viewX + dx; this.y = gesture.viewY + dy;
    }
    return true;
  }
  end() {
    const moved = !!this.gesture?.moved;
    this.gesture = null;
    return moved;
  }
  zoom(x, y, delta) {
    if (this.gesture) return;
    const anchor = this.toWorld(x, y);
    this.scale = Math.min(3, Math.max(0.3, this.scale * Math.exp(-delta * 0.001)));
    this.x = x - anchor.x * this.scale;
    this.y = y - anchor.y * this.scale;
  }
}
if (typeof module !== 'undefined' && module.exports) module.exports = { GraphInteraction };
