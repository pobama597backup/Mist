---
name: ui-ux-polish-accessibility
description: Trigger when building, reviewing, refactoring, auditing, or styling any website, app screen, dashboard, component, form, list, card, modal, navigation, loading state, color system, heading, subheading, helper text, button, or interactive UI element. Prevents common vibe-coded UI problems by enforcing skeleton loaders, semantic color tokens, low-clutter copy, clear labels, and accessibility standards.
---

# UI Polish, Loading States, Semantic Colors, Clutter Reduction & Accessibility Skill

## Purpose

This skill must be used whenever the user asks to create, improve, review, style, refactor, or audit a user interface, especially when the task involves:

- Loading states
- Data fetching
- Skeleton loaders
- Spinners
- Empty states
- Error states
- Color schemes
- Brand colors
- Design tokens
- Buttons, cards, forms, headers, dashboards, or navigation
- Page copy, headings, subheadings, helper text, or descriptions
- Accessibility
- Keyboard navigation
- Contrast
- Focus states
- Alt text
- Perceived performance
- UI clutter
- Vibe-coded apps or websites

The goal is to make the product feel faster, clearer, cleaner, more professional, and more accessible, while reducing the risk of accessibility complaints or legal exposure.

This skill does not provide legal advice. It applies practical UI and accessibility best practices and flags items that may require manual review, user testing, or professional accessibility/legal review.

---

## Mandatory Safety Rules

1. Never claim the UI is "fully accessible", "ADA compliant", "WCAG certified", or "lawsuit-proof".
2. Always state remaining accessibility risks if they cannot be verified automatically.
3. Do not remove helpful copy unless it is redundant, obvious, or not tangibly useful.
4. Do not add skeleton loaders everywhere without purpose. Use them only where async loading creates meaningful delay or layout shift.
5. Do not replace all brand colors with generic colors. Brand colors should be mapped into a semantic system.
6. Do not hard-code random hex colors across components when a design token or semantic color should be used.
7. Do not create fake loading states for instant content.
8. Do not introduce keyboard traps.
9. Do not use color alone to communicate success, danger, warning, status, or required state.
10. When unsure whether text is useful, flag it for review instead of silently deleting it.

---

## When This Skill Must Trigger

Use this skill automatically when the user asks for any of the following:

- "Make this UI better"
- "Clean up this screen"
- "Make this feel faster"
- "Add loading states"
- "Add skeleton loaders"
- "Use better colors"
- "Fix the color scheme"
- "Make this accessible"
- "Check accessibility"
- "Remove clutter"
- "Simplify this page"
- "Improve this dashboard"
- "Review this component"
- "Make this vibe-coded app look professional"
- "Check if my UI can get sued"
- "Add semantic colors"
- "Fix contrast"
- "Make buttons clearer"
- "Make this keyboard friendly"
- Any task involving screens, layouts, components, cards, lists, tables, forms, modals, drawers, navigation, headers, empty states, or async data

---

## Core UI Principles

When working on UI, always apply these four rules:

### 1. Reduce perceived latency with skeleton loaders

Use skeleton loaders for async content where loading delay is noticeable or layout shift is likely.

Skeleton loaders are placeholder shapes, usually gray bars or blocks, that approximate the layout of the final content.

Use skeleton loaders for:

- Feeds
- Lists
- Cards
- Tables
- Dashboards
- Profile headers
- Images
- Avatars
- Comments
- Search results
- Product grids
- Settings panels
- Analytics charts
- Any component that fetches remote data and changes layout

Rules for skeleton loaders:

1. Match the approximate layout of the final content.
2. Keep dimensions stable to reduce layout shift.
3. Use subtle shimmer or pulse animation only if it does not distract.
4. Respect prefers-reduced-motion.
5. Do not use skeleton loaders for content that appears instantly.
6. Do not use skeletons as fake progress.
7. Provide fallback error states and empty states.
8. If loading is short, a subtle spinner or no indicator may be better.
9. If loading may take a long time, explain what is happening or allow retry.
10. Ensure skeleton states are accessible and do not trap focus.

Preferred loading hierarchy:

1. Show cached data immediately if available.
2. Use skeleton loaders for structural async content.
3. Use spinners only for small inline actions or localized operations.
4. Use progress bars only when progress is meaningful.
5. Provide clear error and retry states.

Example pattern:

Bad:
- Show blank screen while fetching.
- Replace whole page with a giant spinner.
- Cause layout jump after data arrives.

Good:
- Show skeleton bars for title, description, list items, cards, or table rows.
- Preserve layout space.
- Swap skeleton for real content smoothly.
- Show error state if fetch fails.

---

### 2. Use semantic colors instead of raw brand colors everywhere

Applications should have both brand colors and semantic colors.

Brand colors define the product identity. Semantic colors define meaning and usage.

Do not scatter raw hex values like #3b82f6, #ef4444, or #10b981 across components unless they are part of a token system.

Use or create semantic color tokens such as:

Surface and layout:
- background
- surface
- surface-muted
- surface-raised
- border
- divider

Text:
- text-primary
- text-secondary
- text-muted
- text-disabled
- text-inverse

Brand and action:
- primary
- primary-hover
- primary-active
- accent
- accent-hover
- link
- link-hover
- focus-ring

Feedback:
- success
- warning
- danger
- info

State:
- selected
- disabled
- readonly
- overlay

Rules for semantic colors:

1. Prefer semantic tokens over raw color values in components.
2. Use brand colors through semantic mappings.
3. Ensure text contrast against backgrounds.
4. Ensure buttons have accessible text contrast.
5. Ensure focus rings are visible and do not disappear into the background.
6. Use danger colors for destructive actions, errors, and critical warnings.
7. Use success colors for confirmation and positive completion.
8. Use warning colors for caution states.
9. Do not rely on color alone to convey meaning.
10. Support dark mode through semantic tokens where possible.

If the project uses Tailwind CSS, prefer CSS variables, theme extensions, or semantic utility names.

If the project uses plain CSS, define CSS custom properties.

If the project uses a component library, follow its existing semantic color system before inventing a new one.

Example semantic token structure:

--color-background
--color-surface
--color-border
--color-text-primary
--color-text-secondary
--color-primary
--color-primary-hover
--color-danger
--color-success
--color-warning
--color-focus-ring

Bad:
- Buttons use random hex values in every component.
- Error text uses whatever red is nearby.
- Links and primary buttons share the same color without semantic distinction.
- Disabled state is just opacity with no accessible distinction.

Good:
- Components consume semantic tokens.
- Meaning is clear from the token name.
- Brand colors are mapped into the system.
- Dark mode can switch tokens without rewriting components.

---

### 3. Remove UI clutter and unnecessary explanatory text

Vibe-coded apps often contain too many redundant headings, subheadings, descriptions, and explanations.

A header like "My Day" is already useful. It usually does not need two sentences underneath explaining what "My Day" means.

Remove or reduce copy that is:

- Obvious
- Redundant
- Decorative but useless
- Repeating the heading
- Explaining standard UI patterns unnecessarily
- Making the layout feel crowded
- Distracting from the main task
- Not tangibly useful

Keep copy that is:

- Actionable
- Helpful in empty states
- Needed for errors
- Needed for onboarding
- Needed for unusual UI behaviour
- Needed for legal, privacy, consent, security, or trust purposes
- Needed to clarify non-obvious consequences

Rules for clutter reduction:

1. If a heading is self-explanatory, do not add a redundant subtitle.
2. If helper text repeats the label, remove it.
3. If a description only restates the page title, remove it.
4. If a section needs explanation, make the explanation short and useful.
5. Prefer one clear sentence over multiple vague sentences.
6. Use progressive disclosure for advanced details.
7. Keep empty states helpful and action-oriented.
8. Keep error states specific and recoverable.
9. Do not remove consent, privacy, legal, refund, terms, or compliance copy.
10. If unsure whether copy is useful, flag it instead of deleting silently.

Example:

Bad:
Heading: My Day
Subheading: This is your My Day page. Here you can view your tasks, events, and schedule for the day.

Better:
Heading: My Day
No subtitle needed.

Useful exception:
Heading: My Day
Helper text: Tasks sync from your connected calendar.

The second helper text is useful because it explains system behaviour.

---

### 4. Check accessibility standards because inaccessible UI can create legal risk

Accessibility is not optional. Inaccessible applications can harm users and create complaints, reputational damage, and legal exposure.

Target WCAG 2.1 AA or WCAG 2.2 AA where practical.

Always check:

Semantic HTML:
- Use real buttons for actions.
- Use real links for navigation.
- Use headings in logical order.
- Use landmarks such as header, nav, main, footer where appropriate.
- Avoid divs pretending to be interactive controls unless ARIA is correctly implemented.

Keyboard accessibility:
- All interactive elements must be keyboard reachable.
- Focus order must be logical.
- Focus must be visible.
- Menus, dialogs, tabs, accordions, dropdowns, and carousels must work by keyboard.
- Forms must be submittable by keyboard.
- No keyboard traps.

Forms:
- Every input needs a visible label.
- Placeholder text must not be the only label.
- Required fields should be clearly marked.
- Error messages should be linked to fields.
- Errors should be announced accessibly.
- Success and failure states should be clear.

Images and media:
- Meaningful images need alt text.
- Decorative images should use empty alt text.
- Icon buttons need accessible names.
- Video should have captions or transcripts where meaningful.
- Audio should provide transcript where meaningful.

Colour and contrast:
- Normal text should usually meet at least 4.5:1 contrast.
- Large text may meet at least 3:1 contrast.
- Buttons, links, placeholders, disabled states, and error text must be readable.
- Do not rely on colour alone.
- Focus indicators must be visible.

Motion:
- Respect prefers-reduced-motion.
- Avoid unnecessary animation.
- Avoid flashing content.
- Ensure carousels and auto-playing content can be paused or stopped where required.

ARIA:
- Use ARIA only when semantic HTML is not enough.
- Do not add ARIA incorrectly.
- Ensure interactive custom components have correct roles, names, states, and keyboard behaviour.
- Modals should manage focus and escape behaviour.
- Live regions should be used carefully for async updates.

Rules for accessibility:

1. Do not create custom controls if native HTML works.
2. Do not remove focus outlines without replacing them with a visible alternative.
3. Do not use icon-only buttons without accessible labels.
4. Do not create placeholders as the only form labels.
5. Do not make text too light or too small.
6. Do not create hover-only interactions.
7. Do not hide important information behind colour-only indicators.
8. Do not assume a component library is fully accessible without checking.
9. Do not mark accessibility complete without manual keyboard testing.
10. Flag uncertain accessibility issues instead of guessing.

---

## Audit Workflow

When asked to audit or improve a UI, follow this order:

### Step 1: Inventory the screen or app

Identify:

- Main user goals
- Navigation structure
- Headings and subheadings
- Buttons and links
- Forms and inputs
- Async data areas
- Loading states
- Empty states
- Error states
- Color usage
- Contrast risks
- Images and icons
- Interactive custom components
- Possible keyboard traps
- Redundant copy
- Accessibility risks

### Step 2: Score or classify issues

Classify issues as:

- HIGH: Accessibility barrier, broken keyboard flow, missing labels, dangerous contrast, misleading state, or major legal/trust risk.
- MEDIUM: Poor loading state, cluttered copy, weak semantic colors, unclear button labels, or likely contrast issue.
- LOW: Visual polish, minor copy improvement, animation refinement, or optional enhancement.
- UNKNOWN: Cannot verify without manual testing, user context, or browser inspection.

### Step 3: Implement improvements

Apply changes in this order:

1. Fix accessibility barriers.
2. Add missing skeleton loaders or better loading states.
3. Replace scattered colors with semantic tokens.
4. Remove redundant headings, subtitles, and helper text.
5. Improve button and link labels.
6. Improve empty states and error states.
7. Improve focus visibility and keyboard behaviour.
8. Improve contrast.
9. Add reduced-motion support where needed.
10. Verify changes.

### Step 4: Verify

Do not mark work complete until the checklist has been reviewed.

---

## Implementation Rules For Common Frameworks

If the project uses React:

- Prefer semantic HTML elements.
- Avoid div onClick without keyboard support.
- Use proper button elements for actions.
- Use accessible names for icon buttons.
- Manage focus in modals and dialogs.
- Avoid unnecessary re-render flicker.
- Use Suspense or loading states only where meaningful.

If the project uses Next.js:

- Use loading.js, Suspense boundaries, or skeleton components where appropriate.
- Avoid layout shift between server-rendered and client-rendered content.
- Ensure metadata and headings are accessible.
- Preserve focus where client navigation occurs.

If the project uses Tailwind CSS:

- Prefer theme tokens or CSS variables over arbitrary values.
- Define semantic color names.
- Use focus-visible styles.
- Ensure disabled states are not only low opacity.
- Use dark mode variants through semantic tokens where possible.

If the project uses plain HTML/CSS:

- Define CSS custom properties for semantic colors.
- Use native form controls.
- Add visible focus styles.
- Add skip link for main content where appropriate.
- Ensure heading order is logical.

If the project uses a component library:

- Check whether the library already provides semantic color tokens.
- Prefer library patterns before custom ones.
- Do not override accessible defaults unless necessary.
- Verify keyboard behaviour after customization.

---

## Skeleton Loader Specification

When adding skeleton loaders, implement them as reusable components where possible.

A good skeleton component should:

1. Have a clear layout similar to the final content.
2. Use neutral background colors.
3. Avoid excessive animation.
4. Respect reduced motion.
5. Not contain fake interactive controls.
6. Not receive keyboard focus unless necessary.
7. Be replaced by real content once loaded.
8. Have an error fallback if loading fails.
9. Have an empty fallback if there is no data.
10. Avoid layout shift.

Skeleton loader examples:

For a list item:
- Avatar circle
- Title bar
- Subtitle bar
- Meta bar

For a card:
- Image block
- Title bar
- Description bar
- Button placeholder

For a table:
- Header row
- Several row placeholders
- Column-aligned bars

For a dashboard:
- Stat card blocks
- Chart block
- Table block
- Activity feed block

Do not overdo skeletons. If a component loads instantly, skeletons may make the UI feel slower or fake.

---

## Semantic Color Specification

When creating or fixing a color system, define at least these tokens:

Background:
- background
- surface
- surface-muted

Text:
- text-primary
- text-secondary
- text-disabled

Borders:
- border
- border-strong

Interactive:
- primary
- primary-hover
- primary-active
- primary-text
- focus-ring

Status:
- success
- warning
- danger
- info

Component states:
- selected-background
- disabled-background
- disabled-text
- overlay

Rules:

1. Buttons should use primary, danger, or neutral semantic tokens.
2. Links should use a link token.
3. Error text should use a danger text token.
4. Success banners should use success tokens.
5. Warning banners should use warning tokens.
6. Focus rings should use a dedicated focus token.
7. Dark mode should override tokens, not component styles.
8. Semantic names should describe purpose, not exact hue.

Bad token names:
- blue-500 everywhere
- red-for-errors maybe
- header-color
- button-color-2

Good token names:
- color-primary
- color-danger
- color-text-secondary
- color-border
- color-focus-ring

---

## Clutter Reduction Specification

Before adding subtitle or helper text, ask:

1. Does the user need this to complete a task?
2. Does this prevent confusion?
3. Does this explain non-obvious behaviour?
4. Does this reduce error?
5. Is this legally or operationally required?

If the answer is no, remove it or reduce it.

Common clutter patterns to remove:

- Subtitles that repeat the heading.
- Paragraphs explaining obvious sections.
- Multiple call-to-action buttons competing for attention.
- Too many badges on one card.
- Redundant icons next to text labels.
- Overly long empty-state explanations.
- Generic marketing copy inside app screens.
- Tooltips for obvious controls.
- Repeated instructions across every screen.

Keep:

- Empty states that tell the user what to do next.
- Error messages that explain how to fix the issue.
- Consent and privacy notices.
- Security warnings.
- Billing and refund explanations.
- Onboarding guidance where the feature is unfamiliar.
- Helper text for unusual form fields.

---

## Accessibility Verification Checklist

Before marking UI work complete, check:

### Keyboard

- [ ] All interactive elements can be reached with Tab.
- [ ] All interactive elements can be activated with Enter or Space where appropriate.
- [ ] Focus order is logical.
- [ ] Focus is visible.
- [ ] No keyboard traps exist.
- [ ] Escape closes modals, drawers, or menus where appropriate.

### Forms

- [ ] Inputs have visible labels.
- [ ] Required fields are marked.
- [ ] Error messages are clear.
- [ ] Errors are associated with fields.
- [ ] Submit button has a clear label.
- [ ] Form can be completed by keyboard only.

### Content

- [ ] Headings are in logical order.
- [ ] Meaningful images have alt text.
- [ ] Decorative images have empty alt text.
- [ ] Icon buttons have accessible labels.
- [ ] Status messages are announced where needed.
- [ ] Redundant headings and subtitles are removed.

### Color

- [ ] Text contrast is readable.
- [ ] Buttons have accessible contrast.
- [ ] Links are distinguishable.
- [ ] Error states do not rely on color alone.
- [ ] Focus ring is visible.

### Loading

- [ ] Skeleton loaders match final layout.
- [ ] No major layout shift occurs.
- [ ] Error states are available.
- [ ] Empty states are available.
- [ ] Reduced motion is respected.

### Semantics

- [ ] Buttons are real buttons.
- [ ] Links are real links.
- [ ] Navigation uses nav where appropriate.
- [ ] Main content uses main where appropriate.
- [ ] Headings use h1 to h6 logically.
- [ ] ARIA is only used when necessary.

---

## Completion Output

When finished, provide:

1. Summary of UI changes made.
2. Files created or modified.
3. Skeleton loaders added.
4. Semantic color tokens added or improved.
5. Clutter removed or simplified.
6. Accessibility fixes applied.
7. Remaining risks.
8. Manual checks required.
9. Items needing user confirmation.
10. Optional improvements not applied.

End with a clear statement:

"This improves perceived performance, UI clarity, and accessibility, but it is not a legal accessibility certification. Manual testing and expert review may still be required."
