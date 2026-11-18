export default defineEventHandler((event) => {
  const marker = process.env.FULLSTACK_PROBE_MARKER
  if (!marker) {
    setResponseStatus(event, 404)
    return { error: 'not found' }
  }
  const port = Number(getRequestURL(event).port || 0)
  return { marker, port }
})
