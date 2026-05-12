import type { ErrorRequestHandler } from "express";

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const status =
    typeof (err as { status?: number })?.status === "number"
      ? (err as { status: number }).status
      : 500;
  req.log?.error({ err }, "Unhandled API error");
  res.status(status).json({
    error: status >= 500 ? "internal_error" : (err as Error)?.message ?? "error",
  });
};
