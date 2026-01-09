---
name: cd-work
description: Execute work on a GitHub issue. Reads comments to resume where you left off.
---

# /cd-work - Work on GitHub Issue (with Smart Resume)

Execute work on a GitHub issue. Automatically detects progress from issue comments and resumes where you left off.

## Usage

```
/cd-work 42        # Work on issue #42
/cd-work #42       # Same thing
```

## Process

### Step 1: Fetch Issue and Analyze

```bash
# Get issue details
gh issue view <number> --json title,body,labels,state,comments
```

**Detect:**
- Is this a parent with sub-issues?
- Is this a sub-issue?
- Has work already started? (check for progress comments)

### Step 2: Check for Existing Progress

Look for progress comments (from `/cd-save` command):

```bash
# Get all comments
gh issue view <number> --json comments --jq '.comments[] | select(.body | contains("Progress Update"))'
```

**If progress comments exist:**

Parse the most recent one to extract:
- ✅ Completed tasks
- 🚧 In-progress task and its state
- 📋 Remaining tasks
- 📁 Files that were changed
- 💾 Commits already made
- ⚠️ Blockers/decisions needed
- 📝 Notes for resuming

**Display resume summary:**

```markdown
## Resuming Issue #45: Set up auth provider

### Previous Progress Found
Last saved: 2024-01-15 3:45 PM

**Completed:**
- [x] Create auth config file
- [x] Set up provider initialization

**In Progress:**
- [ ] Add error handling
  - State: Started, added try-catch to main function
  - Next: Add specific error types

**Remaining:**
- [ ] Add retry logic
- [ ] Write tests

**Last Working On:**
- File: `src/auth/provider.ts`
- Last commit: `abc123 - feat(auth): add provider init`

**Blockers Noted:**
- Need to decide: retry count (3 vs 5)

**Continue from here?** (yes / start fresh / show details)
```

Wait for confirmation before proceeding.

### Step 3: For Parent Issues - Determine Work Order

If this is a parent issue with sub-issues:

```bash
# Get sub-issue status
gh issue view <sub-number> --json state,title
```

**Show status:**

```markdown
## Issue #42: Add User Authentication

**Status:** 2 of 5 sub-issues complete

| # | Sub-Issue | Status | Has Progress? |
|---|-----------|--------|---------------|
| #43 | Set up auth provider | ✅ Done | - |
| #44 | Login/signup UI | ✅ Done | - |
| #45 | Protected routes | 🔄 In Progress | Yes (last: Jan 15) |
| #46 | Session persistence | ⏳ Blocked | No |
| #47 | Integration tests | ⏳ Blocked | No |

**Next:** Continuing #45 - Protected routes (has saved progress)

Proceed?
```

### Step 4: Setup or Resume Branch

**If resuming (progress exists):**
```bash
# Check if branch exists
git branch -a | grep <issue-number>

# If exists, switch to it
git checkout feature/<issue-number>-<slug>
git pull origin feature/<issue-number>-<slug> 2>/dev/null || true

# Check for uncommitted changes mentioned in progress
git status
```

**If fresh start:**
```bash
git checkout main
git pull origin main
git checkout -b feature/<issue-number>-<slug>
```

### Step 5: Restore Context

If resuming, reconstruct the working state:

1. **Re-read the files mentioned** in progress comment
2. **Note where we left off** in the in-progress task
3. **Load any blockers** that need decisions
4. **Check discovered issues** - were they resolved?

```markdown
## Context Restored

**Resuming:** Add error handling in `src/auth/provider.ts`

**Where we left off:**
- Added try-catch to `initProvider()` function
- Need to add specific error types for: NetworkError, AuthError, ConfigError

**Files to focus on:**
- `src/auth/provider.ts` (line ~45, error handling section)
- `src/auth/errors.ts` (need to create)

**Pending decision:**
- Retry count: 3 vs 5 attempts

Ready to continue?
```

### Step 6: Work on the Issue

Follow the remaining tasks from issue (or progress comment):

For each task:

1. **Implement** the change
2. **Test** - Run relevant tests
3. **Commit** with issue reference:
   ```bash
   git commit -m "feat(auth): add error types for provider

   - Add NetworkError, AuthError, ConfigError
   - Update initProvider to use specific errors
   
   Part of #45"
   ```

### Step 7: Handle Discovered Issues

When finding bugs, edge cases, or new requirements while working:

```
ask_followup_question: "I found an issue while working:

**Discovery:** Form validation doesn't handle unicode characters

Create a GitHub issue for this? (yes/no)"
```

If yes:
```bash
gh issue create \
  --title "[Discovery] Form validation unicode handling" \
  --label "discovered" \
  --body "## Discovered While Working On
#45 - Protected routes

## Issue
Form validation regex doesn't handle unicode characters in names.

## Example
Name 'José García' fails validation.

## Suggested Fix
Update regex to use unicode character classes.

## Priority
P3 - Nice to have"
```

Add comment to current issue:
```bash
gh issue comment 45 --body "🔍 **Discovered Issue:** Created #68 - Form validation unicode handling (found while implementing protected routes)"
```

### Step 8: Periodic Auto-Save

Every ~30 minutes of work or after completing a task, automatically save progress:

```
[Auto-saving progress to #45...]
```

This ensures progress isn't lost if session ends unexpectedly.

### Step 9: Quality Check

Before creating PR:

```bash
# TypeScript/React
npm run lint
npm run typecheck  
npm test

# Python
ruff check .
mypy .
pytest
```

### Step 10: Create PR Linked to Issue

```bash
git push -u origin feature/<issue-number>-<slug>

gh pr create \
  --title "feat: <issue title>" \
  --body "## Summary
<What this PR implements>

## Issue
Closes #<issue-number>

## Changes
- Change 1
- Change 2

## Progress History
See issue #<number> comments for detailed progress log.

## Testing
- [ ] Unit tests pass
- [ ] Type checking passes
- [ ] Manual testing done

## Discovered Issues
- #68 - Form validation unicode (P3)
"
```

### Step 11: Final Save & Cleanup

After PR is created:

```bash
# Final progress comment
gh issue comment <number> --body "## ✅ Implementation Complete

**PR:** #<pr-number>
**Branch:** feature/<issue>-<slug>

### Final State
- All tasks completed
- Tests passing
- PR ready for review

### Discovered Issues Created
- #68 - Form validation unicode

---
*Implementation complete. Awaiting PR review.*"
```

### Step 12: Update Parent (if sub-issue)

If this was a sub-issue, check parent status:

```markdown
## Sub-Issue #45 Complete ✓

**PR:** #<pr-number>

### Parent Issue #42 Status
- [x] #43 - Set up auth provider
- [x] #44 - Login/signup UI  
- [x] #45 - Protected routes ← Just completed
- [ ] #46 - Session persistence ← Ready now
- [ ] #47 - Integration tests

**Next available:** #46 - Session persistence

Continue with `/cd-work 46`?
```

### Step 13: Generate Feature Documentation

After ALL sub-issues complete, generate `docs/features/<feature>.md`.

(See full template in original /cd-work spec)

---

## Smart Resume Logic

```
/cd-work 42
    │
    ▼
Fetch issue #42 + comments
    │
    ▼
Has progress comments? ──No──► Fresh start
    │                            │
   Yes                           │
    │                            │
    ▼                            │
Parse latest progress            │
    │                            │
    ▼                            │
Show resume summary              │
    │                            │
    ▼                            │
User confirms ◄──────────────────┘
    │
    ▼
Restore context (files, state, blockers)
    │
    ▼
Continue from in-progress task
```

---

## Key Principles

1. **GitHub is memory** - Progress comments ARE the state
2. **Always resume** - Don't restart work that's partially done
3. **Save frequently** - Auto-save + manual `/cd-save`
4. **Track discoveries** - Don't lose bugs found along the way
5. **One issue = one PR** - Clean, reviewable chunks
