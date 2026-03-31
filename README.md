# expense-tracker

Webhook service that receives invoice emails from Google Apps Script, extracts normalized expense fields from PDF attachments or email body text, and returns a parse result. Google Apps Script owns the spreadsheet writes, dedupe checks, and Gmail labeling.

## Stack

- Node 20+
- TypeScript
- Fastify
- Gemini for structured extraction fallback
- Google Apps Script for Google Sheets writes

## API

### `POST /ingest/email-invoice`

Required header:

```text
x-expense-tracker-secret: <WEBHOOK_SHARED_SECRET>
```

Expected body shape:

```json
{
  "messageId": "...",
  "threadId": "...",
  "subject": "Invoice March 2026",
  "from": "Vendor <billing@vendor.com>",
  "to": "you@company.com",
  "cc": "",
  "bcc": "",
  "replyTo": "",
  "date": "2026-03-31T08:15:00.000Z",
  "plainBody": "Hi, please find attached invoice...",
  "snippet": "Hi, please find attached invoice...",
  "attachments": [
    {
      "filename": "invoice-123.pdf",
      "contentType": "application/pdf",
      "size": 184233,
      "contentBase64": "JVBERi0xLjQKJ..."
    }
  ]
}
```

Success responses:

- `200` with `{ status: "parsed", dedupeKey, receivedAt, parsedExpense }`
- `202` with `{ status: "review", dedupeKey, receivedAt, reason, extractedDraft }`

The backend no longer writes to Google Sheets directly.

## Local setup

1. Copy `.env.example` to `.env` and fill in real values.
2. Install dependencies:

```bash
npm install
```

3. Start the dev server:

```bash
npm run dev
```

## Apps Script

A complete Apps Script implementation lives at `appscript/invoice-ingest.gs`.

That script:

- calls the webhook
- bootstraps `Expenses`, `Review`, and `IngestLog`
- dedupes by reference, then message id, then existing expense ref
- writes columns `A:E` in `Expenses`, leaving `Total` formula-owned
- marks Gmail threads as processed after `parsed`, `duplicate`, or `review`

## Deployment

`render.yaml` is included for a simple web deployment, but this service can also be deployed to scale-to-zero platforms like Cloud Run because it no longer needs long-lived Google Sheets credentials.
