# Design System Master File

> **LOGIC:** When building a specific page, first check `design-system/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

---

**Project:** CodeHarbor Console
**Generated:** 2026-11-16 15:27:26
**Category:** Developer Tool / IDE
**Design Dials:** Variance 2/10 (Centered / Minimal) | Motion 2/10 (Subtle) | Density 8/10 (Dense / Dashboard)

---

## Global Rules

### Color Palette

| Role | Hex | CSS Variable |
|------|-----|--------------|
| Primary | `#1E293B` | `--color-primary` |
| On Primary | `#FFFFFF` | `--color-on-primary` |
| Secondary | `#334155` | `--color-secondary` |
| On Secondary | `#FFFFFF` | `--color-on-secondary` |
| Accent/CTA | `#22C55E` | `--color-accent` |
| On Accent/CTA | `#0F172A` | `--color-on-accent` |
| Background | `#0F172A` | `--color-background` |
| Foreground | `#F8FAFC` | `--color-foreground` |
| Card | `#1B2336` | `--color-card` |
| Card Foreground | `#F8FAFC` | `--color-card-foreground` |
| Muted | `#272F42` | `--color-muted` |
| Muted Foreground | `#94A3B8` | `--color-muted-foreground` |
| Border | `#475569` | `--color-border` |
| Destructive | `#EF4444` | `--color-destructive` |
| On Destructive | `#000000` | `--color-on-destructive` |
| Ring | `#FFFFFF` | `--color-ring` |

**Color Notes:** Code dark + run green. Dark is the default theme (Developer Tool category). A light theme is supported through the same token names; see the light mapping below.

**Light theme mapping (`[data-theme="light"]`)** — same semantic tokens, slate family, verified 4.5:1 text contrast:

| Role | Hex |
|------|-----|
| Primary | `#0F172A` |
| Secondary | `#334155` |
| Accent/CTA | `#15803D` (green-700, white text passes 4.5:1) |
| On Accent/CTA | `#FFFFFF` |
| Background | `#F8FAFC` |
| Foreground | `#020617` |
| Card | `#FFFFFF` |
| Muted | `#E8ECF1` |
| Muted Foreground | `#475569` |
| Border | `#E2E8F0` |
| Destructive | `#DC2626` |
| On Destructive | `#FFFFFF` |
| Ring | `#0F172A` |

**Status tokens (semantic, never raw hex in components).** Badges use a 15% tinted background of the status color with the status color as text, plus an icon and a label — color is never the only signal.

| Token | Dark text / tint | Light text / tint | Used for |
|-------|------------------|-------------------|----------|
| `--status-ready` | `#4ADE80` / `#22C55E26` | `#15803D` / `#22C55E1F` | `ready`, job `succeeded` |
| `--status-progress` | `#60A5FA` / `#3B82F626` | `#1D4ED8` / `#3B82F61F` | `indexing`, `updating`, job `running` |
| `--status-pending` | `#94A3B8` / `#64748B26` | `#475569` / `#64748B1F` | `pending`, job `queued`, `disabled` |
| `--status-warning` | `#FBBF24` / `#F59E0B26` | `#B45309` / `#F59E0B1F` | `credential_required`, `branch_deleted`, `stale` |
| `--status-error` | `#F87171` / `#EF444426` | `#B91C1C` / `#EF44441F` | `failed`, job `failed` |

### Typography

- **Heading Font:** Inter (weights 500 / 600)
- **Body Font:** Inter (weights 400 / 500)
- **Mono Font:** Fira Code (weights 400 / 500) — commit SHA, key prefix, tokens, webhook paths, JSON config snippets, audit `query_hash`
- **Mood:** minimal, clean, swiss, functional, neutral, professional

**Loading rule:** the `/ui` CSP is `default-src 'self'`; no Google Fonts or any CDN. Self-host via npm packages bundled by Vite:

```css
/* web/src/styles/fonts.css */
@import '@fontsource-variable/inter';
@import '@fontsource/fira-code/400.css';
@import '@fontsource/fira-code/500.css';

:root {
  --font-sans: 'Inter Variable', ui-sans-serif, system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  --font-mono: 'Fira Code', ui-monospace, SFMono-Regular, Menlo, monospace;
}
```

Chinese glyphs fall back to the system CJK font (PingFang / Microsoft YaHei); do not bundle a CJK webfont.

**Type scale (base 16px, line-height 1.5):**

| Token | Size / Line | Weight | Usage |
|-------|-------------|--------|-------|
| `--text-xs` | 12px / 16px | 400 | Table meta, timestamps, helper text (never body copy) |
| `--text-sm` | 14px / 20px | 400 / 500 | Table cells, form labels, badges, secondary nav |
| `--text-base` | 16px / 24px | 400 | Body, inputs, primary nav |
| `--text-lg` | 18px / 28px | 600 | Card titles, dialog titles |
| `--text-xl` | 20px / 28px | 600 | Page titles (`h1`, one per page) |
| `--text-2xl` | 24px / 32px | 600 | Onboarding step headline only |

### Spacing Variables

*Density: 8/10 — Dense / Dashboard*

| Token | Value | Usage |
|-------|-------|-------|
| `--space-xs` | `2px` / `0.125rem` | Tight gaps |
| `--space-sm` | `4px` / `0.25rem` | Icon gaps, inline spacing |
| `--space-md` | `8px` / `0.5rem` | Standard padding |
| `--space-lg` | `12px` / `0.75rem` | Section padding |
| `--space-xl` | `16px` / `1rem` | Large gaps |
| `--space-2xl` | `24px` / `1.5rem` | Section margins |
| `--space-3xl` | `32px` / `2rem` | Hero padding |

### Shadow Depths

| Level | Value | Usage |
|-------|-------|-------|
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.05)` | Subtle lift |
| `--shadow-md` | `0 4px 6px rgba(0,0,0,0.1)` | Cards, buttons |
| `--shadow-lg` | `0 10px 15px rgba(0,0,0,0.1)` | Modals, dropdowns |
| `--shadow-xl` | `0 20px 25px rgba(0,0,0,0.15)` | Hero images, featured cards |

---

## Component Specs

Implementation: shadcn/ui (Radix primitives + Tailwind 4) with the CSS variables above wired into `@theme`. Component-level rules below override shadcn defaults where they differ.

### Buttons

- Height 36px (`sm` 32px in table rows, min hit area kept at 44px via padding on touch); radius 6px; weight 500; `cursor: pointer`.
- Primary = solid `--color-accent` / `--color-on-accent`; Secondary = outline `--color-border`; Ghost = no border (toolbar / row actions); Destructive = solid `--color-destructive`.
- Hover: background shifts 8% (`color-mix`), 150ms; no `translateY`, no scale (table rows must not shift).
- Loading: spinner replaces icon, label stays, `aria-busy="true"`, button disabled.
- Icon-only buttons require `aria-label`; prefer icon + text in forms and dialogs.

```css
.btn-primary {
  background: var(--color-accent);
  color: var(--color-on-accent);
  height: 36px;
  padding: 0 14px;
  border-radius: 6px;
  font-weight: 500;
  transition: background-color 150ms ease, box-shadow 150ms ease;
  cursor: pointer;
}
.btn-primary:hover { background: color-mix(in srgb, var(--color-accent) 92%, white); }
.btn-primary:focus-visible { outline: 2px solid var(--color-ring); outline-offset: 2px; }
```

### Cards

- Background `--color-card`, 1px `--color-border`, radius 8px, padding 16px (density 8). Shadow `--shadow-sm` only; no hover lift unless the whole card is a link (then `border-color` change only).
- Status card header: title left, status badge right, metadata as a 2-column definition list (`dl`) with `--text-sm` labels in `--color-muted-foreground`.

### Inputs

- Height 36px, padding 0 12px, radius 6px, `--text-base`, border `--color-border`, background `--color-background`.
- Visible label above every input (never placeholder-only); helper text below in `--text-xs`; error text in `--status-error` below the helper, linked with `aria-describedby`, `aria-invalid="true"`.
- Focus: `outline: 2px solid var(--color-ring); outline-offset: 2px;` — outlines are never removed.
- Secret inputs (PAT, Key): `type="password"` with show/hide toggle, `autocomplete="off"`, `spellcheck="false"`.

### Tables

- Row height 40px, header 36px sticky, cell padding 0 12px, `--text-sm`, zebra off, 1px row borders.
- First column is the entity name (link); status badge column fixed width; monospace columns (`SHA`, prefix) use `--font-mono`.
- Wrap in `overflow-x: auto`; below 768px repository and key lists switch to a card list.
- Empty state: icon + one sentence + the single primary next action.
- Loading: skeleton rows reserving the same height (no CLS); refetch while data exists shows a thin top progress bar, not a skeleton.

### Badges (status)

- Height 22px, padding 0 8px, radius 999px, `--text-xs` weight 500, `white-space: nowrap`.
- Content: 14px icon + label; progress states use a rotating icon with `prefers-reduced-motion` fallback to a static icon.
- Container for async changes: `<span role="status" aria-atomic="true">索引状态：构建中</span>`.

### Modals / Dialogs

- Max width 480px (640px for the secret reveal and the Codeup repository picker), radius 12px, padding 24px, overlay `rgba(2,6,23,0.6)`, no backdrop blur.
- Focus trapped; first focusable element is the primary input or the Cancel button for destructive dialogs; Escape closes unless the dialog is a secret reveal.
- Destructive dialogs: title states the action and target name, body states consequence, confirmation input for delete, destructive button right-most.

### Secret Reveal (project-specific)

- Used for CodeHarbor Key, bootstrap token, webhook token. Value rendered in `--font-mono` inside a bordered box, masked by default with a show/hide toggle, a Copy button with "已复制" feedback (toast + inline state, 2s).
- Close button is disabled until the "我已妥善保存" checkbox is checked; Escape and overlay click do not close.
- The value is never written to storage, URL, or logs; the component clears it from state on close.

### Toasts

- Bottom-right, 4s auto dismiss for success, persistent until dismissed for errors; include `x-request-id` in error toasts as copyable mono text.

---

## Style Guidelines

**Style:** Minimalism & Swiss Style

**Keywords:** Clean, simple, spacious, functional, white space, high contrast, geometric, sans-serif, grid-based, essential

**Best For:** Enterprise apps, dashboards, documentation sites, SaaS platforms, professional tools

**Key Effects:** Subtle hover (200-250ms), smooth transitions, sharp shadows if any, clear type hierarchy, fast loading

### Page Pattern

The generator matched a documentation landing pattern, which does not apply: CodeHarbor Console is an authenticated application shell, not a marketing site. Use the **Console App Shell** pattern instead:

- **Shell:** fixed left sidebar 240px (collapses to icon rail 56px at 1024px, to a drawer below 768px) + top bar 48px (page title / breadcrumb left; user chip with username, key prefix in mono, scope badge, theme toggle, logout right) + content area with max width 1280px and 24px padding.
- **Navigation groups:** 仓库 / Key / MCP 接入 ; 管理（仅管理 Key 可见）: 仓库、用户、Key、审计. Active item: 2px accent bar on the left + `--color-muted` background. Never more than two levels.
- **Page template:** `h1` title + optional one-line description + primary action top-right; filters toolbar; content (table / cards); no hero sections.
- **Onboarding wizard:** centered single column 560px, a 3-step `Stepper` on top, one task per step, Back/Next bottom, progress persists only in memory.
- **Breadcrumbs:** only on detail pages (仓库 > 名称), since depth never exceeds 3.

### Iconography

- One family: **Phosphor Icons** (`@phosphor-icons/react`), weight `regular`, 16px in tables/badges, 20px in nav/buttons. No emoji, no mixed sets.
- Decorative icons next to visible text: `aria-hidden="true"`. Icon-only controls: `aria-label`.
- Reserved mapping: `GitBranch` repository, `Key` keys, `Plugs` MCP, `ShieldCheck` admin, `ArrowsClockwise` sync, `CheckCircle` ready, `CircleNotch` in progress, `Warning` warning states, `XCircle` failed, `Prohibit` disabled, `Copy` copy, `Eye`/`EyeSlash` reveal.

---

## Motion

Motion dial 2/10. An admin console does not need scroll-triggered choreography or GSAP; use CSS transitions only and keep the bundle free of animation libraries.

| Interaction | Duration / Easing | Notes |
|-------------|-------------------|-------|
| Hover / focus color change | 150ms `ease` | Background, border, text color only |
| Dialog / drawer enter | 200ms `cubic-bezier(0.16, 1, 0.3, 1)` | Fade + 8px translate; exit 150ms (exit faster than enter) |
| Toast enter / exit | 200ms / 150ms | Slide 12px from bottom |
| Status badge change | 200ms `ease` | Cross-fade color; no size change |
| In-progress spinner | 1s linear infinite | `CircleNotch`; static icon under reduced motion |
| Skeleton shimmer | 1.5s linear infinite | Disabled under reduced motion (solid muted block) |

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}
```

Never animate `width`, `height`, or layout-affecting properties; never use `transform: scale()` on list rows.

---

## Anti-Patterns (Do NOT Use)

- ❌ Light mode default (dark is default; light is an explicit user toggle persisted in `localStorage` — theme preference is not a secret)
- ❌ Slow performance
- ❌ External resources of any kind (fonts, icons, scripts, analytics) — CSP is `default-src 'self'`
- ❌ Showing a secret value (Key, token) anywhere except the Secret Reveal dialog
- ❌ Placeholder-only labels on PAT / Key / ID inputs
- ❌ Relying on badge color alone to convey repository status
- ❌ Hover-lift transforms on table rows or cards inside lists

### Additional Forbidden Patterns

- ❌ **Emojis as icons** — Use SVG icons (Phosphor regular; Heroicons outline only as fallback)
- ❌ **Missing cursor:pointer** — All clickable elements must have cursor:pointer
- ❌ **Layout-shifting hovers** — Avoid scale transforms that shift layout
- ❌ **Low contrast text** — Maintain 4.5:1 minimum contrast ratio
- ❌ **Instant state changes** — Always use transitions (150-300ms)
- ❌ **Invisible focus states** — Focus states must be visible for a11y

---

## Pre-Delivery Checklist

Before delivering any UI code, verify:

- [ ] No emojis used as icons (use SVG instead)
- [ ] All icons from one set (Phosphor regular)
- [ ] `cursor-pointer` on all clickable elements
- [ ] Hover states with smooth transitions (150-300ms)
- [ ] Dark and light mode: text contrast 4.5:1 minimum, status badges 4.5:1 on their tint
- [ ] Focus states visible for keyboard navigation; dialogs trap focus
- [ ] `prefers-reduced-motion` respected (spinner, skeleton, dialogs)
- [ ] Responsive: 375px, 768px, 1024px, 1440px; tables degrade to cards below 768px
- [ ] No content hidden behind fixed navbars
- [ ] No horizontal scroll on mobile
- [ ] Every form error is inline and linked via `aria-describedby`
- [ ] Every async status change is announced through a single `role="status"` region
- [ ] Secret values only appear in the Secret Reveal dialog and are cleared on close
- [ ] Bundle contains no external URL references (`grep -r "https://" dist/ui/assets` is empty apart from documentation links)
