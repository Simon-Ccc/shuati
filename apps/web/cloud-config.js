/* Shiroha Quiz 云同步配置（登录 / 跨设备同步 / 同学进度）。
   anon key 是公开的（前端没有秘密可言），真正的安全边界是 Supabase 的 RLS 行级权限。
   切勿把 service_role key 填在这里！*/
window.SHIROHA_CLOUD_CONFIG={
  url:'https://niboqbxcanynpfuppvgy.supabase.co',
  anonKey:'sb_publishable_542LzIv6xvmITFSeAp56sw_yA1Ixjso',
  snapshotDebounceMs:2500,
  progressFlushMs:5000,
  progressFlushSize:20
};
