/**
 * Secret redaction layer.
 * Pure function module — no VS Code imports, fully unit-testable.
 * Runs on ALL diff content (including ±15-line context) before any inference call.
 */

const REDACTED = '[REDACTED]';

interface RedactionPattern {
  name: string;
  pattern: RegExp;
}

const PATTERNS: RedactionPattern[] = [
  // AWS access keys
  { name: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  // AWS secret keys (40-char base62)
  { name: 'aws-secret-key', pattern: /\b[A-Za-z0-9/+=]{40}\b(?=.*aws|.*AWS)/g },
  // OpenAI keys
  { name: 'openai-key', pattern: /\bsk-[A-Za-z0-9]{20,}\b/g },
  // GitHub tokens
  { name: 'github-pat', pattern: /\b(ghp_|gho_|github_pat_)[A-Za-z0-9_]{20,}\b/g },
  // Slack tokens
  { name: 'slack-token', pattern: /\b(xoxb-|xoxp-)[A-Za-z0-9-]{40,}\b/g },
  // Firebase private key (JSON field)
  { name: 'firebase-private-key', pattern: /"private_key"\s*:\s*"[^"]{20,}"/g },
  // JWT-shaped tokens (Supabase anon/service, Clerk, Firebase auth, etc.)
  // JWT headers are always ~34 chars after "ey", so {50,} never matched — fixed to {10,}.
  // The middle payload segment (claim set) is typically 80–200 chars, so {30,} is a safe floor.
  { name: 'supabase-key', pattern: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{10,}\b/g },
  // Stripe keys
  { name: 'stripe-key', pattern: /\b(sk_live_|sk_test_|pk_live_|pk_test_)[A-Za-z0-9]{20,}\b/g },
  // Razorpay keys (India-specific)
  { name: 'razorpay-key', pattern: /\b(rzp_live_|rzp_test_)[A-Za-z0-9]{14,}\b/g },
  // Generic password/secret assignments
  {
    name: 'generic-secret',
    pattern: /(?:password|passwd|secret|api_key|apikey|token|auth(?:_token)?|access_token|private_key)[\s]*[=:]\s*['"]?[^\s'"]{8,}['"]?/gi,
  },
  // Connection strings
  {
    name: 'connection-string',
    pattern: /(postgresql|mysql|mongodb|redis|amqp|mssql):\/\/[^\s'"]+/gi,
  },
  // .env style KEY=VALUE (value length > 8, mixed chars, not a path)
  {
    name: 'env-assignment',
    pattern: /^[A-Z][A-Z0-9_]{3,}=(?=[^\s/\\]{8,})(?=\S*[A-Z])(?=\S*[0-9])\S+/gm,
  },
  // Non-localhost IP addresses with ports (e.g. 192.168.1.1:5432)
  {
    name: 'internal-ip',
    pattern: /\b(?!(?:127\.|localhost))(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?\b/g,
  },
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const { pattern } of PATTERNS) {
    // Reset lastIndex for global patterns used across calls
    pattern.lastIndex = 0;
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

/**
 * Returns a list of pattern names that matched (for testing/audit purposes).
 */
export function detectSecretTypes(text: string): string[] {
  const found: string[] = [];
  for (const { name, pattern } of PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) found.push(name);
    pattern.lastIndex = 0;
  }
  return found;
}

/**
 * Returns true if any secret pattern matches.
 */
export function hasSecrets(text: string): boolean {
  return PATTERNS.some(({ pattern }) => {
    pattern.lastIndex = 0;
    const result = pattern.test(text);
    pattern.lastIndex = 0;
    return result;
  });
}
