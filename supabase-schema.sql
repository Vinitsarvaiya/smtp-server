create extension if not exists pgcrypto;

create table if not exists public.inboxes (
  id uuid primary key default gen_random_uuid(),
  address text unique not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  inbox_address text not null references public.inboxes(address) on delete cascade,
  sender text,
  recipient text not null,
  subject text,
  text_body text,
  html_body text,
  message_id text unique,
  content_type text,
  attachments jsonb not null default '[]'::jsonb,
  raw_payload jsonb,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.messages
  add column if not exists content_type text;

alter table public.messages
  add column if not exists attachments jsonb not null default '[]'::jsonb;

alter table public.messages
  add column if not exists raw_payload jsonb;

create index if not exists messages_inbox_address_idx on public.messages (inbox_address);
create index if not exists messages_received_at_idx on public.messages (received_at desc);
create index if not exists inboxes_expires_at_idx on public.inboxes (expires_at);
