// 玻璃文件夹背板的生成艺术：域扭曲噪声场按液面打光，分帧绘制并在所有文件夹间共享缓存。

// 与脑图白底卡片兼容：浅粉彩 marble，含品牌绿；无近黑大块，并排不抢戏
export const ART_PRESETS = {
  mint: {
    style: 'marble',
    colors: ['#f7fcf9', '#eaf6f0', '#d5ecdf', '#bfe2d0', '#a8d5bf', '#dff0e7', '#ffffff'],
    scale: 0.72,
    warp: 2.5,
    angle: 1.2,
    gloss: 0.16,
    veins: 0.08
  },
  sky: {
    style: 'marble',
    colors: ['#f7fbfe', '#eaf3fb', '#d7e9f6', '#c2dcf0', '#a9cce6', '#ddeff8', '#ffffff'],
    scale: 0.72,
    warp: 2.45,
    angle: -0.45,
    gloss: 0.16,
    veins: 0.08
  },
  lilac: {
    style: 'marble',
    colors: ['#fbf8ff', '#f3ecfb', '#e7daf4', '#d8c6eb', '#c7b2e0', '#ebe1f5', '#ffffff'],
    scale: 0.7,
    warp: 2.55,
    angle: 0.9,
    gloss: 0.16,
    veins: 0.08
  },
  peach: {
    style: 'marble',
    colors: ['#fffaf6', '#fff1e8', '#fde3d2', '#f5d0b8', '#e8bda4', '#f7e2d4', '#ffffff'],
    scale: 0.72,
    warp: 2.4,
    angle: -0.9,
    gloss: 0.15,
    veins: 0.06
  },
  mist: {
    style: 'marble',
    colors: ['#fafbfc', '#f0f3f5', '#e2e8ec', '#d0d8de', '#bcc7d0', '#e8ecef', '#ffffff'],
    scale: 0.74,
    warp: 2.35,
    angle: 0.3,
    gloss: 0.12,
    veins: 0.05
  },
  sage: {
    style: 'marble',
    colors: ['#f6faf7', '#e8f2eb', '#d4e5da', '#bdd6c6', '#a5c5b0', '#dce9e1', '#ffffff'],
    scale: 0.72,
    warp: 2.5,
    angle: 2.0,
    gloss: 0.15,
    veins: 0.07
  }
}

export const ART_PRESET_NAMES = Object.keys(ART_PRESETS)

export function hexToRgb(hex) {
  let h = String(hex).trim().replace(/^#/, '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = /^[0-9a-f]{6}$/i.test(h) ? parseInt(h, 16) : 0x808080
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hashString(s) {
  const str = String(s)
  let h = 2166136261
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619)
  return h >>> 0
}

function makeFbm(seed) {
  const r = rng(seed)
  const perm = new Uint8Array(512)
  const grad = new Float32Array(512)
  const p = []
  for (let i = 0; i < 256; i++) p.push(i)
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    const t = p[i]
    p[i] = p[j]
    p[j] = t
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255]
  for (let i = 0; i < 256; i++) {
    const a = r() * Math.PI * 2
    grad[i * 2] = Math.cos(a)
    grad[i * 2 + 1] = Math.sin(a)
  }
  const noise = (x, y) => {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const xf = x - xi
    const yf = y - yi
    const X = xi & 255
    const Y = yi & 255
    const h00 = perm[X + perm[Y]] * 2
    const h10 = perm[X + 1 + perm[Y]] * 2
    const h01 = perm[X + perm[Y + 1]] * 2
    const h11 = perm[X + 1 + perm[Y + 1]] * 2
    const d00 = grad[h00] * xf + grad[h00 + 1] * yf
    const d10 = grad[h10] * (xf - 1) + grad[h10 + 1] * yf
    const d01 = grad[h01] * xf + grad[h01 + 1] * (yf - 1)
    const d11 = grad[h11] * (xf - 1) + grad[h11 + 1] * (yf - 1)
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10)
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10)
    return d00 + u * (d10 - d00) + v * (d01 - d00 + u * (d11 - d01 - d10 + d00))
  }
  return (x, y, octaves) => {
    let sum = 0
    let amp = 0.5
    for (let i = 0; i < octaves; i++) {
      sum += amp * noise(x, y)
      const nx = 1.6 * x + 1.2 * y + 7.1
      y = -1.2 * x + 1.6 * y + 3.3
      x = nx
      amp *= 0.5
    }
    return sum
  }
}

export function createArtJob(width, height, recipe, seed) {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const colors = recipe.colors && recipe.colors.length >= 2 ? recipe.colors : ['#111111', '#eeeeee']
  const stops = colors.map((c, i) => ({ t: i / (colors.length - 1), c: hexToRgb(c) }))
  const scale = recipe.scale != null ? recipe.scale : 0.7
  const warp = recipe.warp != null ? recipe.warp : 3
  const gloss = recipe.gloss != null ? recipe.gloss : 0.4
  const veins = recipe.veins || 0
  const silkAmount = recipe.silk || 0
  const streak = recipe.style === 'streak'
  const fbm = makeFbm(seed * 977 + 13)
  const r = rng(seed + 1)
  const ox = r() * 50
  const oy = r() * 50
  const angle = (recipe.angle || 0) + (r() - 0.5) * 0.5
  const ca = Math.cos(angle)
  const sa = Math.sin(angle)
  const m = Math.min(w, h)
  const gw = Math.ceil(w / 2) + 3
  const gh = Math.ceil(h / 2) + 3
  const G = new Float32Array(gw * gh)
  const GQ = new Float32Array(gw * gh)
  const F = new Float32Array(w * h)
  const Q = new Float32Array(w * h)
  const pixels = new Uint8ClampedArray(w * h * 4)
  let row = 0

  const field = gy => {
    for (let gx = 0; gx < gw; gx++) {
      const u = ((gx - 1) * 2 - w / 2) / m
      const v = ((gy - 1) * 2 - h / 2) / m
      let px = (u * ca - v * sa) * scale
      let py = (u * sa + v * ca) * scale
      if (streak) {
        px *= 0.14
        py *= 2.2
      }
      px += ox
      py += oy
      const qx = fbm(px, py, 3)
      const qy = fbm(px + 5.2, py + 1.3, 3)
      const rx = fbm(px + warp * qx + 1.7, py + warp * qy + 9.2, 3)
      const ry = fbm(px + warp * qx + 8.3, py + warp * qy + 2.8, 3)
      G[gy * gw + gx] = fbm(px + warp * rx, py + warp * ry, 4)
      GQ[gy * gw + gx] = Math.sqrt(qx * qx + qy * qy)
    }
  }

  const upsample = () => {
    const cr = (a, b, c, d) => (-a + 9 * b + 9 * c - d) / 16
    const T = new Float32Array(w * gh)
    for (let gy = 0; gy < gh; gy++) {
      const base = gy * gw
      for (let x = 0; x < w; x++) {
        const c = (x >> 1) + 1
        T[gy * w + x] = x & 1 ? cr(G[base + c - 1], G[base + c], G[base + c + 1], G[base + c + 2]) : G[base + c]
      }
    }
    for (let y = 0; y < h; y++) {
      const c = (y >> 1) + 1
      for (let x = 0; x < w; x++) {
        F[y * w + x] =
          y & 1 ? cr(T[(c - 1) * w + x], T[c * w + x], T[(c + 1) * w + x], T[(c + 2) * w + x]) : T[c * w + x]
        const gx = (x >> 1) + 1
        const q0 = GQ[c * gw + gx]
        const qx = x & 1 ? (q0 + GQ[c * gw + gx + 1]) / 2 : q0
        const q1 = y & 1
          ? x & 1
            ? (GQ[(c + 1) * gw + gx] + GQ[(c + 1) * gw + gx + 1]) / 2
            : GQ[(c + 1) * gw + gx]
          : qx
        Q[y * w + x] = (qx + q1) / 2
      }
    }
  }

  const colorize = () => {
    const sample = []
    const stride = Math.max(1, Math.floor(F.length / 4096))
    for (let i = 0; i < F.length; i += stride) sample.push(F[i])
    sample.sort((a, b) => a - b)
    const lo = sample[Math.floor(sample.length * 0.02)]
    const hi = sample[Math.floor(sample.length * 0.98)]
    const k = 1 / (hi - lo || 1)
    const lx = -0.55
    const ly = -0.65
    const lz = 0.52
    const slope = k * m * 0.012
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        let t = (F[i] - lo) * k
        t = t < 0 ? 0 : t > 1 ? 1 : t
        let j = 1
        while (j < stops.length - 1 && stops[j].t < t) j++
        const a = stops[j - 1]
        const b = stops[j]
        let f = (t - a.t) / (b.t - a.t || 1)
        f = f < 0 ? 0 : f > 1 ? 1 : f
        f = f * f * (3 - 2 * f)
        const gx = (F[x < w - 1 ? i + 1 : i] - F[x > 0 ? i - 1 : i]) * slope
        const gy = (F[y < h - 1 ? i + w : i] - F[y > 0 ? i - w : i]) * slope
        const nd = (-gx * lx - gy * ly + lz) / Math.sqrt(gx * gx + gy * gy + 1)
        const spec = Math.pow(nd > 0 ? nd : 0, 24) * gloss * 255
        const silk = 1 + silkAmount * Math.sin(t * 150 + Q[i] * 24)
        const vein = veins * Math.max(0, 1 - Math.abs(Q[i] - 0.42) * 14) * 0.6
        const lit = (0.82 + 0.28 * nd) * silk * (1 - vein)
        pixels[i * 4] = (a.c[0] + (b.c[0] - a.c[0]) * f) * lit + spec
        pixels[i * 4 + 1] = (a.c[1] + (b.c[1] - a.c[1]) * f) * lit + spec
        pixels[i * 4 + 2] = (a.c[2] + (b.c[2] - a.c[2]) * f) * lit + spec
        pixels[i * 4 + 3] = 255
      }
    }
  }

  const step = rows => {
    if (row >= gh) return true
    const end = Math.min(gh, row + Math.max(1, rows))
    while (row < end) field(row++)
    if (row < gh) return false
    upsample()
    colorize()
    return true
  }

  return { width: w, height: h, pixels, step }
}

const artCache = new Map()
const queue = []
let pumping = false

function pump() {
  if (pumping) return
  pumping = true
  const tick = () => {
    const until = performance.now() + 7
    while (queue.length && performance.now() < until) {
      const head = queue[0]
      if (head.job.step(4)) {
        queue.shift()
        const canvas = document.createElement('canvas')
        canvas.width = head.job.width
        canvas.height = head.job.height
        const ctx = canvas.getContext('2d')
        if (ctx) ctx.putImageData(new ImageData(head.job.pixels, canvas.width, canvas.height), 0, 0)
        head.done(canvas)
      }
    }
    if (queue.length) requestAnimationFrame(tick)
    else pumping = false
  }
  requestAnimationFrame(tick)
}

export function paintArt(recipe, seed, w, h) {
  const key = JSON.stringify([recipe, seed, w, h])
  let p = artCache.get(key)
  if (!p) {
    p = new Promise(done => {
      queue.push({ job: createArtJob(w, h, recipe, seed), done })
      pump()
    })
    artCache.set(key, p)
  }
  return p
}

// plain：约 1/4 用素磨砂背板，图案印在口袋最前一张纸上（参考 Archives）
export function artForKey(key) {
  const hash = hashString(key)
  return {
    recipe: ART_PRESETS[ART_PRESET_NAMES[hash % ART_PRESET_NAMES.length]],
    seed: hash % 997,
    plain: (hash >>> 7) % 4 === 0
  }
}
