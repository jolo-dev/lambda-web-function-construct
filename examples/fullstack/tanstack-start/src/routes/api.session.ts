import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { getAppSession } from '../utils/session'

export const Route = createFileRoute('/api/session')({
  server: {
    handlers: {
      GET: async () => {
        const session = await getAppSession()
        return json(session.userEmail ? { email: session.userEmail } : {})
      },
    },
  },
})
