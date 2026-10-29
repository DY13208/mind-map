// Run before App/router imports: lazy chunks must use the deployed runtime path,
// even when a static build was produced with a different PUBLIC_PATH.
if (typeof window !== 'undefined' && window.externalPublicPath) {
  const runtimePath = String(window.externalPublicPath).trim()
  if (runtimePath) {
    __webpack_public_path__ = runtimePath.endsWith('/')
      ? runtimePath
      : runtimePath + '/'
  }
}
