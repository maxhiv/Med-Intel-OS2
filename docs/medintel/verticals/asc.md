# Vertical: Ambulatory Surgery Centers (ASCs)

## Market

- ≈6,000 Medicare-certified ASCs
- Heavy buyer of: surgical robots, endoscopy stacks, C-arms, anesthesia machines, lasers, ultrasound, OR booms
- Procurement cycle is faster and less bureaucratic than hospitals; decisions are practical and ROI-driven

## Primary modalities

`surgical_robot`, `endoscopy`, `C-arm`, `anesthesia`, `laser`, `ultrasound`, `or_table`, `or_lights`

## Signal weights

| Signal | Weight | Rationale |
|---|---|---|
| `cms_asc_list_expansion` | 0.95 | New CPT payable = direct revenue opportunity |
| `aaahc_aaaasf_expiry` | 0.90 | Accreditation cycle forces equipment review |
| `con_filing` | 0.85 | State CON for new ASC = greenfield install |
| `hcris_depreciation` | 0.70 | (ASCs don't file HCRIS A-7 like hospitals — proxy via 990 if non-profit) |
| `job_posting` | 0.65 | New tech role = service line launch |

## Target decision-maker triangle

| Role | Buyer role | Title patterns |
|---|---|---|
| Clinical champion | `clinical_champion` | Medical Director, Lead Surgeon |
| Economic buyer | `economic_buyer` | ASC Administrator, CFO |
| Technical evaluator | `technical_evaluator` | Director of Nursing, OR Manager |

For physician-owned ASCs (the majority), economic buyer and clinical champion often collapse. Identify ownership structure from CMS provider-data or state ASC list to score that correctly.

## NEPQ outreach hook

**Trigger:** CMS adds new CPT codes to ASC list (annual November announcement, January effective) that match an ASC's specialty mix

**Opening question:** "With CMS adding {{cpt.description}} to the ASC payable list starting January {{year}}, are you planning to bring that case mix in-house? Most centers we work with end up needing {{equipment_typical}} added to handle the volume."

## Sample bid draft template

```
Hi {{contact.first_name}},

CMS just added {{new_cpt_count}} new procedures to the ASC payable list effective January 1 — including {{relevant_cpts}}, which look like a good fit for {{facility.name}}'s case mix.

If you're already planning to bring these volumes in-house, the {{equipment_typical}} market is moving fast right now (lead times stretched to {{lead_time_weeks}} weeks on new units, but the refurb market is healthy). A {{social_proof_facility}} in {{social_proof_state}} just brought in {{social_proof_equipment}} ahead of the January 1 effective date — happy to share what their decision process looked like.

20-minute call this week to walk through the current market?

— {{rep.first_name}}
```

## Outreach guardrails

- Lead with the revenue opportunity from new CPT codes, not the equipment cost
- ASC administrators are intensely ROI-focused — give them the math (lead time × volume × reimbursement)
- Reference the CMS annual rule change by date — it's a hard deadline that creates urgency
- Avoid hospital-style language ("strategic capital review") — ASCs are scrappier
