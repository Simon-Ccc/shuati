-- ============================================================
-- 指定全局管理员（教师账号注册完成后执行）
-- 把下面单引号里的邮箱改成教师注册用的邮箱，然后整体粘贴到
-- Supabase Dashboard → SQL Editor 执行。
-- 移除管理员：DELETE FROM public.admins WHERE user_id IN (SELECT id FROM auth.users WHERE email='教师邮箱');
-- ============================================================

insert into public.admins (user_id)
select id from auth.users where email = '你的教师邮箱@example.com'
on conflict (user_id) do nothing;

-- 验证（应返回 1 行，显示管理员邮箱）
select u.email from public.admins a join auth.users u on u.id = a.user_id;
