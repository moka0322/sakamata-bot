/* Sakamata Remote Keyboard v1.8: local-only tools for standalone PWA */
(()=>{
"use strict";
if(!window.__SKR_STANDALONE__)return;
const keys={draft:"skr-draft-v07",history:"skr-history-v07",snippets:"skr-quick-snippets-v18"};
const MAX=900;
const read=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key)||"null")??fallback}catch{return fallback}};
const save=(key,data)=>{try{localStorage.setItem(key,JSON.stringify(data));return true}catch{return false}};
const element=(tag,txt,cls)=>{const x=document.createElement(tag);if(txt!==undefined)x.textContent=txt;if(cls)x.className=cls;return x};
const button=(txt,fn,cls)=>{const x=element("button",txt,cls||"");x.type="button";x.onclick=fn;return x};
const info=(txt,bad=false)=>{const x=document.getElementById("skr-extras-info");if(x){x.textContent=txt;x.dataset.bad=String(bad)}};
function restore(val){
 const t=document.getElementById("skr-typing");if(!t)return;
 const v=String(val).slice(0,MAX);
 if(t.value.trim()&&t.value!==v&&!confirm("今の下書きを置き換える？ 必要なら先にコピーしてね。"))return;
 t.value=v;t.dispatchEvent(new Event("input",{bubbles:true}));t.focus();
}
function drawHistory(host){
 host.replaceChildren();
 const h=read(keys.history,[]);
 if(!Array.isArray(h)||!h.length){host.append(element("p","送信履歴はまだないよ。"));return}
 h.filter(x=>typeof x==="string").slice(0,5).forEach((s,i)=>{
   host.append(button((i+1)+". "+s.replace(/\s+/g," ").slice(0,54)+(s.length>54?"…":""),()=>restore(s),"skr-extra-history-item"));
 });
}
function drawSnippets(host){
 host.replaceChildren();const list=read(keys.snippets,[]);
 if(!Array.isArray(list)||!list.length){host.append(element("p","よく使う文章を登録すると便利だよ。"));return}
 list.slice(0,12).forEach((s,i)=>{
  if(!s||typeof s.value!=="string")return;
  const row=element("div",undefined,"skr-extra-snippet-row");
  row.append(button(String(s.label||s.value).slice(0,28),()=>restore(s.value)));
  row.append(button("削除",()=>{if(!confirm("この定型文を削除する？"))return;
    const all=read(keys.snippets,[]);all.splice(i,1);save(keys.snippets,all);drawSnippets(host)}, "skr-extra-delete"));
  host.append(row);
 });
}
function exportBackup(){
 const payload={type:"sakamata-local-backup",version:1,time:new Date().toISOString(),
  draft:localStorage.getItem(keys.draft)||"",history:read(keys.history,[]),snippets:read(keys.snippets,[])};
 const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:"application/json"}));
 const a=element("a");a.href=url;a.download="sakamata-backup-"+new Date().toISOString().slice(0,10)+".json";
 document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),6000);
 info("バックアップを保存したよ。接続コードは含んでいないよ。");
}
async function importBackup(file){
 try{
  if(file.size>262144)throw Error("ファイルが大きすぎるよ");
  const data=JSON.parse(await file.text());
  if(data.type!=="sakamata-local-backup"||data.version!==1||typeof data.draft!=="string"||data.draft.length>MAX||!Array.isArray(data.history)||!Array.isArray(data.snippets))throw Error("対応していない形式だよ");
  if(!confirm("下書き・履歴・定型文をバックアップの内容で上書きする？"))return;
  const h=data.history.filter(x=>typeof x==="string").slice(0,5).map(x=>x.slice(0,MAX));
  const s=data.snippets.filter(x=>x&&typeof x.value==="string").slice(0,12)
   .map(x=>({label:String(x.label||"定型文").slice(0,24),value:x.value.slice(0,MAX)}));
  localStorage.setItem(keys.draft,data.draft);save(keys.history,h);save(keys.snippets,s);
  const t=document.getElementById("skr-typing");if(t){t.value=data.draft;t.dispatchEvent(new Event("input",{bubbles:true}))}
  info("復元したよ！ 履歴の『前回の文章』には再読み込み後に反映されるよ。");
  const hBox=document.getElementById("skr-extra-history");if(hBox)drawHistory(hBox);
  const sBox=document.getElementById("skr-extra-snippets");if(sBox)drawSnippets(sBox);
 }catch(e){info("復元失敗："+e.message,true)}
}

// This test intentionally never sends the pairing code, message draft, or files.
// It uses a one-time, randomly named ntfy topic containing only a random probe marker.
async function checkRelayConnectivity(buttonEl, output) {
 buttonEl.disabled=true;
 const lines=[];
 const show=(msg)=>{lines.push(msg);output.textContent=lines.join("\n");};
 const ctrl=new AbortController();
 const timeout=setTimeout(()=>ctrl.abort(),14000);
 const rand=new Uint8Array(12);crypto.getRandomValues(rand);
 const suffix=[...rand].map(n=>n.toString(16).padStart(2,"0")).join("");
 const topic="skr-diag-"+suffix;
 const base="https://ntfy.sh/"+topic;
 const marker="skr-diagnostic-"+suffix;
 const opts={cache:"no-store",signal:ctrl.signal};
 show("診断中：端末の接続コード・下書きは送信しないよ。");
 try{
   const r=await fetch(base+"/json?poll=1&since=latest",opts);
   if(!r.ok)throw Error("GET HTTP "+r.status);
   await r.text();
   show("① 中継からの読み取り：成功（HTTP "+r.status+"）");
 }catch(e){
   show("① 中継からの読み取り：失敗（"+(e.name==="AbortError"?"14秒でタイムアウト":e.message||String(e))+"）");
   show("→ 独立Webサイト→ntfy.sh がブロックされている可能性。SafariのCORS・DNS・VPN・中継障害を確認。");
   clearTimeout(timeout);buttonEl.disabled=false;return;
 }
 clearTimeout(timeout);
 const sendController=new AbortController();const sendTimeout=setTimeout(()=>sendController.abort(),14000);
 try{
   const p=await fetch(base,{method:"POST",headers:{"Content-Type":"text/plain;charset=UTF-8"},body:marker,cache:"no-store",signal:sendController.signal});
   if(!p.ok)throw Error("POST HTTP "+p.status);
   show("② 中継への書き込み：成功（HTTP "+p.status+"）");
 }catch(e){
   show("② 中継への書き込み：失敗（"+(e.name==="AbortError"?"14秒でタイムアウト":e.message||String(e))+"）");
   show("→ 読み取りは可能。書き込み側のCORS・レート制限・送信エラーの可能性。");
   clearTimeout(sendTimeout);buttonEl.disabled=false;return;
 }
 clearTimeout(sendTimeout);
 try{
   const pollCtrl=new AbortController();const timer=setTimeout(()=>pollCtrl.abort(),14000);
   try{
     const res=await fetch(base+"/json?poll=1&since=all",{cache:"no-store",signal:pollCtrl.signal});
     if(!res.ok)throw Error("GET HTTP "+res.status);
     const data=await res.text();
     const messages=data.split("\n").filter(Boolean).flatMap(line=>{
       try{const x=JSON.parse(line);return x.event==="message"?[x.message]:[]}catch(_){return []}
     });
     if(messages.includes(marker)){show("③ テスト文字の再受信：成功");show("判定：iPhoneの独立サイト→ntfy.sh は往復通信可能。次はiPad受信／暗号化・コード一致を診断しよう。");}
     else {show("③ テスト文字の再受信：失敗（応答にマーカーなし）");show("→ 中継のキャッシュや再取得に問題の可能性。");}
   }finally{clearTimeout(timer)}
 }catch(e){show("③ テスト文字の再受信：失敗（"+(e.message||String(e))+"）");}
 buttonEl.disabled=false;
}
function inject(){
 const c=document.querySelector("#skr-panel .skr-compose");
 if(!c||c.querySelector("#skr-extras"))return;
 const d=element("details",undefined,"skr-extras");d.id="skr-extras";
 d.append(element("summary","✦  便利ツール  /  履歴・定型文・バックアップ"));
 const body=element("div",undefined,"skr-extras-body");d.append(body);
 const row=element("div",undefined,"skr-extras-buttons");body.append(row);
 row.append(button("文章をコピー",async()=>{
  try{await navigator.clipboard.writeText(document.getElementById("skr-typing")?.value||"");info("コピーしたよ。")}
  catch{info("コピーできなかったよ。ブラウザの権限を確認してね。",true)}
 }));
 const hWrap=element("div",undefined,"skr-extras-list");hWrap.hidden=true;hWrap.append(element("h4","最近の送信履歴"));
 const hList=element("div");hList.id="skr-extra-history";hWrap.append(hList);
 row.append(button("最近の履歴",()=>{hWrap.hidden=!hWrap.hidden;if(!hWrap.hidden)drawHistory(hList)}));
 row.append(button("下書き保存確認",()=>info("端末に"+(localStorage.getItem(keys.draft)||"").length+"文字の下書きを保存しているよ。")));
 body.append(hWrap,element("h4","よく使う文章"));
 const sList=element("div");sList.id="skr-extra-snippets";body.append(sList);drawSnippets(sList);
 const title=element("input");title.className="skr-extra-name";title.placeholder="定型文の名前";title.maxLength=24;
 const saveRow=element("div",undefined,"skr-extras-buttons");saveRow.append(title,
 button("今の文章を定型文に保存",()=>{
  const v=document.getElementById("skr-typing")?.value||"";
  const arr=read(keys.snippets,[]);
  if(!v.trim())return info("保存する文章を入力してね。",true);
  if(!Array.isArray(arr)||arr.length>=12)return info("定型文は最大12件だよ。",true);
  arr.push({label:(title.value.trim()||v.slice(0,24)).slice(0,24),value:v.slice(0,MAX)});
  if(save(keys.snippets,arr)){title.value="";drawSnippets(sList);info("定型文に保存したよ。")}
  else info("保存できなかったよ。",true);
 }));body.append(saveRow,element("h4","データの引き継ぎ"));
 const file=element("input");file.type="file";file.accept=".json,application/json";file.hidden=true;
 file.addEventListener("change",()=>{const f=file.files?.[0];file.value="";if(f)importBackup(f)});
 const backups=element("div",undefined,"skr-extras-buttons");backups.append(button("バックアップ保存",exportBackup),button("バックアップ読み込み",()=>file.click()));
 body.append(backups,file);
 body.append(element("h4","接続トラブルの切り分け"));
 const diagButton=button("iPhoneから中継への通信をテスト",()=>checkRelayConnectivity(diagButton,diagOutput));
 const diagOutput=element("pre","接続できない場合はここを押してね。下書きや接続コードは診断に送らないよ。");
 diagOutput.style.cssText="white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.6;padding:12px;border-radius:10px;background:#172031;color:#e9efff;margin:6px 0 0";
 body.append(diagButton,diagOutput);
 const message=element("p","下書き・履歴はこの端末内に保存するよ。接続コードは含まれないよ。");
 message.id="skr-extras-info";body.append(message);
 const before=c.querySelector("#skr-draft-count");if(before)c.insertBefore(d,before);else c.append(d);
}
function network(){
 const p=document.getElementById("skr-panel");if(!p)return;
 let e=document.getElementById("skr-extra-network");
 if(!e){e=element("div",undefined,"skr-extra-network");e.id="skr-extra-network";
  const after=p.querySelector(".skr-connection-strip");if(after)after.after(e)}
 if(e){const s=navigator.onLine?"インターネット：接続あり（iPadの応答は上の表示を確認）":"インターネット：オフライン。文章は端末に保存されるよ。";
   if(e.textContent!==s)e.textContent=s;e.dataset.offline=String(!navigator.onLine)}
}
let scheduled=false;const render=()=>{scheduled=false;inject();network()};
new MutationObserver(()=>{if(!scheduled){scheduled=true;requestAnimationFrame(render)}}).observe(document.body,{subtree:true,childList:true});
render();window.addEventListener("online",network);window.addEventListener("offline",network);
document.addEventListener("keydown",e=>{
 if((e.metaKey||e.ctrlKey)&&e.key==="Enter"&&e.target?.id==="skr-typing"){
  e.preventDefault();const b=document.getElementById("skr-remote-send");if(b&&!b.disabled)b.click()
 }
});
})();