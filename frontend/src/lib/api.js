import axios from 'axios'

const api = axios.create({
  baseURL: 'http://127.0.0.1:8000/api',
})

// sessionStorage is isolated per browser tab, so admin and user can stay
// signed in simultaneously in separate tabs without overwriting each other.
api.interceptors.request.use((config) => {
  const token = sessionStorage.getItem('rootlens_access')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

export default api
