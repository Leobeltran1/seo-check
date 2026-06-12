/* SEO Rocket shared auth — session storage, token refresh, authenticated REST calls. */
const SEOR_URL = 'https://jjfojqvhcecyxmstpmxl.supabase.co';
const SEOR_KEY = 'sb_publishable_631aiLjc7Kyv1bSNeNSYDg_xbuMdDCD';

function seorSaveSession(data){
  if(data.access_token) localStorage.setItem('SEORocket_token', data.access_token);
  if(data.refresh_token) localStorage.setItem('SEORocket_refresh', data.refresh_token);
  if(data.user) localStorage.setItem('SEORocket_user', JSON.stringify(data.user));
}
function seorClearSession(){
  localStorage.removeItem('SEORocket_token');
  localStorage.removeItem('SEORocket_refresh');
  localStorage.removeItem('SEORocket_user');
}
function seorGetUser(){
  try{ return JSON.parse(localStorage.getItem('SEORocket_user')); }catch(e){ return null; }
}
function seorLoggedIn(){
  return !!(localStorage.getItem('SEORocket_token') && seorGetUser());
}

function seorTokenExpiringSoon(token){
  try{
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
    return payload.exp * 1000 < Date.now() + 60000;
  }catch(e){ return true; }
}

/* Refresh tokens are single-use, so concurrent callers share one in-flight refresh. */
let seorRefreshing = null;
function seorRefreshSession(){
  if(seorRefreshing) return seorRefreshing;
  seorRefreshing = (async () => {
    const refresh = localStorage.getItem('SEORocket_refresh');
    if(!refresh){ seorClearSession(); return null; }
    try{
      const res = await fetch(SEOR_URL+'/auth/v1/token?grant_type=refresh_token', {
        method:'POST',
        headers:{'Content-Type':'application/json','apikey':SEOR_KEY},
        body:JSON.stringify({refresh_token: refresh})
      });
      const data = await res.json();
      if(!res.ok || !data.access_token){ seorClearSession(); return null; }
      seorSaveSession(data);
      return data.access_token;
    }catch(e){
      return null; /* network hiccup: keep the session so the next attempt can retry */
    }
  })();
  seorRefreshing.then(() => { seorRefreshing = null; }, () => { seorRefreshing = null; });
  return seorRefreshing;
}

async function seorGetValidToken(){
  const token = localStorage.getItem('SEORocket_token');
  if(!token) return null;
  if(!seorTokenExpiringSoon(token)) return token;
  return seorRefreshSession();
}

/* Authenticated Supabase REST call. Throws Error('not-authenticated') when the session is gone. */
async function seorRest(path, opts){
  opts = opts || {};
  let token = await seorGetValidToken();
  if(!token) throw new Error('not-authenticated');
  const doFetch = t => fetch(SEOR_URL+'/rest/v1/'+path, Object.assign({}, opts, {
    headers: Object.assign({'Content-Type':'application/json','apikey':SEOR_KEY,'Authorization':'Bearer '+t}, opts.headers||{})
  }));
  let res = await doFetch(token);
  if(res.status === 401){
    token = await seorRefreshSession();
    if(!token) throw new Error('not-authenticated');
    res = await doFetch(token);
  }
  return res;
}
