import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { normalizeWhitespace } from "../utils.js";
import type { PdfTextExtractor, PdfTextResult } from "../types.js";

export class PdfJsTextExtractor implements PdfTextExtractor {
  async extract(buffer: Buffer): Promise<PdfTextResult> {
    const loadingTask = getDocument({
      data: new Uint8Array(buffer),
      useWorkerFetch: false,
      isEvalSupported: false
    });

    const pdf = await loadingTask.promise;
    const pageTexts: string[] = [];
    let textItemCount = 0;

    try {
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const textContent = await page.getTextContent();
        const text = normalizeWhitespace(
          textContent.items
            .map((item) => ("str" in item ? item.str : ""))
            .filter(Boolean)
            .join(" ")
        );

        if (text.length > 0) {
          pageTexts.push(text);
        }

        textItemCount += textContent.items.length;
      }
    } finally {
      await loadingTask.destroy();
    }

    const text = normalizeWhitespace(pageTexts.join("\n\n"));

    return {
      text,
      pageCount: pdf.numPages,
      isLikelyScanned: text.length === 0 || textItemCount === 0
    };
  }
}
