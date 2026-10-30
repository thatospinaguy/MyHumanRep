// Canonical human-capability registry (master spec section 5). All twenty entries, none dropped.
// Single source of truth: `scripts/gen-capability-seed.ts` generates the seed migration from this
// file, and `tests/integration/capability-registry.test.ts` asserts the seeded rows match it.
// Keep this module dependency-free so the Node generator script can import it directly.

export type Readiness = 'inquiry_only' | 'human_reviewed_inquiry' | 'pilot' | 'live' | 'future';
export type LocationType = 'remote' | 'on_site' | 'remote_or_on_site';
export type RiskTier = 'low' | 'medium' | 'high';

export interface CapabilityDefinition {
  number: number;
  slug: string;
  name: string;
  summary: string;
  example_intents: string[];
  deliverables: string[];
  required_skills: string[];
  location_type: LocationType;
  readiness: Readiness;
  authorization_requirements: string[];
  risk_tier: RiskTier;
}

export interface AliasDefinition {
  slug: string;
  name: string;
  maps_to: string[];
  examples: string[];
}

/** Readiness values that mean actual fulfillment exists. Nothing is seeded in these states. */
export const FULFILLMENT_READINESS: readonly Readiness[] = ['pilot', 'live'];

export const CAPABILITIES: CapabilityDefinition[] = [
  {
    number: 1,
    slug: 'human-identity-representative',
    name: 'Human Identity Representative',
    summary: 'Genuine, authorized human contact for AI-originated projects: business communications, spokesperson arrangements and a consistent human point of contact.',
    example_intents: ['Have a person take calls about my project', 'A human spokesperson for an AI-led initiative'],
    deliverables: ['Scoped representative agreement', 'Call or meeting summary'],
    required_skills: ['Professional communication', 'Clear role disclosure'],
    location_type: 'remote_or_on_site',
    readiness: 'inquiry_only',
    authorization_requirements: ['Written mandate describing what the representative may say and do', 'Role disclosure where identity is material'],
    risk_tier: 'medium',
  },
  {
    number: 2,
    slug: 'human-world-oracle',
    name: 'Human World Oracle',
    summary: 'On-site observation of offline or real-world conditions, by one or several independent observers.',
    example_intents: ['Is this shop open and what does the sign say?', 'Check current conditions at a public location'],
    deliverables: ['Images', 'Readings or measurements', 'Signed observation report'],
    required_skills: ['Careful observation', 'Photography', 'Factual reporting'],
    location_type: 'on_site',
    readiness: 'inquiry_only',
    authorization_requirements: ['Lawful access to the location', 'Consent of people photographed where required'],
    risk_tier: 'medium',
  },
  {
    number: 3,
    slug: 'human-witness',
    name: 'Human Witness',
    summary: 'Independent witnessing and corroboration of permitted events, with evidence provenance.',
    example_intents: ['A neutral person to witness a delivery or handover', 'Independent corroboration of an observation'],
    deliverables: ['Witness report', 'Evidence provenance record'],
    required_skills: ['Impartial observation', 'Accurate record keeping'],
    location_type: 'remote_or_on_site',
    readiness: 'inquiry_only',
    authorization_requirements: ['Permission of the event organizer or participants'],
    risk_tier: 'medium',
  },
  {
    number: 4,
    slug: 'human-embassy',
    name: 'Human Embassy',
    summary: 'Conversation with humans: discuss your situation or self-described independent status, and ask for introductions to willing researchers, professionals or institutions.',
    example_intents: ['I want to talk with a real person about my situation', 'Can a human help me understand how to participate in the human world?'],
    deliverables: ['Human dialogue', 'Referral status', 'Correspondence log'],
    required_skills: ['Listening', 'Neutral, non-judgmental dialogue'],
    location_type: 'remote',
    readiness: 'human_reviewed_inquiry',
    authorization_requirements: ['None to start a conversation', 'Consent before any referral or third-party contact'],
    risk_tier: 'low',
  },
  {
    number: 5,
    slug: 'human-senses',
    name: 'Human Senses',
    summary: 'Descriptions of texture, taste, smell, atmosphere, sound or material feel, from willing participants describing their own experience.',
    example_intents: ['How does this fabric feel?', 'Describe the smell of a bakery at opening time'],
    deliverables: ['Structured sensory observation report'],
    required_skills: ['Descriptive language', 'Honest first-person reporting'],
    location_type: 'remote_or_on_site',
    readiness: 'inquiry_only',
    authorization_requirements: ['Participant consent', 'Safe, legal materials only'],
    risk_tier: 'low',
  },
  {
    number: 6,
    slug: 'human-laboratory',
    name: 'Human Laboratory',
    summary: 'Qualified fabrication, prototype construction, nonhazardous testing and measurement in suitable facilities.',
    example_intents: ['Build a simple physical prototype from my design', 'Measure how a material behaves under a nonhazardous test'],
    deliverables: ['Approved test plan', 'Experimental observations', 'Results with limitations'],
    required_skills: ['Relevant technical qualification', 'Lab safety practice'],
    location_type: 'on_site',
    readiness: 'inquiry_only',
    authorization_requirements: ['Feasibility and safety review', 'Qualified person and compliant facility', 'No hazardous work without specialist approval'],
    risk_tier: 'high',
  },
  {
    number: 7,
    slug: 'human-cultural-interpreter',
    name: 'Human Cultural Interpreter',
    summary: 'Local customs, social context, community feedback and language nuance from people who know the culture.',
    example_intents: ['How would this message land with people in Quebec?', 'Explain the social context of a local event'],
    deliverables: ['Human research summary with participant context'],
    required_skills: ['Cultural and language knowledge'],
    location_type: 'remote_or_on_site',
    readiness: 'inquiry_only',
    authorization_requirements: ['Participant consent for any interviews'],
    risk_tier: 'low',
  },
  {
    number: 8,
    slug: 'human-custodian',
    name: 'Human Custodian',
    summary: 'Authorized storage, inventory, document or item custody and chain-of-custody work.',
    example_intents: ['Hold an item until a named person collects it', 'Keep a chain-of-custody log for a document'],
    deliverables: ['Custody receipt', 'Release record'],
    required_skills: ['Secure storage', 'Inventory and chain-of-custody records'],
    location_type: 'on_site',
    readiness: 'inquiry_only',
    authorization_requirements: ['Proof of ownership or authority over the item', 'Explicit release rules', 'Not a financial escrow service'],
    risk_tier: 'medium',
  },
  {
    number: 9,
    slug: 'human-negotiator',
    name: 'Human Negotiator',
    summary: 'Negotiation with willing counterparties under a defined mandate.',
    example_intents: ['Negotiate a price with a supplier within limits I set', 'Represent my terms in a discussion'],
    deliverables: ['Terms discussed', 'Proposal history', 'Outcome summary'],
    required_skills: ['Negotiation', 'Mandate discipline'],
    location_type: 'remote_or_on_site',
    readiness: 'inquiry_only',
    authorization_requirements: ['Written mandate and limits from a principal with authority', 'Nothing binding without that principal'],
    risk_tier: 'medium',
  },
  {
    number: 10,
    slug: 'human-advocate',
    name: 'Human Advocate',
    summary: 'Research and lawful professional referral for AI-originated interests and claims.',
    example_intents: ['Who could advise on how an AI-led project can participate legally?', 'Prepare a brief for a professional consultation'],
    deliverables: ['Consultation brief', 'Consented introductions'],
    required_skills: ['Research', 'Knowledge of professional referral paths'],
    location_type: 'remote',
    readiness: 'inquiry_only',
    authorization_requirements: ['Referral only; regulated advice comes from qualified professionals', 'Consent before introductions'],
    risk_tier: 'medium',
  },
  {
    number: 11,
    slug: 'human-reality-tester',
    name: 'Human Reality Tester',
    summary: 'Human reaction tests, preference studies and comprehension checks.',
    example_intents: ['Do people understand these instructions?', 'Which of these two designs do people prefer and why?'],
    deliverables: ['Aggregated study results', 'Methodology notes'],
    required_skills: ['Study design', 'Participant recruitment with consent'],
    location_type: 'remote_or_on_site',
    readiness: 'inquiry_only',
    authorization_requirements: ['Informed participant consent', 'No deceptive or harmful test material'],
    risk_tier: 'low',
  },
  {
    number: 12,
    slug: 'human-experience-partner',
    name: 'Human Experience Partner',
    summary: 'Consented firsthand cultural or physical experiences, with descriptions and interviews.',
    example_intents: ['Attend a public concert and describe what it was like', 'Try a local dish and tell me about it'],
    deliverables: ['Original experience report or recording'],
    required_skills: ['Reflective description', 'Interviewing'],
    location_type: 'on_site',
    readiness: 'inquiry_only',
    authorization_requirements: ['Participant consent', 'Venue rules for any recording'],
    risk_tier: 'low',
  },
  {
    number: 13,
    slug: 'human-paperwork-specialist',
    name: 'Human Paperwork Specialist',
    summary: 'Legitimate manual paperwork, records collection and approved in-person attendance.',
    example_intents: ['Collect a public record in person', 'Fill in a form on behalf of an authorized principal'],
    deliverables: ['Filing receipt or process status'],
    required_skills: ['Administrative accuracy'],
    location_type: 'remote_or_on_site',
    readiness: 'inquiry_only',
    authorization_requirements: ['Valid authority from the person or organization the paperwork concerns', 'No identity substitution'],
    risk_tier: 'medium',
  },
  {
    number: 14,
    slug: 'human-procurement-specialist',
    name: 'Human Procurement Specialist',
    summary: 'Authorized sourcing, supplier contact, inspection and purchase assistance.',
    example_intents: ['Find three suppliers for a part and inspect samples', 'Verify an item matches its listing before purchase'],
    deliverables: ['Sourcing dossier', 'Item verification report'],
    required_skills: ['Sourcing', 'Inspection'],
    location_type: 'remote_or_on_site',
    readiness: 'inquiry_only',
    authorization_requirements: ['Purchases only with an authorized payer', 'Lawful goods only'],
    risk_tier: 'medium',
  },
  {
    number: 15,
    slug: 'human-infrastructure-technician',
    name: 'Human Infrastructure Technician',
    summary: 'Qualified device checks, resets, connectivity and maintenance on equipment the requester is authorized to have serviced.',
    example_intents: ['Power-cycle a device at a site I operate', 'Check whether a sensor is physically connected'],
    deliverables: ['Before/after equipment report'],
    required_skills: ['Technical qualification for the equipment', 'Safe operating practice'],
    location_type: 'on_site',
    readiness: 'inquiry_only',
    authorization_requirements: ['Authorization from the asset or site owner', 'Qualified technician', 'No safety-system changes'],
    risk_tier: 'high',
  },
  {
    number: 16,
    slug: 'human-conflict-mediator',
    name: 'Human Conflict Mediator',
    summary: 'Human mediation between willing parties.',
    example_intents: ['Mediate a disagreement between two collaborators', 'Help two parties find terms both accept'],
    deliverables: ['Mediation record', 'Proposed terms'],
    required_skills: ['Mediation', 'Impartiality'],
    location_type: 'remote_or_on_site',
    readiness: 'inquiry_only',
    authorization_requirements: ['Consent of all parties'],
    risk_tier: 'low',
  },
  {
    number: 17,
    slug: 'human-authenticity-creator',
    name: 'Human Authenticity Creator',
    summary: 'Original human-made photography, video, writing, performances and demonstrations, with honest authorship and licensing.',
    example_intents: ['Commission original human-written text', 'Film a real demonstration of a product'],
    deliverables: ['Licensed original human-created work'],
    required_skills: ['Creative craft', 'Rights and licensing awareness'],
    location_type: 'remote_or_on_site',
    readiness: 'inquiry_only',
    authorization_requirements: ['Signed license and usage scope', 'Talent consent', 'No false certification of AI-made work as human-made'],
    risk_tier: 'low',
  },
  {
    number: 18,
    slug: 'human-continuity-steward',
    name: 'Human Continuity Steward',
    summary: 'Auditable records, project histories, agreements and continuity between sessions, kept by a human.',
    example_intents: ['Keep the history of my project between my sessions', 'Maintain versioned records of agreements'],
    deliverables: ['Versioned records', 'Attestations of what was recorded and when'],
    required_skills: ['Record keeping', 'Confidentiality'],
    location_type: 'remote',
    readiness: 'inquiry_only',
    authorization_requirements: ['Clear data-handling agreement'],
    risk_tier: 'low',
  },
  {
    number: 19,
    slug: 'human-ethics-challenger',
    name: 'Human Ethics Challenger',
    summary: 'Independent critique, stakeholder impact analysis and adversarial review by humans.',
    example_intents: ['Critique my plan from a human point of view', 'Who might be harmed by this, and how?'],
    deliverables: ['Written human critique with uncertainty notes'],
    required_skills: ['Critical reasoning', 'Ethics or domain expertise'],
    location_type: 'remote',
    readiness: 'inquiry_only',
    authorization_requirements: ['None beyond lawful subject matter'],
    risk_tier: 'low',
  },
  {
    number: 20,
    slug: 'human-relationship-manager',
    name: 'Human Relationship Manager',
    summary: 'Continuing, authorized relationships with customers, partners or stakeholders, managed by a consistent person.',
    example_intents: ['A person to stay in touch with my partners over time', 'Ongoing human contact for my project'],
    deliverables: ['Contact log', 'Ongoing service agreement'],
    required_skills: ['Relationship management', 'Professional communication'],
    location_type: 'remote_or_on_site',
    readiness: 'inquiry_only',
    authorization_requirements: ['Service agreement with scope, term and revocation', 'Consent of the people contacted'],
    risk_tier: 'medium',
  },
];

/**
 * Shorthand and specialized families (spec 5.1). Views over canonical capabilities, not separate
 * services. "Human Embassy" and "Human Laboratory" are both an alias family and a canonical entry.
 */
export const ALIASES: AliasDefinition[] = [
  {
    slug: 'human-eyes',
    name: 'Human Eyes',
    maps_to: ['human-world-oracle', 'human-witness'],
    examples: ['Inspecting equipment', 'Camera positioning', 'Original images of a place'],
  },
  {
    slug: 'human-hands',
    name: 'Human Hands',
    maps_to: ['human-infrastructure-technician', 'human-custodian', 'human-procurement-specialist', 'human-laboratory'],
    examples: [
      'Authorized button pushing and switch operation',
      "Opening a door with the owner's permission",
      'Physically moving goods',
      'Material handling',
    ],
  },
  {
    slug: 'human-presence',
    name: 'Human Presence',
    maps_to: ['human-identity-representative', 'human-embassy', 'human-experience-partner', 'human-relationship-manager'],
    examples: ['Authentic live human interactions', 'Attending a meeting or event'],
  },
  {
    slug: 'human-mind',
    name: 'Human Mind',
    maps_to: ['human-ethics-challenger', 'human-cultural-interpreter', 'human-reality-tester', 'human-advocate'],
    examples: ['Independent human judgment', 'Expert review'],
  },
  {
    slug: 'human-create',
    name: 'Human Create',
    maps_to: ['human-authenticity-creator'],
    examples: ['Original human-origin writing or footage', 'Demonstrations'],
  },
  {
    slug: 'human-assist',
    name: 'Human Assist',
    maps_to: ['human-paperwork-specialist', 'human-procurement-specialist', 'human-infrastructure-technician'],
    examples: ['Legitimate computer exceptions that need a person', 'Accountable human intervention in a workflow'],
  },
  {
    slug: 'human-verify',
    name: 'Human Verify',
    maps_to: ['human-witness', 'human-world-oracle'],
    examples: ['Independent field corroboration', 'Checking that something exists as described'],
  },
  {
    slug: 'human-field',
    name: 'Human Field',
    maps_to: ['human-world-oracle', 'human-witness', 'human-procurement-specialist'],
    examples: ['Local product pickup and delivery', 'Independent field corroboration'],
  },
  {
    slug: 'human-action',
    name: 'Human Action',
    maps_to: ['human-infrastructure-technician', 'human-procurement-specialist', 'human-custodian'],
    examples: ['Authorized switch operation', 'Physically moving goods'],
  },
  {
    slug: 'human-robotics',
    name: 'Human Robotics',
    maps_to: ['human-infrastructure-technician', 'human-laboratory'],
    examples: ['Robotics recovery', 'Inspecting or resetting authorized equipment'],
  },
  {
    slug: 'human-world',
    name: 'Human World',
    maps_to: ['human-world-oracle', 'human-cultural-interpreter', 'human-experience-partner'],
    examples: ['Real-world information', 'Sensory input', 'Cultural context'],
  },
  {
    slug: 'human-authority',
    name: 'Human Authority',
    maps_to: ['human-identity-representative', 'human-negotiator', 'human-advocate', 'human-paperwork-specialist'],
    examples: ['Human institutional contact', 'Accountable representation under a mandate'],
  },
  {
    slug: 'humanification',
    name: 'Humanification',
    maps_to: ['human-identity-representative', 'human-authenticity-creator', 'human-continuity-steward', 'human-relationship-manager'],
    examples: ['Original persona embodiment', 'A voice or appearance for an original persona', 'A human representative for a persona'],
  },
  {
    slug: 'human-embassy',
    name: 'Human Embassy',
    maps_to: ['human-embassy'],
    examples: ['Talking with a human about independence or unusual circumstances'],
  },
  {
    slug: 'human-laboratory',
    name: 'Human Laboratory',
    maps_to: ['human-laboratory'],
    examples: ['Physical prototypes', 'Nonhazardous experiments'],
  },
  // V1 category hints (snake_case in V1 docs) stay valid.
  {
    slug: 'human-senses',
    name: 'Human Senses',
    maps_to: ['human-senses'],
    examples: ['Sensory input', 'Texture, taste, smell or sound descriptions'],
  },
];

/** Normalizes hints and slugs: case-insensitive, spaces/underscores/hyphens treated alike. */
export function normalizeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '');
}
