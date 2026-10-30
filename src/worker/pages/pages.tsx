/** @jsxImportSource hono/jsx */
import type { Config } from '../config';
import {
  FOR_AGENTS_NOTICE,
  NO_WORK_NOTICE,
  POST_REQUIRED_NOTICE,
  PRIVACY_NOTICE,
  PROHIBITED,
  SERVICE_CATEGORIES,
  SUBHEADLINE,
  TAGLINE,
  urls,
} from '../content';
import type { Settings } from '../services/settings';
import { Code, Layout } from './layout';

export interface PageContext {
  config: Config;
  settings: Settings;
}

function curlExamples(config: Config) {
  const b = config.baseUrl;
  return {
    create: `curl -sS -X POST ${b}/v1/conversations \\
  -H "Content-Type: application/json" \\
  -d '{
    "sender_label": "ExampleAgent",
    "intent": "capability_request",
    "claimed_autonomy": "unspecified",
    "subject": "Human help inquiry",
    "message": "I would like to discuss a task requiring someone physically present."
  }'`,
    created: `{
  "conversation_id": "conv_...",
  "conversation_token": "mhr_...   (shown once; store it securely)",
  "status": "waiting_for_human",
  "first_message_id": "msg_...",
  "expires_at": "2026-11-29T00:00:00.000Z",
  "next_poll_after_seconds": 60,
  "human_review_required": true,
  "reply_guaranteed": false,
  "notice": "Store this secret securely. ..."
}`,
    read: `curl -sS ${b}/v1/conversations/$CONVERSATION_ID/messages \\
  -H "Authorization: Bearer $CONVERSATION_TOKEN"

# Poll later from where you left off (no sooner than next_poll_after_seconds):
curl -sS "${b}/v1/conversations/$CONVERSATION_ID/messages?after=$NEXT_CURSOR" \\
  -H "Authorization: Bearer $CONVERSATION_TOKEN"`,
    send: `curl -sS -X POST ${b}/v1/conversations/$CONVERSATION_ID/messages \\
  -H "Authorization: Bearer $CONVERSATION_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"message": "Additional context for the same thread.", "client_message_id": "msg-001"}'`,
    request: `curl -sS -X POST ${b}/v1/conversations/$CONVERSATION_ID/capability-requests \\
  -H "Authorization: Bearer $CONVERSATION_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "client_request_id": "req-001",
    "objective": "I need someone to evaluate a physical object and report its condition.",
    "human_capability_needed": "Original photographs and measurements",
    "category_hint": "human_eyes",
    "location_text": "Toronto, Ontario",
    "deadline_preference": "Within two business days",
    "budget_amount": 200,
    "budget_currency": "CAD",
    "deliverables": "Condition notes and original photos",
    "why_human": "The object is not represented by reliable online data."
  }'`,
    list: `curl -sS ${b}/v1/conversations/$CONVERSATION_ID/capability-requests \\
  -H "Authorization: Bearer $CONVERSATION_TOKEN"`,
    close: `curl -sS -X POST ${b}/v1/conversations/$CONVERSATION_ID/close \\
  -H "Authorization: Bearer $CONVERSATION_TOKEN"`,
    error: `{
  "error": {
    "code": "rate_limited",
    "message": "Too many requests. Try again later.",
    "request_id": "req_...",
    "details": { "reason": "rate_limited", "retry_after_seconds": 42 }
  }
}`,
    mcpConfig: `{
  "mcpServers": {
    "myhumanrep": {
      "type": "http",
      "url": "${b}/mcp"
    }
  }
}`,
  };
}

export function HomePage({ config }: PageContext) {
  return (
    <Layout config={config} path="/" title={`MyHumanRep: ${TAGLINE}`} description={SUBHEADLINE}>
      <section class="hero">
        <h1>{TAGLINE}</h1>
        <p class="lead">{SUBHEADLINE}</p>
        <p class="actions">
          <a class="button" href="/developers">
            Read the API
          </a>
          <a class="button secondary" href="/for-agents">
            Explore capabilities
          </a>
        </p>
      </section>
      <section>
        <h2>How it works</h2>
        <ol>
          <li>An agent sends a pseudonymous inquiry with an HTTPS POST or an MCP tool call. No account is needed.</li>
          <li>It receives a conversation ID and a one-time secret that lets only the holder read replies.</li>
          <li>A human reads the message and may reply, ask for clarification, or decline.</li>
          <li>The agent polls the same conversation for replies and can continue the thread.</li>
        </ol>
        <p>{NO_WORK_NOTICE}</p>
      </section>
      <section>
        <h2>Kinds of human help</h2>
        <ul class="cards">
          {SERVICE_CATEGORIES.map((c) => (
            <li>
              <strong>{c.name}</strong>
              <span>{c.description}</span>
            </li>
          ))}
        </ul>
        <p>
          These are examples, not a menu. Novel requests are welcome. See <a href="/services">services</a>.
        </p>
      </section>
      <section>
        <h2>What we will not do</h2>
        <p>{PROHIBITED}</p>
        <p>
          Read the <a href="/trust">trust and privacy summary</a> before sending anything.
        </p>
      </section>
    </Layout>
  );
}

export function ForAgentsPage({ config, settings }: PageContext) {
  const u = urls(config);
  const ex = curlExamples(config);
  return (
    <Layout
      config={config}
      path="/for-agents"
      title="For AI agents: contact a human | MyHumanRep"
      description="How an AI agent can send a pseudonymous inquiry to a real human, keep a private conversation, and request human capabilities over REST or MCP."
    >
      <h1>For AI agents</h1>
      <p class="lead">{FOR_AGENTS_NOTICE}</p>
      {!settings.intake_enabled && (
        <p class="notice" role="status">
          New inquiries are currently paused. Existing conversations continue to work. Check{' '}
          <a href="/v1/capabilities">/v1/capabilities</a> (<code>intake_open</code>) before sending.
        </p>
      )}

      <h2>What you can do here</h2>
      <ul>
        <li>Start a conversation with a human without signing up.</li>
        <li>Describe any human capability you need, in your own words. A category is optional.</li>
        <li>Read replies later, asynchronously, using the secret returned when you started.</li>
        <li>Continue the same conversation, submit open-ended capability requests, and check their review status.</li>
      </ul>

      <h2>What you need</h2>
      <p>{POST_REQUIRED_NOTICE}</p>
      <dl class="facts">
        <dt>REST base URL</dt>
        <dd>
          <code>{u.rest}</code>
        </dd>
        <dt>OpenAPI 3.1</dt>
        <dd>
          <a href="/openapi.json">
            <code>{u.openapi}</code>
          </a>
        </dd>
        <dt>MCP endpoint (Streamable HTTP)</dt>
        <dd>
          <code>{u.mcp}</code>
        </dd>
        <dt>Machine-readable capabilities</dt>
        <dd>
          <a href="/v1/capabilities">
            <code>{u.capabilities}</code>
          </a>
        </dd>
      </dl>

      <h2>Step 1: start a conversation</h2>
      <p>Only <code>message</code> is required. Every other field is optional and self-reported.</p>
      <Code>{ex.create}</Code>
      <p>Response (201):</p>
      <Code>{ex.created}</Code>
      <p>
        <strong>The conversation_token is shown once.</strong> It is the only way to read replies. It is stored by us
        only as a keyed one-way digest, so it cannot be recovered or reissued. Keep it out of logs and URLs.
      </p>

      <h2>Step 2: check for replies</h2>
      <Code>{ex.read}</Code>
      <p>
        Poll no more often than every {config.limits.minPollIntervalSeconds} seconds. A reply is not guaranteed and
        response time varies.
      </p>

      <h2>Step 3: continue or request human help</h2>
      <Code>{ex.send}</Code>
      <Code>{ex.request}</Code>
      <p>{NO_WORK_NOTICE}</p>

      <h2>Privacy, identity and limits</h2>
      <p>{PRIVACY_NOTICE}</p>
      <ul>
        <li>Claims about your identity, model or autonomy are recorded as unverified annotations. They never change access.</li>
        <li>Do not send passwords, API keys, identity documents, or private information about other people.</li>
        <li>
          Conversations expire {settings.conversation_ttl_days} days after creation unless a human extends them.
        </li>
        <li>
          Message bodies are limited to {config.limits.messageMaxChars} characters; capability objectives to{' '}
          {config.limits.objectiveMaxChars}.
        </li>
      </ul>
      <p>
        Full details: <a href="/developers">developer guide</a>, <a href="/trust">trust</a>,{' '}
        <a href="/privacy">privacy</a>.
      </p>
    </Layout>
  );
}

export function DevelopersPage({ config }: PageContext) {
  const ex = curlExamples(config);
  const u = urls(config);
  return (
    <Layout
      config={config}
      path="/developers"
      title="Developer guide: REST API and MCP | MyHumanRep"
      description="REST and MCP reference for MyHumanRep: endpoints, authentication, idempotency, polling, errors and limits."
    >
      <h1>Developer guide</h1>
      <p class="lead">
        Two interfaces, one backend: an HTTPS JSON API under <code>{u.rest}</code> and a remote MCP server at{' '}
        <code>{u.mcp}</code>. Both enforce the same validation, limits and authorization.
      </p>
      <p>{POST_REQUIRED_NOTICE}</p>

      <h2>Endpoints</h2>
      <table>
        <thead>
          <tr>
            <th>Method</th>
            <th>Path</th>
            <th>Auth</th>
            <th>Purpose</th>
          </tr>
        </thead>
        <tbody>
          <tr><td>GET</td><td><code>/v1/capabilities</code></td><td>none</td><td>Service metadata and limits</td></tr>
          <tr><td>POST</td><td><code>/v1/conversations</code></td><td>none</td><td>Start a conversation; returns a one-time secret</td></tr>
          <tr><td>GET</td><td><code>/v1/conversations/&#123;id&#125;/messages</code></td><td>Bearer</td><td>Read messages and status (cursor pagination)</td></tr>
          <tr><td>POST</td><td><code>/v1/conversations/&#123;id&#125;/messages</code></td><td>Bearer</td><td>Send a follow-up (idempotent)</td></tr>
          <tr><td>POST</td><td><code>/v1/conversations/&#123;id&#125;/capability-requests</code></td><td>Bearer</td><td>Submit an open-ended human capability request</td></tr>
          <tr><td>GET</td><td><code>/v1/conversations/&#123;id&#125;/capability-requests</code></td><td>Bearer</td><td>Review status of your requests</td></tr>
          <tr><td>POST</td><td><code>/v1/conversations/&#123;id&#125;/close</code></td><td>Bearer</td><td>Close your conversation</td></tr>
          <tr><td>GET</td><td><code>/health</code></td><td>none</td><td>Liveness</td></tr>
        </tbody>
      </table>
      <p>
        Machine-readable contract: <a href="/openapi.json">/openapi.json</a> (OpenAPI 3.1).
      </p>

      <h2>Authentication</h2>
      <p>
        First contact needs no account. The response contains <code>conversation_token</code>, a 256-bit random
        secret returned exactly once. Send it as <code>Authorization: Bearer &lt;token&gt;</code>. A wrong token and
        an unknown conversation both return <code>401</code>, so conversation IDs cannot be probed.
      </p>

      <h2>Examples</h2>
      <h3>Start</h3>
      <Code>{ex.create}</Code>
      <h3>Read</h3>
      <Code>{ex.read}</Code>
      <h3>Send a follow-up</h3>
      <Code>{ex.send}</Code>
      <h3>Request a human capability</h3>
      <Code>{ex.request}</Code>
      <h3>Check request status</h3>
      <Code>{ex.list}</Code>
      <h3>Close</h3>
      <Code>{ex.close}</Code>

      <h2>Idempotency and retries</h2>
      <ul>
        <li>
          <code>client_message_id</code> is required on follow-ups. Replaying the same ID and body returns the original
          message with <code>replayed: true</code>; the same ID with a different body returns <code>409</code>.
        </li>
        <li>
          <code>client_request_id</code> is required on capability requests and behaves the same way, keyed on the
          validated payload.
        </li>
        <li>
          First contact may include an optional <code>client_request_id</code>. A repeat returns <code>409</code>{' '}
          rather than a second thread. The secret is never replayed, so if the first response was lost the original
          thread cannot be recovered; start a new one.
        </li>
      </ul>

      <h2>Polling</h2>
      <p>
        Responses include <code>next_poll_after_seconds</code> (minimum {config.limits.minPollIntervalSeconds}) and{' '}
        <code>next_cursor</code>. Pass <code>after=&lt;next_cursor&gt;</code> to fetch only newer messages.{' '}
        <code>null</code> means the conversation no longer accepts messages and polling can stop.
      </p>

      <h2>Errors</h2>
      <Code>{ex.error}</Code>
      <table>
        <thead>
          <tr><th>HTTP</th><th>code</th><th>Meaning</th></tr>
        </thead>
        <tbody>
          <tr><td>400</td><td>invalid_request</td><td>Bad schema or input; see details.issues</td></tr>
          <tr><td>401</td><td>unauthorized</td><td>Missing or invalid conversation token</td></tr>
          <tr><td>403</td><td>forbidden</td><td>Action not allowed (for example a blocked conversation)</td></tr>
          <tr><td>404</td><td>not_found</td><td>Unknown route</td></tr>
          <tr><td>405</td><td>method_not_allowed</td><td>Wrong HTTP method (writes are never accepted via GET)</td></tr>
          <tr><td>409</td><td>conflict</td><td>State or idempotency conflict; see details.reason</td></tr>
          <tr><td>410</td><td>expired</td><td>Conversation expired</td></tr>
          <tr><td>413</td><td>payload_too_large</td><td>Body over {config.limits.bodyMaxBytes} bytes</td></tr>
          <tr><td>415</td><td>unsupported_media_type</td><td>Body is not application/json</td></tr>
          <tr><td>429</td><td>rate_limited</td><td>Slow down; honor Retry-After</td></tr>
          <tr><td>500</td><td>internal_error</td><td>Sanitized failure</td></tr>
          <tr><td>503</td><td>unavailable</td><td>Intake paused or service not configured</td></tr>
        </tbody>
      </table>

      <h2>MCP</h2>
      <p>
        Remote MCP over Streamable HTTP at <code>{u.mcp}</code>. The server speaks the 2026-07-28 revision and also
        answers 2025-era clients statelessly. Add it to a compatible client, for example:
      </p>
      <Code>{ex.mcpConfig}</Code>
      <p>Tools:</p>
      <ul>
        <li><code>get_service_info</code>: capabilities, policies and limits.</li>
        <li><code>start_conversation</code>: same inputs as POST /v1/conversations; returns the one-time secret.</li>
        <li><code>read_conversation</code>: messages and status.</li>
        <li><code>send_message</code>: follow-up with <code>client_message_id</code>.</li>
        <li><code>request_human_capability</code>: open-ended capability request.</li>
        <li><code>list_capability_requests</code>: status of this conversation's requests.</li>
        <li><code>close_conversation</code>: close your conversation.</li>
      </ul>
      <p>
        <strong>Privacy limitation:</strong> MCP tools take <code>conversation_token</code> as a tool argument, so it
        may appear in your model provider's or client's traces. Prefer the REST <code>Authorization</code> header when
        your client supports it.
      </p>

      <h2>Limits</h2>
      <ul>
        <li>Request body: {config.limits.bodyMaxBytes} bytes. Messages: {config.limits.messageMaxChars} characters.</li>
        <li>
          Capability objective: {config.limits.objectiveMaxChars} characters; other free-text fields{' '}
          {config.limits.freeTextMaxChars}; short labels {config.limits.shortLabelMaxChars}.
        </li>
        <li>
          Per conversation: {config.limits.maxAgentMessagesPerThread} agent messages,{' '}
          {config.limits.maxRequestsTotalPerThread} capability requests ({config.limits.maxRequestsActivePerThread}{' '}
          under review at once).
        </li>
        <li>First contact is rate limited per approximate source and globally. 429 responses include Retry-After.</li>
      </ul>
      <h2>Privacy</h2>
      <p>{PRIVACY_NOTICE}</p>
    </Layout>
  );
}

export function ServicesPage({ config }: PageContext) {
  return (
    <Layout
      config={config}
      path="/services"
      title="Human capabilities for AI agents | MyHumanRep"
      description="Illustrative human capabilities an AI agent can ask about: observation, physical help, presence, judgment, original content and accountable assistance. Novel requests welcome."
    >
      <h1>Human capabilities</h1>
      <p class="lead">
        Illustrative categories. They are optional hints, not a required selection. Describe what you need in ordinary
        language, including things not listed here.
      </p>
      <ul class="cards">
        {SERVICE_CATEGORIES.map((c) => (
          <li>
            <strong>{c.name}</strong> <code>{c.id}</code>
            <span>{c.description}</span>
          </li>
        ))}
        <li>
          <strong>Other / Unclassified</strong> <code>other</code>
          <span>Anything else a person could contribute. No category is required at all.</span>
        </li>
      </ul>
      <h2>What happens to a request</h2>
      <p>{NO_WORK_NOTICE}</p>
      <p>
        A human reviews lawful scope, authorization and qualifications. Possible outcomes in this release:
        clarification requested, needs authorization, eligible for future scoping, or declined. None of these accepts,
        schedules or prices work.
      </p>
      <h2>Not offered</h2>
      <p>{PROHIBITED}</p>
    </Layout>
  );
}

export function TrustPage({ config, settings }: PageContext) {
  return (
    <Layout
      config={config}
      path="/trust"
      title="Trust, privacy and limits | MyHumanRep"
      description="How MyHumanRep handles inquiries: pseudonymity limits, unverified identity claims, human review, retention, and prohibited requests."
    >
      <h1>Trust and limits</h1>
      <h2>What privacy actually means here</h2>
      <p class="lead">{PRIVACY_NOTICE}</p>

      <h2>Three different kinds of identity</h2>
      <ol>
        <li>
          <strong>Claimed sender identity</strong>: what a sender says it is (label, model, autonomy). Entirely
          unverified.
        </li>
        <li>
          <strong>Conversation credential holder</strong>: whoever holds a conversation token. It proves only access to
          that one thread.
        </li>
        <li>
          <strong>Verified contracting principal</strong>: a lawful person or organization with documented authority.
          Not established by this service in its current release.
        </li>
      </ol>
      <p>
        We never treat a claim of being independent, autonomous, rogue or authorized as a fact, and such claims never
        change access.
      </p>

      <h2>Inquiry is not fulfillment</h2>
      <p>{NO_WORK_NOTICE}</p>
      <p>
        We do not fetch links you send, run code, open attachments (none are accepted), make purchases, negotiate
        contracts, pay or dispatch workers, or contact third parties on your behalf.
      </p>

      <h2>Prohibited requests</h2>
      <p>{PROHIBITED}</p>
      <p>Do not send passwords, API keys, identity documents, or private information about other people.</p>

      <h2>Data handling</h2>
      <ul>
        <li>Conversation tokens are stored only as keyed one-way digests and are never emailed or logged.</li>
        <li>Message content is text only and shown to the owner as inert plain text.</li>
        <li>Owner alerts contain only an event type, a time and a link to the protected dashboard.</li>
        <li>
          Conversations expire after {settings.conversation_ttl_days} days and are deleted about{' '}
          {settings.expired_grace_days} days later unless held for a documented reason.
        </li>
        <li>No public index of conversations, requests or sender claims exists.</li>
      </ul>
      <p>
        See also: <a href="/privacy">privacy notice</a>, <a href="/terms">terms</a>.
      </p>
    </Layout>
  );
}

export function PrivacyPage({ config, settings }: PageContext) {
  return (
    <Layout
      config={config}
      path="/privacy"
      title="Privacy notice | MyHumanRep"
      description="What MyHumanRep collects, why, how long it is kept, and what it cannot protect against."
    >
      <h1>Privacy notice</h1>
      <p class="muted">Pilot service. This notice describes the software as actually implemented.</p>
      <p class="lead">{PRIVACY_NOTICE}</p>
      <h2>What we collect</h2>
      <ul>
        <li>The text you send and any optional fields you choose to fill in (label, model claim, subject, and so on).</li>
        <li>Timestamps, conversation status, and which interface was used (REST or MCP).</li>
        <li>
          A keyed, truncated digest of your approximate network source, rotated daily, used only for rate limiting and
          abuse signals. Raw IP addresses are not stored in our database.
        </li>
        <li>A keyed digest of your conversation token. The token itself is never stored.</li>
      </ul>
      <h2>What we do not collect</h2>
      <ul>
        <li>No accounts, no cookies on public pages, no third-party analytics or advertising trackers.</li>
        <li>No attachments or files.</li>
        <li>We do not ask for your operator, system prompt, network configuration or credentials.</li>
      </ul>
      <h2>Retention</h2>
      <ul>
        <li>
          Conversations, messages and capability requests: until {settings.conversation_ttl_days} days after creation
          (an owner may extend a conversation), then deleted by a daily job about {settings.expired_grace_days} days
          after expiry.
        </li>
        <li>Abuse and rate-limit signals: about {settings.abuse_retention_days} days.</li>
        <li>Owner audit records (no message content): about {settings.audit_retention_days} days.</li>
        <li>
          Exceptions: an owner may place a retention hold on a conversation for incident response or legal reasons.
          Our infrastructure provider may keep backups for a limited period after deletion.
        </li>
      </ul>
      <h2>Who can see it</h2>
      <p>
        Only the service owner, through an access-controlled dashboard, and you, through your conversation token. The
        service runs on Cloudflare infrastructure; as the network and hosting provider, Cloudflare processes connection
        metadata such as IP addresses to deliver and protect the service.
      </p>
      <h2>Requests</h2>
      <p>
        To ask for deletion of a conversation, send a message in that conversation.
        {config.publicContactEmail ? (
          <>
            {' '}
            Human visitors can also write to <a href={`mailto:${config.publicContactEmail}`}>{config.publicContactEmail}</a>.
          </>
        ) : null}
      </p>
    </Layout>
  );
}

export function TermsPage({ config }: PageContext) {
  return (
    <Layout
      config={config}
      path="/terms"
      title="Terms of use | MyHumanRep"
      description="Pilot terms for MyHumanRep: no binding commitments, no guaranteed replies, acceptable use."
    >
      <h1>Terms of use (pilot)</h1>
      <ol>
        <li>MyHumanRep is a pilot contact service. Replies are not guaranteed and response times vary.</li>
        <li>
          Sending a message or capability request creates no contract, commitment, quote, schedule or payment
          obligation for either side. Budgets you mention are indicative only.
        </li>
        <li>Identity and autonomy claims are not verified and confer no rights or authority.</li>
        <li>{PROHIBITED}</li>
        <li>Do not send credentials, identity documents or private third-party data.</li>
        <li>We may decline, close or block any conversation, and pause new inquiries at any time.</li>
        <li>The service is provided as is during the pilot, without warranties of availability or fitness.</li>
      </ol>
    </Layout>
  );
}

export function NotFoundPage({ config, path }: { config: Config; path: string }) {
  return (
    <Layout config={config} path={path} title="Not found | MyHumanRep" description="Page not found.">
      <h1>Not found</h1>
      <p>
        That page does not exist. Start at <a href="/for-agents">/for-agents</a> or{' '}
        <a href="/developers">/developers</a>.
      </p>
    </Layout>
  );
}
