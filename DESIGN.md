---
name: WorkStep
description: A precise local-first workspace for human and LLM workflows.
colors:
  workflow-blue: "#0071e3"
  workflow-blue-hover: "#0077ed"
  orchestration-violet: "#7c3aed"
  canvas: "#ffffff"
  soft-surface: "#f5f5f7"
  lifted-surface: "#fbfbfd"
  ink: "#1d1d1f"
  secondary-ink: "#424245"
  muted-ink: "#6e6e73"
  quiet-ink: "#86868b"
  separator: "#d2d2d7"
  soft-separator: "#e8e8ed"
  success: "#16a34a"
  warning: "#b45309"
  failure: "#dc2626"
typography:
  display:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, PingFang SC, sans-serif"
    fontSize: "clamp(40px, 5.2vw, 66px)"
    fontWeight: 700
    lineHeight: 1.06
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, PingFang SC, sans-serif"
    fontSize: "clamp(30px, 4vw, 44px)"
    fontWeight: 700
    lineHeight: 1.12
    letterSpacing: "-0.02em"
  body:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, PingFang SC, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "ui-monospace, SF Mono, JetBrains Mono, Menlo, monospace"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0.1em"
rounded:
  control: "12px"
  panel: "14px"
  window: "18px"
  pill: "999px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "20px"
  lg: "28px"
  xl: "44px"
  section: "92px"
components:
  button-primary:
    backgroundColor: "{colors.workflow-blue}"
    textColor: "{colors.canvas}"
    rounded: "{rounded.control}"
    padding: "12px 20px"
  button-primary-hover:
    backgroundColor: "{colors.workflow-blue-hover}"
  button-ghost:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "12px 20px"
  card:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.window}"
    padding: "14px"
---

# Design System: WorkStep

## Overview

**Creative North Star: "The Precise Workbench"**

WorkStep presents complex orchestration as a calm, inspectable workspace. The visual system is bright, restrained, and product-led: large direct statements establish confidence, while interface previews and status details provide proof without turning the page into a technical dashboard.

The system favors clear hierarchy, generous section rhythm, and familiar desktop-product surfaces. Blue signals action and active work; violet appears as a secondary orchestration cue. Motion demonstrates continuity between workflow stages and stays subordinate to comprehension.

**Key Characteristics:**

- Bright neutral canvases with sparse blue and violet emphasis.
- Large, tightly tracked headings paired with compact product detail.
- Softly lifted windows, restrained borders, and rounded controls.
- Real interface scenes used as evidence, not decorative illustration.
- Direct, calm copy that explains what the product does.

## Colors

The palette uses quiet near-white surfaces and dark neutral text so the workflow blue remains a deliberate signal rather than ambient decoration.

### Primary

- **Workflow Blue:** The principal action, running-state, link, and focus color.
- **Active Workflow Blue:** The hover state for primary actions.

### Secondary

- **Orchestration Violet:** A supporting cue in the brand mark and selected workflow accents.

### Neutral

- **Canvas White:** The base page and raised window surface.
- **Soft Control Gray:** Low-contrast controls, bars, and grouped regions.
- **Lifted Paper:** Alternate sections that need separation from the base canvas.
- **Primary Ink:** Headlines, primary labels, and strong controls.
- **Secondary Ink:** Supporting labels that still need clear contrast.
- **Muted Ink:** Body support copy and metadata.
- **Quiet Ink:** Timestamps and tertiary details.
- **Separator Gray / Soft Separator:** Structural boundaries, with the softer value preferred for large regions.

### Named Rules

**The Active Signal Rule.** Blue marks actions or live state; violet supports orchestration and never competes with the primary action.

**The Quiet Canvas Rule.** Neutral surfaces carry most of every viewport so interface evidence and active states remain legible.

## Typography

**Display Font:** System UI with Apple, Segoe UI, Roboto, and PingFang SC fallbacks  
**Body Font:** System UI with the same platform-native fallbacks  
**Label/Mono Font:** UI monospace with SF Mono, JetBrains Mono, and Menlo fallbacks

**Character:** The primary face is neutral and highly legible across Chinese and English. Monospace is reserved for engine names, status metadata, identifiers, and values that behave like technical data.

### Hierarchy

- **Display** (700, fluid 40–66px, 1.06): Hero statements only.
- **Headline** (700, fluid 30–44px, 1.12): Major section propositions.
- **Title** (600–700, 15–20px): Cards, panels, and named product concepts.
- **Body** (400, 15–17px, 1.55–1.65): Explanations with lines kept near 52–70 characters.
- **Label** (600, 11–13px): Metadata and compact controls; uppercase is limited to short technical labels.

### Named Rules

**The Product Voice Rule.** Use weight, scale, and spacing for emphasis; reserve monospace for information that is genuinely code-like or measurable.

## Layout

The page uses a centered container capped at 1360px with 28px horizontal gutters. Sections follow a generous 92px vertical rhythm on desktop and compress to 64px below 760px. Major propositions lead each region, followed by proof in interface previews, two-column explanations, or three-column demonstrations.

Responsive layouts reduce column count before reducing legibility: feature and collaboration grids collapse progressively, navigation links hide on narrow screens, and primary calls to action become full-width stacks around 600px. DOM order remains the reading order.

## Elevation & Depth

Depth is a hybrid of tonal layering, fine separators, and a single ambient elevation. Most surfaces stay flat; large product windows and hovered demonstration cards use a soft two-stage shadow to distinguish interactive evidence from the page.

### Shadow Vocabulary

- **Ambient Window:** `0 30px 80px rgba(0, 0, 0, 0.07), 0 12px 30px rgba(0, 0, 0, 0.05)` for product windows, modals, and elevated evidence.
- **Interactive Lift:** The ambient window shadow paired with a 4px upward translation on hover.

### Named Rules

**The Evidence Lifts Rule.** Elevation belongs to product previews, modal focus, and interactive response—not ordinary copy containers.

## Shapes

Controls use gently rounded 12px corners, content panels use 14px, and application windows use 18px. Pills are restricted to compact actions, filters, and status badges. Thin neutral borders define structure; the blue-to-violet gradient is reserved for the compact WorkStep mark and small signature accents.

## Components

### Buttons

- **Shape:** Confident rounded rectangle (12px); compact navigation actions may use a pill.
- **Primary:** Workflow blue with white text and 12px × 20px padding.
- **Hover / Focus:** Shift to active blue with a subtle 1px lift; keyboard focus uses a 2px blue outline and 2px offset.
- **Secondary / Ghost:** Canvas surface, primary ink, and a neutral border; hover changes the surface tone.

### Chips

- **Style:** Compact pill geometry with muted neutral surfaces and short labels.
- **State:** Active or live chips may use blue or success green; passive chips remain neutral.

### Cards / Containers

- **Corner Style:** 14–18px depending on scale.
- **Background:** Canvas or lifted paper.
- **Shadow Strategy:** Flat at rest unless the card is primary evidence or interactive.
- **Border:** One-pixel neutral separator.
- **Internal Padding:** Compact 14–20px for interface cards; larger prose compositions rely on surrounding layout gaps.

### Navigation

The sticky 64px navigation uses a translucent canvas with saturation blur and a soft bottom separator. Links are compact and muted until hover; the main action uses inverted ink and canvas colors.

### Workflow Preview

Application previews combine neutral chrome, compact technical labels, real status colors, and continuous motion. They should read as plausible product UI at a glance and remain the richest visual regions on the page.

## Do's and Don'ts

### Do:

- **Do** keep most surfaces neutral and spend saturated color on actions, active workflow state, and small signature cues.
- **Do** use generous spacing between propositions and tighter spacing inside interface evidence.
- **Do** preserve real workflow motion and product-state detail when rearranging the page.
- **Do** keep Chinese and English hierarchy equivalent across responsive sizes.

### Don't:

- **Don't** replace product evidence with generic decorative cards or abstract illustrations.
- **Don't** apply ambient shadows to every container.
- **Don't** use monospace as a general-purpose technology aesthetic.
- **Don't** invent performance, security, or adoption claims that the product cannot substantiate.
