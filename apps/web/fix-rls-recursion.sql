-- ============================================================
-- 修复 class_members 策略无限递归（infinite recursion detected）
-- 原因：策略子查询自引用本表。改用 security definer 函数绕开 RLS 自引用。
-- ============================================================

-- 判断指定用户是否为某班级成员（security definer 绕开 RLS，避免递归）
create or replace function public.is_group_member(p_group_id uuid)
returns boolean language sql security definer set search_path = public
as $$
  select exists (
    select 1 from public.class_members
    where group_id = p_group_id and user_id = auth.uid()
  );
$$;
grant execute on function public.is_group_member(uuid) to authenticated;

-- 重建 class_members 的自引用策略
drop policy if exists "class_members_select_group" on public.class_members;
create policy "class_members_select_group" on public.class_members
  for select using (public.is_group_member(class_members.group_id));

drop policy if exists "class_members_insert_group" on public.class_members;
create policy "class_members_insert_group" on public.class_members
  for insert with check (public.is_group_member(class_members.group_id));
