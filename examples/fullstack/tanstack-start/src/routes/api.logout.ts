import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { getAppSession } from '../utils/session'

export const Route = createFileRoute('/api/logout')({
  server: {
    handlers: {
      POST: async () => {
        const session = await getAppSession()
        await session.destroy()
        return json({ ok: true })
      },
    },
  },
})
