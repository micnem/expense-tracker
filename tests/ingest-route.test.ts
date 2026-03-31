import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { ExpenseEmailIngestService } from "../src/services/expense-ingest-service.js";
import type { EmailInvoicePayload, ParsedExpenseDraft } from "../src/schemas.js";
import { createReferenceDedupeKey } from "../src/utils.js";
import { StubExpenseExtractor, StubPdfTextExtractor } from "./fakes.js";

function createPayload(overrides: Partial<EmailInvoicePayload> = {}): EmailInvoicePayload {
  return {
    messageId: "message-123",
    threadId: "thread-123",
    subject: "Invoice March 2026",
    from: "Vendor Inc <billing@vendor.com>",
    to: "you@company.com",
    cc: "",
    bcc: "",
    replyTo: "",
    date: "2026-03-31T08:15:00.000Z",
    plainBody: "Invoice total USD 42.50 for March 2026",
    snippet: "Invoice total USD 42.50",
    attachments: [
      {
        filename: "invoice-123.pdf",
        contentType: "application/pdf",
        size: 184233,
        contentBase64: Buffer.from("fake pdf contents").toString("base64")
      }
    ],
    ...overrides
  };
}

function createDraft(overrides: Partial<ParsedExpenseDraft> = {}): ParsedExpenseDraft {
  return {
    invoiceDate: "2026-03-31",
    vendor: "Vendor Inc",
    amount: 42.5,
    reference: "INV-123",
    description: "March subscription",
    currency: "USD",
    confidence: 0.94,
    ...overrides
  };
}

function createHarness(options?: {
  draft?: ParsedExpenseDraft;
  payload?: EmailInvoicePayload;
  pdfText?: string;
}) {
  const expenseExtractor = new StubExpenseExtractor(async () => options?.draft ?? createDraft());
  const pdfTextExtractor = new StubPdfTextExtractor({
    text: options?.pdfText ?? "Invoice INV-123 total USD 42.50",
    pageCount: 1,
    isLikelyScanned: false
  });

  const service = new ExpenseEmailIngestService({
    defaultCurrency: "USD",
    minConfidence: 0.7,
    expenseExtractor,
    pdfTextExtractor,
    now: () => new Date("2026-03-31T09:00:00.000Z")
  });

  const app = buildApp({
    config: {
      webhookSharedSecret: "test-secret"
    },
    expenseIngestService: service
  });

  return {
    app,
    pdfTextExtractor,
    payload: options?.payload ?? createPayload()
  };
}

const appsToClose: Array<ReturnType<typeof createHarness>["app"]> = [];

afterEach(async () => {
  while (appsToClose.length > 0) {
    const app = appsToClose.pop();

    if (app) {
      await app.close();
    }
  }
});

describe("POST /ingest/email-invoice", () => {
  it("returns a parsed expense for a valid PDF payload", async () => {
    const harness = createHarness();
    appsToClose.push(harness.app);

    const response = await harness.app.inject({
      method: "POST",
      url: "/ingest/email-invoice",
      headers: {
        "x-expense-tracker-secret": "test-secret"
      },
      payload: harness.payload
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "parsed",
      dedupeKey: createReferenceDedupeKey("INV-123"),
      parsedExpense: {
        source: "mixed",
        vendor: "Vendor Inc",
        amount: 42.5
      }
    });
  });

  it("falls back to email body parsing when no PDF is attached", async () => {
    const harness = createHarness({
      payload: createPayload({
        attachments: [],
        plainBody: "Anthropic invoice amount USD 95.02 reference GW0QIND1-0006",
        snippet: "Anthropic invoice"
      }),
      draft: createDraft({
        vendor: "Anthropic",
        amount: 95.02,
        reference: "GW0QIND1-0006",
        description: "Max plan - 5x"
      })
    });
    appsToClose.push(harness.app);

    const response = await harness.app.inject({
      method: "POST",
      url: "/ingest/email-invoice",
      headers: {
        "x-expense-tracker-secret": "test-secret"
      },
      payload: harness.payload
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "parsed",
      parsedExpense: {
        source: "body",
        vendor: "Anthropic"
      }
    });
    expect(harness.pdfTextExtractor.calls).toBe(0);
  });

  it("routes incomplete parses to review", async () => {
    const harness = createHarness({
      draft: createDraft({
        amount: null
      })
    });
    appsToClose.push(harness.app);

    const response = await harness.app.inject({
      method: "POST",
      url: "/ingest/email-invoice",
      headers: {
        "x-expense-tracker-secret": "test-secret"
      },
      payload: harness.payload
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      status: "review",
      reason: "Parsed expense is missing an amount."
    });
  });

  it("routes non-default currencies to review", async () => {
    const harness = createHarness({
      draft: createDraft({
        currency: "EUR"
      })
    });
    appsToClose.push(harness.app);

    const response = await harness.app.inject({
      method: "POST",
      url: "/ingest/email-invoice",
      headers: {
        "x-expense-tracker-secret": "test-secret"
      },
      payload: harness.payload
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      status: "review",
      reason: expect.stringContaining("EUR")
    });
  });

  it("routes scanned or empty PDFs to review", async () => {
    const harness = createHarness({
      pdfText: ""
    });
    appsToClose.push(harness.app);

    const response = await harness.app.inject({
      method: "POST",
      url: "/ingest/email-invoice",
      headers: {
        "x-expense-tracker-secret": "test-secret"
      },
      payload: harness.payload
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      status: "review",
      reason: expect.stringContaining("did not contain extractable text")
    });
  });

  it("rejects requests with a missing or invalid shared secret", async () => {
    const harness = createHarness();
    appsToClose.push(harness.app);

    const response = await harness.app.inject({
      method: "POST",
      url: "/ingest/email-invoice",
      headers: {
        "x-expense-tracker-secret": "wrong-secret"
      },
      payload: harness.payload
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects malformed payloads", async () => {
    const harness = createHarness();
    appsToClose.push(harness.app);

    const response = await harness.app.inject({
      method: "POST",
      url: "/ingest/email-invoice",
      headers: {
        "x-expense-tracker-secret": "test-secret"
      },
      payload: {
        ...harness.payload,
        messageId: ""
      }
    });

    expect(response.statusCode).toBe(400);
  });

  it("rejects invalid attachment base64", async () => {
    const harness = createHarness({
      payload: createPayload({
        attachments: [
          {
            filename: "invoice-123.pdf",
            contentType: "application/pdf",
            size: 184233,
            contentBase64: "not-valid-base64!!!"
          }
        ]
      })
    });
    appsToClose.push(harness.app);

    const response = await harness.app.inject({
      method: "POST",
      url: "/ingest/email-invoice",
      headers: {
        "x-expense-tracker-secret": "test-secret"
      },
      payload: harness.payload
    });

    expect(response.statusCode).toBe(400);
  });
});
