---
name: compound-dev
description: This skill provides a GitHub-centric development workflow with spec interviews, issue hierarchy management, smart resume from progress comments, multi-agent code review, and knowledge compounding. Tailored for TypeScript, React, and Python projects.
---

# Compound Dev

A GitHub-centric development workflow where each unit of work makes the next one easier.

```
Plan (Interview → GitHub Issues) → Work (Smart Resume) → Save → Review → Compound
```

## Quick Reference

| Command | What it does |
|---------|--------------|
| `/cd-spec` | From description OR document → Interview for gaps → Create GitHub issues |
| `/cd-work 42` | Fetch issue → Resume from progress comments → Work → Generate docs |
| `/cd-save` | Save progress to GitHub issue (manual or pre-compaction) |
| `/cd-review` | Run 7 parallel review agents on PR or branch |
| `/cd-compound` | Document what you learned for future reference |

## Core Philosophy

**GitHub issues are the single source of truth.**

- `/cd-spec` creates issues, not separate plan files
- `/cd-work` reads from GitHub issues AND their comments
- `/cd-save` writes progress TO GitHub issues
- Sessions can stop/resume anytime - progress is never lost

**GitHub comments = persistent memory.**

Unlike local files or Claude's context, GitHub issue comments:
- Survive context compaction
- Survive session restarts
- Are visible to the whole team
- Create an audit trail

---

## /cd-spec - From Idea or Document → GitHub Issues

**Purpose:** Turn a feature into structured GitHub issues. Start from a description OR an existing spec document.

### Usage

```bash
/cd-spec                           # Start fresh, ask what to build
/cd-spec "Add user authentication" # Start with description
/cd-spec docs/auth-spec.md         # Start from existing document
```

### Workflow

**If starting from a document:**
1. Read and analyze the file
2. Summarize what was found
3. Interview ONLY for gaps (don't re-ask what's in the doc)

**If starting from description (or nothing):**
1. Full spec interview using `ask_followup_question`
   - What problem? Who for? Happy path?
   - Error states? Performance? Existing patterns?
   - What's out of scope?
2. Summarize understanding and confirm

2. **Research** (parallel)
   - Repo patterns
   - Industry best practices
   - Framework documentation

3. **Break Down into Sub-Issues**
   
   Right-sized = 1-4 hours of work each:
   ```
   Parent: "Add user authentication" (#42)
   ├── Sub: "Set up auth provider" (#43)
   ├── Sub: "Create login UI" (#44)
   ├── Sub: "Protected routes" (#45)
   └── Sub: "Integration tests" (#46)
   ```

4. **Create GitHub Issues** with `gh issue create`

5. **Output:** Ready for `/cd-work <parent-number>`

See [commands/cd-spec.md](./commands/cd-spec.md) for full details.

---

## /cd-work - Smart Resume from GitHub

**Purpose:** Work on a GitHub issue, automatically resuming from where you left off.

### Usage

```
/cd-work 42    # Work on issue #42 (resumes if progress exists)
```

### Smart Resume

When you run `/cd-work 42`, it:

1. **Fetches issue + all comments**
2. **Looks for progress comments** (from `/cd-save`)
3. **If found, shows resume summary:**
   ```
   ## Resuming Issue #45
   Last saved: Jan 15, 3:45 PM
   
   Completed: 2 tasks
   In Progress: Add error handling (started try-catch)
   Remaining: 3 tasks
   
   Continue from here?
   ```
4. **Restores context** - files, state, blockers
5. **Continues from in-progress task**

### Discovered Issues

When you find bugs/edge cases while working:

```
Claude: "I found an issue: Form doesn't handle unicode names"
        Create GitHub issue for this? (yes/no)
```

If yes, creates linked issue:
```
#68 - [Discovery] Form validation unicode handling
      Discovered while working on #45
```

### Auto-Save

Every ~30 minutes, automatically saves progress to prevent loss.

See [commands/cd-work.md](./commands/cd-work.md) for full details.

---

## /cd-save - Save Progress to GitHub Issue

**Purpose:** Save current work progress so you can resume later.

### Usage

```
/cd-save           # Save progress on current issue (from branch name)
/cd-save 45        # Save progress on specific issue
```

### When to Use

- **End of day:** "Done for today"
- **Taking a break:** "Stepping away"
- **Before switching:** "Need to work on something else"
- **Automatically:** Called before context compaction

### What Gets Saved

Posted as a comment on the GitHub issue:

```markdown
## 🔄 Progress Update - Jan 15, 3:45 PM

### ✅ Completed
- [x] Create auth config
- [x] Set up provider init

### 🚧 In Progress
- [ ] Add error handling
  - State: Added try-catch, need error types
  - Next: Create NetworkError, AuthError classes

### 📋 Remaining
- [ ] Add retry logic
- [ ] Write tests

### 📁 Files Changed
- `src/auth/provider.ts`
- `src/auth/errors.ts` (new)

### 💾 Commits
- `abc123` - feat(auth): add provider init

### 🔍 Discovered Issues
- #68 - Unicode validation (created)

### 📝 Notes for Next Session
- Error types half done, see errors.ts
- Retry logic should use exponential backoff
```

### Pre-Compaction Hook

Before context compaction, `/cd-save` runs automatically:
```
[Context compaction approaching...]
[Auto-saving progress to #45...]
[Progress saved. You can resume with /cd-work 45]
```

See [commands/cd-save.md](./commands/cd-save.md) for full details.

---

## /cd-review - Multi-Agent Code Review

**Purpose:** Get comprehensive review from 7 specialized perspectives in parallel.

### Usage

```
/cd-review 48           # Review PR #48
/cd-review feature/auth # Review branch
/cd-review              # Review current branch
```

### Agents

| Agent | Focus |
|-------|-------|
| `typescript-reviewer` | Types, React patterns, hooks |
| `python-reviewer` | Type hints, Pythonic idioms |
| `security-sentinel` | Auth, injection, secrets |
| `performance-oracle` | Complexity, N+1, bundle size |
| `architecture-strategist` | Design, boundaries, coupling |
| `pattern-recognition-specialist` | Duplication, anti-patterns |
| `code-simplicity-reviewer` | Over-engineering, dead code |

### Output

Findings categorized:
- **P1 Critical** - BLOCKS MERGE
- **P2 Important** - Should fix
- **P3 Nice-to-have** - Optional

See [commands/cd-review.md](./commands/cd-review.md) for full details.

---

## /cd-compound - Document Learnings

**Purpose:** Capture solutions so they compound over time.

### Triggers

- Automatic: "that worked", "it's fixed", "finally got it"
- Manual: `/cd-compound`

### Creates

`docs/solutions/<category>/<date>-<slug>.md` with:
- Symptom
- Root cause
- Solution
- Prevention

See [commands/cd-compound.md](./commands/cd-compound.md) for full details.

---

## The Memory Model

```
┌─────────────────────────────────────────────────────────┐
│                    GitHub Issue #45                      │
├─────────────────────────────────────────────────────────┤
│ Title: Set up auth provider                             │
│ Body: Original spec, tasks, acceptance criteria         │
├─────────────────────────────────────────────────────────┤
│ Comment 1: 🔄 Progress Update - Jan 14                  │
│   - Completed: Config setup                             │
│   - In Progress: Provider init                          │
├─────────────────────────────────────────────────────────┤
│ Comment 2: 🔍 Discovered #67 - Token refresh edge case  │
├─────────────────────────────────────────────────────────┤
│ Comment 3: 🔄 Progress Update - Jan 15                  │
│   - Completed: Config, Provider init                    │
│   - In Progress: Error handling                         │
│   - Notes: Try-catch added, need error types            │
├─────────────────────────────────────────────────────────┤
│ Comment 4: ✅ Implementation Complete                   │
│   - PR: #89                                             │
│   - All tasks done                                      │
└─────────────────────────────────────────────────────────┘

          │
          │  /cd-work 45 reads all this
          │  /cd-save 45 writes progress comments
          ▼

┌─────────────────────────────────────────────────────────┐
│                  Claude's Context                        │
│                                                          │
│  "Resuming #45: Last saved Jan 15                       │
│   In progress: Error handling                           │
│   Next step: Create error types                         │
│   Files: src/auth/provider.ts, src/auth/errors.ts"      │
└─────────────────────────────────────────────────────────┘
```

**Key insight:** GitHub issue comments ARE the persistent memory. Claude reads them to restore state, writes them to save state.

---

## Discovered Issues Pattern

When working on issue A, you often find issues B, C, D:

```
Working on #45 (Protected routes)
    │
    ├── Found: Token refresh fails silently
    │   └── Create #67 with label "discovered"
    │
    ├── Found: Form doesn't clear on submit  
    │   └── Create #68 with label "discovered"
    │
    └── Continue working on #45
```

Each discovered issue:
- Links back to parent: "Discovered while working on #45"
- Gets appropriate priority label
- Doesn't interrupt current work
- Creates audit trail

---

## Workflow Example

```bash
# Monday: Plan a feature
/cd-spec "Add user authentication"
# → Interview happens
# → Creates #42 (parent) + #43, #44, #45, #46 (sub-issues)

# Monday: Start working
/cd-work 42
# → Shows sub-issues, starts with #43
# → Work for 2 hours...

# Monday EOD: Save progress
/cd-save
# → Posts progress comment to #43
# → "Done for today, progress saved"

# Tuesday: Resume
/cd-work 42
# → "Resuming #43, last saved Monday 5pm"
# → "In progress: Error handling, next: add retry"
# → Continues from exact spot

# Tuesday: Find a bug while working
# Claude: "Found edge case with token refresh"
# → Creates #67 as discovered issue
# → Continues on #43

# Tuesday: Finish #43
# → PR created, closes #43
# → "/cd-work 42" now shows #44 as next

# ... continue through sub-issues ...

# Friday: All done
# → Feature docs generated
# → #42 closes when all sub-issues close
```

---

## Directory Structure

```
project/
├── docs/
│   ├── features/              # Auto-generated feature docs
│   │   └── user-auth.md
│   └── solutions/             # Compounded knowledge
│       ├── typescript/
│       ├── react/
│       └── python/
├── todos/                     # Review findings tracking
│   └── 001-p1-security-fix.md
└── ...
```

---

## Tips

1. **Use `/cd-save` liberally** - Can't over-save, can definitely under-save
2. **Let `/cd-work` resume** - Don't manually reconstruct state
3. **Create discovered issues** - Don't lose bugs found along the way
4. **One sub-issue = one PR** - Easier to review and revert
5. **Trust the comments** - They're your persistent memory
