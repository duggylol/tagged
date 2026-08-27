-- ===========================================================================
-- Harden the SECURITY DEFINER functions
--
-- Both RPCs took a `p_user_id` parameter and trusted it. They are reachable
-- over PostgREST as /rest/v1/rpc/..., which meant anyone could pass someone
-- else's UUID and read their AI spend — or, worse, claim their queued
-- extension commands out from under them and have their own browser execute
-- another seller's listings.
--
-- Two changes close it:
--
--   1. Derive the user from the JWT when there is one. auth.uid() is null for
--      the service role, so the cron sweep still works by passing the
--      parameter explicitly.
--   2. Revoke `anon`. auth.uid() is *also* null for anonymous callers, so
--      without this the coalesce fallback would still honour a supplied UUID
--      from an unauthenticated request.
-- ===========================================================================

create or replace function ai_spend_this_month(p_user_id uuid)
returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(cost_usd), 0)
  from ai_usage
  where user_id = coalesce(auth.uid(), p_user_id)
    and created_at >= date_trunc('month', now());
$$;

create or replace function claim_extension_commands(
  p_user_id uuid,
  p_platforms platform_id[],
  p_limit integer default 5
)
returns setof extension_commands
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := coalesce(auth.uid(), p_user_id);
begin
  if v_user_id is null then
    raise exception 'No user context for claim_extension_commands';
  end if;

  return query
  with claimed as (
    select id from extension_commands
    where user_id = v_user_id
      and platform = any(p_platforms)
      and status = 'queued'
    order by created_at
    limit least(greatest(p_limit, 1), 25)
    for update skip locked
  )
  update extension_commands c
  set status = 'running', started_at = now(), attempts = c.attempts + 1
  from claimed
  where c.id = claimed.id
  returning c.*;
end;
$$;

-- Pin the trigger function's search_path so a caller cannot shadow `now()`.
create or replace function touch_updated_at() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Trigger functions have no business being callable over the REST API.
revoke execute on function handle_new_user() from public, anon, authenticated;
revoke execute on function touch_updated_at() from public, anon, authenticated;

revoke execute on function ai_spend_this_month(uuid) from public, anon;
revoke execute on function claim_extension_commands(uuid, platform_id[], integer) from public, anon;

grant execute on function ai_spend_this_month(uuid) to authenticated, service_role;
grant execute on function claim_extension_commands(uuid, platform_id[], integer) to authenticated, service_role;
