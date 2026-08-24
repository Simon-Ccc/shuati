-- ============================================================
-- 关闭公开注册后：账号只能由管理员创建（姓名 + 密码）
-- 登录用「姓名 + 密码」，排行榜直接显示姓名
--
-- 安全模型：
--  - security definer：函数以 postgres 身份执行，可写 auth.users
--  - 函数内部校验调用者必须是 public.admins 表成员，非管理员直接报错
--  - 前端仅用 anon key 调 RPC，service_role key 不落前端
--  - 姓名唯一：重名时拒绝创建，老师加序号区分（如 张三2）
--  - email 由姓名派生（md5），不可猜、不对外展示；学生登录时按姓名反查
--  - 创建即确认（email_confirmed_at=now()），学生拿到账号直接登录
--  - 插入 auth.users 会触发 on_auth_user_created → 自动建 profiles 行
-- ============================================================

-- 1) 管理员创建账号（姓名 + 密码）
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
  -- 仅管理员可调用
  if not exists (select 1 from public.admins where user_id = auth.uid()) then
    raise exception '仅管理员可创建账号';
  end if;
  if v_name = '' or v_name is null then
    raise exception '请输入姓名';
  end if;
  if p_password is null or length(p_password) < 6 then
    raise exception '密码至少 6 位';
  end if;
  -- 姓名唯一
  if exists (select 1 from auth.users where raw_user_meta_data->>'display_name' = v_name) then
    return query select false, v_name, '该姓名已存在，请加序号区分（如 ' || v_name || '2）';
    return;
  end if;

  v_email := 'u' || substr(md5(v_name), 1, 20) || '@class.shiroha';

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_user_meta_data, created_at, updated_at
  ) values (
    '00000000-0000-0000-0000-000000000000',
    gen_random_uuid(),
    'authenticated', 'authenticated', v_email,
    crypt(p_password, gen_salt('bf')),
    now(),
    jsonb_build_object('display_name', v_name, 'provider', 'email'),
    now(), now()
  ) returning id into v_uid;

  -- 触发器 on_auth_user_created 会自动建 profiles；这里兜底
  insert into public.profiles (user_id, display_name)
  values (v_uid, v_name)
  on conflict (user_id) do nothing;

  return query select true, v_name, 'ok';
end;
$$;
grant execute on function public.admin_create_user(text, text) to authenticated;

-- 2) 按姓名反查登录邮箱（登录时：姓名+密码 → 查到 email → 密码登录）
--    仅返回精确匹配姓名的 email；找不到返回空行
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
