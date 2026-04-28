import Fastify from "fastify";
import { timingSafeEqual } from "node:crypto";
import { ZodError } from "zod";
import { InputValidationError } from "./errors.js";
import { emailInvoicePayloadSchema } from "./schemas.js";
import type { AppConfig, ExpenseIngestService } from "./types.js";

function secretsMatch(expected: string, actual: string | undefined): boolean {
  if (!actual) {
    return false;
  }

  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, actualBuffer);
}

export function buildApp(options: {
  config: Pick<AppConfig, "revision" | "webhookSharedSecret">;
  expenseIngestService: ExpenseIngestService;
}) {
  const app = Fastify({
    logger: true
  });

  app.get("/health", async () => ({
    status: "ok",
    revision: options.config.revision
  }));

  app.post("/ingest/email-invoice", async (request, reply) => {
    const secretHeader = request.headers["x-expense-tracker-secret"];
    const providedSecret = Array.isArray(secretHeader) ? secretHeader[0] : secretHeader;

    if (!secretsMatch(options.config.webhookSharedSecret, providedSecret)) {
      return reply.code(401).send({
        message: "Unauthorized"
      });
    }

    try {
      const payload = emailInvoicePayloadSchema.parse(request.body);
      const result = await options.expenseIngestService.ingest(payload);

      if (result.status === "review") {
        return reply.code(202).send(result);
      }

      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof ZodError || error instanceof InputValidationError) {
        return reply.code(400).send({
          message: "Invalid payload",
          issues: error instanceof ZodError ? error.flatten() : undefined,
          detail: error.message
        });
      }

      request.log.error(
        {
          err: error
        },
        "Failed to process email invoice payload."
      );

      return reply.code(500).send({
        message: "Internal server error"
      });
    }
  });

  return app;
}
