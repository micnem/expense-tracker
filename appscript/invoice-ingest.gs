const WEBHOOK_URL = 'https://your-domain.com/ingest/email-invoice';
const WEBHOOK_SECRET = 'replace-me';
const SPREADSHEET_ID = 'replace-me';
const INVOICE_LABEL_NAME = 'Invoices';
const PROCESSED_LABEL_NAME = 'Invoices/Processed';
const MAX_BODY_LENGTH = 20000;
const EXPENSES_SHEET_NAME = 'Expenses';
const REVIEW_SHEET_NAME = 'Review';
const INGEST_LOG_SHEET_NAME = 'IngestLog';

const EXPENSE_HEADERS = ['Date', 'Vendor', 'Amount', 'Ref', 'Description', 'Total'];
const REVIEW_HEADERS = [
  'Received At',
  'Message ID',
  'Thread ID',
  'Subject',
  'From',
  'Attachment Names',
  'Reason',
  'Extracted Draft',
  'Snippet'
];
const INGEST_LOG_HEADERS = [
  'Received At',
  'Message ID',
  'Thread ID',
  'Dedupe Key',
  'Status',
  'Expense Row Number',
  'Parse Summary'
];

function sendInvoiceEmailsToWebhook() {
  const label = GmailApp.getUserLabelByName(INVOICE_LABEL_NAME);
  if (!label) {
    Logger.log('Label not found: ' + INVOICE_LABEL_NAME);
    return;
  }

  let processedLabel = GmailApp.getUserLabelByName(PROCESSED_LABEL_NAME);
  if (!processedLabel) {
    processedLabel = GmailApp.createLabel(PROCESSED_LABEL_NAME);
  }

  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheets = ensureSheets_(spreadsheet);
  const indexes = buildIndexes_(sheets);
  const threads = label.getThreads();

  Logger.log('Found ' + threads.length + ' threads');

  threads.forEach(function(thread) {
    const threadLabelNames = thread.getLabels().map(function(currentLabel) {
      return currentLabel.getName();
    });

    if (threadLabelNames.includes(PROCESSED_LABEL_NAME)) {
      return;
    }

    const messages = thread.getMessages();
    if (!messages || messages.length === 0) {
      return;
    }

    const message = messages[0];
    const attachments = message.getAttachments({
      includeInlineImages: false,
      includeAttachments: true
    });

    const attachmentPayload = attachments
      .filter(function(attachment) {
        const type = attachment.getContentType() || '';
        return type === 'application/pdf' || attachment.getName().toLowerCase().endsWith('.pdf');
      })
      .map(function(attachment) {
        const bytes = attachment.getBytes();
        return {
          filename: attachment.getName(),
          contentType: attachment.getContentType(),
          size: bytes.length,
          contentBase64: Utilities.base64Encode(bytes)
        };
      });

    const plainBody = message.getPlainBody() || '';
    const htmlBody = message.getBody() || '';
    const fallbackBodyText = htmlToText_(htmlBody);
    const extractedBodyText = plainBody || fallbackBodyText;
    const payload = {
      threadId: thread.getId(),
      messageId: message.getId(),
      subject: message.getSubject(),
      from: message.getFrom(),
      to: message.getTo(),
      cc: message.getCc(),
      bcc: typeof message.getBcc === 'function' ? message.getBcc() : '',
      replyTo: message.getReplyTo(),
      date: message.getDate().toISOString(),
      plainBody: truncate_(extractedBodyText, MAX_BODY_LENGTH),
      htmlBody: truncate_(htmlBody, MAX_BODY_LENGTH),
      snippet: truncate_(extractedBodyText, 500),
      attachments: attachmentPayload
    };

    try {
      const response = UrlFetchApp.fetch(WEBHOOK_URL, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
        headers: {
          'x-expense-tracker-secret': WEBHOOK_SECRET
        }
      });

      const statusCode = response.getResponseCode();
      const responseBody = response.getContentText();
      Logger.log('Webhook status for "' + message.getSubject() + '": ' + statusCode);

      if (statusCode < 200 || statusCode >= 300) {
        Logger.log('Webhook error body: ' + responseBody);
        return;
      }

      const result = JSON.parse(responseBody);
      processWebhookResult_(payload, result, sheets, indexes);
      markProcessed_(thread, label, processedLabel);
    } catch (error) {
      Logger.log('Request failed for "' + message.getSubject() + '": ' + error);
    }
  });
}

function processWebhookResult_(payload, result, sheets, indexes) {
  if (result.status === 'parsed') {
    const duplicate = findDuplicate_(payload, result, indexes);
    if (duplicate) {
      appendIngestLog_(sheets.ingestLog, {
        receivedAt: result.receivedAt,
        messageId: payload.messageId,
        threadId: payload.threadId,
        dedupeKey: duplicate.duplicateKey,
        status: 'duplicate',
        expenseRowNumber: duplicate.expenseRowNumber,
        parseSummary: JSON.stringify({
          parsedExpense: result.parsedExpense,
          reason: 'Duplicate invoice skipped.'
        })
      });
      indexes.logByMessageId[payload.messageId] = sheets.ingestLog.getLastRow();
      indexes.logByDedupeKey[duplicate.duplicateKey] = sheets.ingestLog.getLastRow();
      return;
    }

    const expenseRowNumber = appendExpenseRow_(sheets.expenses, result.parsedExpense);
    appendIngestLog_(sheets.ingestLog, {
      receivedAt: result.receivedAt,
      messageId: payload.messageId,
      threadId: payload.threadId,
      dedupeKey: result.dedupeKey,
      status: 'inserted',
      expenseRowNumber: expenseRowNumber,
      parseSummary: JSON.stringify({
        parsedExpense: result.parsedExpense
      })
    });

    indexes.logByMessageId[payload.messageId] = sheets.ingestLog.getLastRow();
    indexes.logByDedupeKey[result.dedupeKey] = sheets.ingestLog.getLastRow();

    if (result.parsedExpense.reference) {
      indexes.expenseRowByReference[normalizeReference_(result.parsedExpense.reference)] = expenseRowNumber;
    }

    return;
  }

  if (result.status === 'review') {
    appendReviewRow_(sheets.review, payload, result);
    appendIngestLog_(sheets.ingestLog, {
      receivedAt: result.receivedAt,
      messageId: payload.messageId,
      threadId: payload.threadId,
      dedupeKey: result.dedupeKey,
      status: 'review',
      expenseRowNumber: '',
      parseSummary: JSON.stringify({
        extractedDraft: result.extractedDraft,
        reason: result.reason
      })
    });

    indexes.logByMessageId[payload.messageId] = sheets.ingestLog.getLastRow();
    indexes.logByDedupeKey[result.dedupeKey] = sheets.ingestLog.getLastRow();
    return;
  }

  throw new Error('Unexpected webhook response: ' + JSON.stringify(result));
}

function ensureSheets_(spreadsheet) {
  const expenses = ensureSheetWithHeaders_(spreadsheet, EXPENSES_SHEET_NAME, EXPENSE_HEADERS);
  const review = ensureSheetWithHeaders_(spreadsheet, REVIEW_SHEET_NAME, REVIEW_HEADERS);
  const ingestLog = ensureSheetWithHeaders_(spreadsheet, INGEST_LOG_SHEET_NAME, INGEST_LOG_HEADERS);

  return {
    expenses: expenses,
    review: review,
    ingestLog: ingestLog
  };
}

function ensureSheetWithHeaders_(spreadsheet, sheetName, headers) {
  let sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }

  const currentHeaders = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const headersMatch = headers.every(function(header, index) {
    return currentHeaders[index] === header;
  });

  if (!headersMatch) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  return sheet;
}

function buildIndexes_(sheets) {
  const logValues = getDataRows_(sheets.ingestLog, 7);
  const expenseValues = getDataRows_(sheets.expenses, 6);
  const logByDedupeKey = {};
  const logByMessageId = {};
  const expenseRowByReference = {};

  logValues.forEach(function(row, index) {
    const rowNumber = index + 2;
    const messageId = row[1];
    const dedupeKey = row[3];

    if (messageId) {
      logByMessageId[messageId] = rowNumber;
    }

    if (dedupeKey) {
      logByDedupeKey[dedupeKey] = rowNumber;
    }
  });

  expenseValues.forEach(function(row, index) {
    const reference = row[3];
    if (reference) {
      expenseRowByReference[normalizeReference_(reference)] = index + 2;
    }
  });

  return {
    logByDedupeKey: logByDedupeKey,
    logByMessageId: logByMessageId,
    expenseRowByReference: expenseRowByReference
  };
}

function getDataRows_(sheet, width) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return [];
  }

  return sheet.getRange(2, 1, lastRow - 1, width).getValues();
}

function findDuplicate_(payload, result, indexes) {
  if (indexes.logByDedupeKey[result.dedupeKey]) {
    return {
      duplicateKey: result.dedupeKey,
      existingLogRow: indexes.logByDedupeKey[result.dedupeKey],
      expenseRowNumber: ''
    };
  }

  if (indexes.logByMessageId[payload.messageId]) {
    return {
      duplicateKey: 'message:' + payload.messageId,
      existingLogRow: indexes.logByMessageId[payload.messageId],
      expenseRowNumber: ''
    };
  }

  const reference = result.parsedExpense.reference;
  if (reference) {
    const normalizedReference = normalizeReference_(reference);
    if (indexes.expenseRowByReference[normalizedReference]) {
      return {
        duplicateKey: result.dedupeKey,
        existingLogRow: '',
        expenseRowNumber: indexes.expenseRowByReference[normalizedReference]
      };
    }
  }

  return null;
}

function appendExpenseRow_(sheet, parsedExpense) {
  const row = [
    parsedExpense.invoiceDate,
    parsedExpense.vendor,
    parsedExpense.amount,
    parsedExpense.reference || '',
    parsedExpense.description
  ];
  const rowNumber = sheet.getLastRow() + 1;
  sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
  return rowNumber;
}

function appendReviewRow_(sheet, payload, result) {
  const row = [
    result.receivedAt,
    payload.messageId,
    payload.threadId,
    payload.subject,
    payload.from,
    payload.attachments.map(function(attachment) {
      return attachment.filename;
    }).join(', '),
    result.reason,
    JSON.stringify(result.extractedDraft),
    payload.snippet
  ];
  const rowNumber = sheet.getLastRow() + 1;
  sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
  return rowNumber;
}

function appendIngestLog_(sheet, entry) {
  const row = [
    entry.receivedAt,
    entry.messageId,
    entry.threadId,
    entry.dedupeKey,
    entry.status,
    entry.expenseRowNumber,
    entry.parseSummary
  ];
  const rowNumber = sheet.getLastRow() + 1;
  sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
  return rowNumber;
}

function markProcessed_(thread, sourceLabel, processedLabel) {
  thread.addLabel(processedLabel);
  thread.removeLabel(sourceLabel);
}

function normalizeReference_(reference) {
  return String(reference).trim().replace(/\s+/g, '').toUpperCase();
}

function truncate_(text, maxLen) {
  if (!text) {
    return '';
  }

  return text.length > maxLen ? text.slice(0, maxLen) : text;
}

function htmlToText_(html) {
  if (!html) {
    return '';
  }

  const text = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|hr)\b[^>]*\/?>/gi, '\n')
    .replace(/<\/(article|aside|div|footer|h[1-6]|header|li|ol|p|section|table|tr|ul)>/gi, '\n')
    .replace(/<(td|th)\b[^>]*>/gi, ' ')
    .replace(/<\/(td|th)>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');

  return normalizeText_(decodeHtmlEntities_(text));
}

function decodeHtmlEntities_(text) {
  const entityMap = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: '\'',
    nbsp: ' '
  };

  return String(text).replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, function(match, entity) {
    const normalized = String(entity).toLowerCase();
    let codePoint;

    if (normalized.indexOf('#x') === 0) {
      codePoint = parseInt(normalized.slice(2), 16);
      return isNaN(codePoint) ? match : String.fromCharCode(codePoint);
    }

    if (normalized.indexOf('#') === 0) {
      codePoint = parseInt(normalized.slice(1), 10);
      return isNaN(codePoint) ? match : String.fromCharCode(codePoint);
    }

    return Object.prototype.hasOwnProperty.call(entityMap, normalized) ? entityMap[normalized] : match;
  });
}

function normalizeText_(text) {
  return String(text)
    .replace(/\r/g, '\n')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}
