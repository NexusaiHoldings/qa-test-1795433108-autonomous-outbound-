export const SDR_DDL = `
CREATE TABLE IF NOT EXISTS sdr_campaigns (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  vertical TEXT,
  offer TEXT,
  daily_target INTEGER NOT NULL DEFAULT 25,
  apollo_filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_sourced_at TIMESTAMPTZ,
  created_by_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backfill columns on deployments provisioned before F1-004.
ALTER TABLE sdr_campaigns ADD COLUMN IF NOT EXISTS daily_target INTEGER NOT NULL DEFAULT 25;
ALTER TABLE sdr_campaigns ADD COLUMN IF NOT EXISTS apollo_filters JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE sdr_campaigns ADD COLUMN IF NOT EXISTS last_sourced_at TIMESTAMPTZ;

-- F1-005: the campaign value proposition the grounded generator weaves into
-- every sequence (the CEO briefing's "GPT-powered 3-email generator" needs an
-- explicit offer to ground against, separate from the Apollo targeting filters).
ALTER TABLE sdr_campaigns ADD COLUMN IF NOT EXISTS value_prop TEXT;

CREATE TABLE IF NOT EXISTS sdr_prospects (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL,
  campaign_id UUID REFERENCES sdr_campaigns(id) ON DELETE SET NULL,
  first_name TEXT,
  last_name TEXT,
  full_name TEXT,
  email TEXT NOT NULL,
  company_name TEXT,
  title TEXT,
  company_domain TEXT,
  country_code TEXT,
  region TEXT,
  fit_score INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'apollo',
  source_external_id TEXT,
  status TEXT NOT NULL DEFAULT 'sourced',
  last_contacted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backfill columns on deployments provisioned before F1-004.
ALTER TABLE sdr_prospects ADD COLUMN IF NOT EXISTS company_domain TEXT;
ALTER TABLE sdr_prospects ADD COLUMN IF NOT EXISTS fit_score INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS sdr_prospects_org_idx ON sdr_prospects(organization_id);
CREATE INDEX IF NOT EXISTS sdr_prospects_org_email_idx ON sdr_prospects(organization_id, email);
CREATE INDEX IF NOT EXISTS sdr_prospects_org_status_idx ON sdr_prospects(organization_id, status);
CREATE INDEX IF NOT EXISTS sdr_prospects_org_campaign_idx ON sdr_prospects(organization_id, campaign_id);
CREATE INDEX IF NOT EXISTS sdr_prospects_org_email_lower_idx ON sdr_prospects(organization_id, lower(email));

CREATE TABLE IF NOT EXISTS sdr_prospect_signals (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL,
  prospect_id UUID NOT NULL REFERENCES sdr_prospects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  headline TEXT NOT NULL,
  source_url TEXT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  weight INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sdr_prospect_signals_org_idx ON sdr_prospect_signals(organization_id);
CREATE INDEX IF NOT EXISTS sdr_prospect_signals_prospect_idx ON sdr_prospect_signals(prospect_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS sdr_prospect_signals_type_idx ON sdr_prospect_signals(organization_id, type);
CREATE UNIQUE INDEX IF NOT EXISTS sdr_prospect_signals_dedupe_uniq
  ON sdr_prospect_signals(prospect_id, type, headline);

CREATE TABLE IF NOT EXISTS sdr_messages (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL,
  campaign_id UUID REFERENCES sdr_campaigns(id) ON DELETE SET NULL,
  prospect_id UUID REFERENCES sdr_prospects(id) ON DELETE SET NULL,
  provider TEXT NOT NULL DEFAULT 'gmail',
  provider_message_id TEXT,
  direction TEXT NOT NULL,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- F1-005: sdr_messages is extended into a sequence touch. A message now belongs
-- to an sdr_sequences row, carries a touch_index (0-based position in the 3-touch
-- cadence), a workflow status enum (draft | approved | queued | sent | bounced |
-- cancelled), and signal_citations (JSON array mapping each personalized sentence
-- to the sdr_prospect_signals.id that grounds it — the grounding-check gate).
ALTER TABLE sdr_messages ADD COLUMN IF NOT EXISTS sequence_id UUID;
ALTER TABLE sdr_messages ADD COLUMN IF NOT EXISTS touch_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sdr_messages ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE sdr_messages ADD COLUMN IF NOT EXISTS signal_citations JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE sdr_messages ADD COLUMN IF NOT EXISTS next_send_at TIMESTAMPTZ;
ALTER TABLE sdr_messages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS sdr_messages_org_idx ON sdr_messages(organization_id);
CREATE INDEX IF NOT EXISTS sdr_messages_org_provider_msg_idx ON sdr_messages(organization_id, provider_message_id);
CREATE INDEX IF NOT EXISTS sdr_messages_sequence_idx ON sdr_messages(sequence_id, touch_index);
CREATE INDEX IF NOT EXISTS sdr_messages_org_status_idx ON sdr_messages(organization_id, status);

-- F1-005: a prospect's 3-touch outbound sequence. One row per prospect+campaign;
-- segment_key = vertical + title-band, the unit the founder approves once so that
-- subsequent sequences in the same segment send autonomously.
CREATE TABLE IF NOT EXISTS sdr_sequences (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL,
  prospect_id UUID NOT NULL REFERENCES sdr_prospects(id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES sdr_campaigns(id) ON DELETE SET NULL,
  segment_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_approval',
  touch_count INTEGER NOT NULL DEFAULT 0,
  next_send_at TIMESTAMPTZ,
  autonomous BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sdr_sequences_org_idx ON sdr_sequences(organization_id);
CREATE INDEX IF NOT EXISTS sdr_sequences_org_status_idx ON sdr_sequences(organization_id, status);
CREATE INDEX IF NOT EXISTS sdr_sequences_org_segment_idx ON sdr_sequences(organization_id, segment_key);
CREATE INDEX IF NOT EXISTS sdr_sequences_campaign_idx ON sdr_sequences(campaign_id);
CREATE UNIQUE INDEX IF NOT EXISTS sdr_sequences_prospect_uniq ON sdr_sequences(prospect_id);

-- F1-005: the founder's first-send approval of a segment. Writing a row here flips
-- the segment autonomous — future sourced prospects in this (campaign, segment_key)
-- are queued without review. sample_message_ids records the batch that was reviewed.
CREATE TABLE IF NOT EXISTS sdr_segment_approvals (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL,
  campaign_id UUID REFERENCES sdr_campaigns(id) ON DELETE CASCADE,
  segment_key TEXT NOT NULL,
  approved_by UUID,
  approved_by_email TEXT,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sample_message_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sdr_segment_approvals_org_idx ON sdr_segment_approvals(organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS sdr_segment_approvals_uniq
  ON sdr_segment_approvals(organization_id, campaign_id, segment_key);

CREATE TABLE IF NOT EXISTS sdr_suppressions (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL,
  email TEXT,
  domain TEXT,
  reason TEXT NOT NULL,
  source_message_id UUID REFERENCES sdr_messages(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sdr_suppressions_org_idx ON sdr_suppressions(organization_id);
CREATE INDEX IF NOT EXISTS sdr_suppressions_org_email_idx ON sdr_suppressions(organization_id, email);
CREATE INDEX IF NOT EXISTS sdr_suppressions_org_domain_idx ON sdr_suppressions(organization_id, domain);
CREATE INDEX IF NOT EXISTS sdr_suppressions_org_reason_idx ON sdr_suppressions(organization_id, reason);

CREATE TABLE IF NOT EXISTS sdr_unsubscribe_events (
  id UUID PRIMARY KEY,
  token_hash TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  event_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sdr_unsubscribe_events_token_hash_idx ON sdr_unsubscribe_events(token_hash);
CREATE INDEX IF NOT EXISTS sdr_unsubscribe_events_ts_idx ON sdr_unsubscribe_events(event_timestamp);

-- F1-006: threading refs so touches 2-3 reply inside touch 1's conversation.
-- thread_ref holds the Gmail threadId / Graph conversationId; rfc822_message_id
-- holds the RFC822 Message-ID used for In-Reply-To / References. sent_mailbox_id
-- records which mailbox actually sent the touch.
ALTER TABLE sdr_messages ADD COLUMN IF NOT EXISTS thread_ref TEXT;
ALTER TABLE sdr_messages ADD COLUMN IF NOT EXISTS rfc822_message_id TEXT;
ALTER TABLE sdr_messages ADD COLUMN IF NOT EXISTS sent_mailbox_id UUID;
ALTER TABLE sdr_messages ADD COLUMN IF NOT EXISTS last_error TEXT;

-- F1-006: Founder Mailbox Sender + Send Guardrails.
-- The 'send' verb executes from the founder's OWN Gmail/Outlook so the customer
-- (not Nexus) is the CAN-SPAM sender and replies land in the inbox the founder
-- already lives in. One row per connected sending mailbox, tenant-scoped by
-- organization_id. OAuth connection is nominally via @nexus/profile-and-account
-- connected accounts (connected_account_ref), but the extended Gmail/Graph send
-- scopes are a lego gap (flagged in blockers) so the access/refresh tokens are
-- held here until the lego closes that gap.
CREATE TABLE IF NOT EXISTS sdr_mailboxes (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL,
  provider TEXT NOT NULL DEFAULT 'gmail',
  email TEXT NOT NULL,
  domain TEXT,
  connected_account_ref UUID,
  display_name TEXT,
  physical_address TEXT,
  status TEXT NOT NULL DEFAULT 'connected',
  warmup_stage INTEGER NOT NULL DEFAULT 0,
  daily_cap INTEGER NOT NULL DEFAULT 20,
  sent_today INTEGER NOT NULL DEFAULT 0,
  sent_today_date DATE,
  warmup_started_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  pause_reason TEXT,
  spf_ok BOOLEAN NOT NULL DEFAULT FALSE,
  dkim_ok BOOLEAN NOT NULL DEFAULT FALSE,
  dmarc_ok BOOLEAN NOT NULL DEFAULT FALSE,
  dns_detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  dns_checked_at TIMESTAMPTZ,
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sdr_mailboxes_org_idx ON sdr_mailboxes(organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS sdr_mailboxes_org_email_uniq
  ON sdr_mailboxes(organization_id, lower(email));
CREATE INDEX IF NOT EXISTS sdr_mailboxes_status_idx ON sdr_mailboxes(organization_id, status);

-- F1-006: the deliverability ledger for every send attempt. event is an enum of
-- queued | sent | bounced_soft | bounced_hard | complaint | opened_unreliable;
-- provider_payload captures the raw provider response / bounce DSN / feedback
-- loop body for audit. Rows drive the warmup ramp, the pause-on-complaint guard,
-- and the /mailbox sending-health gauge.
CREATE TABLE IF NOT EXISTS sdr_send_events (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL,
  message_id UUID,
  mailbox_id UUID NOT NULL,
  event TEXT NOT NULL,
  provider_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sdr_send_events_org_idx ON sdr_send_events(organization_id);
CREATE INDEX IF NOT EXISTS sdr_send_events_mailbox_idx ON sdr_send_events(mailbox_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS sdr_send_events_message_idx ON sdr_send_events(message_id);
CREATE INDEX IF NOT EXISTS sdr_send_events_event_idx ON sdr_send_events(organization_id, event);

-- F1-007: Reply Classifier + Conversation Engine.
-- The ingest cron polls each connected mailbox's Gmail history every 5 minutes.
-- These columns persist the poll cursor (Gmail historyId) + last-polled stamp so
-- subsequent polls only process new inbound mail. ALTER ... IF NOT EXISTS keeps
-- the F1-006 sdr_mailboxes table forwa

CREATE TABLE IF NOT EXISTS sdr_review_queue (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL,
  message_id UUID NOT NULL REFERENCES sdr_messages(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  classifier_guess TEXT,
  classifier_confidence DOUBLE PRECISION,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sdr_review_queue_org_status_idx
  ON sdr_review_queue(organization_id, status, created_at ASC);
CREATE INDEX IF NOT EXISTS sdr_review_queue_message_idx
  ON sdr_review_queue(message_id);

CREATE TABLE IF NOT EXISTS sdr_review_decisions (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL,
  review_id UUID NOT NULL REFERENCES sdr_review_queue(id) ON DELETE CASCADE,
  operator_id UUID NOT NULL,
  corrected_classification TEXT NOT NULL,
  action TEXT NOT NULL,
  notes TEXT,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sdr_review_decisions_org_idx
  ON sdr_review_decisions(organization_id, decided_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS sdr_review_decisions_review_uniq
  ON sdr_review_decisions(review_id);
`;
