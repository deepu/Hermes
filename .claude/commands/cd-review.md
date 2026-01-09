---
name: cd-review
description: Run multi-agent parallel code review on a PR or branch
---

# /cd-review - Multi-Agent Code Review

Get comprehensive code review from 7 specialized perspectives running in parallel.

## Arguments

```
/cd-review              # Review current branch vs main
/cd-review 42           # Review PR #42
/cd-review feature/auth # Review specific branch
/cd-review latest       # Review most recent PR
```

## Process

### Step 1: Detect Target

Determine what to review:

```bash
# If PR number given
gh pr view <number> --json number,title,headRefName

# If branch name given
git rev-parse --verify <branch>

# If "latest"
gh pr list --limit 1 --json number,title

# If nothing given
git branch --show-current
```

### Step 2: Get the Diff

```bash
# For PR
gh pr diff <number>

# For branch comparison
git diff main...<branch> --stat  # Summary first
git diff main...<branch>          # Full diff
```

Also identify:
- Files changed
- Lines added/removed
- File types (TS, TSX, Python, etc.)

### Step 3: Launch Parallel Reviews

Use Task tool to run these agents SIMULTANEOUSLY on the diff:

| Agent | What They Check |
|-------|-----------------|
| **typescript-reviewer** | Types, React patterns, hooks, modern TS |
| **python-reviewer** | Type hints, Pythonic patterns, idioms |
| **security-sentinel** | Auth, injection, data exposure, secrets |
| **performance-oracle** | Complexity, N+1, bundle size, memory |
| **architecture-strategist** | Design, boundaries, coupling |
| **pattern-recognition-specialist** | Duplication, anti-patterns, TODOs |
| **code-simplicity-reviewer** | Over-engineering, dead code |

Only run language-specific reviewers if those languages are in the diff.

Each agent prompt should include:
1. The full diff
2. List of files changed
3. Their specific review focus
4. Request for structured output (see below)

### Agent Output Format

Each agent returns:

```markdown
## [Agent Name] Review

### Findings

#### P1 - Critical (blocks merge)
- **[File:Line]** - [Issue]
  - Why: [Explanation]
  - Fix: [How to fix]

#### P2 - Important (should fix)
- **[File:Line]** - [Issue]
  - Why: [Explanation]
  - Fix: [How to fix]

#### P3 - Nice to have
- **[File:Line]** - [Issue]
  - Fix: [Suggestion]

### Summary
[One paragraph overall assessment]
```

### Step 4: Synthesize Findings

Collect all agent results and:

1. **Deduplicate** - Same issue found by multiple agents
2. **Prioritize** - Confirm P1/P2/P3 classifications
3. **Group** - By file, then by priority

Priority definitions:
- **P1 Critical** - Security holes, data loss, crashes, broken functionality. BLOCKS MERGE.
- **P2 Important** - Performance issues, architectural problems, test gaps. Should fix before merge.
- **P3 Nice-to-have** - Style improvements, minor refactors, suggestions. Optional.

### Step 5: Create Todo Files

For each finding, create `todos/<id>-pending-<priority>-<short-desc>.md`:

```yaml
---
status: pending
priority: p1
source: security-sentinel
file: src/api/auth.ts
line: 45
---

## Issue

[Description of the problem]

## Why This Matters

[Impact if not fixed]

## Suggested Fix

[How to resolve it]

```

### Step 6: Report

Display summary:

```markdown
## Code Review Complete

**Target:** PR #42 - Add user authentication
**Files Changed:** 12
**Lines:** +340 / -45

### Findings Summary

| Priority | Count | Action |
|----------|-------|--------|
| P1 Critical | 2 | ⛔ BLOCKS MERGE |
| P2 Important | 5 | Should fix |
| P3 Nice-to-have | 8 | Optional |

### P1 - Must Fix Before Merge

1. **src/api/auth.ts:45** - SQL injection vulnerability
   - User input passed directly to query
   - Fix: Use parameterized queries

2. **src/utils/crypto.ts:12** - Hardcoded API key
   - Secret exposed in code
   - Fix: Move to environment variable

### P2 - Should Fix

1. **src/hooks/useAuth.ts:23** - Missing dependency in useEffect
2. **src/api/users.ts:78** - N+1 query pattern
3. ...

### Quick Wins (Easy P3s)

- Remove console.log on line 34
- Add return type to function on line 89
- ...

### Overall Assessment

[2-3 sentence summary of code quality and readiness]

### Next Steps

1. Fix P1 issues (required)
2. Address P2 issues (recommended)
3. Consider P3 suggestions (optional)
4. Re-run `/cd-review` after fixes

Todo files created in `todos/` directory.
```

## Handling Large Diffs

If diff is > 2000 lines:
1. Review file-by-file instead of all at once
2. Prioritize: security-sensitive files first
3. Tell user: "Large diff - reviewing in batches"

## Key Principles

1. **Parallel = fast** - All agents run simultaneously
2. **P1 blocks merge** - Non-negotiable
3. **Actionable findings** - Every issue has a fix suggestion
4. **Todo tracking** - Findings don't get lost
