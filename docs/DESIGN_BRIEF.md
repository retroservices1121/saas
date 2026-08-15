# UI design brief — Onboarding Platform

Paste everything below the line into Claude (or any design tool). It is written
to be self-contained: it explains the product, the three audiences, the
constraints that are non-negotiable, and every screen that exists.

---

## The brief

You are designing the interface for a production B2B SaaS product called
**Onboarding**. It is used by accounting firms to collect employee and
contractor tax and banking information on behalf of their client companies.
Real money and real tax filings depend on it. It handles Social Security
numbers and bank account numbers.

Design it the way a serious vertical SaaS product is designed — think Gusto,
Rippling, Vanta, Ramp, Mercury, Justworks. **It must not look like a developer
tool, a terminal, an admin panel, or an AI demo.** No monospace body text, no
dark "hacker" theme, no neon accents, no emoji as iconography, no gradient
mesh backgrounds, no glassmorphism. The people using this are payroll
administrators, bookkeepers, construction supervisors, and hourly workers
filling in a form on a cracked Android phone in a parking lot.

### The three audiences, who are very different

**1. Accounting firm staff (desktop, all day, power users).**
Firm admins and firm staff. They manage dozens of client companies and
hundreds of workers. They live in dense list views, filter and scan, and need
to see status at a glance. They are the *only* people who ever see a tax ID or
a bank account number, and only one field at a time, after typing a reason and
re-entering a two-factor code. Design for density, keyboard use, and fast
scanning. Data tables, not cards. This audience would rather see forty rows
than eight beautiful ones.

**2. Company administrators (desktop and tablet, occasional users).**
The employer. They log in a handful of times to complete their company profile,
upload an insurance certificate, and invite their owners and workers. **They
are deliberately shown almost nothing.** They see a worker's display name, job
title, and a status chip — never a legal name, never a date of birth, never
even the last four digits of anything. The interface must make this feel
intentional and trustworthy rather than broken. When a company admin looks at a
worker row and sees only "Submitted", they should understand *why* without
filing a support ticket. Design an explanatory, reassuring empty state for
this, not an error state.

**3. Workers and company owners (mobile only, once, possibly anxious).**
They receive a text message with a link. They have no account and never log in.
They answer one question per screen, in English or Spanish, and hand over their
Social Security number and their bank account. Many are hourly workers. Some
are undocumented-adjacent and nervous about who sees this. Some have never used
a web form that asked for an SSN and did not turn out to be a scam.

This flow is the emotional centre of the product. It must feel calm, official,
and obviously legitimate. It should visibly name the company that invited them
on the first screen, state plainly that their employer will not see what they
enter, and never look like a phishing page. Large type, one decision per
screen, enormous tap targets, generous spacing, a visible back button, and a
progress indicator that never lies.

---

## Non-negotiable constraints

These come from the security model and from field research. Treat them as
requirements, not suggestions.

1. **Spanish runs 20–30% longer than English.** Design every screen with the
   Spanish string, at **360px wide**. Nothing may depend on a label fitting on
   one line. No horizontal truncation of a person's name, ever.
2. **A persistent language switcher on every single screen**, including the
   very first verification gate before anything is shown. Two buttons
   (English / Español), not a dropdown, not a flag icon.
3. **Minimum 44×44px tap targets**, 16px minimum font size on all inputs (below
   16px, iOS Safari zooms the viewport on focus and destroys the layout).
4. **Sensitive values are masked by default** and render as `•••-••-1234`. When
   revealed they appear in a tabular-figures font, with a visible 30-second
   countdown, and then re-mask themselves automatically. Design that countdown —
   it should feel like a deliberate safety feature, not a timeout error.
5. **Every reveal requires a typed reason and a fresh 2FA code.** Design that as
   a focused modal that feels weighty and deliberate — this is a moment where
   someone is accountable for what they are about to look at.
6. **Status is the primary information design problem.** Six states —
   `Invited`, `In progress`, `Submitted`, `Needs attention`, `Archived`,
   `Complete` — appear across every list in the product. Design one chip system
   that reads correctly at a glance, works for colourblind users (not colour
   alone), and survives being translated into Spanish.
7. **Accessibility is a requirement, not a pass.** WCAG 2.2 AA contrast, visible
   focus rings on every interactive element (do not remove outlines), real
   labels on every field, errors announced not just coloured red.

---

## Visual direction

- **Feel:** competent, quiet, institutional but modern. The visual equivalent of
  a well-run accounting practice. Trustworthy over trendy. This product will
  look dated in five years if it chases anything.
- **Colour:** a restrained neutral palette with one confident brand colour.
  Colour carries meaning here — reserve saturation for status and for
  destructive or sensitive actions. Most of the interface should be neutral.
  Red means a problem or a disclosure. Nothing decorative should be red.
- **Type:** one humanist sans for everything (Inter, Söhne, or similar).
  Tabular figures for all numbers — tax IDs, account numbers, dates, counts.
  Comfortable line height; Spanish paragraphs run long.
- **Density:** dense for firm staff, spacious for the worker flow. These are two
  different scales in the same design system and both need to be specified.
- **Depth:** flat with hairline borders and one subtle elevation level for
  overlays. No heavy drop shadows.
- **Motion:** minimal and functional. A reveal countdown, a step transition, a
  saving indicator. Nothing decorative, nothing over 200ms.
- **Iconography:** a single consistent line-icon set. No emoji anywhere in the
  product surface.

---

## Screens to design

### A. Worker / owner mobile flow (highest priority)
The worker flow is 18 screens; the owner flow is a shorter subset. Design the
system, then these specific screens:

1. **Verification gate** — "Confirm your date of birth to continue." Three
   numeric dropdowns (month / day / year), *not* a native date picker. Explain
   in one sentence why they are being asked. Language switcher visible.
2. **Welcome** — names the inviting company prominently. States what will be
   collected and, plainly, that their employer will not see it. This screen has
   to earn the next sixteen.
3. **A generic one-question screen** — the pattern every step inherits: back
   button, progress, question, input, help text, single primary action.
4. **Tax ID type** — two large tappable cards: "Social Security Number" /
   "ITIN", each with a plain-language explanation of which one someone has.
5. **Tax ID entry** — numeric keypad, masked as typed, live format validation.
   Show the inline soft-warning state ("This looks like an ITIN, but you chose
   SSN — please check") which must be visibly *different* from an error and must
   not block progress.
6. **Routing number** — live checksum validation, inline error state.
7. **Voided check photo** — optional camera capture with a clear skip.
8. **Review** — every answer, sensitive ones masked, each row editable.
9. **E-signature** — full legal authorization text on screen (not collapsed, not
   scroll-past-able), an unchecked consent checkbox, and a "type your full legal
   name" field. Design this to feel like signing something real.
10. **Done** — no sensitive values shown. Warm, finished, nothing left to do.
11. **Error states**: expired link, already-used link, and "locked for 60
    minutes after too many failed attempts."

### B. Firm dashboard (desktop, dense)
12. **Company list** — dozens of client companies, completion progress, filters.
13. **Company detail** — tabs: Overview, Owners, Workers, Documents, Notes,
    Activity.
14. **Worker detail** — masked personal data with per-field reveal buttons, a
    version history of corrections, and the documents attached to that worker.
15. **The reveal modal** — reason field, 2FA code, and the resulting revealed
    value with its countdown.
16. **Activity / audit log** — a readable, filterable event history.
17. **Export** — select companies, date range, a sensitive-data toggle with an
    honest warning, required reason, and the one-time password display.

### C. Company admin (desktop, sparse by design)
18. **Company dashboard** — an onboarding checklist with six items and clear
    next actions.
19. **Company profile form** — address, operating states (multi-select),
    workers' comp status with conditional fields, insurance details.
20. **Worker list** — display name, job title, and a status chip. *Nothing
    else.* Include the explanatory note about why.
21. **Invite a worker** — a short form plus a language preference.

### D. Auth
22. **Sign in**, **2FA code entry**, and **account setup** (choose a password +
    scan a QR code to enrol an authenticator app).

---

## Deliverables

1. A design system: colour tokens (with semantic names), type scale, spacing
   scale, the status chip system, form controls in every state (default, focus,
   filled, error, warning, disabled), buttons, tables, tabs, modals.
2. The screens above, mobile screens at 360px and desktop at 1440px.
3. Both light and dark themes if you propose dark; light is required.
4. Every worker-facing screen shown **in Spanish as well as English**, so the
   layout is proven at the longer string length.

## Explicitly out of scope

Do not design: payroll calculation, tax filing, pay rates, bank login flows,
worker self-service login after submission, or billing. None of these exist in
this product and adding them changes what it is.
