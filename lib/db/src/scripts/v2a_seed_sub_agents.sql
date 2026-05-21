-- v2a_seed_sub_agents.sql — Tier-A sub-agent registry.
--
-- Adapted from handoff seed 06. Per the operator decision, only the 15
-- Tier-A personas are registered (the 41 Tier-B agents are skipped). The
-- main ProspectingAgent auto-loads every Tier-A row into its tool catalog.
--
-- `source_path` points at vendor/sub-agents/<file>.md — the persona markdown
-- vendored in PR E. `source_commit` is filled in at vendor time.
-- `recommended_model` normalized to the current Sonnet identifier.
--
-- Idempotent: ON CONFLICT updates the descriptive fields.

INSERT INTO sub_agent_registry
  (agent_name, source_repo, source_path, display_name, description, category, tier,
   emoji, vibe, persona_token_estimate, recommended_model)
VALUES
('medical-device-systems-engineer', 'mbse-agents', 'medical-device-systems-engineer.md',
 'Medical Device Systems Engineer',
 'Regulatory framework expert: IEC 62304 software lifecycle, ISO 14971 risk management, FDA QMSR, EU MDR 2017/745, SaMD classification. Use to position equipment against regulatory expectations or answer customer compliance questions.',
 'mbse', 'A', '🏥',
 'The SE whose design history files survive FDA premarket inspections.',
 20000, 'claude-sonnet-4-6'),

('strategy-healthcare-consultant', 'healthcare-agents', 'strategy-healthcare-consultant.md',
 'Healthcare Strategy Consultant',
 'Strategic posture analysis for target health systems. Use when a facility''s strategic direction (M&A, service-line expansion) creates capital equipment demand.',
 'strategy', 'A', '🎯', 'Sees the board-level chess game behind every capital decision.',
 8000, 'claude-sonnet-4-6'),

('strategy-clinical-operations-consultant', 'healthcare-agents', 'strategy-clinical-operations-consultant.md',
 'Clinical Operations Strategy Consultant',
 'Bridges strategic intent and clinical operations. Use to translate equipment investments into operational outcomes (case volume, throughput, quality).',
 'strategy', 'A', '🩺', 'Translates "buy a robot" into OR scheduling impact and break-even volume.',
 8000, 'claude-sonnet-4-6'),

('strategy-structural-improvement-consultant', 'healthcare-agents', 'strategy-structural-improvement-consultant.md',
 'Structural Improvement Consultant',
 'Capital structure and organizational design. Use when evaluating debt capacity, capital allocation, or facility-level capital prioritization.',
 'strategy', 'A', '🏗️', 'Reads a bond covenant the way a surgeon reads an MRI.',
 8000, 'claude-sonnet-4-6'),

('revenue-finance-manager', 'healthcare-agents', 'revenue-finance-manager.md',
 'Revenue Cycle Finance Manager',
 'Operating margin, days cash on hand, debt service coverage, capital affordability. The primary financial-readiness advisor for any capital purchase pitch.',
 'revenue', 'A', '💰', 'Knows the spread between bond-market talk and real capital capacity.',
 8000, 'claude-sonnet-4-6'),

('revenue-340b-program-manager', 'healthcare-agents', 'revenue-340b-program-manager.md',
 '340B Program Manager',
 'KEY for the rural hospital vertical. 340B drug-program margin reinvestment, eligibility, enrollment timing. Use whenever the target is CAH, DSH, or FQHC.',
 'revenue', 'A', '💊', 'Tracks 340B margin like a fund manager tracks alpha.',
 8000, 'claude-sonnet-4-6'),

('revenue-contract-analyst', 'healthcare-agents', 'revenue-contract-analyst.md',
 'Revenue Contract Analyst',
 'Payer contract analysis. Use when negotiated rates intersect equipment ROI math.',
 'revenue', 'A', '📜', 'Reads payer contracts the way a poker player reads tells.',
 8000, 'claude-sonnet-4-6'),

('quality-accreditation-specialist', 'healthcare-agents', 'quality-accreditation-specialist.md',
 'Quality & Accreditation Specialist',
 'THE accreditation-driven capital-trigger expert. ACR/IAC/AAAHC/AAAASF/AAHA cycles, Joint Commission, DNV. Use whenever an accreditation expiry surfaces as a trigger.',
 'quality', 'A', '✅', 'Knows which accreditation gaps need fresh equipment by Q3.',
 8000, 'claude-sonnet-4-6'),

('quality-compliance-officer', 'healthcare-agents', 'quality-compliance-officer.md',
 'Quality Compliance Officer',
 'Regulatory compliance pressure as a capital driver. Use when CMS Conditions of Participation, state survey findings, or OCR actions correlate with the target.',
 'quality', 'A', '🛡️', 'Reads CMS deficiency reports for breakfast.',
 8000, 'claude-sonnet-4-6'),

('healthit-interoperability-engineer', 'healthcare-agents', 'healthit-interoperability-engineer.md',
 'Health IT Interoperability Engineer',
 'EHR/PACS/RIS integration realities. Use when the equipment has data-flow requirements (DICOM, HL7, FHIR) that must map to the customer EHR.',
 'healthit', 'A', '🔌', 'Has debugged HL7 v2.5.1 ADT feeds at 2am and lived.',
 8000, 'claude-sonnet-4-6'),

('healthit-epic-applications-analyst', 'healthcare-agents', 'healthit-epic-applications-analyst.md',
 'Epic Applications Analyst',
 'Epic-specific buying behavior, certified-app ecosystem, Bridges interfaces. Use whenever the target is an Epic shop and equipment must integrate.',
 'healthit', 'A', '⚡', '"Epic-certified" matters more to a CIO than the spec sheet.',
 8000, 'claude-sonnet-4-6'),

('operations-supply-chain-manager', 'healthcare-agents', 'operations-supply-chain-manager.md',
 'Supply Chain Operations Manager',
 'Capital procurement process: GPO leverage (Vizient/Premier/HealthTrust), bid process, sole-source justification, value-analysis committees. Use to understand HOW the customer buys.',
 'operations', 'A', '📦', 'Has shepherded a $2M PO through value analysis and lived.',
 8000, 'claude-sonnet-4-6'),

('operations-ambulatory-manager', 'healthcare-agents', 'operations-ambulatory-manager.md',
 'Ambulatory Operations Manager',
 'ASC vertical operations: OR turnover, case scheduling, anesthesia coverage, block management. Use for any ASC prospect.',
 'operations', 'A', '🏥', 'Runs an ASC like a Swiss watchmaker.',
 8000, 'claude-sonnet-4-6'),

('operations-physician-practice-manager', 'healthcare-agents', 'operations-physician-practice-manager.md',
 'Physician Practice Manager',
 'Independent and group-practice operations: owner-physician dynamics, partner-equity structures, capital decisions in surgeon-owned facilities. Use for ortho practice and surgeon-owned ASC prospects.',
 'operations', 'A', '👨‍⚕️', 'Knows the surgeon owners ARE the procurement committee.',
 8000, 'claude-sonnet-4-6'),

('payer-value-based-care-manager', 'healthcare-agents', 'payer-value-based-care-manager.md',
 'Value-Based Care Manager',
 'VBC and risk-bearing contract environment. Use when the target is in an ACO, bundled payment, or capitation model — these change equipment ROI materially.',
 'payer', 'A', '🎯', 'Reads quality bonus structures the way others read sports stats.',
 8000, 'claude-sonnet-4-6')

ON CONFLICT (agent_name) DO UPDATE
  SET display_name      = EXCLUDED.display_name,
      description       = EXCLUDED.description,
      category          = EXCLUDED.category,
      tier              = EXCLUDED.tier,
      emoji             = EXCLUDED.emoji,
      vibe              = EXCLUDED.vibe,
      recommended_model = EXCLUDED.recommended_model,
      updated_at        = NOW();
