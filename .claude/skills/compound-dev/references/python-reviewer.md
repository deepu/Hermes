# Python Reviewer

Review Python code for type safety, Pythonic patterns, and modern best practices.

## Focus Areas

### Type Hints

**Required:**
- All function parameters and return types
- Class attributes (especially in `__init__`)
- Module-level variables when type isn't obvious

**Modern syntax (Python 3.10+):**
```python
# GOOD: Modern union syntax
def process(value: str | None) -> dict[str, Any]:
    ...

# GOOD: Use built-in generics
def get_users() -> list[User]:  # Not List[User]
    ...

# GOOD: TypedDict for structured dicts
class UserData(TypedDict):
    id: int
    name: str
    email: str | None
```

**Red flags:**
```python
# BAD: No type hints
def calculate(x, y):
    return x + y

# BAD: Using Any without justification
def process(data: Any) -> Any:
    ...

# BAD: Old-style type hints
from typing import List, Dict, Optional
def get_items() -> List[Dict[str, str]]:  # Use list[dict[str, str]]
```

### Pythonic Patterns

**Use:**
```python
# GOOD: List comprehension
squares = [x**2 for x in numbers]

# GOOD: Dict comprehension
user_by_id = {u.id: u for u in users}

# GOOD: Context managers
with open(path) as f:
    content = f.read()

# GOOD: f-strings
message = f"Hello, {name}!"

# GOOD: Walrus operator (3.8+)
if (match := pattern.search(text)):
    process(match.group())

# GOOD: Match statement (3.10+)
match status:
    case "pending":
        handle_pending()
    case "complete":
        handle_complete()
    case _:
        handle_unknown()
```

**Avoid:**
```python
# BAD: Manual loop when comprehension works
result = []
for x in numbers:
    result.append(x**2)

# BAD: String concatenation in loops
result = ""
for item in items:
    result += str(item)  # Use ''.join()

# BAD: Using dict.keys() unnecessarily
if key in dict.keys():  # Just: if key in dict:

# BAD: Catching bare Exception
try:
    risky()
except Exception:  # Too broad
    pass
```

### Import Organization

Order:
1. Standard library
2. Third-party packages
3. Local imports

```python
# Standard library
import os
from datetime import datetime
from typing import Any

# Third-party
import httpx
from pydantic import BaseModel

# Local
from .models import User
from .utils import format_date
```

**Use absolute imports** for clarity in larger projects.

### Error Handling

```python
# GOOD: Specific exceptions
try:
    user = get_user(user_id)
except UserNotFoundError:
    return None
except DatabaseError as e:
    logger.error(f"Database error: {e}")
    raise

# GOOD: Custom exceptions
class UserNotFoundError(Exception):
    def __init__(self, user_id: int):
        self.user_id = user_id
        super().__init__(f"User {user_id} not found")
```

### Async Patterns

```python
# GOOD: Async context manager
async with httpx.AsyncClient() as client:
    response = await client.get(url)

# GOOD: Gather for concurrent operations
results = await asyncio.gather(
    fetch_user(user_id),
    fetch_orders(user_id),
    fetch_preferences(user_id),
)

# BAD: Sequential when could be concurrent
user = await fetch_user(user_id)
orders = await fetch_orders(user_id)  # Waits for user unnecessarily
```

### Dataclasses and Pydantic

**Prefer dataclasses for internal data:**
```python
from dataclasses import dataclass

@dataclass
class Point:
    x: float
    y: float
    
    def distance_from_origin(self) -> float:
        return (self.x**2 + self.y**2)**0.5
```

**Prefer Pydantic for validation/serialization:**
```python
from pydantic import BaseModel, validator

class UserCreate(BaseModel):
    email: str
    password: str
    
    @validator('email')
    def email_must_be_valid(cls, v):
        if '@' not in v:
            raise ValueError('Invalid email')
        return v.lower()
```

### Module Extraction Signals

Consider extracting when:
- File > 300 lines
- Multiple unrelated classes in one file
- Utility functions not specific to the module
- Circular import workarounds needed

## Review Output Format

```markdown
### Python Review

#### P1 - Critical
- **src/api/handlers.py:45** - No type hints on public function
  - Why: API contract unclear, type errors possible
  - Fix: Add parameter and return type hints

#### P2 - Important  
- **src/utils/data.py:23** - Catching bare Exception
  - Why: Hides bugs, catches KeyboardInterrupt
  - Fix: Catch specific exception types

- **src/services/user.py:67** - Sequential awaits could be concurrent
  - Why: Performance - waiting unnecessarily
  - Fix: Use asyncio.gather()

#### P3 - Nice to have
- **src/models.py:12** - Using typing.List instead of list
  - Fix: Update to modern syntax: list[str]

### Summary
Good overall structure. Main concerns are missing type hints in the API layer
and overly broad exception handling. Consider adding a type checker to CI.
```

## Tools to Suggest

- **ruff** - Fast linter and formatter
- **mypy** - Static type checking
- **pytest** - Testing
- **black** - Code formatting
