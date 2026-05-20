# 05 — Glossary

Medical capital equipment vocabulary. Reference this when a term feels ambiguous.

---

## Healthcare facility types

- **NPI** — National Provider Identifier. 10-digit unique ID for every US healthcare provider (individual or organization). Issued by CMS. Free public lookup.
- **CCN** — CMS Certification Number. Issued to Medicare-certified facilities (hospitals, ASCs, SNFs). Different from NPI.
- **CAH** — Critical Access Hospital. CMS designation for rural hospitals ≤25 beds with specific criteria. 1,360 CAHs in the US.
- **DSH** — Disproportionate Share Hospital. Treats a high % of low-income patients; gets payment adjustment.
- **SCP** — Sole Community Provider. Rural hospital with no other within 35 miles.
- **FQHC** — Federally Qualified Health Center. Federally funded community health center.
- **ASC** — Ambulatory Surgery Center. Outpatient surgical facility, Medicare-certified.
- **IDN** — Integrated Delivery Network. Hospital + outpatient + physician group system (e.g. HCA, Ascension, Trinity).
- **GPO** — Group Purchasing Organization. Vizient, Premier, HealthTrust, MedAssets — negotiate bulk pricing.
- **340B** — Federal drug pricing program for safety-net providers. Generates drug margin that often funds capital.

## Equipment / modality

- **CT** — Computed Tomography. $200K–$1.2M new, $80K–$400K refurb. 7–10 year lifecycle.
- **MRI** — Magnetic Resonance Imaging. $1M–$3M new, $300K–$900K refurb. 10–14 year lifecycle.
- **PET** / **PET-CT** — Positron Emission Tomography. $1M–$2.5M. 8–10 year lifecycle.
- **Mammography** — Digital mammo + tomo. $100K–$400K. 7–10 year lifecycle. ACR accreditation cycle = 3 years.
- **Fluoro** / **C-arm** — Fluoroscopy. $80K–$400K. Used in OR, GI, ortho.
- **Linac** — Linear Accelerator. Radiation oncology. $2M–$6M. 10–15 year lifecycle.
- **DXA** — Dual-Energy X-ray Absorptiometry. Bone density. $40K–$80K.
- **DR** — Digital Radiography. X-ray panels. $50K–$250K per room.
- **CR** — Computed Radiography. Older X-ray plate tech, being replaced by DR.
- **Surgical robot** — Mako (Stryker), ROSA (Zimmer Biomet), VELYS (J&J), Mazor (Medtronic), da Vinci (Intuitive). $1M–$2.5M.
- **EHR / EMR** — Electronic Health Record / Electronic Medical Record. Epic, Cerner (Oracle Health), Meditech, athenahealth, NextGen, eClinicalWorks.
- **PACS** — Picture Archiving and Communication System. Imaging storage.
- **RIS** — Radiology Information System. Workflow for radiology dept.

## Regulatory / accreditation bodies

- **CMS** — Centers for Medicare & Medicaid Services. Federal payer + regulator.
- **FDA CDRH** — Center for Devices and Radiological Health. Regulates medical devices.
- **MAUDE** — Manufacturer and User Facility Device Experience. FDA's adverse-event + recall database.
- **HCRIS** — Healthcare Cost Report Information System. CMS's hospital financial filings.
- **ACR** — American College of Radiology. Accredits imaging facilities (CT, MRI, mammo, US, PET). 3-year cycle.
- **IAC** — Intersocietal Accreditation Commission. Vascular, cardiology, MRI, CT.
- **AAAHC** — Accreditation Association for Ambulatory Health Care. Accredits ASCs.
- **AAAASF** — American Association for Accreditation of Ambulatory Surgery Facilities. Smaller ASCs.
- **AAHA** — American Animal Hospital Association. Veterinary accreditation, ≈4,800 practices.
- **Joint Commission** — General hospital accreditation.
- **CON** — Certificate of Need. State approval required before major equipment purchase in 35 states + DC.
- **CHNA** — Community Health Needs Assessment. Required IRS §501(r) filing every 3 years.
- **HRSA** — Health Resources and Services Administration. Funds rural health.
- **USDA Rural Development** — Funds rural infrastructure including hospitals.

## Specialties and verticals

- **AAOS** — American Academy of Orthopaedic Surgeons.
- **ABOS** — American Board of Orthopaedic Surgery. Board cert lookup is public.
- **ASCA** — Ambulatory Surgery Center Association.
- **AVMA** — American Veterinary Medical Association.
- **APHIS** — Animal and Plant Health Inspection Service (USDA). Licenses vet facilities.

## Equipment manufacturers (major OEMs)

- **GE Healthcare** — Imaging (MR, CT, ultrasound, mammography, X-ray), monitoring
- **Siemens Healthineers** — Imaging (Magnetom MR, Somatom CT, Mammomat), lab diagnostics
- **Philips** — Imaging, monitoring, ultrasound
- **Canon Medical Systems** — Imaging (formerly Toshiba Medical)
- **Fujifilm Healthcare** — Mammo, ultrasound, endoscopy
- **Hologic** — Women's health (mammo, DXA, surgical)
- **Stryker** — Orthopedic implants + Mako robot
- **Zimmer Biomet** — Orthopedic implants + ROSA robot
- **Medtronic** — Surgical, ortho (Mazor), spine
- **Johnson & Johnson MedTech** — Orthopedic (Depuy Synthes), VELYS robot
- **Intuitive Surgical** — da Vinci robot, monopoly in robotic general surgery
- **Boston Scientific** — Interventional, cardiology
- **Karl Storz** — Endoscopy
- **Olympus** — Endoscopy, microscopes
- **Varian (Siemens)** — Radiation oncology (TrueBeam linac)
- **Elekta** — Radiation oncology (Versa HD linac)
- **Mindray** — Patient monitoring, ultrasound (price-disruptor)
- **Carestream** — DR / X-ray
- **Konica Minolta** — DR / X-ray
- **Mortara / Hillrom (Baxter)** — ECG, monitoring

## Sales / commercial terms

- **RFP** — Request for Proposal. Hospital issues, vendors bid.
- **RFI** — Request for Information. Earlier stage, pre-RFP.
- **GSA Schedule** — Federal contract vehicle.
- **NEPQ** — Neuro-Emotional Persuasion Questioning. Sales methodology (Jeremy Miner / 7th Level). Max prefers this for outreach.
- **EOL** — End of Life. Manufacturer stops support / parts.
- **ROC** — Refurbished / OEM-certified.
- **Demo unit** — Used unit previously shown at trade shows or evaluations, often deeply discounted.
- **Trade-in** — Old equipment returned as credit on new.
- **Capital purchase** vs **operating lease** vs **rental** — three financing models.

## v1.0 / v2.0 internal terms

- **Dual-gate enrichment approval** — both DB approval row AND `*_ENABLED` env var required for paid sources
- **Central intelligence** — the 21-table shared layer (cross-tenant facility data)
- **Tenant layer** — RLS-isolated per-account tables (`outreach_drafts`, `enrichment_source_approvals`, future `opportunities`)
- **Capital trigger** — discrete event signaling imminent purchase (CON filing, bond issuance, EOL, recall, etc.)
- **Equipment-age inference** — triangulating install year from multiple sources
- **Buying readiness score** — weighted composite of all active triggers for a facility
- **Opportunity Inbox** — the v2.0 rep-facing UI surfacing 5–15 ready-to-bid opportunities per week
- **Provisional vs verified** — single-source claims are provisional; ≥2 independent sources = verified
- **Source weight** — pre-assigned trust value per source type (0.0–1.0)

---

*If a term isn't here and it's not in the strategic plan, log it in CHANGELOG.md as an open question.*
