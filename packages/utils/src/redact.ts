const SENSITIVE_KEY = /secret|password|token|authorization|signature|credential|apikey|api_key|ciphertext|databaseurl|database\.url/i;

export const REDACTED = "[redacted]";

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

export function redact(value: unknown, secrets: readonly string[] = [], depth = 0): unknown {
  if (depth > 8) {
    return "[max-depth]";
  }
  if (typeof value === "string") {
    return scrubString(value, secrets);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, secrets, depth + 1));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = isSensitiveKey(key) ? REDACTED : redact(nested, secrets, depth + 1);
    }
    return output;
  }
  return "[unserializable]";
}

export function scrubString(value: string, secrets: readonly string[]): string {
  let output = value;
  for (const secret of secrets) {
    if (secret.length < 6) {
      continue;
    }
    if (output.includes(secret)) {
      output = output.split(secret).join(REDACTED);
    }
  }
  return output;
}
