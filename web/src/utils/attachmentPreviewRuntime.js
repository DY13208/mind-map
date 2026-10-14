import { getRuntimeConfig } from './runtimeConfig'

export function previewAssetUrl(file) {
  const base = process.env.NODE_ENV === 'development' ? '/' : (typeof window !== 'undefined' && window.externalPublicPath) ||
    getRuntimeConfig().publicPath || '/'
  const prefix = String(base).endsWith('/') ? String(base) : String(base) + '/'
  return new URL(prefix + 'attachment-preview/' + file, window.location.href).href
}

let pdfRuntime
export function loadPdfPreviewRuntime() {
  if (!pdfRuntime) {
    const url = previewAssetUrl('pdf/pdf.js')
    pdfRuntime = import(/* webpackIgnore: true */ url).then(pdf => {
      pdf.GlobalWorkerOptions.workerSrc = previewAssetUrl('pdf/pdf.worker.js')
      return pdf
    }).catch(error => { pdfRuntime = null; throw error })
  }
  return pdfRuntime
}

let presentationRuntime
export function loadPresentationPreviewRuntime() {
  if (!presentationRuntime) {
    const url = previewAssetUrl('pptx/renderer-1.3.0.js')
    presentationRuntime = import(/* webpackIgnore: true */ url).catch(error => { presentationRuntime = null; throw error })
  }
  return presentationRuntime
}
