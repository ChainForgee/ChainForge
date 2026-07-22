## Problem
Resolves #295

Field operators using assistive technology may miss status updates because there are no `aria-live` regions set up in the app. Status transitions in campaigns and claim receipts need to be explicitly announced to screen readers.

## What was implemented
- Created a `<LiveRegion>` component in `app/frontend/src/components/LiveRegion.tsx` that uses `aria-live="polite"` and `role="status"` to announce message changes. It includes a small debounce queue (50ms) to ensure consecutive rapid updates are announced clearly.
- Created `getStatusTransitionMessage` utility in `app/frontend/src/lib/status-messages.ts` to map raw status values to verbose, human-readable text (e.g. "Campaign status changed from Active to Paused.").
- Integrated `<LiveRegion>` into `app/frontend/src/app/[locale]/campaigns/page.tsx` and `app/frontend/src/app/[locale]/claim-receipt/page.tsx`, storing previous state with a `useRef` and detecting status transitions to trigger announcements.
- Added `jest-axe` tests for `<LiveRegion>` in `app/frontend/test/live-region.spec.tsx` to verify standard accessibility compliance and ensure text transitions correctly.

## Assumptions made during Phase 1
- `claim-receipt/page.tsx` is the intended target for the "claim-status / claim detail page" mentioned in the requirements, as it's the primary location for viewing a claim's status.
- Campaign transitions happen via optimistic mutation and derive status from the local component list, so `useRef` was used to detect status changes cleanly without modifying the global store or mutation logic.

## How to manually verify
1. Run the application (`pnpm run dev`).
2. Turn on a screen reader (VoiceOver, NVDA, or JAWS).
3. Navigate to the NGO Campaigns page and perform an action like "Pause" or "Resume" on a campaign. The screen reader should announce "Campaign status changed from Active to Paused."
4. Inspect the DOM to verify the visually hidden `aria-live` region updates its text content.

## Follow-up work recommended
- Extend this pattern to other dynamic status indicators in the application (like `VerificationReviewPage` queues or `ActivityCenter` toasts) to ensure universal accessibility coverage.
