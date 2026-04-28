import type { EmailInvoicePayload } from "./schemas.js";
import { InputValidationError } from "./errors.js";
import type { ParsedExpense } from "./types.js";

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const CURRENCY_ALIASES: Record<string, string> = {
  "$": "USD",
  usd: "USD",
  us$: "USD",
  eur: "EUR",
  "€": "EUR",
  gbp: "GBP",
  "£": "GBP",
  ils: "ILS",
  "₪": "ILS"
};

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " "
};

export function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export function decodeBase64OrThrow(value: string): Buffer {
  const normalized = value.replace(/\s+/g, "");

  if (normalized.length === 0 || normalized.length % 4 !== 0 || !BASE64_PATTERN.test(normalized)) {
    throw new InputValidationError("Attachment contentBase64 is not valid base64.");
  }

  const buffer = Buffer.from(normalized, "base64");
  const roundTrip = buffer.toString("base64").replace(/=+$/u, "");

  if (roundTrip !== normalized.replace(/=+$/u, "")) {
    throw new InputValidationError("Attachment contentBase64 is not valid base64.");
  }

  return buffer;
}

export function isPdfAttachment(
  attachment: EmailInvoicePayload["attachments"][number]
): boolean {
  return (
    attachment.contentType.toLowerCase() === "application/pdf" ||
    attachment.filename.toLowerCase().endsWith(".pdf")
  );
}

export function normalizeReference(reference: string): string {
  return reference.trim().replace(/\s+/g, "").toUpperCase();
}

export function createReferenceDedupeKey(reference: string): string {
  return `ref:${normalizeReference(reference)}`;
}

export function createMessageDedupeKey(messageId: string): string {
  return `message:${messageId.trim()}`;
}

export function normalizeCurrency(currency: string | null): string | null {
  if (!currency) {
    return null;
  }

  const normalized = currency.trim();

  if (normalized.length === 0) {
    return null;
  }

  return CURRENCY_ALIASES[normalized.toLowerCase()] ?? normalized.toUpperCase();
}

export function extractSenderName(from: string): string | null {
  const match = from.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/u);

  if (match?.[1]) {
    return normalizeWhitespace(match[1]);
  }

  const emailMatch = from.match(/([A-Z0-9._%+-]+)@/iu);

  if (emailMatch?.[1]) {
    return emailMatch[1].replace(/[._-]+/g, " ").trim();
  }

  return null;
}

export function toIsoDate(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

export function hasUsableText(value: string): boolean {
  const normalized = normalizeWhitespace(value);
  return normalized.length >= 20;
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function decodeHtmlEntity(entity: string): string {
  const normalized = entity.toLowerCase();

  if (normalized.startsWith("#x")) {
    const codePoint = Number.parseInt(normalized.slice(2), 16);
    return Number.isNaN(codePoint) ? `&${entity};` : String.fromCodePoint(codePoint);
  }

  if (normalized.startsWith("#")) {
    const codePoint = Number.parseInt(normalized.slice(1), 10);
    return Number.isNaN(codePoint) ? `&${entity};` : String.fromCodePoint(codePoint);
  }

  return HTML_ENTITY_MAP[normalized] ?? `&${entity};`;
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/giu, (_match, entity: string) =>
    decodeHtmlEntity(entity)
  );
}

export function extractTextFromHtml(value: string): string {
  if (!value.trim()) {
    return "";
  }

  const text = value
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/giu, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<(br|hr)\b[^>]*\/?>/giu, "\n")
    .replace(/<\/(article|aside|div|footer|h[1-6]|header|li|ol|p|section|table|tr|ul)>/giu, "\n")
    .replace(/<(td|th)\b[^>]*>/giu, " ")
    .replace(/<\/(td|th)>/giu, " ")
    .replace(/<[^>]+>/g, " ");

  return normalizeWhitespace(decodeHtmlEntities(text));
}

export function buildBodyText(payload: EmailInvoicePayload): string {
  const segments: string[] = [];

  for (const rawSegment of [payload.plainBody, extractTextFromHtml(payload.htmlBody), payload.snippet]) {
    const normalized = normalizeWhitespace(rawSegment);

    if (!normalized) {
      continue;
    }

    const existingIndex = segments.findIndex(
      (segment) =>
        segment === normalized || segment.includes(normalized) || normalized.includes(segment)
    );

    if (existingIndex === -1) {
      segments.push(normalized);
      continue;
    }

    const existingSegment = segments[existingIndex];

    if (
      existingSegment &&
      normalized.length > existingSegment.length &&
      normalized.includes(existingSegment)
    ) {
      segments[existingIndex] = normalized;
    }
  }

  return segments.join("\n\n");
}

export function buildParseSummary(expense: ParsedExpense | null, reason?: string): string {
  if (!expense) {
    return stringifyJson({
      reason: reason ?? "No parsed expense available."
    });
  }

  return stringifyJson({
    invoiceDate: expense.invoiceDate,
    vendor: expense.vendor,
    amount: expense.amount,
    reference: expense.reference,
    description: expense.description,
    currency: expense.currency,
    confidence: expense.confidence,
    source: expense.source,
    reason
  });
}
