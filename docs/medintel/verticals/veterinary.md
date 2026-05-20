# Vertical: Veterinary Hospitals

## Market

- ≈32,000 vet practices in the US
- ≈4,800 AAHA-accredited (the strongest upgrade-prone segment)
- Veterinary consolidator landscape is rapidly reshaping procurement:
  - **Mars Veterinary Health** (Banfield, VCA, BluePearl, AntechDiagnostics) — ≈2,500 locations, centralized procurement
  - **National Veterinary Associates (NVA)** — ≈1,500, more autonomy per location
  - **Pathway Vet Alliance** — ≈400 (TSG Consumer Partners)
  - **PetVet Care Centers** — ≈400 (KKR)
  - **MedVet** — ≈40 specialty + ER
  - **VetCor** — ≈400

When a consolidator acquires a practice, all locations enter a capital refresh window over the following 18 months.

## Primary modalities

`CT`, `MRI`, `ultrasound`, `dental_radiography`, `C-arm`, `anesthesia`, `endoscopy`, `monitoring`, `laser_therapy`

## Signal weights

| Signal | Weight | Rationale |
|---|---|---|
| `consolidator_acquisition` | 0.90 | Refresh window triggered |
| `new_facility_construction` | 0.85 | Greenfield install |
| `aaha_accreditation_expiry` | 0.85 | Recertification cycle = equipment review |
| `job_posting` | 0.70 | New imaging tech or veterinarian = service expansion |
| `usda_aphis_change` | 0.65 | License status change |

## Target decision-maker triangle

| Role | Buyer role | Title patterns |
|---|---|---|
| Clinical champion | `clinical_champion` | Lead DVM, Medical Director |
| Economic buyer | `economic_buyer` | Practice Owner, Hospital Administrator |

For independent practices (~60% of market): the practice owner is BOTH champion and economic buyer.

For consolidator-owned practices: the economic buyer is at the regional / national level. Identify the procurement contact at the consolidator HQ.

| Consolidator | Procurement contact pattern |
|---|---|
| Mars Veterinary Health | "Capital Equipment Procurement" team at McLean VA HQ |
| NVA | "Director of Operations" per region |
| Pathway | "Regional Operations Director" |
| PetVet | "VP of Operations" |

## NEPQ outreach hook

**Trigger:** Independent vet practice acquired by NVA within the last 12 months + practice has no CT in `equipment_records`

**Opening question:** "I saw {{facility.name}} joined NVA last {{acquisition.quarter}}. Most practices going into NVA end up evaluating diagnostic imaging upgrades within 6–18 months once the operational integration settles — is CT something you're considering?"

**Why this works:** Acknowledges the recent change, demonstrates knowledge of the consolidator transition pattern, asks about their specific timeline without assuming.

## Sample bid draft template

```
Hi Dr. {{contact.last_name}},

I saw {{facility.name}} joined {{consolidator.name}} last {{acquisition.quarter}}, and your AAHA accreditation comes up for renewal in {{accreditation.year}}.

The pattern we see most often with practices coming into {{consolidator.name}}: imaging upgrades land in the 6–18 month post-acquisition window once operational integration is done. Veterinary CT specifically has moved fast in the last 24 months — the Epica VimagoGT, NeuroLogica CereTom, and Esaote Ngenia are all in active use at AAHA-accredited specialty practices your size.

If a quick market scan would be useful before you start the conversation with the regional Ops team, happy to put together a comparison sized to your case mix. {{social_proof_facility}} did this last quarter and the call was 20 minutes.

— {{rep.first_name}}
```

## Outreach guardrails

- For consolidator-owned practices: the practice owner cannot buy independently. Always include or route to the regional procurement contact
- For independent practices: respect that the owner-vet is buying with their own money — be direct about ROI and financing
- Veterinary CT is a real category now (10 years ago, MRI/CT in vet was rare) — reference current vet-specific OEMs
- AAHA accreditation is voluntary but coveted; failure-to-recertify is rare so it's a meaningful timeline marker
