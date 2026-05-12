/**
 * Adapter registry. Resolves a CRM type → adapter implementation. Returns
 * `null` for CRM types we don't support yet (pipedrive, zoho, close, dynamics,
 * "other") so callers can record a clean failure instead of a runtime error.
 */
import type { CrmAdapter, CrmType } from "./types";
import { ghlAdapter } from "./ghl";
import { hubspotAdapter } from "./hubspot";
import { salesforceAdapter } from "./salesforce";

const REGISTRY: Record<CrmType, CrmAdapter> = {
  ghl: ghlAdapter,
  hubspot: hubspotAdapter,
  salesforce: salesforceAdapter,
};

export function getCrmAdapter(crmType: string | null | undefined): CrmAdapter | null {
  if (!crmType) return null;
  if (crmType === "ghl" || crmType === "hubspot" || crmType === "salesforce") {
    return REGISTRY[crmType];
  }
  return null;
}

export type {
  CrmAdapter,
  CrmPushInput,
  CrmPushOutcome,
  CrmType,
  CrmTestResult,
  CredentialFieldSpec,
} from "./types";
export { CrmAdapterError } from "./types";

export function listCrmAdapters(): readonly CrmAdapter[] {
  return Object.values(REGISTRY);
}
