# Compound Dev

A GitHub-centric development workflow for TypeScript/React/Python projects.

**Key feature:** GitHub issue comments = persistent memory. Progress survives context compaction.

## The Flow

```
/cd-spec → From description OR existing doc → Interview for gaps → Create GitHub Issues
                              ↓
/cd-work 42 → Read issue + comments → Resume from last progress → Work
                              ↓
/cd-save → Write progress comment → Safe to stop anytime
                              ↓
/cd-review → 7 parallel agents → Prioritized findings
                              ↓
/cd-compound → Document solutions → Searchable knowledge base
```

## Installation

```bash
# User-level (all projects)
cp -r compound-dev ~/.claude/skills/

# Project-level (just this project)
cp -r compound-dev .claude/skills/
```

## Commands

| Command | What it does |
|---------|--------------|
| `/cd-spec` | From description OR doc → Interview for gaps → Create GitHub issues |
| `/cd-work 42` | Resume from progress comments → Work on issue → Auto-save |
| `/cd-save` | Save progress to GitHub issue (anytime or pre-compaction) |
| `/cd-review` | Run 7 review agents in parallel |
| `/cd-compound` | Document a solved problem |

## The Magic: Smart Resume

```bash
# Monday 5pm - done for the day
/cd-save
# → Progress saved to GitHub issue #45 as a comment

# Tuesday 9am - pick up where you left off
/cd-work 45
# → "Resuming #45: Last saved Monday 5pm"
# → "In progress: Add error handling"
# → "Next step: Create error types in errors.ts"
# → Continues from exact spot
```

**How it works:**
- `/cd-save` posts a structured comment to the GitHub issue
- `/cd-work` reads all comments to find latest progress
- Context restored: completed tasks, current task, files, blockers

## Discovered Issues

When you find bugs while working on something else:

```
Claude: "Found an edge case: token refresh fails silently"
        Create GitHub issue? (yes/no)

You: yes

Claude: Created #67 - [Discovery] Token refresh failure
        Linked to parent #45
        Continuing work on #45...
```

Discovered issues:
- Get labeled `discovered`
- Link back to where they were found
- Don't interrupt your current work
- Create an audit trail

## Example Session

```bash
# Option A: Plan from scratch (Claude interviews you)
/cd-spec "Add user authentication"

# Option B: Plan from existing doc (Claude fills gaps)
/cd-spec docs/auth-spec.md
# → "I've read your doc. Gaps: no error handling mentioned..."
# → Only asks about what's missing

# Either way, creates: #42 (parent), #43, #44, #45, #46 (sub-issues)

# Start working
/cd-work 42
# Shows sub-issues, starts with #43

# Work for a while... find a bug
# Claude creates #67 as discovered issue

# Done for the day
/cd-save
# Progress posted to #43

# Next day
/cd-work 42
# "Resuming #43 from yesterday..."

# Finish #43, PR created
/cd-work 42
# "Moving to #44..."

# Eventually all done
# Feature docs auto-generated
```

## Pre-Compaction Safety

Before Claude's context gets compacted:

```
[Context compaction approaching...]
[Auto-saving progress to #45...]
[Saved. Resume anytime with /cd-work 45]
```

Your progress is never lost.

## Structure

```
compound-dev/
├── SKILL.md                    # Main reference
├── README.md                   # This file
├── commands/
│   ├── plan.md                 # Interview → GitHub issues
│   ├── work.md                 # Smart resume workflow
│   ├── save.md                 # Progress saving  
│   ├── review.md               # Multi-agent review
│   └── compound.md             # Knowledge capture
└── references/
    ├── typescript-reviewer.md
    ├── python-reviewer.md
    └── security-sentinel.md
```

## Why GitHub Comments?

Unlike local files or Claude's context:
- ✅ Survive context compaction
- ✅ Survive session restarts  
- ✅ Visible to whole team
- ✅ Create audit trail
- ✅ Searchable history
- ✅ No extra tools needed

## Based On

Adapted from [Compound Engineering Plugin](https://github.com/EveryInc/cd-compound-engineering-plugin).

**Key additions:**
- `/cd-save` command for progress persistence
- Smart resume in `/cd-work` from issue comments
- Discovered issues pattern
- GitHub comments as memory layer
