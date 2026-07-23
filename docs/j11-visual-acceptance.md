# J11 Journal visual acceptance matrix

Evidence baseline: `evidence/j11-baseline/`

Wadera screenshots and authenticated production baselines show browser-default white controls, weak header hierarchy, compressed/raw date presentation, inconsistent drawer/player styling, and insufficiently defined loading/error/disabled/focus states.

| Surface | Requirement | Implementation evidence | Verification gate |
|---|---|---|---|
| Journal header | Logs, Mindscape and view controls use intentional ClawBoard styling, minimum 40–44px targets, consistent radius/border/color, and no browser-default button appearance | `JournalPage.tsx`, `JournalPage.css` | Component test; authenticated desktop/tablet/mobile screenshot |
| Primary action | Mindscape is visually primary without overpowering the Journal title | `journal-header-tool-primary` | Desktop/mobile visual review |
| View selector | Valid grouped toggle semantics with labels and pressed state | `role=group`, `aria-pressed` | DOM test and keyboard review |
| Journal cards | Consistent gaps, aspect ratios, card elevation, focus treatment and one-column mobile layout | `JournalPage.css` | Desktop/tablet/390px screenshots; no horizontal overflow |
| Drawers | Shared dark elevated surface, sticky descriptive heading, consistent close control and mobile bottom sheet | `JournalDrawer.css`, `MindscapePanel.css` | Dialog semantics, initial focus, Escape and focus return |
| Logs | Operational content remains in Logs, not Journal narrative; controls use shared visual states | `JournalLogsDrawer.tsx`, `JournalRunsPanel.css` | Authenticated drawer screenshot and keyboard review |
| Player hierarchy | Clear privacy context, title, now-playing card, transport, progress, provenance and playlist hierarchy | `MindscapePanel.tsx`, `MindscapePanel.css` | Authenticated fixture with private track |
| Dates | Human-readable localized dates; no raw ISO date in visible player/playlist copy | `formatTrackDate()` | Test and live fixture screenshot |
| Loading/empty/error | Distinct, polished and accessible states; errors reveal no private media details | `loading`, `mindscape-empty`, `mindscape-alert` | Tests plus forced DEV responses |
| Hover/focus/disabled | Visible hover and keyboard focus; disabled controls remain visually distinct; reduced-motion respected | CSS focus/disabled/reduced-motion rules | Keyboard and prefers-reduced-motion review |
| Privacy | No provider URL, media path, song path or receipt hash in rendered client DTOs | Existing authenticated private-byte boundary retained | API/DOM inspection |
| Responsive | No horizontal overflow at 390px; labels remain understandable; drawer becomes bottom sheet | media queries at 767/600/520px | Browser evidence at 1920px, tablet and 390px |

Completion requires actual DEV and production screenshot comparison. Source changes or passing static tests alone are insufficient.
