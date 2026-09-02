let overlay = null
let styleInjected = false

function injectStyle() {
  if (styleInjected) return
  styleInjected = true
  const style = document.createElement('style')
  style.textContent = `
.smm-progress-loading {
  position: fixed;
  inset: 0;
  z-index: 4000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0.28);
  backdrop-filter: blur(2px);
}
.smm-progress-loading__box {
  min-width: 280px;
  max-width: 420px;
  padding: 28px 32px 24px;
  border-radius: 16px;
  background: #fff;
  box-shadow: 0 18px 50px rgba(15, 23, 42, 0.18);
  text-align: center;
}
.smm-progress-loading__spinner {
  width: 36px;
  height: 36px;
  margin: 0 auto 16px;
  border: 3px solid #dbeafe;
  border-top-color: #2563eb;
  border-radius: 50%;
  animation: smm-progress-spin 0.8s linear infinite;
}
.smm-progress-loading__text {
  color: #1d4ed8;
  font-size: 14px;
  line-height: 1.5;
}
.smm-progress-loading__bar {
  display: none;
  height: 8px;
  margin-top: 16px;
  overflow: hidden;
  border-radius: 999px;
  background: #e2e8f0;
}
.smm-progress-loading__bar.is-on {
  display: block;
}
.smm-progress-loading__bar > i {
  display: block;
  height: 100%;
  width: 0;
  border-radius: inherit;
  background: linear-gradient(90deg, #60a5fa, #2563eb);
  transition: width 0.24s ease;
}
.smm-progress-loading__pct {
  display: none;
  margin-top: 8px;
  color: #334155;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.smm-progress-loading__pct.is-on,
.smm-progress-loading__detail.is-on {
  display: block;
}
.smm-progress-loading__detail {
  display: none;
  margin-top: 6px;
  color: #64748b;
  font-size: 12px;
  line-height: 1.4;
}
@keyframes smm-progress-spin {
  to { transform: rotate(360deg); }
}
`
  document.head.appendChild(style)
}

function ensureOverlay() {
  injectStyle()
  if (overlay) return overlay
  overlay = document.createElement('div')
  overlay.className = 'smm-progress-loading'
  overlay.innerHTML =
    '<div class="smm-progress-loading__box">' +
    '<div class="smm-progress-loading__spinner"></div>' +
    '<div class="smm-progress-loading__text"></div>' +
    '<div class="smm-progress-loading__bar"><i></i></div>' +
    '<div class="smm-progress-loading__pct"></div>' +
    '<div class="smm-progress-loading__detail"></div>' +
    '</div>'
  document.body.appendChild(overlay)
  return overlay
}

export const showLoading = (text = '', options = {}) => {
  ensureOverlay()
  updateLoading({
    text,
    percent: options.percent,
    detail: options.detail
  })
}

export const updateLoading = (options = {}) => {
  if (!overlay) ensureOverlay()
  const textEl = overlay.querySelector('.smm-progress-loading__text')
  const barEl = overlay.querySelector('.smm-progress-loading__bar')
  const fillEl = overlay.querySelector('.smm-progress-loading__bar > i')
  const pctEl = overlay.querySelector('.smm-progress-loading__pct')
  const detailEl = overlay.querySelector('.smm-progress-loading__detail')
  if (options.text != null && textEl) textEl.textContent = options.text
  const percent = Number(options.percent)
  const showBar = Number.isFinite(percent)
  if (barEl) barEl.classList.toggle('is-on', showBar)
  if (pctEl) {
    pctEl.classList.toggle('is-on', showBar)
    pctEl.textContent = showBar ? `${Math.max(0, Math.min(100, Math.round(percent)))}%` : ''
  }
  if (fillEl && showBar) {
    fillEl.style.width = `${Math.max(0, Math.min(100, percent))}%`
  }
  if (detailEl) {
    const detail = options.detail ? String(options.detail) : ''
    detailEl.textContent = detail
    detailEl.classList.toggle('is-on', !!detail)
  }
}

export const hideLoading = () => {
  if (overlay && overlay.parentNode) {
    overlay.parentNode.removeChild(overlay)
  }
  overlay = null
}
