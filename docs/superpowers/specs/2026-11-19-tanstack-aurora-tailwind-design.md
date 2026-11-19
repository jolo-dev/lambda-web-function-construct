# TanStack Start Aurora Glass Tailwind restyle

Date: 2026-11-19
Status: Approved by operator in brainstorming; implementation and live redeploy not yet authorized.

## Goal

Restyle the retained TanStack Start Web Function demo with proper Tailwind CSS 4 in the operator-selected **Aurora Glass** direction, using a **split hero + live-proof** home layout and **centered glass cards** for login/profile. The application's behavior, session flow, route contracts, and Web Function delivery topology stay unchanged.

This is a scoped visual refinement of existing code, not a new product surface or redesign of the auth model.

## Approved decisions (brainstorming)

- Visual world: **Aurora Glass** — deep indigo/slate gradient, frosted translucent cards, indigo→cyan primary gradients, emerald live status, amber demo caveats.
- Home layout: **Split hero + live proof** — headline/navigation on the left, glass status card on the right, counter/square controls visible below in the first viewport.
- Auth surfaces: **Centered glass card** — `/login` and `/profile` are centered cards on the gradient field; profile shows the session email and a styled logout control.
- Tooling: Tailwind CSS 4 via `@tailwindcss/vite`, matching the upstream starter's approach. No framework version changes, no external fonts, no icon library.
- The retained live stack is updated in place and **left running**; no cleanup.

## Architecture and files

| File | Change |
| --- | --- |
| `examples/fullstack/tanstack-start/package.json`, `bun.lock` | Add dev dependencies `tailwindcss@^4.2.2` and `@tailwindcss/vite@^4.2.2`; keep all existing pins. |
| `examples/fullstack/tanstack-start/vite.config.ts` | Add `tailwindcss()` to the plugin list alongside `tanstackStart()`. |
| `examples/fullstack/tanstack-start/src/styles/app.css` (new) | `@import "tailwindcss";` plus an `@theme` block defining Aurora tokens and a few base/component utility classes for the gradient background, glass surface, gradient button, and focus ring. |
| `examples/fullstack/tanstack-start/src/routes/__root.tsx` | Import the stylesheet with `?url` and add a `<link rel="stylesheet" href={appCss} />` in `head.links`; keep `fetchUser`/`beforeLoad` unchanged. |
| `src/routes/index.tsx` | Replace markup with split hero + live-proof layout and glass controls; preserve server function, loader, state, and all test IDs. |
| `src/components/LoginPanel.tsx` | Replace the inline `<style>` block and markup with Tailwind classes; centered card, labeled fields, inline error, gradient submit button; keep JSON POST and navigation behavior. |
| `src/routes/login.tsx`, `src/routes/_authed/profile.tsx`, `src/routes/about.tsx` | Wrap content in the shared shell/card classes using Tailwind; preserve IDs and copy. |
| Tests/docs/plan record | Existing tests remain; add any needed assertions only for new accessible names; record styling work and live redeploy in the implementation plan. |

Tailwind's generated CSS is a hashed client asset under `dist/client/assets/`, already routed to private S3 through the `/assets/*` cache behavior. No CloudFront or CDK source change is expected.

## Visual system

- Background: fixed aurora gradient from `#1e1b4b` through `#0f172a` to `#0b1120`, with a subtle radial cyan/indigo glow and a faint grid overlay; must remain readable and not obscure content.
- Surfaces: frosted panels `bg-white/[0.06]`, `backdrop-blur-xl`, `border border-indigo-300/25`, `shadow-2xl shadow-indigo-950/40`, rounded corners. Darker inner wells for inputs/status rows.
- Accents: primary buttons `bg-gradient-to-r from-indigo-500 to-cyan-500`; live/valid status `text-emerald-300`; demo/session caveats `text-amber-300`; muted metadata `text-indigo-200/70`.
- Typography: system sans stack only, strong display weight for headlines, uppercase tracking for small labels, no external font requests.
- Motion: subtle hover/transition on buttons and cards only; respect `prefers-reduced-motion`.
- Accessibility: visible focus rings, real `<label>` elements, semantic headings/landmarks, sufficient contrast, errors announced via existing text nodes (optionally `role="alert"`).

## Behavior preservation and tests

No changes to: SSR timestamp loader, client counter, `square` server function validation, `/api/login`, `/api/session`, `/api/logout`, `_authed` guard, `fetchUser`, probe identity, or the KEYALL cache policy.

All existing IDs used by `test/fullstack-tanstack-start.test.ts` must remain: `ssr-time`, `about-link`, `count`, `increment`, `square-form`, `value`, `square-submit`, `square-result`, `square-error`, `login-error`, `profile-email`. Tests must still pass unchanged except for any purely additive accessibility assertion.

Verification before live update:
1. `cd examples/fullstack/tanstack-start && bun install --frozen-lockfile && bun run build`.
2. Rebuild native artifact (`bun run build:artifact`).
3. From repo root: focused TanStack tests, full `bun test`, `bun run build`, `bun run test:types`, `bun run test:types:cognito`.
4. Rebuild Linux Arm64 artifact with the pinned container command used in the prior task.
5. Run Impeccable's mechanical detector **once** on the changed UI files: `scripts/impeccable detect --json <changed targets>`; fix everything it reports in one batch, then stop.

## Live update

Update the retained `FullstackTanStackStart` stack in place using profile `jolo`, account `246350246460`, region `eu-central-1`, the same `cdk-app.ts`, and a fresh shell-only `FULLSTACK_SESSION_PASSWORD` (rotating it invalidates existing demo sessions, which is acceptable). Bounded checks: CloudFront URL loads, SSR timestamp visible, `/login` styled card, valid login, `/profile` styled card, square mutation/error states, hashed CSS/JS assets return 200 with immutable caching, unsigned direct origin 403. Keep the stack deployed and record the final URL and any changed identifiers in `examples/fullstack/shared/live-resources.md`. No cleanup.

## Risks and limitations

- Tailwind 4 Vite plugin compatibility with pinned Vite 8 must be verified by build; if `?url` CSS import fails, use a direct CSS import in the client entry and record the deviation rather than changing the framework version.
- A fresh session secret invalidates cookies issued by the previous retained deployment.
- Browser hydration/click behavior and streaming timing remain unverified unless a browser pass is added; visual inspection of rendered pages is not proof of hydration.
- The unauthenticated `/profile` route still returns HTTP 500 via the error boundary; this visual change does not alter that behavior.
