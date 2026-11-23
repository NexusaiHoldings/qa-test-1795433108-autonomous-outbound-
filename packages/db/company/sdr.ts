export const SDR_DDL = `
CREATE TABLE IF NOT EXISTS sdr_campaigns (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  vertical TEXT,
  offer TEXT,
  created_by_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
  country_code TEXT,
  region TEXT,
  source TEXT NOT NULL DEFAULT 'apollo',
  source_external_id TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  last_contacted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sdr_prospects_org_idx ON sdr_prospects(organization_id);
CREATE INDEX IF NOT EXISTS sdr_prospects_org_email_idx ON sdr_prospects(organization_id, email);
CREATE INDEX IF NOT EXISTS sdr_prospects_org_status_idx ON sdr_prospects(organization_id, status);

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

CREATE INDEX IF NOT EXISTS sdr_messages_org_idx ON sdr_messages(organization_id);
CREATE INDEX IF NOT EXISTS sdr_messages_org_provider_msg_idx ON sdr_messages(organization_id, provider_message_id);

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
`;
