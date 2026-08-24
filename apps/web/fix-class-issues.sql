-- ============================================================
-- 修复两个班级功能问题：
-- 1) join_class_group 报 "column reference group_id is ambiguous"
--    —— returns table 输出参数名与表列名冲突，输出参数改名
-- 2) 创建班级报错（新行违反 RLS）
--    —— class_members 的插入策略要求"已是本班成员"，创建者还不是成员；
--       允许班级创建者插入自己
-- ============================================================

-- 1) 重建 join_class_group：输出参数改名避免与列名歧义
--    （返回类型变更不能 CREATE OR REPLACE，先 DROP）
drop function if exists public.join_class_group(text);
create function public.join_class_group(p_code text)
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

-- 2) 重建 class_members 插入策略：已是成员 或 是该班级创建者（创建班级时自动加入）
drop policy if exists "class_members_insert_group" on public.class_members;
create policy "class_members_insert_group" on public.class_members
  for insert with check (
    public.is_group_member(class_members.group_id)
    or exists (
      select 1 from public.class_groups g
      where g.id = class_members.group_id and g.created_by = auth.uid()
    )
  );
