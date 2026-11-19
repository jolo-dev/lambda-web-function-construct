# TanStack Start Aurora Glass Tailwind Restyle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the retained TanStack Start Web Function demo with Tailwind CSS 4 in the approved Aurora Glass direction: split hero + live-proof home page and centered glass login/profile cards, with no behavior changes and no cleanup of the live stack.

**Architecture:** Add `@tailwindcss/vite` and a single CSS entry with Aurora design tokens/component classes; import it through TanStack's document head so it emits a hashed CSS asset under `/assets/*`, already served by the existing S3/CloudFront behavior. Replace markup only, keeping loader/server functions/session logic and all tested strings intact.

**Tech Stack:** TanStack Start 1.169.5, React 19.2.5, Vite 8, Tailwind CSS 4, Bun 1.4.4, Node.js 24 Linux Arm64 artifact build, AWS CDK WebFunction/WebFunctionDelivery.

---

## File structure

- Modify: `examples/fullstack/tanstack-start/package.json`, `bun.lock`, `vite.config.ts`
- Create: `examples/fullstack/tanstack-start/src/styles/app.css`
- Modify: `examples/fullstack/tanstack-start/src/routes/__root.tsx`, `index.tsx`, `login.tsx`, `about.tsx`, `_authed/profile.tsx`, `src/components/LoginPanel.tsx`, `src/routes/_authed.tsx`
- Modify: `test/fullstack-tanstack-start.test.ts` for additive copy assertions
- Update: `examples/fullstack/tanstack-start/README.md`, `examples/fullstack/shared/README.md`, plan record
- Git-ignored artifacts: `examples/fullstack/artifacts/tanstack-start/{native-darwin-arm64,linux-arm64}`
- No changes to `src/web-function*.ts`, `stack.ts`, or CDK delivery policy

---

### Task 1: Tailwind 4 setup and document stylesheet

**Files:**
- Modify: `examples/fullstack/tanstack-start/package.json`, `bun.lock`, `vite.config.ts`
- Create: `examples/fullstack/tanstack-start/src/styles/app.css`
- Modify: `examples/fullstack/tanstack-start/src/routes/__root.tsx`
- Test: `test/fullstack-tanstack-start.test.ts`

- [ ] **Step 1: Add a failing CSS-asset test**

Add to `test/fullstack-tanstack-start.test.ts` in the staged-artifact describe block:

```ts
test("stages a hashed Tailwind stylesheet linked from the SSR document head", () => {
  requireArtifact();
  const css = listFiles(path.join(ARTIFACT_ROOT, "dist", "client", "assets"), ".css");
  expect(css.length).toBeGreaterThan(0);
  const html = new TextDecoder().decode((await getBounded(baseUrl(), "/")).body);
  expect(html).toMatch(/rel="stylesheet"/);
  expect(html).toMatch(/href="\/assets\/[^"]+\.css"/);
});
```

Convert the enclosing test callback to `async` if needed. The test must not change existing ID/copy assertions.

- [ ] **Step 2: Verify RED**

Run: `cd /Users/jolo/Development/lambda-web-function-construct && bun test test/fullstack-tanstack-start.test.ts -t "hashed Tailwind stylesheet"`
Expected: FAIL (no `.css` asset / no stylesheet link).

- [ ] **Step 3: Install Tailwind and register the Vite plugin**

Run: `cd examples/fullstack/tanstack-start && bun add -d tailwindcss@^4.2.2 @tailwindcss/vite@^4.2.2`

Replace `vite.config.ts` with:

```ts
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss(), tanstackStart()],
});
```

- [ ] **Step 4: Create the Aurora CSS entry**

Create `src/styles/app.css`:

```css
@import "tailwindcss";

@theme {
  --color-aurora-950: #0b1120;
  --color-aurora-900: #0f172a;
  --color-aurora-800: #1e1b4b;
  --color-aurora-indigo: #818cf8;
  --color-aurora-cyan: #22d3ee;
  --color-aurora-mint: #6ee7b7;
  --color-aurora-amber: #fbbf24;
  --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}

@layer base {
  html { color-scheme: dark; }
  body {
    margin: 0;
    min-height: 100vh;
    font-family: var(--font-sans);
    color: #e0e7ff;
    background:
      radial-gradient(circle at 12% 8%, rgba(99, 102, 241, 0.28), transparent 34rem),
      radial-gradient(circle at 88% 12%, rgba(34, 211, 238, 0.16), transparent 30rem),
      linear-gradient(140deg, var(--color-aurora-800), var(--color-aurora-900) 58%, var(--color-aurora-950));
    background-attachment: fixed;
  }
}

@layer components {
  .aurora-shell { @apply mx-auto w-full max-w-6xl px-5 py-8 sm:px-8 sm:py-12; }
  .aurora-card {
    @apply rounded-2xl border border-indigo-300/25 bg-white/[0.06] p-6 shadow-2xl shadow-indigo-950/40 backdrop-blur-xl;
  }
  .aurora-card-tight { @apply rounded-xl border border-indigo-300/20 bg-white/[0.04] p-4; }
  .aurora-label { @apply text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-indigo-200/70; }
  .aurora-button {
    @apply inline-flex items-center justify-center rounded-xl bg-gradient-to-r from-indigo-500 to-cyan-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-950/40 transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300;
  }
  .aurora-input {
    @apply w-full rounded-xl border border-indigo-300/25 bg-aurora-950/50 px-3 py-2 text-sm text-indigo-50 placeholder:text-indigo-200/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300;
  }
  .aurora-link { @apply text-indigo-200 underline-offset-4 hover:text-cyan-200 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300; }
  .aurora-ok { @apply text-emerald-300; }
  .aurora-warn { @apply text-amber-300; }
  .aurora-button:disabled { @apply cursor-not-allowed opacity-50; }
}

::selection { background: rgba(34, 211, 238, 0.32); color: #f8fafc; }
input, textarea { caret-color: var(--color-aurora-cyan); }
* { scrollbar-color: rgba(165, 180, 252, 0.4) transparent; scrollbar-width: thin; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
}
```

- [ ] **Step 5: Link the stylesheet from the document head**

In `src/routes/__root.tsx`, add near the imports:

```ts
import appCss from "../styles/app.css?url";
```

Add to `head`:

```ts
links: [{ rel: "stylesheet", href: appCss }],
```

Keep `meta`, `beforeLoad`, and components unchanged.

- [ ] **Step 6: GREEN and commit**

Run:
```bash
cd examples/fullstack/tanstack-start && bun run build && bun run build:artifact
cd /Users/jolo/Development/lambda-web-function-construct && bun test test/fullstack-tanstack-start.test.ts
```
Expected: new CSS test passes; all existing focused tests pass. Commit with `git commit -m "Add Tailwind Aurora stylesheet setup"`.

---

### Task 2: Split hero + live-proof home page

**Files:**
- Modify: `examples/fullstack/tanstack-start/src/routes/index.tsx`
- Test: `test/fullstack-tanstack-start.test.ts`

- [ ] **Step 1: Add failing copy test**

Add a focused test asserting the new hero copy appears in the first HTML response:

```ts
test("renders the Aurora split hero copy", async () => {
  const html = new TextDecoder().decode((await getBounded(baseUrl(), "/")).body);
  expect(html).toContain("The whole stack, running live.");
  expect(html).toContain("CloudFront");
  expect(html).toContain("Web Function");
});
```

- [ ] **Step 2: Verify RED**

Run: `bun test test/fullstack-tanstack-start.test.ts -t "Aurora split hero"`
Expected: FAIL on missing hero copy.

- [ ] **Step 3: Replace home markup only**

Keep the `square` server function, route `loader`, state (`count`, `value`, `result`, `error`), and `submit` handler byte-for-byte. Replace the `Home` JSX with a `<main className="aurora-shell">` containing:
- top nav with a CSS-drawn mark (a small cyan-to-indigo rounded bar, no Unicode glyph) plus the wordmark `TanStack Start / Web Function`, links `About` (`id="about-link"`), `Sign in`, `Profile`;
- `section` with `lg:grid lg:grid-cols-[1.2fr_0.8fr] gap-8 items-center`;
- left column: `h1` containing exactly `The whole stack, running live.` with no eyebrow/kicker above it, followed by a `max-w-prose` subtitle mentioning `CloudFront` and `Web Function`;
- right column: `aside.aurora-card` with a small `DEPLOYED PROOF` label in the card header (not above a heading), rows `GET /` + a CSS status dot and `200`, `SSR` + timestamp (`id="ssr-time"`, exact prefix `Rendered on the server at`), `app-session` + `SECURE`, and a cyan/indigo gradient progress bar;
- lower grid with two `section.aurora-card-tight` panels: counter (`id="count"`, button `id="increment"`) and square form (`id="square-form"`, input `id="value"`, button `id="square-submit"`, result/error IDs preserved).
Use Tailwind utility classes plus the shared component classes from `app.css`. No external assets.

- [ ] **Step 4: GREEN and commit**

Run `bun test test/fullstack-tanstack-start.test.ts`; expect all focused tests pass including all pre-existing copy assertions. Commit `git commit -m "Restyle TanStack home page in Aurora Glass"`.

---

### Task 3: Centered auth surfaces and supporting pages

**Files:**
- Modify: `examples/fullstack/tanstack-start/src/components/LoginPanel.tsx`, `src/routes/login.tsx`, `src/routes/_authed/profile.tsx`, `src/routes/about.tsx`, `src/routes/_authed.tsx`
- Test: `test/fullstack-tanstack-start.test.ts`

- [ ] **Step 1: Add failing auth-copy tests**

```ts
test("renders centered Aurora auth cards", async () => {
  const login = new TextDecoder().decode((await getBounded(baseUrl(), "/login")).body);
  expect(login).toContain("Welcome back");
  expect(login).toContain("DEMO SESSION");
  const profile = await fetch(new URL("/profile", baseUrl()), {
    headers: { cookie: "invalid" },
    signal: AbortSignal.timeout(10_000),
  });
  const html = await profile.text();
  expect(html).toContain("Sign in");
});
```

- [ ] **Step 2: Verify RED**

Run: `bun test test/fullstack-tanstack-start.test.ts -t "centered Aurora auth"`
Expected: FAIL on "Welcome back" / "DEMO SESSION".

- [ ] **Step 3: Restyle LoginPanel**

Remove the inline `panelCss` `<style>` block entirely. Keep `useNavigate`, `useState`, JSON POST to `/api/login`, error message, and navigation. Render a centered card:
`<section className="aurora-card mx-auto w-full max-w-md">`, label `aurora-label` with `DEMO SESSION`, `h1` "Welcome back", two labeled inputs using `aurora-input`, an error `<p id="login-error" role="alert" className="aurora-warn">`, demo credential hint, and a full-width `aurora-button`. Preserve exact strings `Sign in`, `demo@example.com`, `demo-password`.

- [ ] **Step 4: Restyle login/profile/about/guard shells**

- `login.tsx`: `<main className="aurora-shell"><LoginPanel /></main>` (no duplicate `<h1>`).
- `_authed/profile.tsx`: centered `aurora-card` with `aurora-label` "ACCOUNT", `<h1>Protected profile</h1>`, `<p id="profile-email">`, session detail line, and a logout button/link to `/api/logout`; use `aurora-warn` for the stateless caveat note.
- `about.tsx`: centered `aurora-card` that keeps the `<h1>About this example</h1>` heading and the `id="about-text"` paragraph with exact copy "This page proves TanStack Start navigation and hydration work on a Web Function." preserved.
- `_authed.tsx`: keep guard logic and error message identical; only wrap the `LoginPanel` error output in `<main className="aurora-shell">` if needed.

- [ ] **Step 5: GREEN and commit**

Run `bun test test/fullstack-tanstack-start.test.ts`; expect all focused tests pass, including auth, copy, and stateless logout tests. Commit `git commit -m "Restyle TanStack auth surfaces in Aurora Glass"`.

---

### Task 4: Full verification, Impeccable detector, and artifacts

**Files:** git-ignored artifacts; docs as needed.

- [ ] **Step 1: Local checks**

From repo root:
```bash
bun test test/fullstack-tanstack-start.test.ts
bun test
bun run build
bun run test:types
bun run test:types:cognito
```
Expected: all pass (baseline 212 plus additive copy/CSS tests), JSII 0 errors/warnings.

- [ ] **Step 2: Run Impeccable detector once**

From repo root:
```bash
/Users/jolo/.pi/agent/skills/impeccable/scripts/impeccable detect --json \
  examples/fullstack/tanstack-start/src/routes/index.tsx \
  examples/fullstack/tanstack-start/src/routes/login.tsx \
  examples/fullstack/tanstack-start/src/routes/about.tsx \
  examples/fullstack/tanstack-start/src/routes/_authed/profile.tsx \
  examples/fullstack/tanstack-start/src/components/LoginPanel.tsx \
  examples/fullstack/tanstack-start/src/styles/app.css
```
Fix every reported issue in one batch, re-run once at most to confirm, then stop. If the launcher fails, report it rather than claiming the gate ran.

- [ ] **Step 3: Rebuild artifacts**

```bash
cd examples/fullstack/tanstack-start && bun run build:artifact
cd /Users/jolo/Development/lambda-web-function-construct
bash examples/fullstack/shared/build-arm64.sh examples/fullstack/tanstack-start -- sh -c 'set -e; npm install --prefix /tmp/bun bun@1.4.4 >/dev/null 2>&1; BUN=/tmp/bun/node_modules/.bin/bun; rm -rf /tmp/build; mkdir -p /tmp/build; cp -a /app/. /tmp/build/; rm -rf /tmp/build/node_modules /tmp/build/dist; cd /tmp/build; "$BUN" install --frozen-lockfile; node build-artifact.mjs'
```
Expected: both artifacts contain hashed CSS in `dist/client/assets` and Tailwind classes in client JS; arm64 platform check passes.

- [ ] **Step 4: Commit docs/review fixes**

Update example/shared READMEs to mention Tailwind CSS and Aurora Glass styling. Commit with `git commit -m "Document Aurora Glass TanStack restyle"`.

---

### Task 5: In-place live update of retained stack (no cleanup)

**Files:** plan record and live-resources docs only.

- [ ] **Step 1: Preflight**

Verify profile `jolo`, account `246350246460`, region `eu-central-1`, stack `FullstackTanStackStart` exists, and generate a fresh ≥32-char `FULLSTACK_SESSION_PASSWORD` in the shell only.

- [ ] **Step 2: Deploy update in place**

```bash
FULLSTACK_SESSION_PASSWORD='<fresh shell-only value>' \
AWS_PROFILE=jolo AWS_REGION=eu-central-1 \
CDK_DEFAULT_ACCOUNT=246350246460 CDK_DEFAULT_REGION=eu-central-1 \
bunx cdk deploy FullstackTanStackStart \
  --app 'bun run examples/fullstack/cdk-app.ts' --require-approval never
```
Bounded: ≤100 HTTP requests, ≤10 min propagation wait, stop on unexpected failure. Do **not** destroy the stack.

- [ ] **Step 3: Verify live visual and behavior**

Through CloudFront: home 200 with Aurora copy + stylesheet link; hashed CSS asset 200 with immutable cache headers; `/login` 200 with "Welcome back"; invalid login 401; valid login secure cookie; `/profile` authed shows email; square valid/invalid; `/about`; direct unsigned 403. Use the browser companion/harness to inspect the rendered desktop page and capture findings; fix visual defects in one batch if found.

- [ ] **Step 4: Record and commit**

Update this plan with a Task 5 execution record and update `examples/fullstack/shared/live-resources.md` with the current URL/distribution/endpoint and the fact that the stack is retained. Commit docs only with `git commit -m "Record Aurora live update"`. No cleanup command should be run.
