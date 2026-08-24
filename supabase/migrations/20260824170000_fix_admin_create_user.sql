-- ============================================================
-- 修复：admin_create_user 报 "function gen_salt(unknown) does not exist"
-- 原因：pgcrypto 的 gen_salt/crypt 装在 extensions schema，
--       而函数 set search_path = public 找不到它们。
-- 修复：改为 schema 限定调用 extensions.gen_salt / extensions.crypt
-- ============================================================

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
    '00000000-0000-0000-0000-0000-000000000000',
    gen_random_uuid(),
    'authenticated', 'authenticated', v_email,
    extensions.crypt(p_password, extensions.gen_salt('bf')),
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
