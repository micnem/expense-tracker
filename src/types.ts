import type { EmailInvoicePayload, ParsedExpenseDraft } from "./schemas.js";

export type ExpenseSource = "pdf" | "body" | "mixed";

export interface AppConfig {
  port: number;
  webhookSharedSecret: string;
  geminiApiKey: string;
  geminiModel: string;
  defaultCurrency: string;
  minConfidence: number;
}

export interface ParsedExpense extends ParsedExpenseDraft {
  source: ExpenseSource;
}

export interface ExtractionInput {
  source: ExpenseSource;
  attachmentFilename: string | null;
  subject: string;
  from: string;
  emailDate: string;
  snippet: string;
  bodyText: string;
  primaryText: string;
}

export interface PdfTextResult {
  text: string;
  pageCount: number;
  isLikelyScanned: boolean;
}

export interface PdfTextExtractor {
  extract(buffer: Buffer): Promise<PdfTextResult>;
}

export interface ExpenseExtractor {
  extract(input: ExtractionInput): Promise<ParsedExpenseDraft>;
}

export interface ParsedResponse {
  status: "parsed";
  dedupeKey: string;
  receivedAt: string;
  parsedExpense: ParsedExpense;
}

export interface ReviewResponse {
  status: "review";
  dedupeKey: string;
  receivedAt: string;
  reason: string;
  extractedDraft: ParsedExpense | null;
}

export type IngestResponse = ParsedResponse | ReviewResponse;

export interface ExpenseIngestService {
  ingest(payload: EmailInvoicePayload): Promise<IngestResponse>;
}
