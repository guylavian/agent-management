import type { Evidence } from "./evidence.ts";

const RULES: Array<{ category: string; pattern: RegExp }> = [
  { category: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/giu },
  { category: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/giu },
  { category: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu },
  { category: "password", pattern: /\b(password|passwd|pwd)\s*[:=]\s*[^\s,;]+/giu },
  { category: "connection-string", pattern: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql):\/\/[^\s]+/giu },
];

export interface RedactionResult { value: string; categories: string[] }

export function redactText(input: string): RedactionResult {
  let value = input.normalize("NFKC").replace(/[\u200B-\u200D\u2060\uFEFF]/gu, "");
  const categories = new Set<string>();
  for (const rule of RULES) {
    value = value.replace(rule.pattern, () => {
      categories.add(rule.category);
      return `[REDACTED:${rule.category}]`;
    });
  }
  return { value, categories: [...categories].sort() };
}

export function redactUnknown(value: unknown): { value: unknown; categories: string[] } {
  const categories = new Set<string>();
  const visit = (item: unknown): unknown => {
    if (typeof item === "string") {
      const redacted = redactText(item);
      redacted.categories.forEach((category) => categories.add(category));
      return redacted.value;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)]));
    }
    return item;
  };
  return { value: visit(value), categories: [...categories].sort() };
}

export function redactEvidence(evidence: Evidence): Evidence {
  const payload = redactUnknown(evidence.payload);
  const excerpt = evidence.rawExcerpt === undefined ? { value: undefined, categories: [] } : redactText(evidence.rawExcerpt);
  const categories = [...new Set([...payload.categories, ...excerpt.categories])].sort();
  return {
    ...evidence,
    ...(evidence.payload === undefined ? {} : { payload: payload.value }),
    ...(excerpt.value === undefined ? {} : { rawExcerpt: excerpt.value }),
    redaction: { applied: categories.length > 0, ...(categories.length ? { categories } : {}) },
  };
}
