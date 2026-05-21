/**
 * Unit tests for the CON document parser (PR: CON document scraping).
 *
 * `parseConDocumentText` is pure — it takes already-extracted PDF text and
 * pulls the structured fields out. The text fixtures below mirror the layout
 * of real NC DHSR decision documents.
 */
import { describe, it, expect } from "vitest";
import { parseConDocumentText } from "../src/services/conDocumentParser";

// Mirrors the NC DHSR conditional-approval document for project D-12683-25
// (Wilkes Medical Center) — the document attached to the original bug report.
const WILKES_APPROVAL = `
NC DEPARTMENT OF HEALTH AND HUMAN SERVICES • DIVISION OF HEALTH SERVICE REGULATION
1915 Health Services Way, Raleigh, NC 27607

RESPONSE REQUIRED November 24, 2025

Jena Folger One Medical Center Boulevard 10th flr Janeway Tower Winston-Salem, NC 27157

Conditional Approval
Project ID #: D-12683-25
Facility: Wilkes Medical Center
Project Description: Acquire one fixed MRI scanner pursuant to the 2025 SMFP need determination
County: Wilkes
FID #: 943561
Approved Capital Expenditure: $3,660,306
Conditions of Approval: See Attachment A
Approved Timetable: See Attachment B
Last Date to Appeal: December 29, 2025
Required State Agency Findings: Enclosed

Dear Jena Folger:

The Healthcare Planning and Certificate of Need Section has conditionally
approved the above referenced certificate of need application.
`;

const DISAPPROVAL = `
RESPONSE REQUIRED March 3, 2025
Acme Health 100 Main St Charlotte, NC 28202
Disapproval
Project ID #: F-11900-24
Facility: Mountain View Surgical Center
Project Description: Develop a single-specialty ambulatory surgical facility
County: Buncombe
FID #: 700412
Required State Agency Findings: Enclosed
`;

describe("parseConDocumentText", () => {
  it("extracts every structured field from an NC approval document", () => {
    const doc = parseConDocumentText(WILKES_APPROVAL);

    expect(doc.projectId).toBe("D-12683-25");
    expect(doc.facilityName).toBe("Wilkes Medical Center");
    expect(doc.county).toBe("Wilkes");
    expect(doc.stateFacilityId).toBe("943561");
    expect(doc.approvedAmount).toBe(3_660_306);
    expect(doc.modality).toBe("MRI");
    expect(doc.equipmentType?.toLowerCase()).toContain("mri");
    expect(doc.approved).toBe(true);
    expect(doc.projectDescription).toContain("fixed MRI scanner");

    expect(doc.appealDeadline?.getUTCFullYear()).toBe(2025);
    expect(doc.appealDeadline?.getUTCMonth()).toBe(11); // December
    expect(doc.decisionDate?.getUTCMonth()).toBe(10); // November
    expect(doc.applicantContact).toContain("Jena Folger");
  });

  it("does NOT bleed the county token into the facility name", () => {
    // The original bug: a Wilkes County filing matched Wilson Medical Center
    // because the filename parse left project-id + county noise in the name.
    // The document's own "Facility:" field is clean.
    const doc = parseConDocumentText(WILKES_APPROVAL);
    expect(doc.facilityName).toBe("Wilkes Medical Center");
    expect(doc.facilityName).not.toMatch(/D-12683|943561|Wikes/);
  });

  it("reads a disapproval as not approved", () => {
    const doc = parseConDocumentText(DISAPPROVAL);
    expect(doc.approved).toBe(false);
    expect(doc.projectId).toBe("F-11900-24");
    expect(doc.county).toBe("Buncombe");
    expect(doc.stateFacilityId).toBe("700412");
    expect(doc.approvedAmount).toBeUndefined();
  });

  it("returns mostly-empty fields for unrelated text without throwing", () => {
    const doc = parseConDocumentText("This is just some unrelated PDF text.");
    expect(doc.projectId).toBeUndefined();
    expect(doc.facilityName).toBeUndefined();
    expect(doc.county).toBeUndefined();
    expect(doc.textLength).toBeGreaterThan(0);
  });
});
