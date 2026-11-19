import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { DEMO_USER, demoCredentialsMatch } from '../utils/demo-user'
import { getAppSession } from '../utils/session'

export const Route = createFileRoute('/api/login')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: any
        try { body = await request.json() } catch { body = {} }
        const email = typeof body?.email === 'string' ? body.email : ''
        const password = typeof body?.password === 'string' ? body.password : ''
        if (!demoCredentialsMatch(email, password)) {
          return json({ error: true, message: 'Invalid email or password' }, { status: 401 })
        }
        const session = await getAppSession()
        session.userEmail = DEMO_USER.email
        await session.save()
        return json({ email: DEMO_USER.email })
      },
    },
  },
})
