
import axios from 'axios'

const api = axios.create({
  baseURL: 'https://root-lens-ai-zsv6.vercel.app/api',
  headers: {
    'Content-Type': 'application/json',
  },
})

api.interceptors.request.use((config) => {
  const token = sessionStorage.getItem('rootlens_access')

  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }

  return config
})

export default api
