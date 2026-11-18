export default defineEventHandler(async (event) => {
  const body = await readBody<{ value?: unknown }>(event).catch(() => ({} as { value?: unknown }))
  const raw = body?.value
  const text = typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : ''
  if (!/^\d+$/.test(text)) {
    setResponseStatus(event, 400)
    return { error: 'Enter a whole number from 0 to 1000' }
  }
  const n = Number(text)
  if (!Number.isInteger(n) || n < 0 || n > 1000) {
    setResponseStatus(event, 400)
    return { error: 'Enter a whole number from 0 to 1000' }
  }
  return { result: `${n} squared is ${n * n}` }
})
