# AWOS design system

The UI foundation is code-owned in [`src/index.css`](./src/index.css). Its contract is
deliberately small:

`tokens -> existing primitives -> product patterns`

## Tokens

- **Surfaces**: canvas, sunken, rail, raised, overlay, subtle, interactive, selected, and
  backdrop. Use `bg-background`/`bg-card` when a shadcn alias is the right role; use the
  `surface-*` names when the shell role needs to be explicit.
- **Text**: primary, secondary, muted, subtle, disabled, and inverse. Do not choose a
  palette color to create a new hierarchy level.
- **Borders and focus**: subtle, default, strong, input, and the shared focus ring. Every
  keyboard target keeps a visible focus treatment; color is not the only focus cue because
  the ring also has a two-pixel offset.
- **Radius, spacing, motion, and elevation**: control/panel/overlay radii, the small AWOS
  spacing scale, fast/base/slow motion timings, and control/panel/overlay shadows.
- **Operational states**: idle, busy, waiting, blocked, passed, failed, interrupted, and
  stale. Each state has foreground, surface, and border roles. State text or an icon must be
  present with the color: examples are `Running`, `Saved`, `Failed`, a spinner, or a check.
- **Diff states**: add, remove, modify, and neutral context each have text, surface, and
  highlight roles. Diff rows retain `+`/`−` markers, line numbers, and status labels so the
  meaning survives without color perception.

Light tokens are the default CSS set; the existing `html.dark` class selects the normal AWOS
dark presentation. No component owns a second theme or a literal replacement palette.

## Density

Chrome consumes the same density variables for control height, input padding, shell gutters,
header rhythm, and panel padding. `data-density="compact"` is the tight console setting;
`data-density="comfortable"` is the roomier setting. The existing transcript choices remain
`compact`, `normal`, and `verbose`: `normal` and `verbose` intentionally use comfortable
chrome while retaining their existing reasoning visibility behavior.

## Primitive rules

The existing `Button`, `Badge`, `Dialog`, and `Textarea` are the only generic primitives in
this package. They own focus, disabled, radius, motion, and semantic variant treatment.
Prefer an existing variant over a local color class. Radix owns dialog interaction and focus
return; AWOS owns the dialog surface and overlay presentation. Raw shell inputs may use the
shared `.awos-input` styling, but a new generic input primitive is not justified by this
foundation.

## Product-pattern ownership

Transcript rows, tool blocks, approvals, diff review, evidence, gates, the sidebar, and the
dock remain product patterns in their existing feature components. They may compose the
primitives and tokens, but product meaning must not leak into `Button` or `Badge`. This issue
does not add tabs, tooltips, sheets, commands, toasts, or another component layer.

## Worker identity

Worker identity comes from the profile id and label already supplied by the protocol. A single
stable hash selects a hue from the generic worker palette; the component supplies one
`--worker-hue` value and the shared `.awos-worker-*` rules derive text, surface, border, and dot
colors. Adding a worker profile does not require a CSS variable, selector, or component branch.
The profile label remains the source of truth for visible naming.

## Accessibility and prohibited styling

Use text, icons, markers, labels, or status text alongside state color. Keep `aria-pressed` on
segmented choices, `aria-expanded` on collapsible rows, dialog titles/descriptions, and
keyboard-visible focus. Do not encode meaning in color alone.

Do not add one-off hex/HSL colors, per-profile selectors, arbitrary state colors, duplicated
focus rings, new radius/spacing values, or local shadow/motion values. Do not create a new
primitive or product pattern until an existing consuming surface requires it and its ownership
is explicit.
