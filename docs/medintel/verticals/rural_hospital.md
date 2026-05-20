# Vertical: Rural Hospitals (Critical Access + Small Rural PPS)

## Market

- 1,360 Critical Access Hospitals (CAH) — ≤25 beds, designated for rural geography
- ≈1,000 additional small rural PPS hospitals (not CAH but ≤100 beds)
- Capital constrained — buys often happen against specific funding events: USDA Rural Development loans, HRSA Small Rural Hospital Improvement grants, 340B drug margin reinvestment

## Primary modalities

`CT`, `ultrasound`, `C-arm`, `fluoroscopy`, `mammo`, `endoscopy`, `telehealth`, `lab_analyzer`

## Signal weights

| Signal | Weight | Rationale |
|---|---|---|
| `usda_loan_award` | 0.95 | Funded — they CAN buy |
| `hrsa_grant` | 0.90 | Funded |
| `chna_gap` | 0.85 | Self-identified clinical gap |
| `con_filing` | 0.80 | Public intent |
| `manufacturer_eol` | 0.80 | Forced refresh in a constrained budget |
| `hcris_depreciation` | 0.75 | Asset class > 70% depreciated |
| `340b_enrollment_change` | 0.70 | New margin to reinvest |

## Target decision-maker triangle

| Role | Buyer role | Title patterns |
|---|---|---|
| Clinical champion | `clinical_champion` | Medical Director, Chief of Staff |
| Economic buyer | `economic_buyer` | CEO (often dual-hat CFO at small CAHs), CFO |
| Procurement gatekeeper | `procurement_gatekeeper` | Materials Manager (often shared with Lab Manager) |
| Executive sponsor | `executive_sponsor` | Hospital Board Chair (key for purchases > $250K) |

## NEPQ outreach hook

**Trigger:** USDA Rural Development Community Facilities loan awarded to facility within last 6 months + outdated equipment in their HCRIS A-7

**Opening question:** "Congrats on the USDA award announced in {{award.date}}. Most of the hospitals we work with in your situation are juggling which equipment lines to refresh first against the loan covenant timeline — are you leaning toward imaging, surgical, or something else?"

**Why this works:** Acknowledges their funding win (rare for vendors to reference), demonstrates research, asks about their prioritization (not their decision).

## Sample bid draft template

```
Hi {{contact.first_name}},

I saw the USDA Rural Development announcement for {{facility.name}} — {{award.amount}} approved in {{award.date}}. Congratulations.

Most CAHs in your position end up sequencing the capital refresh against the loan covenant timeline, usually with the longest-lead-time and oldest-asset items first. Based on your CMS HCRIS filing, the equipment most likely to come up first is your {{equipment.modality}} ({{equipment.manufacturer}} {{equipment.model}}, ~{{equipment.age_years}} years), which {{eol_status_description}}.

If a market scan is useful before you sit down with the board, I can put together a comparative on {{equipment.modality}} for CAH-sized facilities — refurb, demo, and new — with realistic delivery timelines for rural sites. {{social_proof_facility}} ({{social_proof_state}} CAH) just did this and ended up saving {{social_proof_pct}}.

Worth a 20-minute call this week?

— {{rep.first_name}}
```

## Outreach guardrails

- Always reference the funding source by name — these hospitals are proud of their awards
- CAH CFOs are extremely cost-sensitive — lead with refurb / demo options, not new
- Delivery logistics matter (rural sites have install constraints): site survey, power, water for chillers (MRI), HVAC, radiation shielding for CT
- Avoid generic "consultative selling" language — be concrete
- Board-of-directors approval is required for purchases above small thresholds; mention this in follow-ups to show you understand the process
