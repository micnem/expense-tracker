import type { ParsedExpenseDraft } from "../src/schemas.js";
import type {
  ExpenseExtractor,
  ExtractionInput,
  PdfTextExtractor,
  PdfTextResult
} from "../src/types.js";

export class StubExpenseExtractor implements ExpenseExtractor {
  constructor(
    private readonly resolveDraft: (input: ExtractionInput) => Promise<ParsedExpenseDraft> | ParsedExpenseDraft
  ) {}

  async extract(input: ExtractionInput): Promise<ParsedExpenseDraft> {
    return await this.resolveDraft(input);
  }
}

export class StubPdfTextExtractor implements PdfTextExtractor {
  public calls = 0;

  constructor(private readonly result: PdfTextResult) {}

  async extract(): Promise<PdfTextResult> {
    this.calls += 1;
    return this.result;
  }
}
