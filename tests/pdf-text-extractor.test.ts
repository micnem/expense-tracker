import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { PdfJsTextExtractor } from "../src/services/pdf-text-extractor.js";

describe("PdfJsTextExtractor", () => {
  it("extracts text from a simple PDF", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([612, 792]);
    const font = await document.embedFont(StandardFonts.Helvetica);

    page.drawText("Invoice INV-123", {
      x: 72,
      y: 720,
      size: 16,
      font
    });

    page.drawText("Total USD 42.50", {
      x: 72,
      y: 690,
      size: 16,
      font
    });

    const bytes = await document.save();
    const extractor = new PdfJsTextExtractor();
    const result = await extractor.extract(Buffer.from(bytes));

    expect(result.isLikelyScanned).toBe(false);
    expect(result.text).toContain("INV-123");
    expect(result.text).toContain("USD 42.50");
  });
});
