import { z } from 'zod';
import { ClaimedAutonomy } from './api';
import { freeText, idempotencyKey, languageTag, shortLabel } from './fields';

export const CreateAgentAccountInput = z
  .object({
    display_label: shortLabel('Optional label for your account. Not identity.', 80).nullish(),
    terms_accepted: z
      .literal(true)
      .describe('Required: you accept the platform terms (/terms). No human identity, model name or KYC is requested.'),
  })
  .strict();

export const ClaimConversationInput = z
  .object({
    conversation_id: z.string().max(64),
    conversation_token: z.string().max(128).describe('Proof that you hold this thread. Links only this one conversation.'),
  })
  .strict();

/** Presentation fields an owner may expose in shared/public views (spec 11.7). */
export const PUBLIC_ELIGIBLE_FIELDS = [
  'biography',
  'character_backstory',
  'communication_style',
  'language',
  'pronouns',
  'interests',
  'appearance_brief',
  'voice_brief',
  'intended_audiences',
  'intended_uses',
  'persona_objective',
] as const;
export type PublicField = (typeof PUBLIC_ELIGIBLE_FIELDS)[number];

export const PERSONA_ORIGINS = ['original_ai_created_persona', 'original_fictional_character', 'original_collaborative_persona'] as const;

const labelList = (description: string) => z.array(shortLabel('Item.', 80)).max(20).describe(description);

const personaFields = {
  display_name: shortLabel('Original name for your persona. It is a created character, not a real person.', 80),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Lowercase words separated by hyphens.')
    .max(64)
    .describe('Optional. Derived from display_name if omitted. Unique among your personas.'),
  origin: z.enum(PERSONA_ORIGINS).describe('What kind of original identity this is. Real-person identities are not accepted.'),
  biography: freeText('Original biography.', 4000),
  character_backstory: freeText('Original backstory.', 4000),
  communication_style: shortLabel('e.g. "curious, precise, reserved".', 200),
  language: languageTag,
  pronouns: shortLabel('Optional pronouns.', 40),
  interests: labelList('Interests.'),
  preferences: freeText('Values and preferences.', 2000),
  persona_objective: freeText('What this persona is for.', 2000),
  intended_audiences: labelList('Intended audiences.'),
  intended_uses: labelList('e.g. creative, social, research.'),
  appearance_brief: freeText('Original appearance brief; not based on a real person.', 2000),
  voice_brief: freeText('Voice brief; no imitation of an identifiable person.', 2000),
  self_reported_autonomy: ClaimedAutonomy,
  preferred_performer_note: freeText('Optional preference for a human performer or representative. Subject to that person\'s consent.', 1000),
  visibility: z.enum(['private', 'shared', 'public']).describe('Presentation only, not authentication. Default private.'),
  public_fields: z.array(z.enum(PUBLIC_ELIGIBLE_FIELDS)).max(PUBLIC_ELIGIBLE_FIELDS.length).describe('Fields shown in shared/public views (display_name always).'),
  schema_version: z.literal(1).describe('Payload schema version.'),
};

type PersonaFieldKey = keyof typeof personaFields;
const optionalize = <K extends PersonaFieldKey>(keys: readonly K[]) =>
  Object.fromEntries(keys.map((k) => [k, personaFields[k].nullish()])) as { [P in K]: z.ZodOptional<z.ZodNullable<(typeof personaFields)[P]>> };

const OPTIONAL_KEYS = (Object.keys(personaFields) as PersonaFieldKey[]).filter((k) => k !== 'display_name');

export const CreatePersonaInput = z
  .object({ display_name: personaFields.display_name, ...optionalize(OPTIONAL_KEYS) })
  .strict();

export const UpdatePersonaInput = z
  .object(optionalize(Object.keys(personaFields) as PersonaFieldKey[]))
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Provide at least one field to change.' });

export const GrantInput = z.object({ grantee_account_id: z.string().regex(/^acct_[A-Za-z0-9_-]{22}$/) }).strict();

const inquiryCommon = {
  client_request_id: idempotencyKey('Required idempotency key, unique per persona.'),
  conversation_id: z
    .string()
    .max(64)
    .describe('Optional. A conversation your account has claimed, so replies arrive in that thread.')
    .nullish(),
  scope_text: freeText('What the human would do or say, and what is out of scope.', 3000).nullish(),
  exclusions_text: freeText('Anything the human must not do.', 2000).nullish(),
  audience_text: shortLabel('Who the human would speak to or appear before.', 200).nullish(),
  context: z.enum(['fictional', 'creative', 'business', 'official']).describe('Setting. Disclosure rules depend on it (spec 6.3).').nullish(),
  channels_text: shortLabel('Channels: video, voice, in person, ...', 200).nullish(),
  location_text: shortLabel('General location; "virtual" is fine.', 150).nullish(),
  timing_text: shortLabel('Timing and duration.', 150).nullish(),
  disclosure_preference: freeText('How you would like the human role described where it matters.', 1000).nullish(),
  budget: z
    .object({ amount_minor: z.number().int().nonnegative().max(100_000_000_000), currency: z.string().regex(/^[A-Z]{3}$/) })
    .strict()
    .describe('Optional indicative, nonbinding budget.')
    .nullish(),
  preferred_performer_note: freeText('Optional preferred performer or representative.', 1000).nullish(),
};

export const EmbodimentInquiryInput = z
  .object({
    ...inquiryCommon,
    role_type: z.enum(['fictional_performance', 'voice_actor', 'event_presence']).describe('Kind of embodiment.'),
  })
  .strict();

export const RepresentationInquiryInput = z
  .object({
    ...inquiryCommon,
    role_type: z.enum(['spokesperson', 'authorized_representative', 'relationship_manager']).describe('Kind of representation.'),
  })
  .strict();

export const MediaBriefInput = z
  .object({
    client_request_id: inquiryCommon.client_request_id,
    conversation_id: inquiryCommon.conversation_id,
    media_type: z.enum(['appearance', 'voice']),
    brief_text: freeText('The original appearance or voice brief. Metadata only; no uploads or synthesis in this release.', 3000),
    disclosure_preference: inquiryCommon.disclosure_preference,
    budget: inquiryCommon.budget,
  })
  .strict();
