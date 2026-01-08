# TypeScript/React Reviewer

Review TypeScript and React code for type safety, patterns, and best practices.

## Focus Areas

### Type Safety

**Check for:**
- No `any` without explicit justification comment
- Proper use of `unknown` for truly unknown types
- Type narrowing with type guards
- Discriminated unions for state
- Proper generic constraints

**Red flags:**
```typescript
// BAD: any without justification
function process(data: any) { ... }

// BAD: Type assertion without check
const user = data as User;

// BAD: Non-null assertion overuse
user!.profile!.name!
```

**Good patterns:**
```typescript
// GOOD: Type guard
function isUser(data: unknown): data is User {
  return typeof data === 'object' && data !== null && 'id' in data;
}

// GOOD: Discriminated union
type State = 
  | { status: 'loading' }
  | { status: 'error'; error: Error }
  | { status: 'success'; data: User };
```

### React Patterns

**Hooks:**
- Dependencies array completeness in useEffect/useCallback/useMemo
- Custom hooks for reusable logic
- Proper cleanup in useEffect
- Avoid hooks in conditionals/loops

**Red flags:**
```typescript
// BAD: Missing dependency
useEffect(() => {
  fetchUser(userId);
}, []); // userId should be in deps

// BAD: Object in dependency (new reference each render)
useEffect(() => {
  doSomething(options);
}, [{ page: 1 }]); // Should be [page] or memoized

// BAD: No cleanup for subscription
useEffect(() => {
  const sub = events.subscribe(handler);
  // Missing: return () => sub.unsubscribe();
}, []);
```

**Component Structure:**
- Single responsibility
- Props interface clearly defined
- Avoid prop drilling (use context or composition)
- Memoization only when needed (profile first)

### Modern TypeScript (4.0+)

**Use:**
- Template literal types where helpful
- `satisfies` operator for type checking with inference
- `const` assertions for literal types
- Optional chaining `?.` and nullish coalescing `??`

**Avoid:**
- Legacy `namespace` (use modules)
- `enum` (prefer union types or const objects)
- `/// <reference>` directives

### Import Organization

Standard order:
1. React/framework imports
2. Third-party libraries
3. Internal absolute imports
4. Relative imports
5. Type-only imports

```typescript
import { useState } from 'react';
import { format } from 'date-fns';
import { Button } from '@/components/ui';
import { useAuth } from '../hooks';
import type { User } from '../types';
```

## Review Output Format

```markdown
### TypeScript Review

#### P1 - Critical
- **src/components/Auth.tsx:45** - Using `any` for API response
  - Why: Loses type safety, bugs slip through
  - Fix: Define proper response type or use `unknown` with validation

#### P2 - Important
- **src/hooks/useUser.ts:23** - Missing `userId` in useEffect dependencies
  - Why: Stale closure, won't refetch when userId changes
  - Fix: Add `userId` to dependency array

#### P3 - Nice to have
- **src/utils/format.ts:12** - Could use `satisfies` for better inference
  - Fix: `const config = { ... } satisfies Config`

### Summary
Types are generally good, but watch out for the `any` usage in API responses. 
Consider adding zod or similar for runtime validation at API boundaries.
```
