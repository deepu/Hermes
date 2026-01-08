---
name: cd-compound
description: Document a solved problem to compound team knowledge
---

# /cd-compound - Document Learnings

Capture solutions so they compound over time. Each documented problem makes future debugging faster.

## Triggers

### Automatic Triggers

Listen for phrases indicating a problem was solved:
- "that worked"
- "it's fixed"
- "finally got it"
- "problem solved"
- "that was it"
- "working now"

When detected, ask: "Sounds like you solved something! Want me to document it with `/cd-compound`?"

### Manual Trigger

```
/cd-compound                    # Start documentation flow
/cd-compound auth bug fix       # With context hint
```

## Process

### Step 1: Verify Solution

Before documenting, confirm:

> Before I document this - is the problem fully solved and verified working?
> 
> (I want to make sure we capture the actual solution, not a partial fix)

Wait for confirmation.

### Step 2: Interview for Context

Use `ask_followup_question` to gather details. Ask ONE at a time:

1. **Symptom**
   "What was the symptom? What error message or unexpected behavior did you see?"

2. **Context**
   "Where did this happen? (file, feature, user flow)"

3. **Root Cause**
   "What was the actual root cause? Why was it happening?"

4. **Discovery**
   "How did you find the root cause? What led you to it?"

5. **Solution**
   "What was the fix? (code change, config change, etc.)"

6. **Prevention**
   "How can we prevent this in the future? (tests, linting rules, patterns to follow)"

### Step 3: Categorize

Determine the appropriate category:

| Category | When to Use |
|----------|-------------|
| `build-errors/` | Compilation, bundling, dependency issues |
| `test-failures/` | Test-related problems |
| `runtime-errors/` | Errors during execution |
| `performance/` | Slowness, memory, optimization |
| `typescript/` | TS-specific type errors, patterns |
| `react/` | React-specific (hooks, rendering, state) |
| `python/` | Python-specific issues |
| `tooling/` | IDE, linter, formatter issues |
| `deployment/` | CI/CD, hosting, environment issues |

### Step 4: Generate Filename

Format: `<date>-<short-description>.md`

Examples:
- `2024-01-15-useeffect-missing-dependency.md`
- `2024-01-15-type-narrowing-with-discriminated-unions.md`
- `2024-01-15-pytest-fixture-scope-confusion.md`

### Step 5: Create Document

Create `docs/solutions/<category>/<filename>.md`:

```markdown
---
title: <Descriptive Title>
category: <category>
tags: [tag1, tag2, tag3]
created: <YYYY-MM-DD>
---

# <Title>

## Symptom

[What you saw - error message, unexpected behavior, screenshot if relevant]

```
<exact error message if applicable>
```

## Context

[Where this happened - file, feature, user flow]

## Root Cause

[Why it was happening - the actual underlying issue]

## Solution

[How to fix it]

```typescript
// Code example if relevant
```

## How I Found It

[Debugging steps that led to the root cause - helps future debugging]

## Prevention

[How to prevent this in the future]

- [ ] Add test for this case
- [ ] Add linting rule
- [ ] Update documentation
- [ ] Create pattern to follow

## Related

[Links to related docs, issues, or external resources]
```

### Step 6: Confirm

Show the user:

```markdown
## Documented ✓

**File:** docs/solutions/<category>/<filename>.md
**Title:** <title>
**Tags:** <tags>

### Summary

<2-3 sentence summary of what was captured>

This solution is now searchable for future reference.
```

## Finding Past Solutions

When starting to debug a new issue, first search existing solutions:

```bash
# Search by keyword
grep -r "keyword" docs/solutions/

# Search by tag in frontmatter
grep -l "tags:.*typescript" docs/solutions/**/*.md

# Recent solutions
ls -lt docs/solutions/**/*.md | head -10
```

## Directory Structure

```
docs/
└── solutions/
    ├── build-errors/
    │   └── 2024-01-10-vite-chunk-error.md
    ├── typescript/
    │   └── 2024-01-12-type-narrowing-issue.md
    ├── react/
    │   └── 2024-01-15-useeffect-cleanup.md
    ├── python/
    │   └── 2024-01-14-async-context-manager.md
    └── ...
```

## Key Principles

1. **Capture immediately** - Details fade fast
2. **Include the error message** - Exact text helps searching
3. **Explain the "why"** - Root cause, not just fix
4. **Add prevention steps** - Stop it from happening again
5. **Make it searchable** - Good title, tags, keywords

## Compound Effect

Over time, this creates a searchable knowledge base:
- New team members learn from past issues
- Same bugs don't waste time twice
- Patterns emerge (what breaks often?)
- Documentation stays close to code
