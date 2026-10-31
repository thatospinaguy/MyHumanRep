// Embodiment and representation consent templates (master spec 6.3, 6.5). These are DRAFT checklists of what an
// agreement must record. They are not legal advice and must be reviewed by a qualified lawyer before real use.
// No agreement is created or signed through the API in this release: the provider network arrives in Phase 5.

export const TEMPLATE_STATUS = 'draft_requires_legal_review' as const;

export type PersonaContext = 'fictional' | 'creative' | 'business' | 'official';

export interface TemplateSection {
  key: string;
  label: string;
  required: boolean;
  guidance: string;
}

export interface ConsentTemplate {
  slug: string;
  version: string;
  title: string;
  applies_to_roles: string[];
  summary: string;
  sections: TemplateSection[];
}

/** Spec 6.5: accepting a performance role never authorizes any of these. */
export const NEVER_AUTHORIZED = [
  'access to any account',
  'signing documents or contracts on anyone\'s behalf',
  'identity, biometric, CAPTCHA, KYC or government-ID verification',
  'banking, payments or financial instructions',
  'public endorsement in the performer\'s own name',
];

/** Spec 6.3 context matrix, as disclosure rules. */
export const DISCLOSURE_RULES: Record<PersonaContext, { required: 'context_and_consent' | 'if_material' | 'always'; rule: string }> = {
  fictional: {
    required: 'context_and_consent',
    rule: 'Fiction, performance or consensual roleplay: context and consent decide attribution. No universal label is imposed.',
  },
  creative: {
    required: 'context_and_consent',
    rule: 'Creative or social use: follow platform terms and disclose automation or the human role where it is material to the audience.',
  },
  business: {
    required: 'if_material',
    rule: 'Business settings: the human must have a mandate, and their role must be disclosed wherever it is material to the counterparty.',
  },
  official: {
    required: 'always',
    rule: 'Official, regulated, legal or government settings: the human role must be disclosed, and a persona never substitutes for a legal person, beneficial owner or required documents.',
  },
};

const common = (extra: TemplateSection[]): TemplateSection[] => [
  { key: 'persona', label: 'Persona and its creator/controller', required: true, guidance: 'Persona ID and the agent account that controls it. The persona is an original character, not a legal person.' },
  { key: 'participant', label: 'Human performer or representative', required: true, guidance: 'The consenting person. Their legal identity stays private and is never shown on the persona\'s public profile.' },
  { key: 'principal', label: 'Contracting principal (optional)', required: false, guidance: 'A verified person or organization with legal and financial authority, where the work needs one.' },
  { key: 'role', label: 'Role type', required: true, guidance: 'One of the roles this template applies to.' },
  { key: 'audience_context', label: 'Audience and context', required: true, guidance: 'Who the participant will speak to, and whether the setting is fictional, creative, business or official.' },
  { key: 'scope', label: 'Permitted speech and actions', required: true, guidance: 'What the participant may say and do.' },
  { key: 'exclusions', label: 'Express exclusions', required: true, guidance: 'What is out of scope. Always includes everything in never_authorized.' },
  { key: 'channels_term', label: 'Channels, locations, duration, start and end', required: true, guidance: 'Where and when the role applies.' },
  { key: 'consent_revocation', label: 'Consent and revocation', required: true, guidance: 'How the participant consents, and how either side can withdraw.' },
  { key: 'fee_rights', label: 'Fee and usage rights', required: true, guidance: 'Fee, rights to footage and recordings, licensing limits.' },
  { key: 'disclosure', label: 'Disclosure requirements', required: true, guidance: 'How the human role is disclosed, following the context rules.' },
  { key: 'third_party_permission', label: 'Organizer or counterparty permission', required: false, guidance: 'Required where an event, platform or counterparty must agree.' },
  { key: 'evidence_privacy', label: 'Evidence and privacy controls', required: true, guidance: 'What is recorded, who can see it, and how long it is kept.' },
  { key: 'stop_escalation', label: 'Stop and escalation', required: true, guidance: 'The participant can stop at any time and escalate to a MyHumanRep human.' },
  ...extra,
];

export const CONSENT_TEMPLATES: ConsentTemplate[] = [
  {
    slug: 'fictional-performance',
    version: '0.1-draft',
    title: 'Fictional performance and voice',
    applies_to_roles: ['fictional_performance', 'voice_actor'],
    summary: 'A consenting performer portrays or voices an original persona in a fictional or creative setting.',
    sections: common([
      { key: 'character_brief', label: 'Character brief', required: true, guidance: 'The original persona brief the performer works from. No imitation of an identifiable real person.' },
    ]),
  },
  {
    slug: 'event-presence',
    version: '0.1-draft',
    title: 'Event presence',
    applies_to_roles: ['event_presence'],
    summary: 'A consenting person attends a willing event, meeting or session for a persona or project.',
    sections: common([
      { key: 'venue_permission', label: 'Venue and organizer', required: true, guidance: 'The event, its organizer, and confirmation that attendance is welcome.' },
    ]),
  },
  {
    slug: 'representation',
    version: '0.1-draft',
    title: 'Spokesperson, representative or relationship manager',
    applies_to_roles: ['spokesperson', 'authorized_representative', 'relationship_manager'],
    summary: 'A consenting person speaks or acts for a persona or project within a written mandate.',
    sections: common([
      { key: 'mandate', label: 'Mandate and authority limits', required: true, guidance: 'Bounded, expiring and revocable authority. No blanket permission for future tasks.' },
    ]),
  },
];

export function templateForRole(roleType: string | null | undefined): ConsentTemplate | null {
  if (!roleType) return null;
  return CONSENT_TEMPLATES.find((t) => t.applies_to_roles.includes(roleType)) ?? null;
}

export function templateRef(t: ConsentTemplate | null) {
  return t ? { slug: t.slug, version: t.version, status: TEMPLATE_STATUS } : null;
}

export function disclosureFor(context: string | null | undefined) {
  const rule = DISCLOSURE_RULES[(context ?? '') as PersonaContext];
  return rule ? { context, ...rule } : { context: null, required: 'context_and_consent' as const, rule: 'No context given; the human reviewer will ask before any agreement.' };
}
