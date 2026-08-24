-- ============================================================
-- Shiroha Quiz 公告功能 schema v1
-- 管理员发布公告，登录用户可读；首页横幅滚动显示，用户可关闭
-- ============================================================

create table if not exists public.announcements (
  id         uuid primary key default gen_random_uuid(),
  title      text not null default '',
  content    text not null,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  active     boolean not null default true
);
create index if not exists idx_announcements_active_created on public.announcements (active, created_at desc);
alter table public.announcements enable row level security;

-- 公告公开可读（横幅给登录用户展示）
create policy "announcements_select_all" on public.announcements
  for select using (true);
-- 管理员可发布/修改/删除
create policy "announcements_insert_admin" on public.announcements
  for insert with check (exists (select 1 from public.admins where user_id = auth.uid()));
create policy "announcements_update_admin" on public.announcements
  for update using (exists (select 1 from public.admins where user_id = auth.uid()))
  with check (exists (select 1 from public.admins where user_id = auth.uid()));
create policy "announcements_delete_admin" on public.announcements
  for delete using (exists (select 1 from public.admins where user_id = auth.uid()));
