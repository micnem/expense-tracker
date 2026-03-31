import { GoogleGenAI } from "@google/genai";
import { expenseExtractionSchema } from "../schemas.js";
import type { ExpenseExtractor, ExtractionInput } from "../types.js";

const expenseExtractionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "invoiceDate",
    "vendor",
    "amount",
    "reference",
    "description",
    "currency",
    "confidence"
  ],
  properties: {
    invoiceDate: {
      anyOf: [
        {
          type: "string",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$"
        },
        {
          type: "null"
        }
      ]
    },
    vendor: {
      anyOf: [
        {
          type: "string"
        },
        {
          type: "null"
        }
      ]
    },
    amount: {
      anyOf: [
        {
          type: "number"
        },
        {
          type: "null"
        }
      ]
    },
    reference: {
      anyOf: [
        {
          type: "string"
        },
        {
          type: "null"
        }
      ]
    },
    description: {
      anyOf: [
        {
          type: "string"
        },
        {
          type: "null"
        }
      ]
    },
    currency: {
      anyOf: [
        {
          type: "string"
        },
        {
          type: "null"
        }
      ]
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1
    }
  }
} as const;

function buildPrompt(input: ExtractionInput): string {
  return [
    "You extract a single expense row from invoice-related email content.",
    "Return JSON only.",
    "Rules:",
    "- Use null for any field you cannot support from the provided text.",
    "- invoiceDate must be the invoice issue date in YYYY-MM-DD, not a service period boundary.",
    "- amount must be the invoice total as a plain number with no currency symbol.",
    "- reference must be the invoice number, receipt number, or billing reference.",
    "- description should be a short human-readable summary of the billed product or service.",
    "- currency must be an ISO 4217 code like USD, EUR, GBP, or ILS when possible.",
    "- confidence must be between 0 and 1 and should drop when fields are inferred.",
    "",
    `Source type: ${input.source}`,
    `Attachment filename: ${input.attachmentFilename ?? "none"}`,
    `Email subject: ${input.subject}`,
    `Email from: ${input.from}`,
    `Email date: ${input.emailDate}`,
    "",
    "Primary source text:",
    input.primaryText || "(empty)",
    "",
    "Email body text:",
    input.bodyText || "(empty)",
    "",
    "Email snippet:",
    input.snippet || "(empty)"
  ].join("\n");
}

export class GeminiExpenseExtractor implements ExpenseExtractor {
  private readonly client: GoogleGenAI;

  constructor(
    private readonly options: {
      apiKey: string;
      model: string;
    }
  ) {
    this.client = new GoogleGenAI({
      apiKey: options.apiKey
    });
  }

  async extract(input: ExtractionInput) {
    const response = await this.client.models.generateContent({
      model: this.options.model,
      contents: buildPrompt(input),
      config: {
        temperature: 0,
        responseMimeType: "application/json",
        responseJsonSchema: expenseExtractionJsonSchema
      }
    });

    const text = response.text;

    if (!text) {
      throw new Error("Gemini did not return structured JSON text.");
    }

    return expenseExtractionSchema.parse(JSON.parse(text) as unknown);
  }
}
