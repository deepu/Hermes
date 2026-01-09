---
name: cd-save
description: Save current progress to GitHub issue. Call manually anytime or automatically before compaction.
---

# /cd-save - Save Progress to GitHub Issue

Save your current work progress to the GitHub issue so you (or Claude) can resume later.

## Usage

```
/cd-save           # Save progress on current issue
/cd-save 45        # Save progress on specific issue #45
```

## When to Use

- **End of day**: "Done for today, save progress"
- **Taking a break**: "Stepping away, save where I am"
- **Before switching tasks**: "Need to work on something else"
- **Automatically**: Called before context compaction

## Process

### Step 1: Identify Current Issue

If no issue number provided, detect from:
```bash
# Check current branch name
git branch --show-current
# Extract issue number from branch name like "feature/45-auth-provider"
```

If can't detect, use `ask_followup_question`:
```
"Which issue should I save progress to? (Enter issue number)"
```

### Step 2: Gather Progress Information

Collect:

**From Git:**
```bash
# Files changed
git diff --name-only HEAD~$(git rev-list --count origin/main..HEAD) 2>/dev/null || git diff --name-only

# Recent commits on this branch
git log origin/main..HEAD --oneline

# Uncommitted changes
git status --short
```

**From Context:**
- What tasks were completed
- What task is currently in progress
- What's remaining
- Any blockers or decisions needed
- Any discovered issues (bugs found, edge cases, etc.)

### Step 3: Format Progress Comment

Create a structured progress update:

```markdown
## 🔄 Progress Update - <timestamp>

### ✅ Completed
- [x] Task 1: <description>
- [x] Task 2: <description>

### 🚧 In Progress
- [ ] Task 3: <description>
  - Current state: <where we are>
  - Next step: <what to do next>

### 📋 Remaining
- [ ] Task 4: <description>
- [ ] Task 5: <description>

### 📁 Files Changed
- `src/components/Auth.tsx` - Added login form
- `src/hooks/useAuth.ts` - Created auth hook
- `src/utils/validate.ts` - Added validation helpers

### 💾 Commits
- `abc123` - feat(auth): add login form component
- `def456` - feat(auth): create useAuth hook

### ⚠️ Uncommitted Changes
- `src/components/Auth.tsx` (modified)
- `src/styles/auth.css` (new file)

### 🚧 Blockers / Decisions Needed
- Need to decide: JWT expiry time (1hr vs 24hr)
- Blocked by: Waiting for API endpoint from backend team

### 🔍 Discovered Issues
- Found edge case: What happens when token refresh fails mid-request?
- Potential bug: Form doesn't clear on successful submit

### 📝 Notes for Next Session
- Auth hook is working but needs error handling
- Started on form validation, see `validate.ts`
- Next: Wire up form submission to API

---
*Saved by `/cd-save` command*
```

### Step 4: Post Comment to GitHub Issue

```bash
gh issue comment <issue-number> --body "<progress-markdown>"
```

### Step 5: Handle Discovered Issues

If any discovered issues were noted, offer to create them:

```
ask_followup_question: "I noted 2 discovered issues:
1. Edge case: token refresh failure handling
2. Potential bug: form clear on submit

Create GitHub issues for these? (yes/no/select)"
```

If yes, create linked issues:
```bash
gh issue create \
  --title "[Discovery] Token refresh failure handling" \
  --label "discovered,bug" \
  --body "## Discovered While Working On
#<parent-issue>

## Issue
<description>

## Context
Found while implementing auth flow - what happens when token refresh fails mid-request?

## Suggested Priority
P2 - Should handle before release"
```

### Step 6: Confirm Save

```markdown
## Progress Saved ✓

**Issue:** #45 - Set up auth provider
**Comment:** <link-to-comment>

**Summary:**
- 2 tasks completed
- 1 task in progress
- 2 tasks remaining
- 2 discovered issues created (#67, #68)

**To Resume:**
Run `/cd-work 45` - it will read this progress and continue where you left off.
```

## Pre-Compaction Hook

Add to `.claude/hooks/pre-compaction.md` (or equivalent):

```markdown
Before context compaction, automatically run:

1. Check if there's an active issue being worked on (from branch name)
2. If yes, run `/cd-save` to preserve progress
3. Notify user: "Progress saved to #<issue> before compaction"
```

## What Gets Saved

| Information | Source |
|-------------|--------|
| Completed tasks | From conversation context |
| In-progress task | Current work state |
| Remaining tasks | Original issue minus completed |
| Files changed | `git diff --name-only` |
| Commits made | `git log origin/main..HEAD` |
| Uncommitted work | `git status` |
| Blockers | From conversation |
| Discovered issues | Bugs/edge cases found |
| Next steps | What to do when resuming |

## Key Principles

1. **Save often** - Better to over-save than lose progress
2. **Be specific** - "Started on validation" < "Added email regex, need phone validation"
3. **Note blockers** - Future you needs to know what's stuck
4. **Track discoveries** - Don't lose bugs found along the way
5. **Git state matters** - Include uncommitted changes
