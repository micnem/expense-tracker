import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

interface FakeSheet {
  getLastRow(): number;
  getRange(row: number, column: number, numRows: number, numColumns: number): {
    getValues(): unknown[][];
  };
}

function createSheet(rows: unknown[][]): FakeSheet {
  return {
    getLastRow() {
      return rows.length + 1;
    },
    getRange(row: number, column: number, numRows: number, numColumns: number) {
      const startRow = row - 2;
      const startColumn = column - 1;
      const values = rows.slice(startRow, startRow + numRows).map((sourceRow) => {
        const paddedRow = [...sourceRow];

        while (paddedRow.length < startColumn + numColumns) {
          paddedRow.push("");
        }

        return paddedRow.slice(startColumn, startColumn + numColumns);
      });

      return {
        getValues() {
          return values;
        }
      };
    }
  };
}

function loadInvoiceIngestScript() {
  const source = fs.readFileSync(
    new URL("../appscript/invoice-ingest.gs", import.meta.url),
    "utf8"
  );
  const context: Record<string, (...args: never[]) => unknown> = {};

  vm.createContext(context);
  vm.runInContext(source, context);

  return context as {
    buildIndexes_: (sheets: {
      expenses: FakeSheet;
      ingestLog: FakeSheet;
    }) => {
      logByExpenseSignature: Record<string, number>;
      logByMessageId: Record<string, number>;
      expenseRowByExpenseSignature: Record<string, number>;
    };
    findDuplicate_: (
      payload: { messageId: string },
      result: {
        dedupeKey: string;
        parsedExpense: {
          reference: string | null;
          amount: number | null;
        };
      },
      indexes: {
        logByExpenseSignature: Record<string, number>;
        logByMessageId: Record<string, number>;
        expenseRowByExpenseSignature: Record<string, number>;
      }
    ) =>
      | {
          duplicateKey: string;
          existingLogRow: number | string;
          expenseRowNumber: number | string;
        }
      | null;
  };
}

function createIndexes(options: {
  expenseRows?: unknown[][];
  ingestLogRows?: unknown[][];
}) {
  const script = loadInvoiceIngestScript();

  return script.buildIndexes_({
    expenses: createSheet(options.expenseRows ?? []),
    ingestLog: createSheet(options.ingestLogRows ?? [])
  });
}

describe("invoice-ingest Apps Script dedupe", () => {
  it("does not treat matching references with different amounts as duplicates", () => {
    const script = loadInvoiceIngestScript();
    const indexes = createIndexes({
      expenseRows: [["2026-05-01", "Google", 43.11, "1905-7112-8812", "Google Cloud", ""]],
      ingestLogRows: [
        [
          "2026-05-01T08:00:00.000Z",
          "message-1",
          "thread-1",
          "ref:1905-7112-8812",
          "inserted",
          2,
          JSON.stringify({
            parsedExpense: {
              invoiceDate: "2026-05-01",
              vendor: "Google",
              amount: 43.11,
              reference: "1905-7112-8812",
              description: "Google Cloud"
            }
          })
        ]
      ]
    });

    const duplicate = script.findDuplicate_(
      { messageId: "message-2" },
      {
        dedupeKey: "ref:1905-7112-8812",
        parsedExpense: {
          reference: "1905-7112-8812",
          amount: 100
        }
      },
      indexes
    );

    expect(duplicate).toBeNull();
  });

  it("still marks matching reference-and-amount pairs as duplicates", () => {
    const script = loadInvoiceIngestScript();
    const indexes = createIndexes({
      expenseRows: [["2026-05-01", "Google", 43.11, "1905-7112-8812", "Google Cloud", ""]]
    });

    const duplicate = script.findDuplicate_(
      { messageId: "message-2" },
      {
        dedupeKey: "ref:1905-7112-8812",
        parsedExpense: {
          reference: "1905-7112-8812",
          amount: 43.11
        }
      },
      indexes
    );

    expect(duplicate).toEqual({
      duplicateKey: "ref:1905-7112-8812",
      existingLogRow: "",
      expenseRowNumber: 2
    });
  });
});
