# Vertical: Orthopedic Surgery

## Market

- ≈6,500 orthopedic group practices in the US
- ≈2,200 specialty / orthopedic-focused hospitals and surgical hospitals
- Massive shift of ortho cases from inpatient to ASC (driven by 2018+ CMS ASC list expansions for TKA, THA, total shoulder)

## Primary modalities

`surgical_robot` (Mako, ROSA, VELYS, Mazor), `C-arm`, `fluoroscopy`, `navigation_system`, `intraop_imaging`

## Signal weights

| Signal | Weight | Rationale |
|---|---|---|
| `cms_procedure_volume_growth` | 0.95 | Volume growth = capacity expansion |
| `surgical_robot_age` | 0.90 | Mako 1st gen, da Vinci Si EOL approaching |
| `job_posting_robotic` | 0.85 | "Robotic Surgery Coordinator" hiring = imminent install |
| `con_filing` | 0.80 | State-required for new OR or surgical hospital |
| `asc_list_expansion` | 0.75 | New CPT added to ASC payable list |

## Target decision-maker triangle

| Role | Buyer role | Title patterns |
|---|---|---|
| Clinical champion | `clinical_champion` | Lead Orthopedic Surgeon, Joint Replacement Director |
| Economic buyer | `economic_buyer` | Practice Administrator, COO, Service Line Director |
| Technical evaluator | `technical_evaluator` | OR Director, Director of Perioperative Services |

For larger health systems, add `executive_sponsor` (VP / Chief of Surgical Services).

## NEPQ outreach hook

**Trigger:** Hiring "Robotic Surgery Coordinator" + ASC owned by the practice + no existing robot in `equipment_records`

**Opening question:** "I noticed {{facility.name}} is hiring a Robotic Surgery Coordinator and you don't currently have a robot listed in the state radiation registry. Are you in the middle of a Mako / ROSA / VELYS evaluation, or earlier in the process?"

**Why this works:** Specific, sourced, asks about their current process not their willingness. Most reps lead with "have you considered a robot?" — that loses to "I saw you're already heading that direction."

## Sample bid draft template

```
Hi Dr. {{contact.last_name}},

I saw {{facility.name}} posted for a Robotic Surgery Coordinator last month, and your CMS Physician Compare data shows {{procedure_volumes.tka_count}} TKAs and {{procedure_volumes.tha_count}} THAs in the most recent reporting period — strong volume for an ASC-focused practice your size.

If you're in the middle of evaluating Mako vs ROSA vs VELYS, the timing matters more than the brand: Stryker, Zimmer, and J&J each run their fiscal-year-end deal cycles differently, and the negotiated trade-in / used-unit market is far better than the list price suggests. {{social_proof_facility}} just did this in {{social_proof_quarter}} and ended up saving {{social_proof_pct}} on a comparable evaluation.

Worth a 20-minute conversation to walk through what's actually moving in the used / refurb market right now? No pitch — just market intel from someone who placed {{rep.placements_count}} of these last year.

— {{rep.first_name}}
```

## Outreach guardrails

- Reference CMS data (CPT volumes from `procedure_volumes`) — surgeons respect data
- Acknowledge the surgeon's autonomy in equipment selection (they hate being treated like a procurement target)
- For ortho ASCs, the surgeon-owner IS the economic buyer — collapse the triangle to a single human
- Never disparage Intuitive da Vinci (they're not in ortho but are a culturally loaded reference)
