---
name: cd-spec
description: Create GitHub issues from a feature idea OR an existing spec document. Interviews to fill gaps.
---

# /cd-spec - From Idea or Document → GitHub Issues

Turn a feature into structured GitHub issues. Start from:
- **A description** - "Add user authentication"
- **A markdown file** - `docs/auth-spec.md` (your existing notes/spec)

## Usage

```bash
/cd-spec                           # Start fresh, ask what to build
/cd-spec "Add user authentication" # Start with description
/cd-spec docs/auth-spec.md         # Start from existing document
/cd-spec specs/feature.md          # Start from existing document
```

## Process

### Step 0: Detect Input Type

**If no argument:**
```
ask_followup_question: "What would you like to plan? 

You can:
1. Describe the feature (e.g., 'Add user authentication')
2. Point to a document (e.g., 'docs/auth-spec.md')

What do you have?"
```

**If argument is a file path** (ends in `.md`, `.txt`, or file exists):
→ Go to **Document-First Flow**

**If argument is text:**
→ Go to **Description-First Flow**

---

## Document-First Flow

When starting from an existing markdown file:

### Step 1: Read and Analyze Document

```bash
cat <filepath>
```

Parse the document for:
- **Title/Feature name**
- **Problem statement** (why)
- **User/audience** (who)
- **Requirements** (what)
- **Technical details** (how)
- **Edge cases**
- **Out of scope**
- **Open questions**

### Step 2: Summarize Understanding

```
"I've read your document. Here's what I found:

**Feature:** <extracted title>
**Problem:** <extracted or 'Not specified'>
**Users:** <extracted or 'Not specified'>
**Requirements:**
- <requirement 1>
- <requirement 2>
- ...

**Technical Notes:**
- <any technical details mentioned>

**Edge Cases Mentioned:**
- <edge case 1>
- ...

**Open Questions in Doc:**
- <any questions or TBDs in the doc>

**Gaps I noticed:**
- <missing info 1>
- <missing info 2>

Is this accurate?"
```

Wait for confirmation.

### Step 3: Interview for Gaps

Only ask about what's MISSING from the document. Use `ask_followup_question` for each gap:

```
# Only if not in document:
ask_followup_question: "The doc doesn't mention error handling. What should happen when <specific scenario> fails?"

# Only if not in document:
ask_followup_question: "I didn't see performance requirements. Any constraints on response time or data volume?"

# Only if not in document:
ask_followup_question: "What's explicitly out of scope? (So I don't over-build)"
```

**Skip questions already answered in the document.**

### Step 4: Proceed to Research & Issue Creation

(Same as description-first flow from Step 2 onward)

---

## Description-First Flow

When starting from a description or nothing:

### Step 1: Spec Interview (Full)

Use `ask_followup_question` for each. Ask ONE at a time, wait for answer:

```
ask_followup_question: "What problem are we solving? What's the user pain point?"
[wait]

ask_followup_question: "Who is this for? Any specific user types or permission levels?"
[wait]

ask_followup_question: "Walk me through the happy path - what does success look like?"
[wait]

ask_followup_question: "What should happen when things go wrong? Any error states to handle?"
[wait]

ask_followup_question: "Any performance constraints or expected data volumes?"
[wait]

ask_followup_question: "Any existing patterns in the codebase I should follow?"
[wait]

ask_followup_question: "What's explicitly out of scope?"
[wait]
```

Summarize and confirm:

```
ask_followup_question: "Here's my understanding:

**Problem:** [what we're solving]
**User:** [who it's for]  
**Happy Path:** [main flow]
**Edge Cases:** [what we discussed]
**Out of Scope:** [boundaries]

Does this match your vision? Any corrections?"
```

---

## Common Flow (Both Paths Continue Here)

### Step 2: Research (Parallel)

Launch simultaneously:

1. **Repo Research** - Find existing patterns in codebase
2. **Best Practices** - Find industry standards (2024-2025)
3. **Framework Docs** - Get relevant TypeScript/React/Python docs

### Step 3: Break Down into Sub-Issues

Right-sized chunks (1-4 hours each):

```
Parent: "Add user authentication" (#42)
├── Sub: "Set up auth provider" (#43)
├── Sub: "Create login UI" (#44)
├── Sub: "Protected routes" (#45)
└── Sub: "Integration tests" (#46)
```

**Good sub-issue size:**
- 1-4 hours of work
- Single responsibility
- Can be reviewed independently
- Has clear acceptance criteria

### Step 4: Create GitHub Issues

**Create each sub-issue first:**

```bash
gh issue create \
  --title "[Parent Feature] Sub-task: <specific task>" \
  --label "sub-issue" \
  --body "## Overview
<What this sub-issue accomplishes>

## Parent Issue
Part of #TBD (will update after parent created)

## Tasks
- [ ] Task 1
- [ ] Task 2

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2

## Technical Notes
<Any implementation details from spec/interview>

## Dependencies
- Depends on: #<issue> (if any)
- Blocks: #<issue> (if any)"
```

**Then create parent issue:**

```bash
gh issue create \
  --title "<Feature Name>" \
  --label "feature,epic" \
  --body "## Summary
<Problem we're solving and why>

## User Story
As a [user type], I want to [action] so that [benefit].

## Spec Summary
<From interview OR from original document>

## Source Document
<If started from file: link or path to original doc>

## Sub-Issues
- [ ] #<sub-1> - <title>
- [ ] #<sub-2> - <title>
- [ ] #<sub-3> - <title>

## Implementation Order
1. #<sub-1> (no dependencies)
2. #<sub-2> (depends on #<sub-1>)
...

## Edge Cases
| Case | Handling |
|------|----------|
| <edge case> | <how we handle> |

## Out of Scope
- <exclusion 1>
- <exclusion 2>

## Research Notes
<Key findings from research phase>

## Acceptance Criteria
- [ ] All sub-issues completed
- [ ] Feature works end-to-end
- [ ] Documentation updated
- [ ] Tests passing"
```

**Link sub-issues to parent:**

```bash
gh issue comment <sub-issue-number> --body "Parent issue: #<parent-number>"
```

### Step 5: Report

```markdown
## GitHub Issues Created ✓

**Source:** <"Your description" OR "docs/auth-spec.md">

**Parent Issue:** #<number> - <title>
**URL:** <github-url>

**Sub-Issues:**
1. #<sub-1> - <title>
2. #<sub-2> - <title>
3. #<sub-3> - <title>

**Implementation Order:**
Start with #<sub-1>, then...

**Next Step:**
Run `/cd-work <parent-number>` to start implementation.
```

---

## Examples

### Example 1: Fresh Start

```
You: /cd-spec

Claude: "What would you like to plan? Describe the feature or point to a document."

You: "Add ability for users to export their data as CSV"

Claude: "What problem are we solving?..."
[full interview]
```

### Example 2: From Description

```
You: /cd-spec "Add dark mode support"

Claude: "What problem are we solving? What's the user pain point?"
[full interview starting from that context]
```

### Example 3: From Document

```
You: /cd-spec docs/dark-mode-spec.md

Claude: "I've read your document. Here's what I found:

**Feature:** Dark Mode Support
**Problem:** Users want reduced eye strain at night
**Requirements:**
- Toggle in settings
- Persist preference
- System preference detection
...

**Gaps I noticed:**
- No mention of which components need updating
- No error handling specified

Is this accurate?"

You: "Yes"

Claude: "The doc doesn't specify which components need dark mode. 
        Should this be app-wide or specific sections?"
[targeted questions only for gaps]
```

---

## Key Principles

1. **Don't re-ask what's answered** - If the doc specifies it, don't ask again
2. **Always fill gaps** - Interview for missing pieces
3. **Preserve original context** - Link to source doc in parent issue
4. **Same output format** - Whether from doc or description, end result is GitHub issues
