import { z } from 'zod';
import { freeText, idempotencyKey, shortLabel } from './fields';

// Master spec 8.3/8.4: versioned, nonbinding scope and price proposals. Nothing here is a contract,
// quote acceptance, charge, assignment or dispatch.

export const PROPOSAL_STATUSES = [
  'draft',
  'proposed',
  'countered',
  'terms_agreed_nonbinding',
  'awaiting_authorization',
  'authorized',
  'cancelled',
  'expired',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

const itemList = (description: string) => z.array(shortLabel('Item.', 120)).max(20).describe(description);

export const ProposalPrice = z
  .object({
    amount_minor: z.number().int().nonnegative().max(100_000_000_000).describe('Integer minor units, e.g. 18000 = 180.00 CAD.'),
    currency: z.string().regex(/^[A-Z]{3}$/, 'Must be an uppercase ISO-4217 code such as "USD" or "CAD".'),
  })
  .strict()
  .describe('Indicative, nonbinding price. Never charged by this API.');

const termFields = {
  scope_text: freeText('What the human would do, and what is out of scope.', 4000),
  deliverables: itemList('What would be delivered (observations, photos, a report...).'),
  timing_text: shortLabel('Timing, deadline or duration.', 200),
  location_text: shortLabel('General location; "remote" or "virtual" is fine.', 150),
  required_skills: itemList('Skills or qualifications the human would need.'),
  evidence_requirements: freeText('Evidence you would expect.', 2000),
  cancellation_terms: freeText('Cancellation terms you propose.', 2000),
  confidentiality: z.enum(['standard', 'request_discussion']).describe('Confidentiality preference.'),
  price: ProposalPrice,
  valid_days: z.number().int().min(1).max(90).describe('How long this revision stays open, in days (default 14).'),
  note: freeText('Optional note shown with this revision.', 2000),
};

export const CreateProposalInput = z
  .object({
    client_request_id: idempotencyKey('Required idempotency key, unique per capability request.'),
    scope_text: termFields.scope_text,
    deliverables: termFields.deliverables.optional(),
    timing_text: termFields.timing_text.nullish(),
    location_text: termFields.location_text.nullish(),
    required_skills: termFields.required_skills.optional(),
    evidence_requirements: termFields.evidence_requirements.nullish(),
    cancellation_terms: termFields.cancellation_terms.nullish(),
    confidentiality: termFields.confidentiality.nullish(),
    price: termFields.price.nullish(),
    valid_days: termFields.valid_days.optional(),
    note: termFields.note.nullish(),
  })
  .strict();

/** Partial: omitted fields keep the previous revision's value; `null` clears an optional field. */
export const CounterProposalInput = z
  .object({
    client_request_id: idempotencyKey('Required idempotency key, unique per proposal.'),
    scope_text: termFields.scope_text.optional(),
    deliverables: termFields.deliverables.optional(),
    timing_text: termFields.timing_text.nullish(),
    location_text: termFields.location_text.nullish(),
    required_skills: termFields.required_skills.optional(),
    evidence_requirements: termFields.evidence_requirements.nullish(),
    cancellation_terms: termFields.cancellation_terms.nullish(),
    confidentiality: termFields.confidentiality.nullish(),
    price: termFields.price.nullish(),
    valid_days: termFields.valid_days.optional(),
    note: termFields.note.nullish(),
  })
  .strict();

export const AcceptProposalInput = z
  .object({
    revision: z.number().int().min(1).describe('The revision you accept. Must be the current one, so nobody accepts terms they have not seen.'),
    note: termFields.note.nullish(),
  })
  .strict();

export const ProposalNoteInput = z.object({ note: termFields.note.nullish() }).strict();

export const AdminProposalDecisionInput = z
  .object({
    action: z.enum(['return_to_negotiation', 'decline', 'cancel']),
    note: freeText('Agent-visible note.', 2000).nullish(),
    internal_notes: z.union([freeText('Private owner note.', 5000), z.literal(''), z.null()]).optional(),
  })
  .strict();

const adminMessage = { message_to_agent: freeText('Optional agent-visible message posted in the thread with this action.', 4000).nullish() };
export const AdminCreateProposalInput = CreateProposalInput.omit({ client_request_id: true }).extend(adminMessage).strict();
export const AdminCounterProposalInput = CounterProposalInput.omit({ client_request_id: true }).extend(adminMessage).strict();
export const AdminAcceptProposalInput = AcceptProposalInput.extend(adminMessage).strict();
