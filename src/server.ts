import "dotenv/config";
import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";
import { GeminiExpenseExtractor } from "./services/expense-extractor.js";
import { ExpenseEmailIngestService } from "./services/expense-ingest-service.js";
import { PdfJsTextExtractor } from "./services/pdf-text-extractor.js";

async function main() {
  const config = loadConfig();

  const expenseIngestService = new ExpenseEmailIngestService({
    defaultCurrency: config.defaultCurrency,
    minConfidence: config.minConfidence,
    expenseExtractor: new GeminiExpenseExtractor({
      apiKey: config.geminiApiKey,
      model: config.geminiModel
    }),
    pdfTextExtractor: new PdfJsTextExtractor()
  });

  const app = buildApp({
    config,
    expenseIngestService
  });

  try {
    await app.listen({
      host: "0.0.0.0",
      port: config.port
    });
  } catch (error) {
    app.log.error(
      {
        err: error
      },
      "Failed to start the expense tracker service."
    );
    process.exitCode = 1;
  }
}

void main();
