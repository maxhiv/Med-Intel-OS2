/**
 * Unit tests for the requireRole RBAC middleware (PR B).
 * Pure logic — no database.
 */
import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { requireRole, requireTenantAdmin, requireOperator, hasRole } from "../src/middlewares/requireRole";

function mockRes() {
  const res: Partial<Response> & { _status?: number; _json?: unknown } = {};
  res.status = vi.fn((code: number) => {
    res._status = code;
    return res as Response;
  }) as unknown as Response["status"];
  res.json = vi.fn((body: unknown) => {
    res._json = body;
    return res as Response;
  }) as unknown as Response["json"];
  return res as Response & { _status?: number; _json?: unknown };
}

function reqWithRole(role: string | null): Request {
  return { currentUser: role ? { role } : undefined } as unknown as Request;
}

describe("hasRole — hierarchy", () => {
  it("rep does not satisfy tenant_admin", () => {
    expect(hasRole({ role: "rep" }, "tenant_admin")).toBe(false);
  });
  it("tenant_admin satisfies tenant_admin", () => {
    expect(hasRole({ role: "tenant_admin" }, "tenant_admin")).toBe(true);
  });
  it("operator satisfies tenant_admin (higher covers lower)", () => {
    expect(hasRole({ role: "operator" }, "tenant_admin")).toBe(true);
  });
  it("operator satisfies operator", () => {
    expect(hasRole({ role: "operator" }, "operator")).toBe(true);
  });
  it("v1.0 platform_admin maps to operator level", () => {
    expect(hasRole({ role: "platform_admin" }, "operator")).toBe(true);
    expect(hasRole({ role: "platform_admin" }, "tenant_admin")).toBe(true);
  });
  it("rep does not satisfy operator", () => {
    expect(hasRole({ role: "rep" }, "operator")).toBe(false);
  });
  it("null user fails every check", () => {
    expect(hasRole(null, "rep")).toBe(false);
  });
  it("unknown role fails every check", () => {
    expect(hasRole({ role: "wizard" }, "rep")).toBe(false);
  });
});

describe("requireRole — middleware", () => {
  it("401s when no user is on the request", () => {
    const res = mockRes();
    const next = vi.fn();
    requireOperator()(reqWithRole(null), res, next);
    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("403s a rep hitting an operator route", () => {
    const res = mockRes();
    const next = vi.fn();
    requireOperator()(reqWithRole("rep"), res, next);
    expect(res._status).toBe(403);
    expect((res._json as { error: string }).error).toBe("insufficient_role");
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() for an operator on an operator route", () => {
    const res = mockRes();
    const next = vi.fn();
    requireOperator()(reqWithRole("operator"), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res._status).toBeUndefined();
  });

  it("tenant_admin route: rep denied, tenant_admin allowed, operator allowed", () => {
    const repNext = vi.fn();
    requireTenantAdmin()(reqWithRole("rep"), mockRes(), repNext);
    expect(repNext).not.toHaveBeenCalled();

    const taNext = vi.fn();
    requireTenantAdmin()(reqWithRole("tenant_admin"), mockRes(), taNext);
    expect(taNext).toHaveBeenCalledOnce();

    const opNext = vi.fn();
    requireTenantAdmin()(reqWithRole("operator"), mockRes(), opNext);
    expect(opNext).toHaveBeenCalledOnce();
  });

  it("403s an unrecognized role", () => {
    const res = mockRes();
    const next = vi.fn();
    requireRole("rep")(reqWithRole("wizard"), res, next);
    expect(res._status).toBe(403);
    expect((res._json as { error: string }).error).toBe("invalid_role");
  });

  it("throws if constructed with no roles", () => {
    expect(() => requireRole()).toThrow();
  });
});
