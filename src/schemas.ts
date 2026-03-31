import { z } from "zod";

export const emailAttachmentSchema = z.object({
  filename: z.string().min(1),
  contentType: z.string().min(1),
  size: z.number().int().nonnegative(),
  contentBase64: z.string().min(1)
});

export const emailInvoicePayloadSchema = z.object({
  messageId: z.string().min(1),
  threadId: z.string().min(1),
  subject: z.string().default(""),
  from: z.string().min(1),
  to: z.string().default(""),
  cc: z.string().default(""),
  bcc: z.string().default(""),
  replyTo: z.string().default(""),
  date: z.string().datetime({ offset: true }),
  plainBody: z.string().default(""),
  snippet: z.string().default(""),
  attachments: z.array(emailAttachmentSchema).default([])
});

export const expenseExtractionSchema = z.object({
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  vendor: z.string().trim().min(1).nullable(),
  amount: z.number().finite().nonnegative().nullable(),
  reference: z.string().trim().min(1).nullable(),
  description: z.string().trim().min(1).nullable(),
  currency: z.string().trim().min(1).nullable(),
  confidence: z.number().min(0).max(1)
});

export type EmailInvoicePayload = z.infer<typeof emailInvoicePayloadSchema>;
export type EmailAttachment = z.infer<typeof emailAttachmentSchema>;
export type ParsedExpenseDraft = z.infer<typeof expenseExtractionSchema>;
