/* Shiroha Quiz 云同步模块：登录 / 跨设备同步 / 同学进度 / 管理员面板。
   依赖 window.supabase（libs/supabase.min.js）与 window.SHIROHA_CLOUD_CONFIG（cloud-config.js）。
   未配置 / 断网 / SDK 缺失时全部静默降级为纯本地模式，绝不阻断本地使用。 */
(function(){
  const CLOUD_META_KEY='shiroha_quiz_cloud_meta_v102';
  const CONFIG=(window.SHIROHA_CLOUD_CONFIG&&typeof window.SHIROHA_CLOUD_CONFIG==='object')?window.SHIROHA_CLOUD_CONFIG:{};
  const PLACEHOLDER=CONFIG.anonKey&&CONFIG.anonKey.includes('PLEASE_PASTE');
  const SNAPSHOT_DEBOUNCE=Number(CONFIG.snapshotDebounceMs||2500);
  const PROGRESS_FLUSH_MS=Number(CONFIG.progressFlushMs||5000);
  const PROGRESS_FLUSH_SIZE=Number(CONFIG.progressFlushSize||20);

  let bridge=null;                 // app.js 注册的桥（getSnapshot/getBankList/getBankById/applyRemoteSnapshot/toast）
  let client=null;                 // supabase 客户端（惰性创建）
  let currentUser=null;            // 当前用户（session.user）
  let isAdmin=false;               // 管理员标记（内存缓存，不进快照）
  let adminChecked=false;
  let loginMode='login';           // 'login' | 'register'
  let authUnsub=null;
  let snapshotTimer=null;          // 快照防抖
  let lastSyncAt=0;                // 上次成功同步时间（本模块自身 meta，不写进 app state 避免 saveSilent 递归）
  let lastRemoteUpdatedAt=0;
  let syncing=false;               // syncNow 重入保护
  let progressQueue=[];            // 逐题统计队列
  let progressTimer=null;
  let lastProgressFlushAt=0;

  const $=(id)=>document.getElementById(id);
  const escV102=(s)=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const cfgOkV102=()=>!PLACEHOLDER&&!!CONFIG.url&&!!CONFIG.anonKey;
  const cloudReadyV102=()=>!!window.supabase&&!!window.supabase.createClient&&cfgOkV102()&&navigator.onLine!==false;

  function readMetaV102(){
    try{
      const raw=localStorage.getItem(CLOUD_META_KEY);
      if(raw){const m=JSON.parse(raw);lastSyncAt=Number(m.lastSyncAt||0);lastRemoteUpdatedAt=Number(m.lastRemoteUpdatedAt||0);}
    }catch(_){}
  }
  function writeMetaV102(){try{localStorage.setItem(CLOUD_META_KEY,JSON.stringify({lastSyncAt,lastRemoteUpdatedAt}))}catch(_){}}

  function cloudClientV102(){
    if(client)return client;
    if(!cloudReadyV102())return null;
    try{
      client=window.supabase.createClient(CONFIG.url,CONFIG.anonKey,{
        auth:{persistSession:true,autoRefreshToken:true,storageKey:'shiroha_quiz_auth_v102'}
      });
      return client;
    }catch(e){warnDevV102('createClient failed',e);return null}
  }
  function warnDevV102(...a){try{if(window.warnDev)window.warnDev(...a)}catch(_){}}
  function cloudToastV102(msg,type){try{if(bridge&&bridge.toast)bridge.toast(msg,type||'warn')}catch(_){}}
  function cloudErrorTextV102(err){
    const s=String(err&&err.message||err||'');
    if(/Invalid login credentials/i.test(s))return'邮箱或密码不正确';
    if(/User already registered/i.test(s))return'该邮箱已注册，请直接登录';
    if(/Email not confirmed/i.test(s))return'请先到邮箱点击确认链接，再回来登录';
    if(/invite|邀请码/i.test(s))return'邀请码不存在或已失效';
    if(/network|fetch|Failed to fetch|TypeError/i.test(s))return'网络不可用，已保持本地模式';
    if(/already been used|重复/i.test(s))return'该名称已被使用';
    return s||'操作失败，请稍后重试';
  }
  function fmtCloudTimeV102(iso){
    if(!iso)return'—';
    const t=new Date(iso).getTime();if(!t)return'—';
    const diff=Date.now()-t;const min=Math.floor(diff/60000);
    if(min<1)return'刚刚';if(min<60)return min+' 分钟前';
    const h=Math.floor(min/60);if(h<24)return h+' 小时前';
    const d=Math.floor(h/24);if(d<7)return d+' 天前';
    const dt=new Date(t);return`${dt.getMonth()+1}-${dt.getDate()}`;
  }
  function uidV102(){return currentUser?currentUser.id:''}

  // ================= 桥接 =================
  function registerBridgeV102(b){
    bridge=b||null;
    if(bridge&&bridge.getSnapshot){
      try{
        const snap=JSON.parse(bridge.getSnapshot());
        const cs=snap&&snap.settings&&snap.settings.cloudSyncV102;
        if(cs){lastRemoteUpdatedAt=Number(cs.lastRemoteUpdatedAt||0);}
      }catch(_){}
    }
  }
  function snapshotSubsetV102(){
    const snap=JSON.parse(bridge.getSnapshot());
    return {
      schemaVersion:1,
      clientUpdatedAt:Date.now(),
      wrongBook:snap.wrongBook||{},
      favorites:snap.favorites||{},
      records:snap.records||[],
      practiceProgress:snap.settings&&snap.settings.practiceProgressV58916||{},
      crossPlatformMeta:snap.crossPlatformMeta||{}
    };
  }

  // ================= 登录 UI / 全站门禁 =================
  function bindCloudDomV102(){
    const btn=$('cloud-login-btn-v102');
    if(btn)btn.onclick=showCloudGateV103;
    const toggle=$('cloud-toggle-mode-v102');if(toggle)toggle.onclick=cloudToggleModeV102;
    const submit=$('cloud-submit-v102');if(submit)submit.onclick=cloudSubmitV102;
    const forgot=$('cloud-forgot-v102');if(forgot)forgot.onclick=cloudForgotV102;
    const lbSel=$('leaderboard-bank-select-v102');if(lbSel)lbSel.onchange=()=>{if(lbSel.value)renderLeaderboardV102()};
    const refresh=$('leaderboard-refresh-btn-v102');if(refresh)refresh.onclick=()=>renderLeaderboardV102();
    const adminClose=$('cloud-admin-close-v102');if(adminClose)adminClose.onclick=()=>$('cloud-admin-modal').classList.add('hidden');
    window.addEventListener('beforeunload',()=>{try{flushProgressV102(true)}catch(_){}});
  }
  // 全站门禁：未登录时显示全屏登录层，登录后隐藏
  function showCloudGateV103(){
    const gate=$('cloud-gate-v103');if(gate)gate.classList.remove('hidden');
    loginMode=currentUser?'login':'login';
    cloudToggleModeV102(true);
    const st=$('cloud-modal-status-v102');if(st)st.textContent='登录后：数据保存在云端，跨设备同步，同学互看排行榜。';
    const email=$('cloud-email-v102');if(email){email.value=currentUser?currentUser.email:'';email.focus()}
    setCloudGateStatusV103('');
  }
  function hideCloudGateV103(){
    const gate=$('cloud-gate-v103');if(gate)gate.classList.add('hidden');
    setCloudModalStatusV102('');
  }
  function setCloudGateStatusV103(msg,isErr){
    const el=$('cloud-gate-status-v103');if(!el)return;
    el.textContent=msg||'';
    el.className='muted cloud-gate-cloud-status-v103'+(isErr?' is-err':'');
  }
  function setCloudModalStatusV102(msg,type){
    const el=$('cloud-modal-status-v102');if(!el)return;
    el.textContent=msg||'';
    el.className='notice'+(type==='ok'?' ok':type==='danger'?'':' warn');
    if(msg==='')el.className='notice';
  }
  function cloudToggleModeV102(force){
    if(currentUser){loginMode='login';}
    else loginMode=(force===true||loginMode==='register')?'login':'register';
    const title=$('cloud-modal-title-v102');if(title)title.textContent=loginMode==='register'?'注册账号':'登录';
    const submit=$('cloud-submit-v102');if(submit)submit.textContent=loginMode==='register'?'注册':'登录';
    const toggle=$('cloud-toggle-mode-v102');if(toggle)toggle.textContent=loginMode==='register'?'切换到登录':'切换到注册';
    const nick=$('cloud-nickname-field-v102');if(nick)nick.classList.toggle('hidden',loginMode!=='register');
    const pass=$('cloud-password-v102');if(pass)pass.setAttribute('autocomplete',loginMode==='register'?'new-password':'current-password');
    const st=$('cloud-modal-status-v102');if(st&&!currentUser)st.textContent=loginMode==='register'?'注册后需要到邮箱点击确认链接。':'登录后：跨设备同步学习进度，同学互看排行榜。';
  }
  async function cloudSubmitV102(){
    const c=cloudClientV102();if(!c){setCloudModalStatusV102('云端不可用：请检查网络与配置。','warn');return}
    const email=($('cloud-email-v102')||{}).value||'';const password=($('cloud-password-v102')||{}).value||'';
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){setCloudModalStatusV102('请输入正确的邮箱地址。','warn');return}
    if(password.length<6){setCloudModalStatusV102('密码至少 6 位。','warn');return}
    const submit=$('cloud-submit-v102');if(submit){submit.disabled=true;submit.textContent='处理中…'}
    try{
      if(loginMode==='register'){
        const nickname=($('cloud-nickname-v102')||{}).value||'';
        const {error}=await c.auth.signUp({email,password,options:{data:{display_name:nickname}}});
        if(error)throw error;
        setCloudModalStatusV102('注册成功！确认邮件已发送到 '+escV102(email)+'，请先到邮箱点击确认链接，再回来登录。','ok');
        loginMode='login';cloudToggleModeV102(true);
      }else{
        const {data,error}=await c.auth.signInWithPassword({email,password});
        if(error)throw error;
        if(data&&data.session)currentUser=data.session.user;
        hideCloudGateV103();renderCloudAuthUiV102();
        if(currentUser)syncNowV102();
      }
    }catch(e){setCloudModalStatusV102(cloudErrorTextV102(e),'danger')}
    finally{if(submit){submit.disabled=false;submit.textContent=loginMode==='register'?'注册':'登录'}}
  }
  async function cloudForgotV102(){
    const c=cloudClientV102();if(!c)return;
    const email=($('cloud-email-v102')||{}).value||'';
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){setCloudModalStatusV102('请先输入邮箱。','warn');return}
    const {error}=await c.auth.resetPasswordForEmail(email);
    if(error){setCloudModalStatusV102(cloudErrorTextV102(error),'danger');return}
    setCloudModalStatusV102('重置密码邮件已发送，请查收。','ok');
  }
  async function cloudSignOutV102(){
    if(!confirm('退出登录？本地数据不会删除。'))return;
    const c=cloudClientV102();
    try{await flushProgressV102(false)}catch(_){}
    if(c){try{await c.auth.signOut()}catch(_){}}
    currentUser=null;isAdmin=false;adminChecked=false;
    renderCloudAuthUiV102();
    if(document.querySelector('#leaderboard.view.active'))renderLeaderboardV102();
  }
  function renderCloudAuthUiV102(){
    const btn=$('cloud-login-btn-v102');if(!btn)return;
    if(!cfgOkV102()){
      btn.hidden=true;
    }else if(!cloudReadyV102()){
      btn.hidden=false;btn.textContent='登录 / 同步';
    }else if(currentUser){
      btn.hidden=false;
      btn.textContent=(isAdmin?'★ ':'')+(currentUser.user_metadata&&currentUser.user_metadata.display_name?String(currentUser.user_metadata.display_name).slice(0,6):(currentUser.email||'').split('@')[0])+' · 退出';
      btn.onclick=cloudSignOutV102;
    }else{
      btn.hidden=false;btn.textContent='登录 / 同步';
      btn.onclick=showCloudGateV103;
    }
    renderCloudPillV102();
    renderSettingsCloudCardV102();
  }
  function renderCloudPillV102(){
    const pill=$('cloud-status-pill-v102');if(!pill)return;
    if(!cfgOkV102()){pill.textContent='未配置云端';pill.className='pill cloud-status-pill-v102';return}
    if(!cloudReadyV102()){pill.textContent='离线模式';pill.className='pill cloud-status-pill-v102 is-fail';return}
    if(!currentUser){pill.textContent='未登录';pill.className='pill cloud-status-pill-v102';return}
    pill.className='pill cloud-status-pill-v102'+(isAdmin?' is-admin':' is-synced');
    pill.textContent=(isAdmin?'管理员 · ':'')+(lastSyncAt?'已同步 '+fmtCloudTimeV102(new Date(lastSyncAt).toISOString()):'已登录');
  }
  function renderSettingsCloudCardV102(){
    const card=$('cloud-settings-card-v102');
    if(card){card.remove()}
    const holder=document.querySelector('#settings .card');if(!holder)return;
    const div=document.createElement('div');
    div.id='cloud-settings-card-v102';
    div.className='data-tool-card-v23 cloud-settings-card-v102';
    const status=!cfgOkV102()?'未配置云端（cloud-config.js）':!currentUser?'未登录':'已登录'+(isAdmin?' · 管理员':'');
    div.innerHTML=`<div class="section-head"><div><h3>云端账号</h3><p class="muted">${escV102(status)}。登录后可跨设备同步进度、查看同学排行榜。</p></div><div class="actions"><button id="cloud-settings-go-v102" class="primary" type="button">进入同学进度</button>${currentUser?'<button id="cloud-settings-out-v102" class="ghost" type="button">退出登录</button>':''}</div></div>`;
    holder.appendChild(div);
    const go=$('cloud-settings-go-v102');if(go)go.onclick=()=>{switchViewV102('leaderboard')};
    const out=$('cloud-settings-out-v102');if(out)out.onclick=cloudSignOutV102;
  }
  function switchViewV102(viewId){try{if(window.switchViewV45)window.switchViewV45(viewId)}catch(_){document.querySelector('.nav[data-view="leaderboard"]')&&document.querySelector('.nav[data-view="leaderboard"]').click()}}

  // ================= 快照同步 =================
  function onLocalStateSavedV102(){
    if(!currentUser||!cloudReadyV102())return;
    if(snapshotTimer)clearTimeout(snapshotTimer);
    snapshotTimer=setTimeout(()=>{snapshotTimer=null;pushSnapshotV102()},SNAPSHOT_DEBOUNCE);
  }
  async function pullSnapshotV102(){
    const c=cloudClientV102();if(!c||!currentUser)return null;
    const {data,error}=await c.from('user_state').select('snapshot,client_updated_at').eq('user_id',currentUser.id).maybeSingle();
    if(error)throw error;
    return data||null;
  }
  async function pushSnapshotV102(){
    if(!currentUser||!cloudReadyV102())return;
    const c=cloudClientV102();if(!c)return;
    if(syncing)return;
    try{
      if(!bridge||!bridge.getSnapshot)return;
      const subset=snapshotSubsetV102();
      const {error}=await c.from('user_state').upsert({user_id:currentUser.id,snapshot:subset,client_updated_at:subset.clientUpdatedAt},{onConflict:'user_id'});
      if(error)throw error;
      lastSyncAt=Date.now();writeMetaV102();renderCloudPillV102();
    }catch(e){warnDevV102('pushSnapshotV102 failed',e)}
  }
  async function syncNowV102(){
    if(!currentUser||!cloudReadyV102()||syncing)return;
    syncing=true;
    try{
      const c=cloudClientV102();if(!c){syncing=false;return}
      await refreshAdminFlagV102();
      const remote=await pullSnapshotV102();
      let needPush=true;
      if(remote&&remote.client_updated_at&&remote.client_updated_at>lastRemoteUpdatedAt){
        const merged=applyRemoteV102(remote.snapshot,remote.client_updated_at);
        needPush=!merged;
      }
      if(needPush)await pushSnapshotV102();
    }catch(e){warnDevV102('syncNowV102 failed',e)}
    finally{syncing=false;renderCloudAuthUiV102()}
  }
  // 远端快照合并：true=已应用；false=本地更新的无需应用
  function applyRemoteV102(snapshotRaw,clientUpdatedAt){
    let snap=null;
    try{snap=typeof snapshotRaw==='string'?JSON.parse(snapshotRaw):snapshotRaw}catch(e){return false}
    if(!snap||typeof snap!=='object')return false;
    const remoteTs=Number(clientUpdatedAt||snap.clientUpdatedAt||0);
    const localTs=lastSyncAt||0;
    if(remoteTs<=localTs&&lastRemoteUpdatedAt>0)return false;
    if(bridge&&bridge.applyRemoteSnapshot){
      bridge.applyRemoteSnapshot({...snap,clientUpdatedAt:remoteTs});
    }
    lastRemoteUpdatedAt=remoteTs;writeMetaV102();
    return true;
  }

  // ================= 逐题统计 =================
  function queueProgressV102(bid,qid,ok){
    if(!currentUser||!cloudReadyV102())return;
    progressQueue.push({user_id:currentUser.id,bank_id:String(bid||''),question_id:String(qid||''),correct:!!ok,answered_at:new Date().toISOString()});
    if(progressQueue.length>=PROGRESS_FLUSH_SIZE)flushProgressV102(false);
    else if(!progressTimer){
      progressTimer=setTimeout(()=>{progressTimer=null;flushProgressV102(false)},PROGRESS_FLUSH_MS);
    }
  }
  async function flushProgressV102(force){
    if(progressTimer){clearTimeout(progressTimer);progressTimer=null}
    if(!progressQueue.length)return;
    if(!currentUser||!cloudReadyV102())return;
    const c=cloudClientV102();if(!c)return;
    const rows=progressQueue.slice();
    progressQueue=[];
    try{
      const {error}=await c.from('progress_stats').upsert(rows,{onConflict:'user_id,bank_id,question_id'});
      if(error)throw error;
      lastProgressFlushAt=Date.now();
    }catch(e){
      // 失败：若强制（退出/交卷）则丢弃，否则保留稍后重试一次
      warnDevV102('flushProgressV102 failed',e);
      if(!force&&progressQueue.length+rows.length<=PROGRESS_FLUSH_SIZE*2){
        progressQueue=rows.concat(progressQueue);
        if(!progressTimer)progressTimer=setTimeout(()=>{progressTimer=null;flushProgressV102(false)},PROGRESS_FLUSH_MS);
      }else{
        cloudToastV102('部分进度未能同步，稍后会自动重试。','warn');
      }
    }
  }
  function flushOnExitV102(){flushProgressV102(true)}

  // ================= 管理员 =================
  async function refreshAdminFlagV102(){
    isAdmin=false;adminChecked=false;
    if(!currentUser||!cloudReadyV102())return;
    const c=cloudClientV102();if(!c)return;
    try{
      const {data}=await c.from('admins').select('user_id').eq('user_id',currentUser.id).limit(1);
      isAdmin=!!(data&&data.length);adminChecked=true;
    }catch(e){warnDevV102('refreshAdminFlagV102 failed',e)}
  }

  // ================= 班级 =================
  async function myGroupsV102(){
    const c=cloudClientV102();if(!c||!currentUser)return{groups:[],members:[]};
    const {data:myRows}=await c.from('class_members').select('group_id').eq('user_id',currentUser.id);
    const gids=[...(myRows||[])].map(r=>r.group_id);
    let groups=[],members=[];
    if(gids.length){
      const {data:gs}=await c.from('class_groups').select('id,name,invite_code,created_by').in('id',gids);
      groups=gs||[];
      const {data:ms}=await c.from('class_members').select('group_id,user_id').in('group_id',gids);
      members=ms||[];
    }
    return{groups,members};
  }
  async function createClassV102(){
    const c=cloudClientV102();if(!c)return;
    const nameInput=$('cloud-class-name-v102');const name=(nameInput&&nameInput.value||'').trim();
    if(!name){cloudToastV102('请输入班级名称。','warn');return}
    const code=genInviteCodeV102();
    const {data,error}=await c.from('class_groups').insert({name,invite_code:code,created_by:currentUser.id}).select().single();
    if(error){cloudToastV102(cloudErrorTextV102(error),'danger');return}
    const {error:me}=await c.from('class_members').insert({group_id:data.id,user_id:currentUser.id});
    if(me){cloudToastV102(cloudErrorTextV102(me),'danger');return}
    cloudToastV102(`班级「${data.name}」已创建，邀请码：${data.invite_code}。`,'ok');
    renderLeaderboardV102();
  }
  async function joinClassV102(){
    const c=cloudClientV102();if(!c)return;
    const codeInput=$('cloud-join-code-v102');const code=(codeInput&&codeInput.value||'').trim().toUpperCase();
    if(!code){cloudToastV102('请输入邀请码。','warn');return}
    const {data,error}=await c.rpc('join_class_group',{p_code:code});
    if(error){cloudToastV102(cloudErrorTextV102(error),'danger');return}
    cloudToastV102(`已加入班级「${data&&data[0]&&data[0].name||''}」。`,'ok');
    renderLeaderboardV102();
  }
  async function leaveClassV102(gid){
    const c=cloudClientV102();if(!c)return;
    if(!confirm('退出该班级？退出后不再显示同学进度。'))return;
    const {error}=await c.from('class_members').delete().eq('group_id',gid).eq('user_id',currentUser.id);
    if(error){cloudToastV102(cloudErrorTextV102(error),'danger');return}
    cloudToastV102('已退出班级。','ok');
    renderLeaderboardV102();
  }
  function genInviteCodeV102(len){
    const chars='ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let s='';
    const arr=new Uint32Array(len);
    try{crypto.getRandomValues(arr)}catch(_){for(let i=0;i<len;i++)arr[i]=Math.floor(Math.random()*0xFFFFFFFF)}
    for(let i=0;i<len;i++)s+=chars[arr[i]%chars.length];
    return s;
  }

  // ================= 排行榜 =================
  function renderClassPanelV102(groups,members){
    const panel=$('cloud-class-panel-v102');if(!panel)return;
    if(!currentUser){
      panel.innerHTML=`<div class="notice">登录后创建或加入班级，与同学互看学习进度。</div>`;
      return;
    }
    if(!groups.length){
      panel.innerHTML=`<div class="cloud-class-form-v102">
          <label>班级名称<input id="cloud-class-name-v102" placeholder="例如：病理学 2023 班" /></label>
          <label>邀请码<input id="cloud-join-code-v102" placeholder="输入同学的邀请码加入" /></label>
        </div>
        <div class="actions"><button id="cloud-create-class-v102" class="primary" type="button">创建班级</button><button id="cloud-join-class-v102" class="ghost" type="button">加入班级</button></div>`;
      $('cloud-create-class-v102').onclick=createClassV102;
      $('cloud-join-class-v102').onclick=joinClassV102;
      return;
    }
    panel.innerHTML=groups.map(g=>{
      const memberCount=(members||[]).filter(m=>m.group_id===g.id).length;
      const mine=g.created_by===currentUser.id;
      return `<div class="cloud-class-badge-v102">
        <b>${escV102(g.name)}</b>
        <span class="pill">${memberCount} 名成员</span>
        <span class="cloud-class-code-v102">${escV102(g.invite_code)}</span>
        <span class="muted">邀请码可分享给同学</span>
        <div class="actions"><button class="ghost mini-btn" data-copy-code-v102="${escV102(g.invite_code)}" type="button">复制</button><button class="ghost mini-btn" data-leave-class-v102="${escV102(g.id)}" type="button">退出班级</button></div>
      </div>`;
    }).join('');
    panel.querySelectorAll('[data-copy-code-v102]').forEach(b=>b.onclick=()=>{try{navigator.clipboard.writeText(b.dataset.copyCodeV102).then(()=>cloudToastV102('邀请码已复制。','ok')).catch(()=>cloudToastV102('邀请码：'+b.dataset.copyCodeV102,'warn'))}catch(_){}});
    panel.querySelectorAll('[data-leave-class-v102]').forEach(b=>b.onclick=()=>leaveClassV102(b.dataset.leaveClassV102));
  }
  async function renderLeaderboardV102(){
    const list=$('leaderboard-list-v102');const pill=$('cloud-status-pill-v102');
    if(!list)return;
    if(!cfgOkV102()){list.innerHTML='<div class="cloud-leaderboard-empty-v102">云端未配置：请在 cloud-config.js 填入 Supabase anon key。</div>';renderCloudPillV102();return}
    if(!cloudReadyV102()){list.innerHTML='<div class="cloud-leaderboard-empty-v102">当前处于离线状态，联网后刷新。</div>';renderCloudPillV102();return}
    if(!currentUser){
      list.innerHTML='<div class="cloud-leaderboard-empty-v102">登录后查看同学学习进度。</div>';
      renderCloudPillV102();renderClassPanelV102([],[]);
      return;
    }
    list.innerHTML='<div class="muted">加载中…</div>';
    try{
      if(!adminChecked)await refreshAdminFlagV102();
      renderCloudAuthUiV102();
      const{groups,members}=await myGroupsV102();
      renderClassPanelV102(groups,members);
      // 管理员：额外渲染全部班级列表（班级管理）
      if(isAdmin){
        await renderAdminPanelV102(groups);
      }else{
        const adm=$('cloud-admin-panel-v102');if(adm)adm.remove();
      }
      // 排行榜数据
      const lbSel=$('leaderboard-bank-select-v102');
      const bankId=lbSel&&lbSel.value||'';
      if(!bankId){list.innerHTML='<div class="cloud-leaderboard-empty-v102">请选择题库查看排行。</div>';return}
      if(!groups.length){list.innerHTML='<div class="cloud-leaderboard-empty-v102">先创建或加入班级，才能看到同学进度。</div>';return}
      const memberIds=[...new Set((members||[]).map(m=>m.user_id))];
      const {data:rows}=await cSelectStatsV102(bankId,memberIds);
      const statMap=new Map();let lastAct=0;
      for(const r of rows||[]){statMap.set(r.user_id,{answered:r.count||0,correct:r.correct||0,last:r.last||null});if((r.last||0)>lastAct)lastAct=r.last}
      // 昵称
      const nameMap=new Map();
      try{
        const {data:ps}=await cloudClientV102().from('profiles').select('user_id,display_name').in('user_id',memberIds);
        for(const p of ps||[])nameMap.set(p.user_id,p.display_name||'同学');
      }catch(_){}
      const entries=memberIds.map(uid=>({uid,name:nameMap.get(uid)||'同学',...statMap.get(uid)||{answered:0,correct:0,last:null}}));
      entries.sort((a,b)=>(b.answered-a.answered)||((b.last||0)-(a.last||0)));
      if(!entries.some(e=>e.answered>0)){list.innerHTML='<div class="cloud-leaderboard-empty-v102">还没有同学做过这个题库，快去答题成为第一吧。</div>';return}
      list.innerHTML=entries.map((e,i)=>{
        const acc=e.answered?Math.round(e.correct/e.answered*100):0;
        const mine=e.uid===currentUser.id;
        const rank=i+1;
        return `<div class="leaderboard-row-v102${mine?' me-v102':''}">
          <span class="leaderboard-rank-v102 rank${rank<=3?rank+'-v102':''}">${rank}</span>
          <span class="leaderboard-name-v102">${escV102(e.name)}${mine?'<span class="source-badge">我</span>':''}</span>
          <span class="leaderboard-metrics-v102">
            <span class="lb-metric-v102">已做 <b>${e.answered}</b> 题</span>
            <span class="lb-metric-v102">正确 <b>${e.correct}</b></span>
            <span class="lb-metric-v102">正确率 <b>${acc}%</b></span>
            <span class="lb-metric-v102">最近 <b>${fmtCloudTimeV102(e.last?new Date(e.last).toISOString():'')}</b></span>
          </span>
        </div>`;
      }).join('');
      renderCloudPillV102();
    }catch(e){
      warnDevV102('renderLeaderboardV102 failed',e);
      list.innerHTML='<div class="cloud-leaderboard-empty-v102">加载失败：'+escV102(cloudErrorTextV102(e))+'</div>';
    }
  }
  async function cSelectStatsV102(bankId,memberIds){
    const c=cloudClientV102();
    if(!c||!memberIds.length)return{data:[]};
    try{
      const {data,error}=await c.from('progress_stats').select('user_id,count(),count(correct:eq.true),max(answered_at)').eq('bank_id',bankId).in('user_id',memberIds);
      if(error)throw error;
      return{data:(data||[]).map(r=>({user_id:r.user_id,count:Number(r.count||0),correct:Number(r.correct||0),last:r.max||null}))};
    }catch(e){
      // 兜底：客户端聚合
      const {data}=await c.from('progress_stats').select('user_id,correct,answered_at').eq('bank_id',bankId).in('user_id',memberIds);
      const map=new Map();
      for(const r of data||[]){
        const cur=map.get(r.user_id)||{count:0,correct:0,last:0};
        cur.count++;if(r.correct)cur.correct++;
        const t=new Date(r.answered_at||0).getTime();if(t>cur.last)cur.last=t;
        map.set(r.user_id,cur);
      }
      return{data:[...map.entries()].map(([uid,v])=>({user_id:uid,...v}))};
    }
  }
  function onLeaderboardViewV102(){renderLeaderboardV102()}

  // ================= 管理员面板 =================
  async function renderAdminPanelV102(myGroups){
    let panel=$('cloud-admin-panel-v102');
    if(!panel){
      const holder=$('cloud-class-panel-v102');
      if(!holder)return;
      const div=document.createElement('div');
      div.id='cloud-admin-panel-v102';
      div.className='data-tool-card-v23 cloud-admin-panel-v102';
      div.style.marginTop='14px';
      holder.parentNode.insertBefore(div,holder.nextSibling);
      panel=div;
    }
    const c=cloudClientV102();
    const {data:groups}=await c.from('class_groups').select('id,name,invite_code,created_by').order('created_at',{ascending:true});
    const {data:members}=await c.from('class_members').select('group_id,user_id,joined_at');
    const {data:profiles}=await c.from('profiles').select('user_id,display_name');
    const nameOf=(uid)=>profiles&&profiles.find(p=>p.user_id===uid)||null;
    panel.innerHTML=`<div class="section-head"><div><p class="kicker">Admin</p><h3>班级管理（管理员）</h3><p class="muted">可查看全部班级、踢出成员、查看学生错题详情、修改班级设置。</p></div></div>
      ${(groups||[]).map(g=>{
        const ms=(members||[]).filter(m=>m.group_id===g.id);
        return `<div class="cloud-class-badge-v102" data-admin-class-v102="${escV102(g.id)}">
          <b>${escV102(g.name)}</b><span class="pill">${ms.length} 人</span><span class="cloud-class-code-v102">${escV102(g.invite_code)}</span>
          <details class="cloud-admin-class-detail-v102"><summary class="muted">管理（成员 / 设置）</summary>
            <div class="cloud-admin-member-list-v102">
              ${ms.length?ms.map(m=>{
                const p=nameOf(m.user_id);
                return `<div class="cloud-admin-member-row-v102">
                  <span>${escV102(p?p.display_name:'同学')}</span>
                  <span class="muted">${fmtCloudTimeV102(m.joined_at)}加入</span>
                  <div class="row-actions">
                    <button class="ghost mini-btn" data-admin-wrong-v102="${escV102(g.id)}" data-admin-uid-v102="${escV102(m.user_id)}" type="button">错题详情</button>
                    <button class="ghost danger mini-btn" data-admin-kick-v102="${escV102(g.id)}" data-admin-uid-v102="${escV102(m.user_id)}" type="button">踢出</button>
                  </div>
                </div>`;}).join(''):'<p class="muted">暂无成员</p>'}
            </div>
            <div class="cloud-admin-class-settings-v102">
              <label>班级名<input class="cloud-admin-rename-input-v102" data-admin-rename-v102="${escV102(g.id)}" value="${escV102(g.name)}" /></label>
              <div class="row-actions">
                <button class="ghost mini-btn" data-admin-rename-btn-v102="${escV102(g.id)}" type="button">保存名称</button>
                <button class="ghost mini-btn" data-admin-recode-v102="${escV102(g.id)}" type="button">重新生成邀请码</button>
                <button class="ghost danger mini-btn" data-admin-disband-v102="${escV102(g.id)}" type="button">解散班级</button>
              </div>
            </div>
          </details>
        </div>`;}).join('')||'<p class="muted">还没有任何班级。</p>'}`;
    panel.querySelectorAll('[data-admin-kick-v102]').forEach(b=>b.onclick=()=>adminKickV102(b.dataset.adminKickV102,b.dataset.adminUidV102));
    panel.querySelectorAll('[data-admin-wrong-v102]').forEach(b=>b.onclick=()=>adminWrongDetailV102(b.dataset.adminUidV102));
    panel.querySelectorAll('[data-admin-rename-btn-v102]').forEach(b=>b.onclick=()=>{
      const input=panel.querySelector(`[data-admin-rename-v102="${CSS.escape(b.dataset.adminRenameBtnV102)}"]`);
      adminRenameV102(b.dataset.adminRenameBtnV102,input&&input.value||'');
    });
    panel.querySelectorAll('[data-admin-recode-v102]').forEach(b=>b.onclick=()=>adminRegenCodeV102(b.dataset.adminRecodeV102));
    panel.querySelectorAll('[data-admin-disband-v102]').forEach(b=>b.onclick=()=>adminDisbandV102(b.dataset.adminDisbandV102));
  }
  async function adminKickV102(gid,uid){
    if(!confirm('确定将该成员踢出班级？'))return;
    const c=cloudClientV102();if(!c)return;
    const {error}=await c.from('class_members').delete().eq('group_id',gid).eq('user_id',uid);
    if(error){cloudToastV102(cloudErrorTextV102(error),'danger');return}
    cloudToastV102('已移出班级。','ok');
    renderLeaderboardV102();
  }
  async function adminRenameV102(gid,name){
    name=(name||'').trim();if(!name)return;
    const c=cloudClientV102();if(!c)return;
    const {error}=await c.from('class_groups').update({name}).eq('id',gid);
    if(error){cloudToastV102(cloudErrorTextV102(error),'danger');return}
    cloudToastV102('班级名称已更新。','ok');
    renderLeaderboardV102();
  }
  async function adminRegenCodeV102(gid){
    const c=cloudClientV102();if(!c)return;
    const code=genInviteCodeV102(8);
    const {error}=await c.from('class_groups').update({invite_code:code}).eq('id',gid);
    if(error){cloudToastV102(cloudErrorTextV102(error),'danger');return}
    cloudToastV102('新邀请码：'+code+'（已复制）','ok');
    try{navigator.clipboard.writeText(code)}catch(_){}
    renderLeaderboardV102();
  }
  async function adminDisbandV102(gid){
    if(!confirm('确定解散该班级？所有成员关系将删除，此操作不可撤销。'))return;
    const c=cloudClientV102();if(!c)return;
    const {error}=await c.from('class_groups').delete().eq('id',gid);
    if(error){cloudToastV102(cloudErrorTextV102(error),'danger');return}
    cloudToastV102('班级已解散。','ok');
    renderLeaderboardV102();
  }
  async function adminWrongDetailV102(uid){
    if(!uid){return}
    const c=cloudClientV102();if(!c)return;
    const modal=$('cloud-admin-modal');if(!modal)return;
    const body=$('cloud-admin-body-v102');if(!body)return;
    const title=$('cloud-admin-title-v102');if(title)title.textContent='学生错题详情';
    body.innerHTML='<p class="muted">加载中…</p>';
    modal.classList.remove('hidden');
    try{
      const {data:rows}=await c.from('progress_stats').select('bank_id,question_id,answered_at').eq('user_id',uid).eq('correct',false);
      if(!rows||!rows.length){body.innerHTML='<div class="cloud-leaderboard-empty-v102">该学生还没有答错的题。</div>';return}
      const byBank=new Map();
      for(const r of rows){if(!byBank.has(r.bank_id))byBank.set(r.bank_id,[]);byBank.get(r.bank_id).push(r)}
      const banks=bridge&&bridge.getBankList?bridge.getBankList():[];
      const bankName=(bid)=>((banks.find(b=>b.id===bid)||{}).name)||bid;
      const bankMeta=(bid)=>bridge&&bridge.getBankById?bridge.getBankById(bid):null;
      const bankTabs=[...byBank.keys()];
      body.innerHTML=`<div class="cloud-admin-banks-v102">${bankTabs.map((bid,i)=>`<span class="pill ${i===0?'on-v102':''}" data-admin-banktab-v102="${escV102(bid)}">${escV102(bankName(bid))}（${byBank.get(bid).length}）</span>`).join('')}</div>
        ${bankTabs.map((bid,i)=>{
          const meta=bankMeta(bid);
          const qmap=new Map((meta&&meta.questions||[]).map(q=>[q.id,q]));
          const items=byBank.get(bid);
          return `<div class="cloud-admin-wrong-list-v102" data-admin-banklist-v102="${escV102(bid)}" ${i===0?'':'hidden'}>
            ${items.map(r=>{
              const q=qmap.get(r.question_id);
              const text=q?q.question:('题目 ID：'+r.question_id+'（本地无该题库，无法显示题干）');
              return `<div class="cloud-admin-wrong-item-v102"><div>${escV102(text)}</div><div class="muted">${escV102(q?('题型：'+(q.typeLabel||q.type||'')):'')} · 答错于 ${fmtCloudTimeV102(r.answered_at)}</div></div>`;
            }).join('')}
          </div>`;
        }).join('')}`;
      body.querySelectorAll('[data-admin-banktab-v102]').forEach(t=>t.onclick=()=>{
        body.querySelectorAll('[data-admin-banktab-v102]').forEach(x=>x.classList.remove('on-v102'));
        t.classList.add('on-v102');
        body.querySelectorAll('[data-admin-banklist-v102]').forEach(x=>x.hidden=x.dataset.adminBanklistV102!==t.dataset.adminBanktabV102);
      });
    }catch(e){
      warnDevV102('adminWrongDetailV102 failed',e);
      body.innerHTML='<div class="cloud-leaderboard-empty-v102">加载失败：'+escV102(cloudErrorTextV102(e))+'</div>';
    }
  }

  // ================= 启动 =================
  function initCloudV102(){
    readMetaV102();
    bindCloudDomV102();
    if(!cfgOkV102()){
      renderCloudAuthUiV102();showCloudGateV103();
      setCloudGateStatusV103('云端未配置：请先在 cloud-config.js 填入 Supabase anon key。',true);
      return;
    }
    if(!window.supabase||!window.supabase.createClient){
      renderCloudAuthUiV102();showCloudGateV103();
      setCloudGateStatusV103('云端组件缺失：libs/supabase.min.js 未加载。',true);
      return;
    }
    const c=cloudClientV102();
    if(!c){renderCloudAuthUiV102();showCloudGateV103();setCloudGateStatusV103('网络不可用：请检查网络连接后刷新重试。',true);return}
    try{
      c.auth.getSession().then(({data})=>{
        if(data&&data.session){currentUser=data.session.user;hideCloudGateV103();refreshAdminFlagV102().then(()=>{renderCloudAuthUiV102();syncNowV102()})}
        else {renderCloudAuthUiV102();showCloudGateV103()}
      }).catch(e=>{warnDevV102('getSession failed',e);renderCloudAuthUiV102();showCloudGateV103()});
      authUnsub=c.auth.onAuthStateChange((event,session)=>{
        const wasUser=!!currentUser;
        currentUser=session?session.user:null;
        if(currentUser&&(event==='SIGNED_IN'||event==='TOKEN_REFRESHED'||!wasUser)){
          hideCloudGateV103();
          refreshAdminFlagV102().then(()=>{renderCloudAuthUiV102();syncNowV102()});
        }else if(!currentUser){
          isAdmin=false;adminChecked=false;renderCloudAuthUiV102();
          if(event==='SIGNED_OUT'){
            showCloudGateV103();switchViewV102('dashboard');
          }
        }else{renderCloudAuthUiV102()}
      });
    }catch(e){warnDevV102('initCloudV102 failed',e);renderCloudAuthUiV102();showCloudGateV103()}
  }

  window.ShirohaCloud={
    registerBridgeV102,
    initCloudV102,
    onLocalStateSavedV102,
    queueProgressV102,
    flushOnExitV102,
    onLeaderboardViewV102
  };
})();
