import type { EmailInvoicePayload, ParsedExpenseDraft } from "../schemas.js";
import type {
  ExpenseExtractor,
  ExpenseIngestService,
  ExpenseSource,
  ExtractionInput,
  IngestResponse,
  ParsedExpense,
  PdfTextExtractor
} from "../types.js";
import {
  buildBodyText,
  createMessageDedupeKey,
  createReferenceDedupeKey,
  decodeBase64OrThrow,
  extractInvoiceSignals,
  extractSenderName,
  hasUsableText,
  isPdfAttachment,
  normalizeReference,
  normalizeCurrency,
  normalizeWhitespace,
  toIsoDate
} from "../utils.js";

interface ExpenseIngestionServiceOptions {
  defaultCurrency: string;
  minConfidence: number;
  expenseExtractor: ExpenseExtractor;
  pdfTextExtractor: PdfTextExtractor;
  now?: () => Date;
}

interface ExtractionSelection {
  input: ExtractionInput | null;
  reviewReason: string | null;
}

export class ExpenseEmailIngestService implements ExpenseIngestService {
  private readonly now: () => Date;

  constructor(private readonly options: ExpenseIngestionServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async ingest(payload: EmailInvoicePayload): Promise<IngestResponse> {
    const receivedAt = this.now().toISOString();
    const selection = await this.selectExtractionInput(payload);

    if (!selection.input) {
      return this.createReviewResponse(
        payload,
        receivedAt,
        selection.reviewReason ?? "No usable document content found.",
        null
      );
    }

    const draft = await this.options.expenseExtractor.extract(selection.input);
    const fallbackSignals = extractInvoiceSignals(
      [selection.input.primaryText, selection.input.bodyText, selection.input.snippet].filter(Boolean).join("\n\n")
    );
    const parsedExpense = this.normalizeParsedExpense(
      payload,
      draft,
      selection.input.source,
      fallbackSignals
    );
    const reviewReason = this.getReviewReason(parsedExpense);

    if (reviewReason) {
      return this.createReviewResponse(payload, receivedAt, reviewReason, parsedExpense);
    }

    return {
      status: "parsed",
      dedupeKey: this.createDedupeKey(payload.messageId, parsedExpense.reference),
      receivedAt,
      parsedExpense
    };
  }

  private normalizeParsedExpense(
    payload: EmailInvoicePayload,
    draft: ParsedExpenseDraft,
    source: ExpenseSource,
    fallbackSignals: ReturnType<typeof extractInvoiceSignals>
  ): ParsedExpense {
    const descriptionFallback = normalizeWhitespace(payload.subject || payload.snippet);
    const draftReference = draft.reference?.trim() || null;
    const fallbackReference = fallbackSignals.reference?.trim() || null;

    return {
      invoiceDate: draft.invoiceDate ?? toIsoDate(payload.date),
      vendor: draft.vendor?.trim() || extractSenderName(payload.from) || null,
      amount:
        draft.amount === null
          ? fallbackSignals.amount
          : Math.round(draft.amount * 100) / 100,
      reference: this.chooseReference(draftReference, fallbackReference),
      description: draft.description?.trim() || descriptionFallback || null,
      currency: normalizeCurrency(draft.currency ?? fallbackSignals.currency),
      confidence: draft.confidence,
      source
    };
  }

  private getReviewReason(parsedExpense: ParsedExpense): string | null {
    if (parsedExpense.confidence < this.options.minConfidence) {
      return `Extraction confidence ${parsedExpense.confidence.toFixed(2)} is below the ${this.options.minConfidence.toFixed(2)} threshold.`;
    }

    if (!parsedExpense.vendor) {
      return "Parsed expense is missing a vendor.";
    }

    if (parsedExpense.amount === null) {
      return "Parsed expense is missing an amount.";
    }

    if (!parsedExpense.description) {
      return "Parsed expense is missing a description.";
    }

    if (!parsedExpense.currency) {
      return "Currency could not be confidently determined.";
    }

    if (parsedExpense.currency !== this.options.defaultCurrency) {
      return `Parsed currency ${parsedExpense.currency} does not match the default currency ${this.options.defaultCurrency}.`;
    }

    return null;
  }

  private createReviewResponse(
    payload: EmailInvoicePayload,
    receivedAt: string,
    reason: string,
    parsedExpense: ParsedExpense | null
  ): IngestResponse {
    return {
      status: "review",
      dedupeKey: this.createDedupeKey(payload.messageId, parsedExpense?.reference ?? null),
      receivedAt,
      reason,
      extractedDraft: parsedExpense
    };
  }

  private async selectExtractionInput(payload: EmailInvoicePayload): Promise<ExtractionSelection> {
    const bodyText = buildBodyText(payload);
    const pdfAttachment = payload.attachments.find(isPdfAttachment);

    if (pdfAttachment) {
      const buffer = decodeBase64OrThrow(pdfAttachment.contentBase64);
      const result = await this.options.pdfTextExtractor.extract(buffer);

      if (result.isLikelyScanned || !hasUsableText(result.text)) {
        return {
          input: null,
          reviewReason: `PDF attachment ${pdfAttachment.filename} did not contain extractable text.`
        };
      }

      return {
        input: {
          source: hasUsableText(bodyText) ? "mixed" : "pdf",
          attachmentFilename: pdfAttachment.filename,
          subject: payload.subject,
          from: payload.from,
          emailDate: payload.date,
          snippet: payload.snippet,
          bodyText,
          primaryText: result.text
        },
        reviewReason: null
      };
    }

    if (!hasUsableText(bodyText)) {
      return {
        input: null,
        reviewReason: "No PDF attachment or usable email body text was provided."
      };
    }

    return {
      input: {
        source: "body",
        attachmentFilename: null,
        subject: payload.subject,
        from: payload.from,
        emailDate: payload.date,
        snippet: payload.snippet,
        bodyText,
        primaryText: bodyText
      },
      reviewReason: null
    };
  }

  private createDedupeKey(messageId: string, reference: string | null): string {
    return reference ? createReferenceDedupeKey(reference) : createMessageDedupeKey(messageId);
  }

  private chooseReference(draftReference: string | null, fallbackReference: string | null): string | null {
    if (!fallbackReference) {
      return draftReference;
    }

    if (!draftReference) {
      return fallbackReference;
    }

    const normalizedDraft = normalizeReference(draftReference);
    const normalizedFallback = normalizeReference(fallbackReference);

    if (normalizedDraft === normalizedFallback) {
      return fallbackReference;
    }

    if (normalizedFallback.startsWith(normalizedDraft) || normalizedDraft.startsWith(normalizedFallback)) {
      return fallbackReference.length >= draftReference.length ? fallbackReference : draftReference;
    }

    return draftReference;
  }
}
