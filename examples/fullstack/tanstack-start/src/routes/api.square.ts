import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'

export const Route = createFileRoute('/api/square')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: any
        try { body = await request.json() } catch { body = {} }
        const raw = body?.value
        const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000) {
          return json({ error: 'Value must be a number from 0 to 1000' }, { status: 400 })
        }
        return json({ result: String(value * value) })
      },
    },
  },
})
