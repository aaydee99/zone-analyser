-- Undoes 0014_rate_limits.sql (each instance counts rate limits in its own memory again, and the
-- worker remembers relayed calls in its own memory).
drop function if exists public.relay_call_use(text, timestamptz);
drop function if exists public.rate_limit_peek(text);
drop function if exists public.rate_limit_hit(text, integer, integer);
drop table if exists public.relay_calls_used;
drop table if exists public.rate_limits;
