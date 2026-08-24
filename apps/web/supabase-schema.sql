-- ============================================================
-- Shiroha Quiz 云同步 schema v1
-- 在 Supabase Dashboard → SQL Editor 新建查询，整体粘贴执行（幂等，可重复运行）
-- 注意：所有 RLS policy 集中放在表创建之后，避免引用尚未创建的表
-- ============================================================

-- 1) 管理员表（全局管理员，单独指定；用 make-admin.sql 按邮箱添加）
create table if not exists public.admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;

-- 2) 用户资料表
create table if not exists public.profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.profiles enable row level security;

-- 3) 班级表
create table if not exists public.class_groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  invite_code text not null unique,
  created_by  uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);
alter table public.class_groups enable row level security;

-- 4) 班级成员表（联合主键）
create table if not exists public.class_members (
  group_id  uuid not null references public.class_groups(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index if not exists idx_class_members_user on public.class_members (user_id);
alter table public.class_members enable row level security;

-- 5) 快照同步表（每用户一行，jsonb 全量快照）
create table if not exists public.user_state (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  snapshot          jsonb not null default '{}'::jsonb,
  client_updated_at bigint not null default 0,   -- 客户端 Date.now() 毫秒，跨时钟比较主键
  updated_at        timestamptz not null default now()
);
alter table public.user_state enable row level security;

-- 6) 逐题统计表（联合主键 = user_id + bank_id + question_id；只存最近一次作答结果）
create table if not exists public.progress_stats (
  user_id     uuid not null references auth.users(id) on delete cascade,
  bank_id     text not null,
  question_id text not null,
  correct     boolean not null,
  answered_at timestamptz not null default now(),
  primary key (user_id, bank_id, question_id)
);
create index if not exists idx_progress_stats_bank on public.progress_stats (bank_id, answered_at desc);
alter table public.progress_stats enable row level security;

-- ============ RLS 策略（统一在表创建后定义） ============

-- admins：本人可查（前端判断 isAdmin）
create policy "admins_select_self" on public.admins
  for select using (auth.uid() = user_id);

-- profiles：本人写；本人/同班成员/管理员可读
create policy "profiles_insert_self" on public.profiles
  for insert with check (auth.uid() = user_id);
create policy "profiles_update_self" on public.profiles
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "profiles_select_self_or_group" on public.profiles
  for select using (
    auth.uid() = user_id or exists (
      select 1 from public.class_members me
      join public.class_members other on me.group_id = other.group_id
      where me.user_id = auth.uid() and other.user_id = public.profiles.user_id
    ) or exists (select 1 from public.admins where user_id = auth.uid())
  );

-- class_groups：仅本班成员与管理员可查（加入班级走 RPC join_class_group，security definer 绕开 RLS，无需公开 select）
create policy "class_groups_select_member_or_admin" on public.class_groups
  for select using (
    exists (select 1 from public.class_members where group_id = class_groups.id and user_id = auth.uid())
    or exists (select 1 from public.admins where user_id = auth.uid())
  );
create policy "class_groups_insert" on public.class_groups
  for insert with check (auth.uid() = created_by);
create policy "class_groups_update_admin" on public.class_groups
  for update using (exists (select 1 from public.admins where user_id = auth.uid()))
  with check (exists (select 1 from public.admins where user_id = auth.uid()));
create policy "class_groups_delete_admin" on public.class_groups
  for delete using (exists (select 1 from public.admins where user_id = auth.uid()));

-- class_members：本人/同班/管理员可读；本人退出；管理员踢人；成员经 RPC 或建班插入
create policy "class_members_select_self" on public.class_members
  for select using (user_id = auth.uid());
-- 同班成员判断用 security definer 函数（直接子查询本表会 infinite recursion）
create policy "class_members_select_group" on public.class_members
  for select using (public.is_group_member(class_members.group_id));
create policy "class_members_select_admin" on public.class_members
  for select using (exists (select 1 from public.admins where user_id = auth.uid()));
-- 插入：已是成员 或 是该班级创建者（创建班级时自动加入）
create policy "class_members_insert_group" on public.class_members
  for insert with check (
    public.is_group_member(class_members.group_id)
    or exists (
      select 1 from public.class_groups g
      where g.id = class_members.group_id and g.created_by = auth.uid()
    )
  );
create policy "class_members_delete_self" on public.class_members
  for delete using (user_id = auth.uid());
create policy "class_members_delete_admin" on public.class_members
  for delete using (exists (select 1 from public.admins where user_id = auth.uid()));

-- user_state：仅本人
create policy "user_state_all_self" on public.user_state
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- progress_stats：本人写；同班成员（互看排行榜）与管理员（错题详情/全局查看）可读
create policy "progress_stats_all_self" on public.progress_stats
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "progress_stats_select_group" on public.progress_stats
  for select using (
    exists (select 1 from public.class_members me
            join public.class_members other on me.group_id = other.group_id
            where me.user_id = auth.uid() and other.user_id = public.progress_stats.user_id)
    or exists (select 1 from public.admins where user_id = auth.uid())
  );

-- ============ 触发器与函数 ============

-- 新用户自动建 profiles 行（display_name 取注册时填的昵称，缺省给"同学+id前4位"）
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (user_id, display_name)
  values (new.id,
          coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), '同学' || substr(new.id::text, 1, 4)))
  on conflict (user_id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 判断是否为某班级成员（security definer 绕开 RLS 自引用，供 class_members 策略使用）
create or replace function public.is_group_member(p_group_id uuid)
returns boolean language sql security definer set search_path = public
as $$
  select exists (
    select 1 from public.class_members
    where group_id = p_group_id and user_id = auth.uid()
  );
$$;
grant execute on function public.is_group_member(uuid) to authenticated;

-- 按邀请码加入班级的 RPC（security definer，绕开 RLS 校验邀请码，防全表枚举）
-- 注意：输出参数用 gid/gname，避免与表列名 group_id/name 冲突（ambiguous）
create or replace function public.join_class_group(p_code text)
returns table (gid uuid, gname text)
language plpgsql security definer set search_path = public
as $$
declare g public.class_groups%rowtype;
begin
  select * into g from public.class_groups where invite_code = trim(p_code);
  if not found then
    raise exception '邀请码不存在或已失效';
  end if;
  insert into public.class_members (group_id, user_id) values (g.id, auth.uid())
  on conflict (group_id, user_id) do nothing;
  return query select g.id, g.name;
end;
$$;
grant execute on function public.join_class_group(text) to authenticated;

-- 生成邀请码的 RPC（security definer 生成随机码）
create or replace function public.gen_invite_code(len int default 8)
returns text language sql
as $$
  select upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, greatest(4, len)));
$$;
grant execute on function public.gen_invite_code(int) to authenticated;

-- 可选加固：anon（未登录）一律不可读写业务表（RLS 已挡，这里双保险）
revoke all on public.profiles, public.class_groups, public.class_members,
          public.user_state, public.progress_stats, public.admins from anon;

-- ============ 关闭公开注册：管理员创建账号（姓名 + 密码） ============
-- 登录用「姓名 + 密码」；email 由姓名派生，不对外展示。
-- security definer + 函数内管理员校验；前端仅用 anon key 调 RPC。

-- 管理员创建账号
create or replace function public.admin_create_user(
  p_name text,
  p_password text
) returns table (created boolean, display_name text, message text)
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid;
  v_name text := trim(p_name);
  v_email text;
begin
  if not exists (select 1 from public.admins where user_id = auth.uid()) then
    raise exception '仅管理员可创建账号';
  end if;
  if v_name = '' or v_name is null then
    raise exception '请输入姓名';
  end if;
  if p_password is null or length(p_password) < 6 then
    raise exception '密码至少 6 位';
  end if;
  if exists (select 1 from auth.users where raw_user_meta_data->>'display_name' = v_name) then
    return query select false, v_name, '该姓名已存在，请加序号区分（如 ' || v_name || '2）';
    return;
  end if;
  v_email := 'u' || substr(md5(v_name), 1, 20) || '@class.shiroha';
  -- 注意：必须补齐 GoTrue 必填列（空字符串/0/false），否则登录时
  -- GoTrue Scan 到 NULL 会报 500 "Database error querying schema"
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, invited_at,
    confirmation_token, recovery_token,
    email_change_token_new, email_change,
    email_change_token_current, email_change_confirm_status,
    phone, phone_change_token, reauthentication_token,
    raw_app_meta_data, raw_user_meta_data,
    confirmed_at,
    is_anonymous, is_sso_user,
    created_at, updated_at
  ) values (
    '00000000-0000-0000-0000-000000000000',
    gen_random_uuid(),
    'authenticated', 'authenticated', v_email,
    extensions.crypt(p_password, extensions.gen_salt('bf')),
    now(), null,
    '', '',
    '', '',
    '', 0,
    '', '', '',
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('display_name', v_name, 'provider', 'email'),
    now(),
    false, false,
    now(), now()
  ) returning id into v_uid;
  insert into public.profiles (user_id, display_name)
  values (v_uid, v_name)
  on conflict (user_id) do nothing;
  return query select true, v_name, 'ok';
end;
$$;
grant execute on function public.admin_create_user(text, text) to authenticated;

-- 按姓名反查登录邮箱
create or replace function public.get_user_email_by_name(p_name text)
returns table (email text)
language sql security definer set search_path = public
as $$
  select u.email
  from auth.users u
  where u.raw_user_meta_data->>'display_name' = trim(p_name)
    and u.deleted_at is null
  limit 1;
$$;
grant execute on function public.get_user_email_by_name(text) to authenticated;
