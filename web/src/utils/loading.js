import { Loading } from 'element-ui'

let loadingInstance = null

export const showLoading = (text = '') => {
  loadingInstance = Loading.service({
    lock: true,
    text
  })
}

export const hideLoading = () => {
    if (loadingInstance) {
        loadingInstance.close()
        loadingInstance = null
    }
  }
  