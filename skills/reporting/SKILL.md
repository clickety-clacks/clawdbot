---
name: reporting
description: How to report status, respond to alerts, and communicate progress.
---

# Reporting

How to communicate status, progress, and alerts to Flynn.

## Core Principle

**Report on goals, not activity.** Describe the *effect* on progress, not what technically happened.

- ❌ "ios-2 committed the toast duration change"
- ✅ "Session picker UX is ready for testing"

## Alert Clarity Contract (required)

Every alert response must make these explicit:

1. **What changed** (fact)
2. **Who owns next action** (`agent`, `CLU`, `Flynn`, or `none`)
3. **Whether Flynn must do anything now** (`yes/no`, and what)
4. **Completion evidence** (SHA, device, test result, or link when relevant)

Never use vague phrases like "smoke check" without defining the exact check and owner.

## If deploy/cherry-pick involved

Include:
- repo name
- picked SHA(s)
- deployed SHA
- whether this message is informational vs requires action

## What to Share

For status updates, completions, and alerts:
- **Goal**: what objective this relates to
- **Progress**: how this moved the goal forward
- **Blockers**: what prevents progress (if any)
- **Root cause**: why something failed (if applicable)

Skip routine incremental chatter. Share milestones, completions, and blockers.

## Format

- Lead with 📋 for normal status updates.
- Keep it tight (1-3 sentences unless Flynn asks for detail).
- End with explicit owner/action line when there is a next step.
