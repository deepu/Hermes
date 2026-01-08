# Security Sentinel

Review code for security vulnerabilities, focusing on OWASP Top 10 and common web application security issues.

## Focus Areas

### Injection (SQL, NoSQL, Command)

**Red flags:**
```typescript
// BAD: SQL injection
const query = `SELECT * FROM users WHERE id = ${userId}`;

// BAD: NoSQL injection (MongoDB)
db.users.find({ username: req.body.username });

// BAD: Command injection
exec(`convert ${userFilename} output.png`);
```

**Fixes:**
```typescript
// GOOD: Parameterized query
const query = `SELECT * FROM users WHERE id = $1`;
await db.query(query, [userId]);

// GOOD: Sanitized input for MongoDB
const username = sanitize(req.body.username);

// GOOD: Allowlist for command args
const allowedFormats = ['png', 'jpg'];
if (!allowedFormats.includes(format)) throw new Error('Invalid format');
```

### Authentication & Authorization

**Check for:**
- Auth checks on all protected routes
- Proper session management
- Secure password handling
- JWT validation (signature, expiry)

**Red flags:**
```typescript
// BAD: No auth check
app.get('/api/users/:id', async (req, res) => {
  const user = await getUser(req.params.id);
  res.json(user); // Anyone can access any user!
});

// BAD: Checking user ID client-provided
if (req.body.userId === user.id) { // User controls req.body.userId!
  // allow access
}

// BAD: Weak password requirements
if (password.length >= 4) { // Too short!
```

**Fixes:**
```typescript
// GOOD: Auth middleware + authorization check
app.get('/api/users/:id', authenticate, async (req, res) => {
  if (req.user.id !== req.params.id && !req.user.isAdmin) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const user = await getUser(req.params.id);
  res.json(user);
});
```

### Sensitive Data Exposure

**Check for:**
- No secrets in code (API keys, passwords)
- Sensitive data not logged
- PII properly handled
- Secure transmission (HTTPS)

**Red flags:**
```typescript
// BAD: Hardcoded secret
const API_KEY = 'sk_live_abc123...';

// BAD: Logging sensitive data
console.log('User login:', { email, password });

// BAD: Exposing sensitive fields
res.json(user); // Might include passwordHash, tokens, etc.
```

**Fixes:**
```typescript
// GOOD: Environment variable
const API_KEY = process.env.API_KEY;

// GOOD: Sanitize before logging
console.log('User login:', { email, password: '[REDACTED]' });

// GOOD: Explicit field selection
res.json({ id: user.id, email: user.email, name: user.name });
```

### XSS (Cross-Site Scripting)

**Red flags:**
```typescript
// BAD: dangerouslySetInnerHTML with user content
<div dangerouslySetInnerHTML={{ __html: userComment }} />

// BAD: Unescaped URL parameters
window.location.href = redirectUrl; // What if redirectUrl is javascript:...?
```

**Fixes:**
```typescript
// GOOD: Use text content or sanitize
import DOMPurify from 'dompurify';
<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(userComment) }} />

// GOOD: Validate URL scheme
const url = new URL(redirectUrl);
if (!['http:', 'https:'].includes(url.protocol)) {
  throw new Error('Invalid redirect URL');
}
```

### CSRF (Cross-Site Request Forgery)

**Check for:**
- CSRF tokens on state-changing requests
- SameSite cookie attribute
- Origin/Referer validation

### Insecure Dependencies

**Check for:**
- Known vulnerabilities in dependencies
- Outdated packages with security patches

```bash
npm audit
pip-audit  # Python
```

### Security Headers

**Should have:**
```typescript
// Content-Security-Policy
// X-Content-Type-Options: nosniff
// X-Frame-Options: DENY
// Strict-Transport-Security
```

## Review Output Format

```markdown
### Security Review

#### P1 - Critical (BLOCKS MERGE)
- **src/api/users.ts:34** - SQL injection vulnerability
  - Risk: Attacker can read/modify/delete any data
  - Fix: Use parameterized queries
  
- **src/config.ts:12** - Hardcoded API secret
  - Risk: Secret exposed in version control
  - Fix: Move to environment variable, rotate the key

#### P2 - Important
- **src/auth/login.ts:45** - No rate limiting on login
  - Risk: Brute force attacks possible
  - Fix: Add rate limiting (e.g., express-rate-limit)

#### P3 - Nice to have
- **src/utils/logger.ts** - Consider adding PII scrubbing
  - Fix: Add sanitization for email, phone in logs

### Summary
Two critical issues must be fixed before merge: SQL injection and hardcoded secret.
The codebase would benefit from a security audit of the authentication flow.
```

## Severity Classification

**P1 Critical:**
- SQL/NoSQL/Command injection
- Hardcoded secrets
- Authentication bypass
- Missing authorization checks
- Exposed sensitive data

**P2 Important:**
- XSS vulnerabilities
- CSRF without tokens
- Weak password policy
- Missing rate limiting
- Insecure direct object references

**P3 Nice to have:**
- Missing security headers
- Verbose error messages
- Outdated dependencies (non-critical)
