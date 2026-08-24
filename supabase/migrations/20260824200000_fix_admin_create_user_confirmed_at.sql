-- ============================================================
-- 修复：admin_create_user 报 "cannot insert a non-DEFAULT value
--       into column confirmed_at"
-- 原因：auth.users.confirmed_at 是 GENERATED ALWAYS 生成列
--       （由 email_confirmed_at 派生），不能手动插入。
-- 修复：INSERT 列中移除 confirmed_at，其余保持补齐状态。
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
    email_confirmed_at, invited_at,
    confirmation_token, recovery_token,
    email_change_token_new, email_change,
    email_change_token_current, email_change_confirm_status,
    phone, phone_change_token, reauthentication_token,
    raw_app_meta_data, raw_user_meta_data,
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
    false, false,
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
