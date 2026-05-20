# Vertical: Imaging Centers

## Market

- ≈11,000 freestanding imaging centers in the US
- ≈8,000 hospital outpatient imaging departments
- Equipment refresh cycle: 7–10 years for CT/MRI, 5–7 years for mammo, 3–5 years for ultrasound

## Primary modalities

`MRI`, `CT`, `mammo`, `PET`, `ultrasound`, `DXA`, `fluoro`

## Signal weights (from `vertical_modules.signal_weights`)

| Signal | Weight | Rationale |
|---|---|---|
| `con_filing` | 0.95 | Direct intent to acquire |
| `acr_iac_expiry` | 0.90 | Re-accreditation often triggers upgrade |
| `manufacturer_eol` | 0.88 | Forced refresh window |
| `fda_recall` | 0.85 | Replacement budget activated |
| `hcris_depreciation` | 0.75 | Asset class depreciation > 70% |
| `job_posting` | 0.65 | Velocity ≥3 in 60 days |
| `construction_permit` | 0.60 | Site expansion |
| `press_release` | 0.55 | Self-disclosed plans |

## Target decision-maker triangle

| Role | Buyer role | Title patterns |
|---|---|---|
| Clinical champion | `clinical_champion` | Lead Radiologist, Imaging Medical Director |
| Economic buyer | `economic_buyer` | Practice Administrator, CFO, Imaging Director |
| Procurement gatekeeper | `procurement_gatekeeper` | Materials Manager, Procurement Director |

For hospital-affiliated centers, add a fourth: `executive_sponsor` (VP of Radiology / Chief Medical Officer).

## NEPQ outreach hook

**Trigger:** ACR mammo accreditation expiring within 12 months + Hologic Selenia Dimensions (EOL 2024)

**Opening question:** "When your ACR accreditation comes up next March, are you planning to recertify on the current Selenia, or are you exploring an upgrade to 3Dimensions or a competitor before then?"

**Why this works (NEPQ):** Status-quo disruption + concrete timeline + manufacturer-specific knowledge demonstrates expertise. The rep has not pitched anything — they're asking a thoughtful operational question. Follow-up depending on response.

## Sample bid draft template

```
Hi {{contact.first_name}},

I noticed {{facility.name}}'s ACR mammography accreditation is up for renewal in {{accreditation.expires_at | format}}, and your installed Selenia Dimensions is approaching end-of-service from Hologic ({{eol.parts_end_date | format}}).

Most centers in your position end up making the upgrade decision 6–9 months before the accreditation expiry to avoid recertifying on a sunset platform. We've helped {{social_proof_count}} comparable centers navigate this exact decision — usually with 3Dimensions or the 3D Performance package, sometimes with a competitive switch to a Fuji ASPIRE Cristalle.

Would it be worth a 20-minute call next week to walk through what the current refurb / new market looks like for centers your size? I can send a 3-vendor comparison ahead of time so the call is productive.

— {{rep.first_name}}
```

## Outreach guardrails

- Never mention price in the first message
- Never claim certainty about competitor installs unless `competitive_installs` has `verified` status
- Reference the source (accreditation registry, EOL bulletin) by name — "I saw on ACR's lookup tool..." — to demonstrate research transparency
- Always offer a multi-vendor comparison, never a single-vendor pitch (Chicago Medex is a broker — they sell from multiple OEMs)
