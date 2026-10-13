// ==UserScript==
// @name         Remote Keyboard
// @namespace    https://chatgpt.com/
// @version      1.9.2
// @description  iPhone/iPad遠隔入力：見やすい専用画面、安定した下書き同期、返信検出診断。
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @inject-into  content
// @grant        GM.xmlHttpRequest
// @connect      ntfy.sh
// ==/UserScript==

(() => {
  'use strict';
  if (document.getElementById('skr-launcher')) return;
  const STANDALONE = !!window.__SKR_STANDALONE__; // independently hosted sender webpage

  const VERSION = '1.9.2';
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const CODE_LEN = 12;
  const MAX_TEXT = 900;
  const MAX_FILE_BYTES = 1750000; // ntfy.sh public attachment limit is about 2 MB
  const FILE_TYPES = new Set(['image/png','image/jpeg','image/webp','image/heic','image/heif','application/pdf','text/plain']);
  const STORAGE = 'skr-pairing-v04'; // compatible with v0.4-0.6 pairings
  const DRAFT_STORAGE = 'skr-draft-v07';
  const HISTORY_STORAGE = 'skr-history-v07';
  const SETTINGS_STORAGE = 'skr-settings-v07';
  const OWNED_DRAFT_STORAGE = 'skr-receiver-owned-draft-v13';
  const REPLY_LIMIT = 500; // preview only; keep ntfy messages within the free service size limit
  const safeStorage = (k, fallback = '') => { try { return localStorage.getItem(k) ?? fallback; } catch (_) { return fallback; } };
  const putStorage = (k,v) => { try { localStorage.setItem(k, v); return true; } catch (_) { return false; } };
  const loadSettings = () => { try { return { confirm: true, replies: false, autoFocus: true, photoMode: 'auto', theme: 'aurora', motion: 'system', ...JSON.parse(safeStorage(SETTINGS_STORAGE,'{}')) }; } catch (_) { return { confirm:true, replies:false, autoFocus:true,theme:'aurora',motion:'system' }; } };
  let settings = loadSettings();
  const visualThemes = ['aurora','lagoon','graphite'];
  function safeTheme() { return visualThemes.includes(settings.theme) ? settings.theme : 'aurora'; }
  function applyAppearance() {
    const panel = document.getElementById('skr-panel');
    if (!panel) return;
    panel.dataset.theme = safeTheme();
    panel.dataset.motion = ['off','on','system'].includes(settings.motion) ? settings.motion : 'system';
    const themeButton = panel.querySelector('#skr-theme-switch');
    if (themeButton) {
      themeButton.textContent = '✦  '+ ({aurora:'オーロラ',lagoon:'ラグーン',graphite:'モノクロ'}[safeTheme()]);
      themeButton.setAttribute('aria-label','デザイン変更：'+ themeButton.textContent);
    }
  }
  function cycleTheme() {
    const current = safeTheme();
    settings.theme = visualThemes[(visualThemes.indexOf(current)+1)%visualThemes.length];
    saveSettings(); applyAppearance();
  }

  let lastSent = (() => { try { return JSON.parse(safeStorage(HISTORY_STORAGE, '[]')); } catch (_) { return []; } })();
  if (!Array.isArray(lastSent)) lastSent = [];
  lastSent = lastSent.filter(x => typeof x === 'string').slice(0,5);
  function saveDraft(value) { putStorage(DRAFT_STORAGE, String(value || '').slice(0, MAX_TEXT)); }
  function saveHistory(value) { if (!value) return; lastSent = [value, ...lastSent.filter(x=>x!==value)].slice(0,5); putStorage(HISTORY_STORAGE, JSON.stringify(lastSent)); }
  function restoreDraft() { return safeStorage(DRAFT_STORAGE, '').slice(0, MAX_TEXT); }
  function saveSettings() { putStorage(SETTINGS_STORAGE, JSON.stringify(settings)); }
  const SERVICE = 'https://ntfy.sh/';
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  const el = s => document.querySelector(s);
  const now = () => Date.now();
  const delay = (fn, ms) => setTimeout(fn, ms);
  const isValidCode = v => typeof v === 'string' && new RegExp('^[' + ALPHABET + ']{' + CODE_LEN + '}$').test(v);
  const cleanCode = v => String(v || '').toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, CODE_LEN);
  const pretty = v => (String(v || '').match(/.{1,4}/g) || []).join('–');

  // Pairing usability. The generated code remains the same 12-character secret
  // as v1.8, so existing receivers and keys remain compatible.
  const PAIR_APP_URL = 'https://sakamata-remote-keyboard.onrender.com/';
  function pairLink(value) {
    const u=new URL(PAIR_APP_URL);
    u.hash='pair='+encodeURIComponent(value);
    return u.href; // URL fragment is not included in the HTTP request
  }
  function codeFromText(value) {
    const raw=String(value||'').trim();
    try {
      const u=new URL(raw);
      if (u.origin===new URL(PAIR_APP_URL).origin) {
        const pair=new URLSearchParams(u.hash.replace(/^#/,'')).get('pair');
        return pair && isValidCode(cleanCode(pair)) ? cleanCode(pair) : '';
      }
      return '';
    } catch(_) {}
    const codeCandidate=cleanCode(raw);
    return isValidCode(codeCandidate) ? codeCandidate : '';
  }
  function paintPairCode(parent,value) {
    parent.replaceChildren();
    const normalized=cleanCode(value);
    const labels=[];
    parent.setAttribute('aria-label', normalized.length===CODE_LEN?
      '接続コード '+normalized.split('').map(ch=>/\d/.test(ch)?'数字 '+ch:'英字 '+ch).join('、'):
      '接続コード '+normalized.length+'文字');
    for(let group=0;group<3;group++){
      if(group){const dash=document.createElement('span');dash.className='skr-pair-separator';dash.textContent='–';dash.setAttribute('aria-hidden','true');parent.append(dash);}
      const section=document.createElement('span');section.className='skr-pair-group';
      section.setAttribute('aria-hidden','true');
      for(let i=group*4;i<Math.min((group+1)*4,normalized.length);i++) {
        const ch=normalized[i],span=document.createElement('span');
        span.className=/[2-9]/.test(ch)?'skr-pair-digit':'skr-pair-letter';
        span.textContent=ch;span.title=/[2-9]/.test(ch)?'数字の '+ch:'アルファベットの '+ch;
        section.append(span);
      }
      parent.append(section);
    }
  }
  async function copyPair(value) {
    if(!isValidCode(value)) {updateStatus('コピーする接続コードが見つからないよ。',true);return false;}
    try {
      if(!navigator.clipboard?.writeText)throw new Error('clipboard API unavailable');
      await navigator.clipboard.writeText(pretty(value));
      updateStatus('接続コードをコピーしたよ。iPhoneで「コードを貼り付け」を使ってね。');
      return true;
    }catch(e){
      // Do not silently claim that a copy succeeded; show selectable text.
      window.prompt('自動コピーできなかったよ。ここから選択してコピーしてね。',pretty(value));
      updateStatus('自動コピーが使えなかったので、選択用の画面を開いたよ。');
      return false;
    }
  }
  async function sharePair() {
    if(!isValidCode(code)){updateStatus('共有するコードがないよ。',true);return;}
    const link=pairLink(code);
    if(typeof navigator.share==='function'){
      try{
        await navigator.share({title:'リモート入力 接続',url:link});
        updateStatus('共有先に接続リンクを渡したよ。iPhoneで開いて接続を確認してね。');
        return;
      }catch(e){if(e?.name==='AbortError')return;}
    }
    try{
      if(!navigator.clipboard?.writeText)throw new Error('clipboard API unavailable');
      await navigator.clipboard.writeText(link);
      updateStatus('接続リンクをコピーしたよ。AirDropやメッセージで自分のiPhoneへ共有してね。');
    }catch(e){
      window.prompt('自分のiPhoneに送る接続リンクをコピーしてね。',link);
      updateStatus('共有リンクのコピー画面を開いたよ。');
    }
  }
  async function pastePairInto(input,feedback) {
    try{
      if(!navigator.clipboard?.readText)throw new Error('clipboard API unavailable');
      const text=await navigator.clipboard.readText(), candidate=codeFromText(text);
      if(!candidate){updateStatus('クリップボードに有効な12文字のコードがないよ。',true);return;}
      input.value=pretty(candidate);
      input.dispatchEvent(new Event('input',{bubbles:true}));
      updateStatus('接続コードを取り込んだよ。「iPadへ接続」を押してね。');
    }catch(_){
      updateStatus('Safariがクリップボードの読み取りを許可しなかったよ。入力欄を長押しして「ペースト」を使ってね。',true);
      input.focus();
    }
  }
  function shareablePairFragment() {
    if(!STANDALONE)return '';
    try{
      const fragment=new URLSearchParams(location.hash.replace(/^#/,''));
      const raw=fragment.get('pair');
      if(!raw)return '';
      // Scrub the secret from the address bar and browser history before use.
      history.replaceState(history.state,'',location.pathname+location.search);
      const candidate=cleanCode(raw);
      return isValidCode(candidate)?candidate:'';
    }catch(_){return '';}
  }


  function randomCode() {
    // New codes avoid visually ambiguous 'Z' and '2'.
    // Old codes (which may contain both) remain fully valid and load unchanged.
    const choices=ALPHABET.replace(/[Z2]/g,'');
    const limit=Math.floor(256/choices.length)*choices.length;
    let result='';
    while(result.length<CODE_LEN){
      const random=new Uint8Array(CODE_LEN);
      crypto.getRandomValues(random);
      for(const n of random){
        if(n>=limit)continue; // reject to avoid modulo bias
        result+=choices[n%choices.length];
        if(result.length===CODE_LEN)break;
      }
    }
    return result;
  }
  function randomId() {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return [...bytes].map(v => v.toString(16).padStart(2, '0')).join('');
  }
  function b64(buffer) {
    const bytes = new Uint8Array(buffer);
    let str = '';
    for (const v of bytes) str += String.fromCharCode(v);
    return btoa(str);
  }
  function un64(s) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
  function hex(buffer) { return [...new Uint8Array(buffer)].map(v => v.toString(16).padStart(2, '0')).join(''); }

  function readPrefs() {
    try {
      const prefs = JSON.parse(localStorage.getItem(STORAGE) || '{}');
      return {
        role: ['receive', 'send', 'choose'].includes(prefs.role) ? prefs.role : 'choose',
        receiverCode: isValidCode(prefs.receiverCode) ? prefs.receiverCode : '',
        senderCode: isValidCode(prefs.senderCode) ? prefs.senderCode : '',
        auto: prefs.auto !== false,
      };
    } catch (_) { return { role: 'choose', receiverCode: '', senderCode: '', auto: true }; }
  }
  let prefs = readPrefs();
  function savePrefs() {
    try { localStorage.setItem(STORAGE, JSON.stringify(prefs)); }
    catch (_) { updateStatus('端末の記憶を保存できないよ。プライベートブラウズを確認してね。', true); }
  }

  let mode = 'choose', code = '', key = null, topicRoot = '', sessionId = '';
  let active = false, connected = false, allowed = false;
  let statusText = '未接続', statusBad = false, stream = null;
  let fallbackTimer = 0, retryTimer = 0, pollingTimer = 0, parallelPollTimer = 0, pingTimer = 0, typingTimer = 0, verifyTimer = 0;
  let generation = 0, lastSeq = -1, seq = 0, lastApplied = null, currentSender = '', sentText = '', lastPublish = 0;
  let seenIds = new Set(), publishing = false, composition = false, pendingAuto = 0;
  let pendingSend = null, pendingSendTimer = 0, receiverSending = false, manualWatch = false;
  let ambiguousSendText = ''; // Unverified send never automatically deletes a draft.
  const completedRequests = new Set(), completedFiles = new Set();
  const latestReceipt = new Map(), receivedFiles = new Map();
  let sendingFile = false;
  // A file reaching the relay is NOT the same as a verified ChatGPT attachment.
  let fileTransferStage = 'まだファイルを選択していないよ。';
  let fileTransferFailed = false;
  let pickedReplyPathInfo = null;
  let replyPicker = null;
  let pickerCapture = null;
  // Only the current unsent draft is cleared. Last-sent history is preserved.
  // Keep a short-lived undo buffer in memory, not in cloud storage.
  let erasedDraft = null, eraseUndoTimer = 0;

  let focusMode = STANDALONE || (prefs.role === 'send' && settings.autoFocus !== false);
  let replyTimer = 0, replyBusy = false, replyBaseline = null, lastReplyText = '', replyEpoch = 0;
  let remoteShare = null; // last confirmed receiver preference; resets on reconnect
  let receiverChatUrl = ''; // encrypted receiver-provided chat deep link
  let pendingReply = null; // explicit, user-initiated reply request, with timeout
  let sendRescueTimers = []; // one-shot relay polling while waiting for a send receipt
  let lastReceiverAckAt = 0, lastInboundAt = 0, lastReceiverContactAt = 0, healthTimer = 0;
  let relayPostAt = 0, relayPollAt = 0, relayError = '', handshakeStartAt = 0;
  let incomingCount=0, decryptOkCount=0, decryptFailCount=0, helloCount=0, ackSentCount=0;
  let pollEvents=0,pollTextBytes=0,pollMessageRows=0,pollParseFailures=0,rxSseEvents=0;
  function relayBody(res) {
    // Userscripts GM transport can expose text in either responseText or response.
    return typeof res?.responseText==='string' && res.responseText.length ? res.responseText :
      (typeof res?.response==='string'?res.response:'');
  }
  function channelCheck() { return topicRoot?topicRoot.slice(-4).toUpperCase():'未設定'; }
  function scanNtfyLines(raw,epoch,updateCursor) {
    let total=0,bad=0,last='';
    for(const row of String(raw||'').split(/\r?\n/)){
      if(!row.trim())continue;
      try{
        const m=JSON.parse(row);
        if(m.event==='message' && typeof m.message==='string'){
          total++;last=m.id||last;receiveOne(m.id,m.message,epoch);
        }
      }catch(_){bad++}
    }
    pollEvents++;pollTextBytes+=String(raw||'').length;
    pollMessageRows+=total;pollParseFailures+=bad;
    if(last&&typeof updateCursor==='function')updateCursor(last);
    return {total,bad};
  }
  let transportCycle = 0;
  const PEER_TIMEOUT_MS = 65000; // Don't call an old acknowledgement a live connection.
  const STREAM_IDLE_RESTART_MS = 65000;
  let lastHealthProbeAt = 0;
  let lastWatchdogRestartAt = 0;
  let lastDraftAckSeq = 0;

  // This is evidence that a receiver draft came from THIS app, not an arbitrary
  // ChatGPT draft. Preserve the ownership record across refreshes, scoped to chat.
  function ownedContext() { return location.origin + location.pathname; }
  function loadOwnedDraft() {
    try {
      const p=JSON.parse(safeStorage(OWNED_DRAFT_STORAGE,'{}'));
      if(p.context===ownedContext() && p.code===code &&
          typeof p.text==='string' && now()-p.time < 24*3600*1000) return p.text;
    }catch(_){}
    return null;
  }
  function recordOwnedDraft(text) {
    if(mode!=='receive') return;
    if(!text) {try{localStorage.removeItem(OWNED_DRAFT_STORAGE);}catch(_){};return;}
    putStorage(OWNED_DRAFT_STORAGE,JSON.stringify({context:ownedContext(), code,
      text:String(text).slice(0,MAX_TEXT),time:now()}));
  }
  function restoreOwnedDraft() {
    const editor=findEditor(); const owned=loadOwnedDraft();
    if(editor && owned !== null && normalize(readEditor(editor))===normalize(owned)) {
      lastApplied=owned; return true;
    }
    return false;
  }
  function adoptVisibleDraft() {
    if(mode!=='receive') return;
    const editor=findEditor();
    if(!editor || !normalize(readEditor(editor)).trim()) {
      updateStatus('引き継ぐ文章がないよ。',true);return;
    }
    if(!window.confirm('iPadの現在の下書きを、iPhoneとの同期対象として引き継ぐ？ 送信はしないよ。')) return;
    lastApplied=readEditor(editor); lastSeq=-1; recordOwnedDraft(lastApplied);
    if(!active) allowReceive();
    else {allowed=true;updateStatus('この文章を引き継いだよ。iPhone側で文章を再同期してね。');}
  }
  async function probePeer() {
    if(mode!=='send'||!active||!key)return;
    const epoch=generation;
    try{await publish('down',{type:'hello',sid:sessionId},epoch);
      if(epoch===generation && !connected)updateStatus('iPadの応答を確認中…');
    }catch(e){if(epoch===generation)updateStatus('通信確認失敗：'+e.message,true);}
  }
  function restartListenerIfStale(minIdleMs = STREAM_IDLE_RESTART_MS) {
    if(!active || !key || document.visibilityState==='hidden') return false;
    if(now()-lastInboundAt<minIdleMs || now()-lastWatchdogRestartAt<30000) return false;
    // Safari can leave a nominally open SSE stream unable to deliver messages.
    // Recreate just the stream without resetting the pairing, draft, or send receipt.
    lastWatchdogRestartAt=now();
    ++transportCycle;
    clearTimeout(fallbackTimer);clearTimeout(retryTimer);clearTimeout(pollingTimer);
    try{stream?.abort?.()}catch(_){} stream=null;
    listen(mode==='send'?'up':'down',generation);
    return true;
  }
  function resumeAfterForeground() {
    if(!active)return;
    if(mode==='send') {
      if(connected && now()-lastReceiverAckAt>PEER_TIMEOUT_MS){connected=false;remoteShare=null;updateRemoteShareState();refreshSendButton();}
      restartListenerIfStale(28000);
      // A lost receipt does not authorize retrying the ChatGPT post.
      probePeer();
    } else if(mode==='receive') {
      restartListenerIfStale(28000);
    }
  }
  function startHealthChecks() {
    clearInterval(healthTimer);
    healthTimer=setInterval(()=>{
      if(!active || !key || document.visibilityState==='hidden')return;
      const rotated = restartListenerIfStale(mode==='send'?45000:65000);
      if(mode==='send') {
        const age=now()-lastReceiverAckAt;
        if(connected && age>PEER_TIMEOUT_MS) {
          connected=false;remoteShare=null;updateRemoteShareState();
          updateStatus('iPadの応答が止まったよ。自動で再接続中…（下書きは保存済み）',true);
          refreshSendButton();
        }
        // Confirm the *iPad's* response, not merely a successful relay POST.
        if((!connected || rotated) && now()-lastHealthProbeAt>18000) {
          lastHealthProbeAt=now();probePeer();
        }
      } else if(mode==='receive' && rotated) {
        updateStatus('中継の受信を自動で再接続中…（下書きは保持）');
      }
    },12000);
  }
  let replyObserver = 0, observedReply = '', deliveredReply = '', replyChangedAt = 0;

  function updateConnectionBadge() {
    const state=el('#skr-connection-state');
    if(!state)return;
    const good = active && (mode==='receive' ? allowed && connected : connected);
    let kind = good ? 'online' : active ? 'waiting' : 'offline';
    state.dataset.state=kind;
    state.textContent=good?'● '+(mode==='send'?'iPad 接続中':'iPhone 接続中'):
      active?'◌ 接続を確認中':'○ 未接続';
    state.setAttribute('aria-label','接続状態：'+state.textContent);
  }
  function updateStatus(text, bad = false) {
    statusText = text; statusBad = bad;
    const e = el('#skr-status');
    if (e) {e.textContent=text.length>260?text.slice(0,240)+'…（詳細は接続設定で確認）':text;e.dataset.error=String(bad);}
    updateConnectionBadge();
    refreshSendButton();
  }
  function refreshSendButton() {
    const b=el('#skr-remote-send');
    if(b){
      b.disabled=!connected||!active||!!pendingSend;
      b.textContent=pendingSend?'送信を確認しています…':'↗  iPadへ送信';
    }
    const unsure=el('#skr-confirm-posted');
    if(unsure)unsure.hidden=!!pendingSend||!ambiguousSendText||
      (el('#skr-typing')?.value||'')!==ambiguousSendText;
  }
  function confirmPostedAndClear() {
    if(pendingSend){updateStatus('送信確認中だよ。完了まで待ってね。',true);return;}
    const input=el('#skr-typing');
    if(!input?.value)return;
    if(!window.confirm('iPadのChatGPTに投稿済みであることを確認した？\n確認できた場合だけ、このiPhoneの下書きを消去するよ。'))return;
    saveHistory(input.value);
    input.value='';sentText='';ambiguousSendText='';saveDraft('');
    clearTimeout(typingTimer);refreshDraftCount();refreshSendButton();
    updateStatus('投稿済みを確認して、iPhoneの下書きを消したよ。');
  }
  async function setupCrypto(pairCode) {
    const topicHash = await crypto.subtle.digest('SHA-256', encoder.encode('SKR4/topic/' + pairCode));
    const keyHash = await crypto.subtle.digest('SHA-256', encoder.encode('SKR4/key/' + pairCode));
    topicRoot = 'skr4-' + hex(topicHash).slice(0, 32);
    key = await crypto.subtle.importKey('raw', keyHash, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  async function encrypt(packet) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = encoder.encode(JSON.stringify(packet));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
    return JSON.stringify({ v: 4, i: b64(iv), c: b64(ciphertext) });
  }
  async function decrypt(data) {
    const packet = JSON.parse(data);
    if (packet.v !== 4) throw new Error('version mismatch');
    const decoded = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: un64(packet.i) }, key, un64(packet.c));
    return JSON.parse(decoder.decode(decoded));
  }
  function topic(direction) { return topicRoot + '-' + direction; }
  function endpoint(direction) { return SERVICE + topic(direction); }
  function safeChatUrl(raw) {
    try { const u = new URL(raw);
      return (u.protocol === 'https:' && (u.hostname === 'chatgpt.com' || u.hostname === 'chat.openai.com') && /^\/c\/[a-zA-Z0-9-]+$/.test(u.pathname)) ? u.origin+u.pathname : '';
    } catch(_) { return ''; }
  }
  function currentChatUrl() { return !STANDALONE ? safeChatUrl(location.href) : ''; }
  function gm(options) {
    if (typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function') return GM.xmlHttpRequest(options);
    // Fetch transport for the independently hosted HTTPS sender. Cross-origin
    // ntfy requests require the relay server to permit CORS; not guaranteed.
    if (!STANDALONE) throw new Error('UserscriptsのGM通信が使えないよ');
    const controller = new AbortController();
    const headers = { ...(options.headers || {}) };
    delete headers['X-Priority']; // avoid extra CORS preflight for text payloads
    const init = { method: options.method || 'GET', headers, body: options.data,
      signal: controller.signal, cache: 'no-store' };
    const promise = fetch(options.url, init).then(async r => {
      const response = options.responseType === 'arraybuffer' ? await r.arrayBuffer() : await r.text();
      return { status: r.status, response, responseText: typeof response === 'string' ? response : '' };
    });
    promise.abort = () => controller.abort();
    return promise;
  }

  function disconnect() {
    stopReplyPicker();
    generation++; active = false; connected = false; allowed = false;
    lastReceiverAckAt=0;lastInboundAt=0;lastReceiverContactAt=0;lastHealthProbeAt=0;lastWatchdogRestartAt=0;lastDraftAckSeq=0;++transportCycle;clearInterval(healthTimer);
    key = null; topicRoot = ''; currentSender = ''; lastSeq = -1; lastApplied = null; seq = 0;
    remoteShare = null; receiverChatUrl = ''; updateRemoteShareState();
    relayPostAt = relayPollAt = handshakeStartAt = 0; relayError = '';
    incomingCount=decryptOkCount=decryptFailCount=helloCount=ackSentCount=0;
    pollEvents=pollTextBytes=pollMessageRows=pollParseFailures=rxSseEvents=0;
    seenIds.clear();
    clearTimeout(fallbackTimer); clearTimeout(retryTimer); clearTimeout(pollingTimer); clearTimeout(parallelPollTimer);
    clearInterval(pingTimer); clearTimeout(typingTimer); clearTimeout(verifyTimer); clearTimeout(pendingAuto);
    clearTimeout(pendingSendTimer); clearTimeout(replyTimer); replyBusy = false;
    if (pendingReply) clearTimeout(pendingReply.timer); pendingReply = null;
    sendRescueTimers.forEach(clearTimeout); sendRescueTimers = [];
    clearInterval(replyObserver); replyObserver=0;
    pendingSend = null; receiverSending = false; manualWatch = false;
    completedRequests.clear(); completedFiles.clear(); latestReceipt.clear(); receivedFiles.clear(); sendingFile = false;
    try { stream?.abort?.(); } catch (_) {}
    stream = null; publishing = false;
  }

  function findEditor() {
    for (const selector of [
      '#prompt-textarea', '[data-testid="prompt-textarea"]',
      'div.ProseMirror[contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]'
    ]) {
      const e = el(selector);
      if (e && !e.closest('#skr-panel')) return e;
    }
    return null;
  }
  function readEditor(editor) {
    if (!editor) return '';
    if ('value' in editor && (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT')) return editor.value;
    // ProseMirror renders multiline input as sibling paragraphs on iPad Safari.
    // innerText can add extra blank lines between them; read the actual paragraph units.
    const blocks=[...editor.children];
    if(editor.classList?.contains('ProseMirror') && blocks.length && blocks.every(n=>n.tagName==='P')) {
      return blocks.map(n=>{
        const value=n.innerText??n.textContent??'';
        return value.replace(/\n$/,'');
      }).join('\n');
    }
    return editor.innerText ?? editor.textContent ?? '';
  }
  function normalize(s) {
    return String(s ?? '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').replace(/[\u200b\u2060\ufeff]/g, '').replace(/\n+$/g, '');
  }
  function writeEditor(editor, text) {
    try {
      if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
        const proto = editor.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(editor, text); else editor.value = text;
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
        return true;
      }
      if (!editor.isContentEditable) return false;
      editor.focus();
      const selection = window.getSelection(), range = document.createRange();
      range.selectNodeContents(editor); selection.removeAllRanges(); selection.addRange(range);
      return document.execCommand(text ? 'insertText' : 'delete', false, text || undefined);
    } catch (_) { return false; }
  }
  function applyDraft(text, n, sid) {
    if (mode !== 'receive' || !allowed || typeof text !== 'string' || text.length > MAX_TEXT || !Number.isSafeInteger(n)) return;
    if (sid !== currentSender || n <= lastSeq) return;
    const editor=findEditor();
    if(!editor){updateStatus('入力欄が見つからないよ。会話を開いてね。',true);return;}
    const current=normalize(readEditor(editor));
    const previouslyOwned=lastApplied===null?loadOwnedDraft():lastApplied;
    if(current.trim() && previouslyOwned===null){
      updateStatus('iPad側の文章を保護中。消さずに「今の下書きをiPhoneの入力として引き継ぐ」を押してね。',true);return;
    }
    if(previouslyOwned!==null && current!==normalize(previouslyOwned) && current!==normalize(text) && current.trim()){
      allowed=false;
      updateStatus('iPad側で変更された文章を保護したよ。復旧ボタンで引き継げるよ。',true);return;
    }
    if(current!==normalize(text) && !writeEditor(editor,text)){
      updateStatus('iPad入力欄への書き込みに失敗。文章は消さずに保持するよ。',true);return;
    }
    lastApplied=text;lastSeq=n;
    clearTimeout(verifyTimer);
    updateStatus('iPadの入力欄へ反映中… '+text.length+'文字');
    // A text editor returning true does not prove that React adopted the update.
    // ACK only after checking the actual iPad composer after its render cycle.
    const epoch=generation;
    const verifyApplied=(attempt)=>{
      if(epoch!==generation||mode!=='receive'||sid!==currentSender||lastSeq!==n)return;
      const latest=findEditor(), actual=latest?normalize(readEditor(latest)):null;
      if(actual===normalize(text)){
        recordOwnedDraft(text);
        updateStatus(text.length?'iPhoneの下書きを反映したよ：'+text.length+'文字':'iPadの入力欄も空になったよ');
        publish('up',{type:'draft_ack',sid,seq:n,length:text.length},epoch).catch(()=>{});
      }else if(attempt<2){
        // Give React/Safari time to commit changes; never overwrite an unrelated draft.
        verifyTimer=delay(()=>verifyApplied(attempt+1),700);
      }else{
        if(actual && actual.trim() && actual!==normalize(text))allowed=false;
        updateStatus('iPadの表示が同期内容と一致しないよ。文章を保持して、復旧操作を待ってるね。',true);
      }
    };
    verifyTimer=delay(()=>verifyApplied(0),420);
  }


  // Send only the ChatGPT composer button, never a general button on the page.
  function findChatSendButton() {
    const editor = findEditor();
    if (!editor) return null;
    const selectors = [
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'button[aria-label="メッセージを送信"]',
      'button[aria-label="送信"]'
    ];
    const form = editor.closest('form');
    for (const selector of selectors) {
      const candidate = (form && form.querySelector(selector)) || document.querySelector(selector);
      if (candidate && !candidate.closest('#skr-panel') && !candidate.disabled &&
          candidate.getAttribute('aria-disabled') !== 'true' &&
          candidate.getClientRects().length > 0) return candidate;
    }
    return null;
  }
  // ChatGPT changes the rendered conversation markup fairly often. Accept
  // explicit author markers, user-message testids, and turn wrappers.
  // A ChatGPT build can have a <main> for navigation or a blank placeholder,
  // while conversation messages are rendered in another React region. Never
  // assume the first <main> contains the conversation.
  const chatMarkers = '[data-message-author-role],[data-testid^="conversation-turn-"],[data-testid="user-message"],[data-testid="assistant-message"],[data-testid^="assistant-message-"],.markdown,.prose';
  function conversationRoot() {
    const roots = [...document.querySelectorAll('main,[role="main"],#thread,[data-testid="conversation-panel"],[data-testid="conversation-view"]')];
    let winner = null, score = 0;
    for (const root of roots) {
      if (root.closest('#skr-panel')) continue;
      const current = root.querySelectorAll(chatMarkers).length;
      if (current > score) { winner = root; score = current; }
    }
    // If all likely areas have zero markers, scan body instead of the wrong
    // <main>. Strict filters below still prevent our own UI being shared.
    return winner || document.body;
  }
  function userMessages() {
    const root=conversationRoot();
    const selectors = [
      '[data-message-author-role="user"]',
      '[data-testid="user-message"]',
      '[data-testid^="user-message-"]',
      '[data-author="user"]', '[data-role="user"]',
      '[data-testid="user-turn"]', '[class*="user-message-bubble"]'
    ];
    const matches = [...root.querySelectorAll(selectors.join(','))]
      .filter(n=>!n.closest('#skr-panel') && !n.closest('form') && !n.closest('[contenteditable="true"]'));
    const turns = matches.map(n=>n.closest('[data-testid^="conversation-turn-"]') ||
        n.closest('article') || n);
    // Find the chat-turn container when both direct and indirect nodes exist.
    return [...new Set(turns)];
  }
  function countRenderedExactUserText(text) {
    const expected=normalize(text).replace(/\s+/g,' ').trim();
    if (!expected) return 0;
    // Conservative fallback for versions of ChatGPT that omit author markers.
    // Require exact content inside a leaf element of the conversation and also
    // a cleared composer before treating a send as acknowledged.
    const root=conversationRoot();
    const nodes=root.querySelectorAll('p, [data-testid="user-message"], [class*="user-message-bubble"]');
    let matches=0;
    for (const n of nodes) {
      if(n.closest('#skr-panel, nav, [role="navigation"]') || n.closest('form') || n.closest('[contenteditable="true"]'))continue;
      const val=normalize(n.innerText || n.textContent || '').replace(/\s+/g,' ').trim();
      if(val===expected)matches++;
    }
    return matches;
  }
  function submittedMessageVisible(text, priorCount, priorLast, beforeRenderedCount=0) {
    const messages = userMessages();
    const last = messages[messages.length - 1];
    if (last && (messages.length > priorCount || last !== priorLast)) {
      const shown=normalize(last.innerText || last.textContent || '').replace(/\s+/g,' ').trim();
      const expected=normalize(text).replace(/\s+/g,' ').trim();
      if(expected && (shown===expected || shown.includes(expected)))return true;
    }
    const editor=findEditor();
    if(editor && !normalize(readEditor(editor)).trim() &&
       countRenderedExactUserText(text)>beforeRenderedCount) return true;
    return false;
  }
  async function awaitChatSubmission(text, beforeCount, priorLast, epoch, timeoutMs=15000, beforeRenderedCount=0) {
    const limit = now()+timeoutMs;
    while(epoch===generation && now()<limit){
      if(submittedMessageVisible(text,beforeCount,priorLast,beforeRenderedCount))return true;
      await new Promise(r=>delay(r,300));
    }
    return false;
  }
  async function editorStayedEmpty(epoch, waitMs=1500) {
    // This signal is weaker than a rendered user turn: a blank editor is not
    // proof of server delivery. Only consider it AFTER this app clicked Send.
    const until=now()+waitMs;
    let clearedSince=0;
    while(epoch===generation && now()<until) {
      const editor=findEditor();
      if(!editor) return false;
      if(normalize(readEditor(editor)).trim())clearedSince=0;
      else if(!clearedSince)clearedSince=now();
      else if(now()-clearedSince>=850)return true;
      await new Promise(r=>delay(r,170));
    }
    return false;
  }
  function receivedDraftOk(text, n, sid) {
    if (!allowed || sid !== currentSender || !active) return false;
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) return false;
    if (!Number.isSafeInteger(n) || n < lastSeq) return false;
    const editor = findEditor();
    if (!editor) return false;
    const existing = normalize(readEditor(editor));
    const owned=lastApplied===null?loadOwnedDraft():lastApplied;
    // Never override an unrelated draft created on the iPad.
    if (existing.trim() && owned === null && existing !== normalize(text)) return false;
    if (existing.trim() && owned !== null && existing !== normalize(owned) && existing !== normalize(text)) return false;
    if (existing !== normalize(text) && !writeEditor(editor, text)) return false;
    lastApplied = text;recordOwnedDraft(text);
    lastSeq = Math.max(lastSeq, n);
    return true;
  }
  async function handleSendRequest(packet, epoch) {
    if (epoch !== generation || mode !== 'receive') return;
    const { sid, id, seq: n, text } = packet;
    if (typeof sid !== 'string' || typeof id !== 'string' || id.length > 80) return;
    if (completedRequests.has(id)) return; // Never re-submit on duplicate relay messages.
    completedRequests.add(id);
    if (completedRequests.size > 150) completedRequests.delete(completedRequests.values().next().value);
    const reply = async (ok, message, verified = ok) => {
      const receipt = { type: 'send_result', sid, id, ok, verified, message, text: ok ? text : '' };
      latestReceipt.set(id, receipt);
      if (latestReceipt.size > 25) latestReceipt.delete(latestReceipt.keys().next().value);
      try { await publish('up', receipt, epoch); }
      catch (e) { if (epoch === generation) updateStatus('送信結果の返信に失敗：' + e.message, true); }
    };
    if (!allowed || !active || sid !== currentSender || receiverSending) {
      await reply(false, 'iPadが受信準備中、または別の送信を処理中だよ。'); return;
    }
    if (!receivedDraftOk(text, n, sid)) {
      await reply(false, 'iPadの下書きが違うか、入力欄に書き込めないよ。'); return;
    }
    receiverSending = true;
    try {
      // Wait for React to settle before pressing the send button.
      await new Promise(r => delay(r, 260));
      if (epoch !== generation) return;
      const editor = findEditor();
      if (!editor || normalize(readEditor(editor)) !== normalize(text)) {
        await reply(false, '入力欄の文章が変わったよ。送信はしていないよ。'); return;
      }
      const sendButton = findChatSendButton();
      if (!sendButton) {
        await reply(false, 'ChatGPTの送信ボタンが見つからない／無効だよ。iPadを確認してね。'); return;
      }
      const priorMessages = userMessages();
      const baselineReply = lastAssistantNode();
      const beforeAssistantText=baselineReply?(baselineReply.innerText||baselineReply.textContent||'').trim():'';
      const beforeCount = priorMessages.length, beforeLast = priorMessages[beforeCount - 1];
      const beforeRenderedCount=countRenderedExactUserText(text);
      sendButton.click();
      let verified = await awaitChatSubmission(text, beforeCount, beforeLast, epoch, 21500, beforeRenderedCount);
      if (epoch !== generation) return;
      if(!verified){
        // Fallback for ChatGPT UIs without author-role DOM markers: after this
        // exact Send click, a new/changed assistant turn AND an empty composer
        // is strong evidence of a submitted prompt.
        const latest=lastAssistantNode();
        const afterText=latest?(latest.innerText||latest.textContent||'').trim():'';
        const emptyComposer=!!findEditor()&&!normalize(readEditor(findEditor())).trim();
        verified=emptyComposer&&!!afterText&&
          (latest!==baselineReply || afterText!==beforeAssistantText)&&
          (userMessages().length>beforeCount || latest!==baselineReply || afterText.length>beforeAssistantText.length+8);
      }
      if(!verified){
        // A blank composer can be temporary while ChatGPT/React re-renders.
        // Never erase the sender's only draft without seeing a posted user turn.
        if (await editorStayedEmpty(epoch)) {
          await reply(false, 'iPad入力欄は空に見えるけど、投稿を確認できなかったよ。iPhoneの下書きは保持したよ。送信済みかiPadで確認してね。', false);
          updateStatus('投稿の成功を確認できなかったよ。iPhoneの下書きを保持したよ。',true);
          return;
        }
        await reply(false, '投稿確認ができず、iPadの入力欄にも文章が残っている可能性があるよ。iPadで確かめてね。二重送信は禁止。');
        updateStatus('送信の成否を確認できないよ。iPadで確かめてね。', true);
        return;
      }
      lastApplied = null;recordOwnedDraft('');
      clearTimeout(verifyTimer);
      updateStatus('iPhoneからの送信が完了したよ！');
      await reply(true, 'iPadに投稿したことを確認できたよ！');
      // The independent reply observer also works when ChatGPT's send DOM changes.
    } catch (e) {
      await reply(false, '送信処理エラー：' + (e?.message || '不明'));
    } finally { receiverSending = false; }
  }
  function handleSendResult(packet) {
    if (mode !== 'send' || !pendingSend || packet.sid !== sessionId || packet.id !== pendingSend.id) return;
    const original = pendingSend.text;
    pendingSend = null;
    clearTimeout(pendingSendTimer);
    sendRescueTimers.forEach(clearTimeout); sendRescueTimers=[];
    if (!packet.ok) {
      ambiguousSendText=original;
      updateStatus('遠隔送信：' + (packet.message || '完了を確認できないよ。iPadを確認してね。')+'／投稿済みなら下の「送信済みを確認してクリア」を押してね。', true);
      refreshSendButton();return;
    }
    ambiguousSendText='';
    const typing = el('#skr-typing');
    // Do not clear text that the user changed while waiting for confirmation.
    saveHistory(original);
    if (typing && typing.value === original) {
      typing.value = '';
      sentText = '';
      saveDraft('');
      clearTimeout(typingTimer);refreshDraftCount();
    }
    const note = packet.verified === false
      ? 'iPadの入力欄は空になったよ。ただし投稿完了は未確認。文章は「前回の文章」から復元できるよ。'
      : '投稿を確認したよ！次の文章を入力してね。';
    updateStatus(typing && typing.value === '' ? note : '送信操作後も、新しく入力した文章は残したよ。' );
    // Receiver's composer is already empty, so no destructive clear is needed.
    refreshSendButton();
  }
  async function rescueIncoming(epoch, requestId) {
    if (epoch !== generation || !pendingSend || pendingSend.id !== requestId || !topicRoot) return;
    try {
      // An SSE connection may appear open but fail to deliver events in iOS Safari.
      const since = String(Math.floor(now() / 1000) - 90);
      const res = await gm({method:'GET',url:endpoint('up')+'/json?poll=1&since='+since,
                            responseType:'text',timeout:12000});
      if (res.status !== 200) return;
      for (const line of String(res.responseText || '').split('\n')) {
        if (!line.trim()) continue;
        try {const m=JSON.parse(line);if(m.event==='message')receiveOne(m.id,m.message,epoch);}catch(_){}
      }
    } catch(_) { /* normal subscription remains in charge */ }
  }
  function scheduleReceiptRecovery(epoch, requestId) {
    sendRescueTimers.forEach(clearTimeout); sendRescueTimers=[];
    for (const ms of [4500,10000,18500,27000]) {
      sendRescueTimers.push(delay(()=>{
        if (epoch !== generation || pendingSend?.id !== requestId) return;
        rescueIncoming(epoch,requestId);
        publish('down',{type:'receipt_query',sid:sessionId,id:requestId},epoch).catch(()=>{});
      },ms));
    }
  }
  async function requestRemoteSend() {
    if (mode !== 'send' || !active || !connected || pendingSend) {
      updateStatus('まだ接続していないか、送信結果を待っているよ。', true); return;
    }
    if (composition) { updateStatus('日本語を変換確定してから送信してね。'); return; }
    const typing = el('#skr-typing');
    const text = typing?.value || '';
    if (!text.trim()) { updateStatus('送る文章が空だよ。'); return; }
    if (text.length > MAX_TEXT) { updateStatus('文章が長すぎるよ。', true); return; }
    if (settings.confirm && !window.confirm('この文章をiPadのChatGPTに投稿する？\n\n' + text.slice(0,180) + (text.length>180?'…':''))) {
      updateStatus('送信を取り消したよ。下書きは残っているよ。'); return;
    }
    clearTimeout(typingTimer);
    const request = { id: randomId(), text };
    pendingSend = request; ambiguousSendText='';
    refreshSendButton();
    const epoch = generation;
    pendingSendTimer = delay(() => {
      if (epoch !== generation || pendingSend?.id !== request.id) return;
      pendingSend = null; ambiguousSendText=request.text;
      updateStatus('送信結果を確認できないよ。iPadで投稿済みなら、下の「送信済みを確認してクリア」を使ってね（二重送信しないで）。',true);
      refreshSendButton();
    }, 33000);
    // Recovery only polls for receipts; it NEVER resends the actual post.
    scheduleReceiptRecovery(epoch, request.id);
    try {
      await publish('down', { type: 'send_request', sid: sessionId, id: request.id, seq: ++seq, text }, epoch);
      if (epoch === generation) updateStatus('iPadで送信処理中…結果を待ってるよ。');
    } catch (e) {
      if (epoch === generation && pendingSend?.id === request.id) {
        pendingSend = null; clearTimeout(pendingSendTimer);
        ambiguousSendText='';
        updateStatus('送信命令を届けられなかった：' + e.message, true);
        refreshSendButton();
      }
    }
  }
  // Also clear the iPhone typing area if someone physically presses Send on the iPad.
  async function observeManualSend() {
    if (mode !== 'receive' || !allowed || !active || receiverSending || manualWatch || !lastApplied) return;
    const text = lastApplied;
    const sid = currentSender;
    const epoch = generation;
    const priorMessages = userMessages();
    const beforeCount = priorMessages.length, beforeLast = priorMessages[beforeCount - 1];
    const beforeRenderedCount=countRenderedExactUserText(text);
    manualWatch = true;
    try {
      const verified = await awaitChatSubmission(text, beforeCount, beforeLast, epoch, 7000, beforeRenderedCount);
      if (!verified || epoch !== generation || sid !== currentSender) return;
      lastApplied = null;recordOwnedDraft('');
      clearTimeout(verifyTimer);
      updateStatus('iPadから送信したよ。iPhoneの入力欄も消すね。');
      publish('up', { type: 'sent_notice', sid, text }, epoch)
        .catch(e => updateStatus('入力欄消去の通知に失敗：' + e.message, true));
    } finally { manualWatch = false; }
  }
  document.addEventListener('click', e => {
    if (mode === 'receive' && !receiverSending && findChatSendButton() === e.target?.closest?.('button')) {
      // Capture listener fires before ChatGPT handles the user's real click.
      observeManualSend();
    }
  }, true);

  async function publish(direction, packet, epoch = generation) {
    if (epoch !== generation || !key) return;
    const payload = await encrypt({ ...packet, ts: now() });
    // ntfy treats a message larger than 4096 bytes as an attachment.
    // Never accidentally publish encrypted message JSON as an attachment.
    if (encoder.encode(payload).byteLength > 3800) throw new Error('文章が中継の容量上限を超えたよ。短く分けて送ってね。');
    if (epoch !== generation) return;
    const res = await gm({ method: 'POST', url: endpoint(direction), data: payload,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Priority': '1' }, timeout: 12000 });
    if (res.status < 200 || res.status >= 300) {
      relayError = '中継への投稿 HTTP ' + res.status + (res.status === 429 ? '（無料枠の制限）' : '');
      throw new Error(relayError);
    }
    relayPostAt = now(); relayError = '';
  }

  function receiveOne(id, body, epoch) {
    if (epoch !== generation || !body || seenIds.has(id)) return;
    lastInboundAt=now();seenIds.add(id);
    if(mode==='receive')incomingCount++;
    if (seenIds.size > 150) seenIds = new Set([...seenIds].slice(-70));
    Promise.resolve().then(() => decrypt(body)).then(packet => {
      if(mode==='receive')decryptOkCount++;
      if (epoch !== generation || !packet || now() - packet.ts > 120000 || packet.ts - now() > 60000) return;
      if (mode === 'receive') {
        lastReceiverContactAt=now();
        if (packet.type === 'hello' && typeof packet.sid === 'string') {
          helloCount++;
          connected = true;
          if (currentSender !== packet.sid) { currentSender = packet.sid; lastSeq = -1; }
          updateStatus('iPhoneを認識したよ！入力を待ってるね。');
          publish('up', { type: 'ack', sid: packet.sid, chatUrl: currentChatUrl() }, epoch).then(() => {ackSentCount++;announceShareState(epoch)}).catch(e => updateStatus('応答エラー：' + e.message, true));
        } else if (packet.type === 'draft' && typeof packet.sid === 'string') {
          connected = true;
          if (currentSender !== packet.sid) { currentSender = packet.sid; lastSeq = -1; }
          if (!receiverSending) applyDraft(packet.text, packet.seq, packet.sid);
        } else if (packet.type === 'send_request' && typeof packet.sid === 'string') {
          handleSendRequest(packet, epoch);
        } else if (packet.type === 'receipt_query' && packet.sid === currentSender) {
          const receipt = latestReceipt.get(packet.id);
          if (receipt && receipt.sid === packet.sid) publish('up', receipt, epoch).catch(() => {});
        } else if (packet.type === 'file_offer' && packet.sid === currentSender) {
          handleFileOffer(packet, epoch);
        } else if (packet.type === 'diagnostic_request' && packet.sid === currentSender) {
          // No conversation text, page URL, credentials, identifiers or selectors transmitted.
          const summary=replyDiagnostics();
          publish('up',{type:'diagnostic_result',sid:packet.sid,id:packet.id||'',summary},epoch).catch(e=>updateStatus('診断の送信失敗：'+e.message,true));
        } else if (packet.type === 'reply_request' && packet.sid === currentSender) {
          if (!settings.replies) {
            announceShareState(epoch);
            publish('up',{type:'reply_unavailable',sid:packet.sid,id:packet.id||'',reason:'iPadで返信共有がオフになっているよ。iPad側でオンにしてね。'},epoch).catch(()=>{});
          } else sendReplySnapshot(epoch, packet.sid, packet.id || '').catch(e => {
            publish('up',{type:'reply_unavailable',sid:packet.sid,id:packet.id||'',reason:'iPadで返信を取得できなかった：'+e.message},epoch).catch(()=>{});
          });
        }
      } else if (mode === 'send' && packet.type === 'ack' && packet.sid === sessionId) {
        const firstAck=!connected;
        lastReceiverAckAt=now();connected=true;
        receiverChatUrl = safeChatUrl(packet.chatUrl || '');
        const chatHint=el('#skr-chat-link-hint');if(chatHint)chatHint.textContent=receiverChatUrl?'iPadの会話が見つかったよ。タップで全文を開ける！':'iPadで会話を開いた状態で「iPadの会話を確認」を押してね。';
        updateStatus(firstAck?'iPadが応答したよ。下書きを確認するね。':'iPadから応答あり・接続を確認したよ。');
        if(firstAck && !pendingSend) sendDraft(true);
        refreshSendButton();
      } else if (mode === 'send' && packet.type === 'draft_ack' && packet.sid === sessionId) {
        lastReceiverAckAt=now();connected=true;
        const current=el('#skr-typing')?.value??'';
        if(Number.isSafeInteger(packet.seq) && packet.seq >= lastDraftAckSeq) {
          lastDraftAckSeq=packet.seq;
          if(packet.seq===seq && current.length===packet.length)
            updateStatus('iPadへの文字反映を確認：'+packet.length+'文字');
        }
        refreshSendButton();
      } else if (mode === 'send' && packet.type === 'send_result' && packet.sid === sessionId) {
        lastReceiverAckAt=now();connected=true;handleSendResult(packet);
      } else if (mode === 'send' && packet.type === 'file_result' && packet.sid === sessionId) {
        updateStatus(packet.message || 'iPadがファイルを受け取ったよ。');
        updateFileProgress('④ iPadの報告：'+(packet.message || '受信通知あり')+' ※ChatGPT上の添付完了はiPadで確認してね。',
          /失敗|見つからない|エラー/.test(packet.message||''));
      } else if (mode === 'send' && packet.type === 'reply_snapshot' && packet.sid === sessionId) {
        if(remoteShare===false)return; // don't redisplay a delayed reply after sharing is disabled
        if (pendingReply && (!packet.id || pendingReply.id === packet.id)) {clearTimeout(pendingReply.timer);pendingReply=null;}
        showReply(packet.text, packet.stamp);
      } else if (mode === 'send' && packet.type === 'reply_unavailable' && packet.sid === sessionId) {
        if (pendingReply && (!packet.id || pendingReply.id === packet.id)) {clearTimeout(pendingReply.timer);pendingReply=null;}
        updateStatus(packet.reason || 'iPadから返信を読み取れなかったよ。',true);
        const box=el('#skr-reply');if(box)box.textContent=packet.reason||'返信を読み取れなかったよ。';
      } else if (mode === 'send' && packet.type === 'diagnostic_result' && packet.sid === sessionId) {
        const d=packet.summary;
        if(d && d.version && Number.isInteger(d.assistantCandidates)) {
          const e=el('#skr-remote-debug');
          if(e) e.textContent='iPad 診断 v'+String(d.version).slice(0,20)+'：'+conciseDiagnostics(d);
          updateStatus('iPadの診断を受信したよ。返信カード内に結果を表示したよ。');
        }
      } else if (mode === 'send' && packet.type === 'share_state' && packet.sid === sessionId) {
        remoteShare = !!packet.enabled; updateRemoteShareState();
        if(!remoteShare){lastReplyText='';const box=el('#skr-reply');if(box)box.textContent='返信共有がオフです。iPad側でオンにしてね。';}
      } else if (mode === 'send' && packet.type === 'sent_notice' && packet.sid === sessionId) {
        const typing = el('#skr-typing');
        if (typing && normalize(typing.value) === normalize(packet.text)) {
          saveHistory(packet.text);
          typing.value = ''; sentText = ''; saveDraft('');
          clearTimeout(typingTimer);
          updateStatus('iPadからの送信を確認！入力欄を空にしたよ。');
        }
      }
    }).catch(() => { if(mode==='receive')decryptFailCount++; /* encrypted messages from other sessions are ignored */ });
  }
  function assistantCandidates() {
    const root=conversationRoot();
    // Prefer explicit assistant markers and mark-up generated by ChatGPT.
    const primary=[...root.querySelectorAll([
      '[data-message-author-role="assistant"]', '[data-testid="assistant-message"]',
      '[data-testid^="assistant-message-"]', '[data-testid="assistant-turn"]',
      '[data-author="assistant"]', '[data-role="assistant"]'
    ].join(','))].filter(n=>!n.closest('#skr-panel'));
    if(primary.length)return [...new Set(primary.map(n=>n.closest('[data-testid^="conversation-turn-"]') || n.closest('article') || n))];
    // Some builds only mark conversation-turn-N and put the assistant's answer
    // in a markdown/prose subtree. Never pick a turn with a user marker.
    const turns=[...root.querySelectorAll('[data-testid^="conversation-turn-"],article[data-turn-id]')];
    const filtered=turns.filter(n=>!n.querySelector('[data-message-author-role="user"],[data-testid="user-message"],[class*="user-message-bubble"]') &&
      n.querySelector('[data-testid="message-content"],.markdown,.prose,[data-testid="assistant-message"]'));
    if(filtered.length)return filtered;
    // Last resort: a reply markdown container inside the actual main region.
    // A user message normally doesn't have markdown rendering, and this fallback
    // is deliberately conservative (no arbitrary page text / sidebar capture).
    return [...root.querySelectorAll('.markdown,.prose,[data-testid="message-content"]')].filter(n=>
      !n.closest('#skr-panel,nav,[role="navigation"],form,[contenteditable="true"],[data-message-author-role="user"],[data-testid="user-message"]') &&
      n.getClientRects().length > 0);

  }
  function lastAssistantNode() {
    const nodes=assistantCandidates();return nodes[nodes.length-1]||null;
  }
  function latestAssistantText() {
    const node=lastAssistantNode();if(!node)return '';
    const candidates=[node.querySelector('[data-testid="message-content"]'),
      node.querySelector('.markdown'),node.querySelector('.prose'),node].filter(Boolean);
    let full='';
    // Prefer a rich message body over turn controls (copy, regenerate, etc.).
    for(const item of candidates){
      const value=String(item.innerText||item.textContent||'').trim();
      if(value && !full)full=value;
      if(item!==node && value.length>full.length)full=value;
    }
    if(!full)return '';
    let part=full.slice(0,REPLY_LIMIT);
    while(encoder.encode(part).byteLength>1700)part=part.slice(0,-20);
    return part+(full.length>part.length?'\n…（続きはiPadで確認してね）':'');
  }
  function replyDiagnostics() {
    const root=conversationRoot();
    const q=(region,s)=>region.querySelectorAll(s).length;
    const body=document.body;
    const chat= s=>q(root,s);
    // Only structural counts; NEVER include chat text, URL, tokens or secrets.
    return {version:VERSION, scanRoot:root===body?'body':'content',
      mainCount:q(body,'main'), mainTextLength:(body.querySelector('main')?.innerText||'').length,
      bodyTextLength:(body.innerText||'').length,
      iframeCount:q(body,'iframe'),
      user:chat('[data-message-author-role="user"]'),
      assistant:chat('[data-message-author-role="assistant"]'),
      turns:chat('[data-testid^="conversation-turn-"]'),
      markdown:chat('.markdown'),prose:chat('.prose'),
      userMessage:chat('[data-testid="user-message"]'),
      globalUser:q(body,'[data-message-author-role="user"]'),
      globalAssistant:q(body,'[data-message-author-role="assistant"]'),
      globalMarkdown:q(body,'.markdown'),globalProse:q(body,'.prose'),
      globalArticle:q(body,'article'),globalParagraph:q(body,'p'),
      assistantCandidates:assistantCandidates().length,
      detectedLength:latestAssistantText().length,
      // Only structural hints, never message text/URL or user identity.
      // Shadow DOM contents are NOT traversed to prevent leaking unrelated components.
      shadowHosts:[...body.querySelectorAll('*')].filter(e=>!!e.shadowRoot).length,
      contentEditableCount:q(body,'[contenteditable="true"]'),
      roleLogCount:q(body,'[role="log"]'),
      ariaMessageCount:q(body,'[role="article"],[aria-roledescription="message"]'),
      paragraphOutsidePanel:[...body.querySelectorAll('p')].filter(e=>!e.closest('#skr-panel,nav,[role="navigation"]')).length,
      visibleParagraphs:[...body.querySelectorAll('p')].filter(e=>!e.closest('#skr-panel,nav,[role="navigation"]')&&e.getClientRects().length>0).length,
      manualPickedStructure:pickedReplyPathInfo ? {...pickedReplyPathInfo} : null
    };
  }
  function conciseDiagnostics(d) {
    return '返信候補 '+d.assistantCandidates+'件 ／ 会話ターン '+d.turns+'件 ／ 段落 '+d.visibleParagraphs+'件 ／ iframe '+d.iframeCount+'件。'+
      (d.assistantCandidates===0 ? '返信の目印を検出できていないよ。iPad側で「コピーした返信を転送」を試してね。':'返信候補があるよ。取得をもう一度試してね。');
  }
  async function requestRemoteDiagnostics() {
    if (!connected || mode!=='send') { updateStatus('iPadに接続してから診断してね。',true);return; }
    const epoch=generation;
    try { await publish('down',{type:'diagnostic_request',sid:sessionId,id:randomId()},epoch);updateStatus('iPadに返信の構造診断を依頼したよ。'); }
    catch(e){updateStatus('診断依頼失敗：'+e.message,true);}
  }
  function showDiagnostics() {
    const d=replyDiagnostics();
    const pre=el('#skr-debug-output');
    if(pre)pre.textContent=JSON.stringify(d,null,2);
    const readable=el('#skr-diagnostic-summary');
    if(readable)readable.textContent=conciseDiagnostics(d);
    updateStatus('返信検出の診断を更新したよ。本文は診断に含めていないよ。');
  }
  function showReply(text, stamp) {
    const host = el('#skr-reply');
    if (!host || typeof text !== 'string') return;
    lastReplyText = text;
    host.textContent = text || 'まだ返信がないよ。iPadのChatGPTを確認してね。';
    const when = el('#skr-reply-time');
    if (when) when.textContent = Number.isFinite(stamp) ? new Date(stamp).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'}) : '';
    if (text) updateStatus('iPadの返信を受信したよ！');
  }
  function updateRemoteShareState() {
    const e = el('#skr-remote-share-state');
    if (!e) return;
    e.textContent = remoteShare === true ? 'iPadの返信共有：オン（最新の返信を取得できます）'
      : remoteShare === false ? 'iPadの返信共有：オフ（iPad側でオンにできます）'
      : 'iPadの返信共有：確認中（接続後に状態を受信します）';
    e.dataset.enabled = String(remoteShare);
    e.setAttribute('role', 'status');
  }
  function updateLocalShareState() {
    const enabled = !!settings.replies;
    const btn = el('#skr-share-toggle');
    if (btn) {
      btn.textContent = enabled ? '✓ 返信共有：オン（タップでオフ）' : '× 返信共有：オフ（タップでオン）';
      btn.dataset.enabled = String(enabled);
      btn.setAttribute('aria-pressed', String(enabled));
      btn.setAttribute('aria-label', '返信をiPhoneに共有する設定：' + (enabled ? 'オン' : 'オフ'));
    }
    const state = el('#skr-share-status');
    if (state) state.textContent = enabled
      ? 'オン：接続したiPhoneから最新の返信を確認できます。'
      : 'オフ：iPhoneにはChatGPTの返信を共有しません。';
  }
  function announceShareState(epoch = generation) {
    if (mode === 'receive' && allowed && active && currentSender && key && epoch === generation) {
      publish('up', { type:'share_state', sid:currentSender, enabled:!!settings.replies }, epoch).catch(() => {});
    }
  }
  // iPad fallback: explicitly tap a displayed reply when ChatGPT provides no
  // recognizable assistant DOM markers. No automatic capture of arbitrary text.
  function stopReplyPicker() {
    if (pickerCapture) {document.removeEventListener('click', pickerCapture, true);document.removeEventListener('touchend', pickerCapture, true);}
    pickerCapture = null;
    if (replyPicker) replyPicker.remove();
    replyPicker = null;
    if (mode === 'receive') {
      const panel = el('#skr-panel'); if (panel) panel.hidden = false;
    }
  }
  function pickedReplyCandidate(target) {
    const from = target?.nodeType === 3 ? target.parentElement : target;
    if (!(from instanceof Element) || from.closest('#skr-panel,#skr-reply-picker-tip,nav,[role="navigation"],form,[contenteditable="true"]')) return null;
    const explicit = from.closest('[data-message-author-role="assistant"],[data-testid="assistant-message"],[data-testid^="conversation-turn-"],[data-testid="message-content"],.markdown,.prose,article');
    if (explicit && !explicit.closest('#skr-panel') && (explicit.innerText||'').trim()) return explicit;
    // Many ChatGPT builds render plain paragraphs without author markers.
    // Start from a tapped paragraph, then group nearby paragraphs only while
    // the group stays small enough not to swallow the full conversation.
    const leaf=from.closest('p,li,blockquote,pre,h1,h2,h3,h4,div')||from;
    let chosen=leaf, node=leaf;
    for(let level=0;level<5 && node?.parentElement;level++){
      const parent=node.parentElement;
      if(parent===document.body || parent.closest('#skr-panel,nav,[role="navigation"],form'))break;
      const raw=(parent.innerText||'').trim();
      const count=parent.querySelectorAll('p').length;
      if(!raw || raw.length>2600 || count>14 || parent.querySelectorAll('textarea,[contenteditable="true"]').length)break;
      // Only expand if a text grouping actually exists; arbitrary page wrappers
      // and navigation must never become share candidates.
      if(count>=2 && raw.length>=25 && raw.length<2600)chosen=parent;
      node=parent;
    }
    return chosen;
  }
  function startReplyPicker() {
    if(mode!=='receive' || !active || !allowed || !connected || !settings.replies || !currentSender){
      updateStatus('先に返信共有をオンにして、iPhoneへ接続してね。',true);return;
    }
    stopReplyPicker();
    const panel=el('#skr-panel');if(panel)panel.hidden=true;
    const tip=document.createElement('div');tip.id='skr-reply-picker-tip';tip.setAttribute('role','status');
    const msg=document.createElement('span');msg.textContent='ChatGPTに表示中の返信本文をタップしてね。送信前に内容を確認できるよ。';
    const cancel=document.createElement('button');cancel.type='button';cancel.textContent='中止';
    cancel.addEventListener('click',()=>stopReplyPicker());
    tip.append(msg,cancel);document.body.append(tip);replyPicker=tip;
    pickerCapture=async e=>{
      if(e.target?.closest?.('#skr-reply-picker-tip'))return;
      e.preventDefault();e.stopPropagation();e.stopImmediatePropagation?.();
      const node=pickedReplyCandidate(e.target);
      if(!node){msg.textContent='そこは返信の文章じゃないみたい。返信本文をタップしてね。';return;}
      const raw=(node.innerText||node.textContent||'').trim();
      if(!raw){msg.textContent='文章が見つからなかったよ。別の段落をタップしてね。';return;}
      const meta={tag:node.tagName,paragraphs:node.querySelectorAll('p').length,
        textLength:raw.length,source:node.matches('[data-message-author-role="assistant"],[data-testid="assistant-message"],.markdown,.prose')?'identified':'manual'};
      // Confirmation is required: DOM grouping is heuristic and can include
      // text surrounding the reply. Show both beginning and end of selection.
      const intro=raw.slice(0,150),outro=raw.length>200?'\n…\n末尾：'+raw.slice(-80):'';
      if(!window.confirm('この文章をiPhoneに転送する？\n範囲が違う場合はキャンセルして、別の段落をタップしてね。\n\n'+intro+outro))return;
      pickedReplyPathInfo=meta;
      stopReplyPicker();
      let content=raw.slice(0,REPLY_LIMIT);
      while(encoder.encode(content).byteLength>1700)content=content.slice(0,-20);
      if(raw.length>content.length)content+='\n…（続きはiPadで確認してね）';
      try {
        await publish('up',{type:'reply_snapshot',sid:currentSender,id:'',text:content,stamp:now()});
        updateStatus('選んだ返信をiPhoneに転送したよ。自動検出の改善用情報も診断欄で確認できるよ。');
      }catch(err){updateStatus('選んだ返信の転送に失敗：'+(err?.message||err),true);}
    };
    document.addEventListener('click',pickerCapture,true);
    // iOS Safari may not dispatch click for non-interactive paragraph elements.
    document.addEventListener('touchend',pickerCapture,{capture:true,passive:false});
  }

  async function shareSelectedReply() {
    if (mode !== 'receive' || !active || !allowed || !settings.replies || !currentSender) {
      updateStatus('返信共有をオンにして、iPhoneとの接続を確認してね。',true);return;
    }
    // This is a last-resort manual alternative when the chat DOM is not
    // exposed to the userscript. Only explicitly selected text is transferred.
    const selected=(window.getSelection()?.toString() || '').trim();
    if (!selected) { updateStatus('まずiPad上で返信文を長押しして、共有したい部分を選択してね。',true);return; }
    if (!window.confirm('選択した文章をiPhoneへ転送する？\n\n'+selected.slice(0,140)))return;
    let content=selected.slice(0,REPLY_LIMIT);
    while(encoder.encode(content).byteLength>1700)content=content.slice(0,-20);
    try {
      await publish('up',{type:'reply_snapshot',sid:currentSender,id:'',text:content,stamp:now()});
      updateStatus('選択した返信をiPhoneへ送ったよ。');
    } catch(e) { updateStatus('転送に失敗：'+e.message,true); }
  }
  async function shareCopiedReply() {
    if(mode!=='receive'||!active||!allowed||!settings.replies||!currentSender) {
      updateStatus('返信共有をオンにして、iPhoneとの接続を確認してね。',true);return;
    }
    if (!navigator.clipboard?.readText) {updateStatus('このSafariではクリップボード読み込みが使えないよ。選択テキスト方式を試してね。',true);return;}
    try {
      const raw=String(await navigator.clipboard.readText()||'').trim();
      if(!raw){updateStatus('コピーされた文章がないよ。返信をコピーしてから押してね。',true);return;}
      if(!window.confirm('クリップボードの文章をiPhoneへ共有する？\n\n'+raw.slice(0,130)))return;
      let value=raw.slice(0,REPLY_LIMIT);
      while(encoder.encode(value).byteLength>1700)value=value.slice(0,-20);
      await publish('up',{type:'reply_snapshot',sid:currentSender,id:'',text:value,stamp:now()});
      updateStatus('コピーした返信をiPhoneへ転送したよ。');
    } catch(e){ updateStatus('コピーした返信を読み込めなかったよ。Safariの権限を確認してね：'+e.message,true); }
  }
  function toggleReplySharing() {
    settings.replies = !settings.replies;
    saveSettings();
    if (!settings.replies) { clearTimeout(replyTimer); replyBusy = false; clearInterval(replyObserver); replyObserver=0; }
    else startReplyObserver();
    updateLocalShareState();
    announceShareState();
    updateStatus(settings.replies ? '返信共有をオンにしたよ。iPhoneでも状態を確認できるよ。' : '返信共有をオフにしたよ。');
  }
  async function sendReplySnapshot(epoch, sid, requestId = '') {
    if (mode !== 'receive' || !allowed || !settings.replies || sid !== currentSender || epoch !== generation) return;
    const text=latestAssistantText();
    if (!text) {
      await publish('up',{type:'reply_unavailable',sid,id:requestId,reason:'iPadで返信本文を自動検出できなかったよ。'+conciseDiagnostics(replyDiagnostics())},epoch);
      return;
    }
    await publish('up', { type:'reply_snapshot', sid, id:requestId, text, stamp:now() }, epoch);
    deliveredReply=text;
  }
  // Detect new answers independently of whether the web composer exposes a
  // successful-send signal. Only active when the user opted into reply sharing.
  function startReplyObserver() {
    clearInterval(replyObserver); replyObserver=0;
    if (!settings.replies || mode!=='receive' || !allowed || !active) return;
    const epoch=generation;
    observedReply=latestAssistantText();
    deliveredReply=observedReply; // don't spontaneously resend history on opt-in
    replyChangedAt=now();
    replyObserver=setInterval(()=>{
      if(epoch!==generation || !settings.replies || mode!=='receive' || !allowed || !active){clearInterval(replyObserver);replyObserver=0;return;}
      const text=latestAssistantText();
      if(text!==observedReply){observedReply=text;replyChangedAt=now();}
      if(!currentSender || !text || text===deliveredReply || now()-replyChangedAt<3300)return;
      const generating=!!document.querySelector('button[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="生成を停止"]');
      if(generating)return;
      // Don't mark as delivered until the relay accepts it. Retry after an
      // intermittent relay failure instead of silently losing the reply.
      if(replyBusy)return;
      replyBusy=true;
      sendReplySnapshot(epoch,currentSender).catch(()=>{
        if(epoch===generation)updateStatus('返信の転送に失敗。自動で再試行するよ。',true);
      }).finally(()=>{replyBusy=false;});
    },1700);
  }
  function watchNextReply(epoch, baselineNode = lastAssistantNode()) {
    clearTimeout(replyTimer);
    replyBusy = true;
    replyBaseline = baselineNode;
    let previous = '', changedAt = 0;
    const stopAt = now() + 120000;
    const tick = async () => {
      if (epoch !== generation || mode !== 'receive' || !settings.replies) { replyBusy=false; return; }
      const node = lastAssistantNode();
      const text = latestAssistantText();
      if (node && node !== replyBaseline && text) {
        if (text !== previous) { previous=text; changedAt=now(); }
        const generating = !!document.querySelector('button[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="生成を停止"]');
        if (!generating && now()-changedAt >= 2800) {
          try { await sendReplySnapshot(epoch,currentSender); } catch (_) {}
          replyBusy=false; return;
        }
      }
      if (now() >= stopAt) { replyBusy=false; return; }
      replyTimer = delay(tick,1200);
    };
    replyTimer = delay(tick,900);
  }
  async function askForReply() {
    if (!connected || mode !== 'send') { updateStatus('iPadに接続してから試してね。',true); return; }
    if (remoteShare === false) {updateStatus('返信共有はオフだよ。iPad側で「返信共有：オン」にしてね。',true);return;}
    if (pendingReply) clearTimeout(pendingReply.timer);
    const id=randomId(),epoch=generation;
    pendingReply={id,timer:delay(()=>{
      if(epoch!==generation || pendingReply?.id!==id)return;
      pendingReply=null;
      updateStatus('返信が届かないよ。iPadのSafariが開いているか、返信共有がオンか確認してね。',true);
    },16000)};
    const box=el('#skr-reply');if(box)box.textContent='iPadから返信を取得中…';
    try {await publish('down',{type:'reply_request',sid:sessionId,id},epoch);updateStatus('返信を照会中…');}
    catch(e){if(pendingReply?.id===id){clearTimeout(pendingReply.timer);pendingReply=null;}updateStatus('返信確認エラー：'+e.message,true);}
  }
  function refreshDraftCount() {
    const typing = el('#skr-typing'), counter = el('#skr-draft-count');
    if (typing && counter) counter.textContent = typing.value.length + ' / ' + MAX_TEXT + ' 文字';
  }
  function resetEraseUndo() {
    clearTimeout(eraseUndoTimer);
    erasedDraft = null;
    const undo = el('#skr-undo-erase');
    if (undo) undo.style.display = 'none';
  }
  function eraseCurrentDraft() {
    const typing = el('#skr-typing');
    if (!typing || mode !== 'send') return;
    if (pendingSend) {
      updateStatus('送信結果の確認中は消去できないよ。結果を待ってね。', true);
      return;
    }
    if (!typing.value) {updateStatus('入力欄はもう空だよ。'); return;}
    // One tap to clear; the visible Undo action avoids a confirmation on every use.
    const previous = typing.value;
    erasedDraft = previous;
    clearTimeout(eraseUndoTimer);
    typing.value = '';
    saveDraft('');
    refreshDraftCount();
    clearTimeout(typingTimer);
    // Clear is an urgent synchronization, not a normal throttled typing update.
    changed();
    if(active && connected){
      clearTimeout(typingTimer);
      typingTimer=delay(()=>sendDraft(true,true),120);
    }
    const undo = el('#skr-undo-erase');
    if (undo) undo.style.display = 'block';
    eraseUndoTimer = delay(resetEraseUndo, 30000);
    updateStatus(connected
      ? 'iPhoneを消去したよ。iPadの消去は反映確認待ち（30秒以内は復元できるよ）。'
      : 'iPhoneだけ消去したよ。iPadへの消去は未確認なので再接続後に確認してね。', !connected);
  }
  function undoEraseDraft() {
    const typing = el('#skr-typing');
    if (!typing || erasedDraft === null || mode !== 'send') return;
    if (pendingSend) {updateStatus('送信中は復元できないよ。', true);return;}
    if (typing.value && !window.confirm('今の下書きを、消去前の文章で置き換える？')) return;
    const previous = erasedDraft;
    resetEraseUndo();
    typing.value = previous;
    refreshDraftCount();
    changed();
    updateStatus('消去前の文章を復元したよ。iPadにも同期するね。');
  }
  async function pasteClipboard() {
    const typing=el('#skr-typing'); if (!typing) return;
    try {
      const text=await navigator.clipboard.readText();
      if(!text) { updateStatus('クリップボードに文字がないよ。'); return; }
      const a=typing.selectionStart ?? typing.value.length, b=typing.selectionEnd ?? typing.value.length;
      const next=typing.value.slice(0,a)+text+typing.value.slice(b);
      if(next.length>MAX_TEXT){updateStatus('貼り付けると最大文字数を超えるよ。',true);return;}
      typing.value=next; saveDraft(next); typing.focus(); changed();
      updateStatus('コピーした文字を追加したよ。');
    } catch(e){ typing.focus(); updateStatus('Safariで自動貼り付けが拒否されたよ。入力欄を長押しして「ペースト」を選んでね。',true); }
  }
  async function pasteImage() {
    try {
      if(!navigator.clipboard?.read) throw new Error('画像の貼り付けには未対応のブラウザだよ');
      const items=await navigator.clipboard.read();
      for(const item of items){
        const mime=item.types.find(x=>x.startsWith('image/') && FILE_TYPES.has(x));
        if(mime){ const blob=await item.getType(mime); await sendChosenFile(new File([blob],'clipboard-image.' + (mime.split('/')[1] || 'png'),{type:mime})); return; }
      }
      updateStatus('コピーした画像が見つからないよ。写真を選択してね。',true);
    } catch(e){updateStatus('画像ペースト不可：'+e.message+'。写真の選択を使ってね。',true);}
  }
  function switchFocus(force) {
    focusMode = typeof force === 'boolean' ? force : !focusMode;
    document.documentElement.classList.toggle('skr-focus-mode',focusMode);
    const panel=el('#skr-panel'); if(panel) {panel.hidden=false; if(focusMode) panel.scrollTop=0;}
    const toggle=el('#skr-focus-toggle'); if(toggle) toggle.textContent=focusMode?'小窓に戻す':'専用入力画面';
  }
  // EXPERIMENTAL: file transfer via end-to-end encrypted ntfy attachment.
  // Binary content, original filename and media type are never sent to ntfy in plaintext.
  function updateFileProgress(message,bad=false) {
    fileTransferStage=message;fileTransferFailed=!!bad;
    for(const selector of ['#skr-file-progress-quick']){
      const node=el(selector);if(node){node.textContent=message;node.dataset.error=String(bad);}
    }
  }
  function cleanFilename(name) {
    return String(name || 'file').replace(/[\\/\x00-\x1f]/g, '_').slice(0, 120);
  }
  function showBytes(num) { return (num / 1024 / 1024).toFixed(2) + ' MB'; }
  async function shrinkImage(file) {
    const url = URL.createObjectURL(file);
    const photoMode=['auto','quality','small','original'].includes(settings.photoMode)?settings.photoMode:'auto';
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const dimensions=photoMode==='quality' ? [2400,2000,1650,1200] :
        photoMode==='small' ? [1200,1000,800,640] : [1800,1400,1100,850];
      const jpegQuality=photoMode==='quality' ? 0.90 : photoMode==='small' ? 0.67 : 0.78;
      for (const maxDim of dimensions) {
        const ratio = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * ratio));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * ratio));
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('写真の圧縮を利用できないよ');
        ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', jpegQuality));
        if (blob && blob.size <= MAX_FILE_BYTES) {
          const base = cleanFilename(file.name).replace(/\.[^.]+$/, '') || 'photo';
          return new File([blob], base + '-small.jpg', { type: 'image/jpeg' });
        }
      }
      throw new Error('圧縮しても容量が大きいよ。別の画像を試してね');
    } finally { URL.revokeObjectURL(url); }
  }
  async function prepareFile(file) {
    if (!file) throw new Error('ファイルを選んでね');
    const type = file.type.toLowerCase();
    if (!FILE_TYPES.has(type)) throw new Error('まずはJPEG/PNG/WebP・PDF・テキストのみ対応だよ');
    if(settings.photoMode==='original' && file.size>MAX_FILE_BYTES)throw new Error('元画像のままでは容量制限を超えるよ。自動を選んでね。');
    if (type === 'image/heic' || type === 'image/heif') return await shrinkImage(file);
    if (file.size <= MAX_FILE_BYTES) return file;
    if (type.startsWith('image/')) return await shrinkImage(file);
    throw new Error('ファイルが大きすぎるよ（今は ' + showBytes(MAX_FILE_BYTES) + ' 以下）。');
  }
  async function uploadEncryptedFile(file, epoch) {
    const raw = await file.arrayBuffer();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, raw));
    const packed = new Uint8Array(iv.byteLength + ciphertext.byteLength);
    packed.set(iv, 0); packed.set(ciphertext, iv.byteLength);
    const res = await gm({ method: 'PUT', url: endpoint('files'), data: packed.buffer,
      headers: { 'Filename': 'encrypted.bin', 'Content-Type': 'application/octet-stream', 'X-Priority': '1' },
      timeout: 45000, responseType: 'text' });
    if (epoch !== generation) throw new Error('端末の接続が変わったよ');
    if (res.status < 200 || res.status >= 300) throw new Error('ファイル中継が失敗：HTTP ' + res.status);
    let message;
    try { message = JSON.parse(String(res.responseText || res.response || '')); }
    catch (_) { throw new Error('中継の返信を読めなかったよ'); }
    const url = message.attachment?.url;
    if (typeof url !== 'string' || !url.startsWith('https://ntfy.sh/')) throw new Error('ファイルのURLを取得できなかったよ');
    return url;
  }
  async function sendChosenFile(file, batch = false) {
    if (sendingFile && !batch){updateFileProgress('別のファイルを転送中だよ。完了まで待ってね。',true);return;}
    if (mode !== 'send' || !active || !connected || pendingSend) {
      updateStatus('接続完了してからファイルを選んでね。', true);updateFileProgress('iPadとの接続を確認してから選び直してね。',true);return;
    }
    sendingFile = true;
    const epoch = generation;
    try {
      updateStatus('ファイルを準備中…');
      updateFileProgress('① 準備中：'+cleanFilename(file.name)+' ｜ 元のサイズ '+showBytes(file.size));
      const candidate = await prepareFile(file);
      const saved=file.size>0 ? Math.max(0,Math.round(100*(1-candidate.size/file.size))) : 0;
      const changed=candidate!==file;
      const conversion=!changed?'（元のファイルを維持）':candidate.size<file.size?'（'+saved+'%削減）':'（形式変換・容量は増加）';
      updateFileProgress('② 変換済み：'+showBytes(file.size)+' → '+showBytes(candidate.size)+conversion+'。暗号化・転送中…');
      updateStatus('暗号化して転送中… ' + showBytes(candidate.size));
      const url = await uploadEncryptedFile(candidate, epoch);
      await publish('down', { type: 'file_offer', sid: sessionId, id: randomId(),
        url, name: cleanFilename(candidate.name), mime: candidate.type, size: candidate.size }, epoch);
      if (epoch === generation) {
        updateStatus('iPadへ転送依頼したよ。添付されたかiPad側で確認してね。');
        updateFileProgress('③ 中継へ送信済み：iPadの受信確認を待機中。ChatGPTへの添付完了は未確認。');
      }
    } catch (e) { if (epoch === generation) {updateStatus('ファイル送信：' + e.message, true);updateFileProgress('失敗：'+e.message,true);} }
    finally { sendingFile = false; }
  }
  function tryAttach(file) {
    try {
      const candidates = [...document.querySelectorAll('input[type="file"]')];
      const input = candidates.find(e => e.accept === '' || e.accept.includes('image') || e.accept.includes('.pdf') || e.multiple);
      if (!input) return false;
      const transfer = new DataTransfer(); transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true; // Event fired, NOT proof that ChatGPT finished uploading.
    } catch (_) { return false; }
  }
  function renderReceivedFiles() {
    const host = el('#skr-received-files');
    if (!host) return;
    host.replaceChildren();
    for (const [id, file] of receivedFiles) {
      const paragraph = document.createElement('p');
      paragraph.textContent = '受信：' + file.name + ' (' + showBytes(file.size) + ')'; host.append(paragraph);
      button(host, 'ChatGPTへの添付を再試行', () => {
        updateStatus(tryAttach(file) ? '添付操作を試したよ。ChatGPTの添付表示を確認してね。' : '添付欄を見つけられないよ。ファイルを保存して手動で添付してね。', true);
      });
      button(host, 'このファイルをiPadに保存', () => {
        const blobUrl = URL.createObjectURL(file);
        const a = document.createElement('a'); a.href = blobUrl; a.download = file.name;
        document.body.append(a); a.click(); a.remove();
        delay(() => URL.revokeObjectURL(blobUrl), 60000);
      });
    }
  }
  async function handleFileOffer(packet, epoch) {
    const { sid, id, url, name, mime, size } = packet;
    if (epoch !== generation || mode !== 'receive' || !allowed || sid !== currentSender) return;
    if (typeof id !== 'string' || id.length > 80 || completedFiles.has(id)) return;
    let safeURL = false;
    try { const parsed = new URL(url); safeURL = parsed.protocol === 'https:' && parsed.hostname === 'ntfy.sh' && !parsed.username && !parsed.password; } catch (_) {}
    if (!safeURL || typeof name !== 'string' ||
        !FILE_TYPES.has(mime) || !Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES) return;
    completedFiles.add(id);
    const report = async message => { try { await publish('up', { type: 'file_result', sid, id, message }, epoch); } catch (_) {} };
    try {
      updateStatus('暗号化ファイルをダウンロード中…');
      const res = await gm({ method: 'GET', url, responseType: 'arraybuffer', timeout: 40000 });
      if (res.status !== 200) throw new Error('ダウンロードHTTP ' + res.status);
      if (!(res.response instanceof ArrayBuffer)) throw new Error('Safariの拡張機能がバイナリ通信に対応していない可能性があるよ');
      const packed = new Uint8Array(res.response);
      if (packed.length < 30 || packed.length > MAX_FILE_BYTES + 60) throw new Error('暗号化ファイルのサイズが正しくないよ');
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: packed.slice(0, 12) }, key, packed.slice(12));
      if (plain.byteLength !== size) throw new Error('受信ファイルのサイズが一致しないよ');
      const file = new File([plain], cleanFilename(name), { type: mime });
      receivedFiles.set(id, file);
      if (receivedFiles.size > 3) receivedFiles.delete(receivedFiles.keys().next().value);
      renderReceivedFiles();
      const attempted = tryAttach(file);
      const msg = attempted
        ? 'ファイル受信・復号は成功。ChatGPTへの添付操作を開始したよ。実際の添付完了はiPadの表示で確認してね（未検証）。'
        : 'ファイル受信・復号は成功！ChatGPTの添付欄が見つからないよ。iPad側のパネルで保存・手動添付してね。';
      updateStatus(msg, !attempted);
      await report(msg);
    } catch (e) {
      const msg = 'ファイル受信失敗：' + (e.message || String(e));
      updateStatus(msg, true); await report(msg);
    }
  }

  // Prefer SSE; fall back to polling if Userscripts does not stream the HTTP response.
  function listen(direction, epoch) {
    if (epoch !== generation) return;
    const cycle=++transportCycle;lastInboundAt=now();
    if (STANDALONE && typeof EventSource !== 'undefined') {
      try {
        const es = new EventSource(endpoint(direction)+'/sse');
        stream = {abort:()=>es.close()};
        let good=false;
        es.addEventListener('message',ev=>{
          if(epoch!==generation||cycle!==transportCycle)return;
          good=true;
          try {const m=JSON.parse(ev.data);if(m.event==='message')receiveOne(m.id,m.message,epoch);}catch(_){}
        });
        es.onerror=()=>{ if(epoch===generation&&cycle===transportCycle){es.close();startPolling(direction,epoch,cycle);} };
        clearTimeout(fallbackTimer);
        fallbackTimer=delay(()=>{if(epoch===generation&&cycle===transportCycle&&!good){es.close();startPolling(direction,epoch,cycle);}},15000);
        return;
      } catch(_) {startPolling(direction,epoch,cycle);return;}
    }
    let seen = 0, pending = '', progressing = false, gotMessage = false;
    function ingest(change) {
      pending += change;
      let match;
      // SSE may use CRLF as well as LF; the separator can also span two chunks.
      while ((match = /\r?\n\r?\n/.exec(pending))) {
        const frame = pending.slice(0, match.index); pending = pending.slice(match.index + match[0].length);
        const data = frame.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
        if (!data) continue;
        try { const m = JSON.parse(data); if (m.event === 'message') { gotMessage=true;rxSseEvents++;receiveOne(m.id, m.message, epoch); } } catch (_) {}
      }
      if (pending.length > 50000) pending = pending.slice(-5000);
    }
    function progress(e) {
      if (epoch !== generation||cycle!==transportCycle) return;
      const raw = String(e?.responseText ?? (typeof e?.response === 'string' ? e.response : ''));
      if (raw.length > seen) { progressing = true; ingest(raw.slice(seen)); seen = raw.length; }
    }
    function fallback() {
      if (epoch !== generation||cycle!==transportCycle) return;
      try { stream?.abort?.(); } catch (_) {}
      stream = null;
      startPolling(direction, epoch,cycle);
    }
    try {
      stream = gm({ method: 'GET', url: endpoint(direction) + '/sse', timeout: 0,
        responseType: 'text', headers: { Accept: 'text/event-stream' },
        onprogress: progress, onreadystatechange: progress,
        onload: e => {
          progress(e);
          if (epoch === generation && cycle === transportCycle) { updateStatus('通信が切れたので再接続中…'); retryTimer = delay(() => listen(direction, epoch), 2500); }
        },
        onerror: () => { if (epoch === generation&&cycle===transportCycle) fallback(); },
        ontimeout: () => { if (epoch === generation&&cycle===transportCycle) fallback(); }
      });
    } catch (e) { updateStatus('通信エラー：' + e.message, true); return; }
    clearTimeout(fallbackTimer);
    fallbackTimer = delay(() => { if (epoch === generation&&cycle===transportCycle && !gotMessage) fallback(); }, 16000);
  }
  function startPolling(direction, epoch,cycle=transportCycle) {
    clearTimeout(pollingTimer);
    updateStatus('定期確認モードで中継を監視中（iPadの応答を確認中。数秒の遅延あり）');
    let since = String(Math.floor(now() / 1000) - 12);
    async function tick() {
      if (epoch !== generation||cycle!==transportCycle) return;
      try {
        const res = await gm({ method: 'GET', url: endpoint(direction) + '/json?poll=1&since=' + encodeURIComponent(since), responseType: 'text', timeout: 15000 });
        if (res.status !== 200) throw new Error('HTTP ' + res.status);
        scanNtfyLines(relayBody(res),epoch,id=>{since=id});
      } catch (e) { if (epoch === generation) updateStatus('中継の通信に失敗：' + e.message, true); }
      if (epoch === generation&&cycle===transportCycle) pollingTimer = delay(tick, 8500);
    }
    tick();
  }

  // Parallel lightweight polling during handshake and after idle periods.
  // SSE can look open in iOS Safari while never delivering any complete message frames.
  // Message IDs are deduplicated by receiveOne() to prevent duplicate sends.
  function startParallelPoll(direction, epoch) {
    clearTimeout(parallelPollTimer);
    let cursor = String(Math.floor(now()/1000)-90);
    let rounds = 0;
    async function tick() {
      if(epoch!==generation || !active || !key)return;
      if(document.visibilityState==='hidden') {
        parallelPollTimer=delay(tick,15000);return;
      }
      const waiting = (mode==='send' && !connected) ||
        (mode==='receive' && (!connected || now()-lastReceiverContactAt>25000));
      if(waiting){
        try {
          const url=endpoint(direction)+'/json?poll=1&since='+encodeURIComponent(cursor);
          const r=await gm({method:'GET',url,responseType:'text',timeout:15000});
          if(r.status!==200) throw new Error('HTTP '+r.status+(r.status===429?'（中継の利用制限）':''));
          relayPollAt=now();relayError='';
          scanNtfyLines(relayBody(r),epoch,id=>{cursor=id});
          if(mode==='send'&&!connected && ++rounds===2 && epoch===generation)
            updateStatus('中継へのアクセスは成功。でもiPadの応答がないよ。接続コードの一致とiPadの受信状態を確認してね。');
        }catch(e){
          relayError='中継からの受信確認：'+(e.message||String(e));
          if(epoch===generation && !connected)updateStatus(relayError,true);
        }
      }
      if(epoch===generation && active)
        parallelPollTimer=delay(tick,rounds<4?9000:22000);
    }
    parallelPollTimer=delay(tick,5500);
  }

  function startReceive(createNew = false) {
    disconnect(); mode = 'receive';
    code = createNew || !isValidCode(prefs.receiverCode) ? randomCode() : prefs.receiverCode;
    prefs.role = mode; prefs.receiverCode = code; savePrefs(); draw();
    updateStatus('受信コードを用意したよ。受信を開始してね。');
  }
  async function allowReceive(automatic = false) {
    if (active) return;
    const editor = findEditor();
    if (!editor) {
      if (automatic) { pendingAuto = delay(() => allowReceive(true), 1500); return; }
      updateStatus('ChatGPTの入力欄がまだ見つからないよ。', true); return;
    }
    if (normalize(readEditor(editor)).trim() && !restoreOwnedDraft()) {
      updateStatus('iPadに既存の下書きがあるよ。消さずに引き継ぐ場合は「今の下書きを引き継ぐ」を押してね。',true);return;
    }
    try { await setupCrypto(code); }
    catch (e) { updateStatus('暗号化の準備ができないよ：' + e.message, true); return; }
    active = true; allowed = true; const epoch = generation;
    startHealthChecks(); // Reply scraping disabled: use same-conversation link instead.
    updateStatus(lastApplied!==null ? '前回の途中入力を保持して、受信を再開中…' : (automatic?'受信を再開中…':'受信を開始中…'));
    // Refresh the receiver button: the old 'allow receive' label was misleading even after activating.
    draw(); listen('down', epoch);startParallelPoll('down', epoch);
  }
  async function startSend(value, automatic = false) {
    const parsed = cleanCode(value);
    if (!isValidCode(parsed)) { updateStatus('接続コードが違うよ（英数字12文字）。', true); return; }
    const previousDraft = el('#skr-typing')?.value ?? sentText; saveDraft(previousDraft);
    disconnect(); mode = 'send'; code = parsed; sentText = previousDraft;
    prefs.role = 'send'; prefs.senderCode = code; savePrefs(); draw();
    try { await setupCrypto(code); }
    catch (e) { updateStatus('暗号化の準備エラー：' + e.message, true); return; }
    sessionId = randomId(); active = true;
    const epoch = generation;
    updateStatus(automatic ? '前回のiPadに自動再接続中…' : 'iPadに接続中…');
    listen('up', epoch);startParallelPoll('up', epoch);
    // Keep periodically verifying the *real* iPad response. A stored pairing
    // or successful relay POST is not a live connection acknowledgement.
    pingTimer=setInterval(()=>{
      if(epoch!==generation)return;
      if(!connected || now()-lastReceiverAckAt>35000){lastHealthProbeAt=now();probePeer();}
    },25000);
    startHealthChecks();delay(()=>probePeer(),1000);
  }
  async function sendDraft(force = false, urgent = false) {
    if (!active || !connected || mode !== 'send' || publishing || pendingSend) return;
    if (composition) return;
    const value = el('#skr-typing')?.value ?? sentText;
    if (value.length > MAX_TEXT) { updateStatus('入力は最大 ' + MAX_TEXT + ' 文字までだよ。', true); return; }
    if (!force && value === sentText) return;
    const wait = urgent ? 0 : Math.max(0, 4200 - (now() - lastPublish));
    if (wait > 0) { clearTimeout(typingTimer); typingTimer = delay(() => sendDraft(force, urgent), wait); return; }
    sentText = value; publishing = true; const epoch = generation; lastPublish = now();
    try { await publish('down', { type: 'draft', sid: sessionId, seq: ++seq, text: value }, epoch);
      if (epoch === generation) updateStatus(value.length ? '中継へ送信したよ（iPadの反映を確認中）：' + value.length + '文字' : '空の下書きを中継へ送ったよ（反映確認中）。');
    } catch (e) { if (epoch === generation) updateStatus('送信失敗：' + e.message, true); }
    finally {
      publishing = false;
      if (epoch === generation && (el('#skr-typing')?.value ?? sentText) !== sentText) {
        clearTimeout(typingTimer); typingTimer = delay(() => sendDraft(true), 900);
      }
    }
  }
  function changed() {
    const typing=el('#skr-typing'); if(typing) saveDraft(typing.value);
    refreshDraftCount();
    clearTimeout(typingTimer);
    if (!composition && !pendingSend) typingTimer = delay(() => sendDraft(), 550);
  }
  function resume() {
    const editor=findEditor();
    if(!editor){updateStatus('iPadの入力欄を見つけられないよ。',true);return;}
    const existing=readEditor(editor), owned=lastApplied===null?loadOwnedDraft():lastApplied;
    if(normalize(existing).trim()){
      if(owned!==null && normalize(existing)===normalize(owned)){
        lastApplied=existing;lastSeq=-1;allowed=true;recordOwnedDraft(existing);
        updateStatus('残った文章は以前の同期内容と一致したよ。消さずに復旧した！iPhoneで文章を再同期してね。');
      }else{
        updateStatus('iPadの文章を保護しているよ。確認して引き継ぐね。');
        adoptVisibleDraft(); // always asks confirmation; never silently erases the editor
      }
      return;
    }
    lastApplied=null;lastSeq=-1;allowed=true;recordOwnedDraft('');
    updateStatus('空の入力欄で同期を再開したよ。iPhoneの文章を再同期してね。');
  }
  function changeRole() { disconnect(); mode = 'choose'; focusMode = false; document.documentElement.classList.remove('skr-focus-mode'); prefs.role = 'choose'; savePrefs(); draw(); updateStatus('端末の役割を選んでね。'); }
  function forgetPair() {
    if (!window.confirm('この端末に保存した接続コードを削除する？ 両端末から完全に解除したい場合は、もう一方でも削除してね。')) return;
    disconnect();if(mode==='receive')recordOwnedDraft(''); prefs = { role: 'choose', receiverCode: '', senderCode: '', auto: true }; savePrefs();
    mode = 'choose'; code = ''; focusMode = false; document.documentElement.classList.remove('skr-focus-mode'); draw(); updateStatus('この端末の接続記憶を消したよ。');
  }
  function button(container, label, action, main = false) {
    const e = document.createElement('button'); e.type = 'button'; e.textContent = label;
    if (main) e.className = 'skr-primary'; e.onclick = action; container.append(e); return e;
  }
  function details(container,title,open=false){
    const wrap=document.createElement('details');wrap.className='skr-details';wrap.open=open;
    const summary=document.createElement('summary');summary.textContent=title;wrap.append(summary);container.append(wrap);
    return wrap;
  }
  function draw() {
    const panel=el('#skr-panel');if(!panel)return;
    panel.replaceChildren();
    const header=document.createElement('header');header.className='skr-header';
    const brand=document.createElement('div');brand.className='skr-brand';
    const symbol=document.createElement('span');symbol.className='skr-brand-icon';symbol.textContent='⌨';symbol.setAttribute('aria-hidden','true');
    const brandLines=document.createElement('div');brandLines.className='skr-brand-lines';
    const title=document.createElement('strong');title.textContent='リモート入力';
    const subtitle=document.createElement('span');subtitle.textContent='REMOTE KEYBOARD  /  v'+VERSION;
    brandLines.append(title,subtitle);brand.append(symbol,brandLines);
    const close=document.createElement('button');close.textContent='×';close.className='skr-close';close.setAttribute('aria-label','専用画面を閉じる');
    close.onclick=()=>{if(focusMode)switchFocus(false);else panel.hidden=true;};
    const headerTools=document.createElement('div');headerTools.className='skr-header-actions';
    const themeSwitch=document.createElement('button');themeSwitch.id='skr-theme-switch';themeSwitch.className='skr-theme-switch';
    themeSwitch.type='button';themeSwitch.title='色を切り替える';themeSwitch.onclick=cycleTheme;
    headerTools.append(themeSwitch,close);
    header.append(brand,headerTools);panel.append(header);
    const connection=document.createElement('div');connection.className='skr-connection-strip';panel.append(connection);
    const label=document.createElement('span');label.id='skr-connection-state';label.className='skr-state-pill';connection.append(label);
    const modeLabel=document.createElement('span');modeLabel.className='skr-mode-label';modeLabel.textContent=mode==='send'?'送信モード':mode==='receive'?'受信モード':'初期設定';connection.append(modeLabel);
    const status=document.createElement('p');status.id='skr-status';status.setAttribute('role','status');
    status.textContent=statusText;status.dataset.error=String(statusBad);panel.append(status);
    const p=(text,into=panel)=>{const e=document.createElement('p');e.textContent=text;into.append(e);return e;};
    if(mode==='choose') {
      p('iPadは受信、iPhoneは入力を選んでね。設定は次回から記憶するよ。');
      button(panel,'iPad：受信する',()=>startReceive(),true);
      button(panel,'iPhone：入力する',()=>{disconnect();mode='send';prefs.role=mode;savePrefs();code=prefs.senderCode||'';draw();if(settings.autoFocus!==false)switchFocus(true);},true);
    }
    if(mode==='receive') {
      const card=document.createElement('section');card.className='skr-card';panel.append(card);
      p('01  /  接続コード（iPhoneと共有）',card);
      const c=document.createElement('div');c.id='skr-code';c.className='skr-pair-chars';card.append(c);
      paintPairCode(c,code);
      const keyLegend=document.createElement('p');keyLegend.className='skr-pair-legend';
      keyLegend.textContent='色で見分けよう：';keyLegend.append(
        Object.assign(document.createElement('span'),{className:'skr-pair-digit',textContent:'数字 2〜9'}),
        document.createTextNode(' ／ '),
        Object.assign(document.createElement('span'),{className:'skr-pair-letter',textContent:'英字 A〜Z'})
      );card.append(keyLegend);
      const shareButtons=document.createElement('div');shareButtons.className='skr-pair-actions';card.append(shareButtons);
      button(shareButtons,'コードをコピー',()=>copyPair(code));
      button(shareButtons,'iPhoneへ共有（AirDrop等）',sharePair);
      p('共有リンクは接続用の秘密の鍵だよ。自分の端末以外には送らないでね。',card);
      if(active)button(card,'同期を再開（iPadの入力欄が空の場合）',resume,true);
      else button(card,'入力を許可して受信開始',()=>allowReceive(),true);
      button(card,'今の下書きをiPhoneの入力として引き継ぐ',adoptVisibleDraft);
      p('返信を見るときは、iPhoneの「同じChatGPT会話を開く」を使ってね。',panel);
      const inbox=document.createElement('section');inbox.id='skr-received-files';panel.append(inbox);renderReceivedFiles();
      const advanced=details(panel,'⚙  接続・詳細設定');
      button(advanced,'接続コードを新しくする',()=>startReceive(true));
      button(advanced,'受信通信を再起動',()=>{if(active){restartListenerIfStale(0);updateStatus('受信経路の再接続を試しているよ。');}else{allowReceive();}});
      button(advanced,'通信診断を表示',()=>{updateStatus('通信先照合：'+channelCheck()+'／受信：'+(active?'起動中':'停止中')+'／中継GET：'+(relayPollAt?'成功':'未確認')+'／取得文字数：'+pollTextBytes+'／メッセージ行：'+pollMessageRows+'／JSON解析失敗：'+pollParseFailures+'／SSE受信：'+rxSseEvents+'／暗号化受信：'+incomingCount+'／復号：'+decryptOkCount+'／復号失敗：'+decryptFailCount+'／接続要求：'+helloCount+'／応答：'+ackSentCount+(relayError?'／'+relayError:''));});
      button(advanced,'中継の最新メッセージを再確認（投稿しない）',async()=>{
        if(!active||!key){updateStatus('先に受信を開始してね。',true);return;}
        const epoch=generation;
        updateStatus('最新の中継メッセージを調査中…');
        try{
          const r=await gm({method:'GET',url:endpoint('down')+'/json?poll=1&since=5m',responseType:'text',timeout:16000});
          if(r.status!==200)throw Error('HTTP '+r.status);
          const result=scanNtfyLines(relayBody(r),epoch);
          updateStatus('通信先：'+channelCheck()+'／直近5分：'+result.total+'件／取得文字数：'+relayBody(r).length+'／JSON解析失敗：'+result.bad+'件／暗号化受信：'+incomingCount+'件／復号：'+decryptOkCount+'件。しばらく後に診断をもう一度確認してね。');
        }catch(e){updateStatus('最新メッセージの確認失敗：'+(e.message||e),true)}
      });
      button(advanced,'端末の役割を変更',changeRole);
      button(advanced,'この端末の接続記憶を消す',forgetPair);
    }
    if(mode==='send') {
      const quick=document.createElement('nav');quick.className='skr-quicknav';quick.setAttribute('aria-label','画面内の移動');panel.append(quick);
      const jump=(name,selector,openDetails=false)=>{
        const b=document.createElement('button');b.type='button';b.textContent=name;
        b.addEventListener('click',()=>{
          const target=el(selector);if(!target)return;
          if(openDetails && target.tagName==='DETAILS')target.open=true;
          target.scrollIntoView({block:'start',behavior:'smooth'});
        });quick.append(b);
      };
      jump('✎ 入力','#skr-typing');jump('↩ 会話','.skr-reply-wrap');
      const compose=document.createElement('section');compose.className='skr-card skr-compose';panel.append(compose);
      const l=document.createElement('label');l.textContent='01  /  iPhoneから入力';l.className='skr-step-label';l.htmlFor='skr-typing';compose.append(l);
      const typing=document.createElement('textarea');typing.id='skr-typing';typing.rows=5;typing.maxLength=MAX_TEXT;
      typing.placeholder='iPhoneで文字を入力して、iPadへ送ろう…';typing.value=sentText||restoreDraft();
      typing.addEventListener('input',changed);
      typing.addEventListener('compositionstart',()=>{composition=true;});
      typing.addEventListener('compositionend',()=>{composition=false;changed();});compose.append(typing);
      const tools=document.createElement('div');tools.className='skr-tools';compose.append(tools);
      button(tools,'貼り付け',pasteClipboard);
      button(tools,'前回の文章',()=>{
        if(!lastSent.length){updateStatus('送信履歴がまだないよ。');return;}
        if(typing.value.trim()&&!window.confirm('今の下書きを前回の文章で上書きする？'))return;
        resetEraseUndo();
        typing.value=lastSent[0];saveDraft(typing.value);changed();updateStatus('前回の文章を戻したよ。');
      });
      const erase = button(tools, '全消去', eraseCurrentDraft);
      erase.id = 'skr-erase-draft';
      erase.title = '未送信の下書きだけを、iPhoneとiPadの両方から消去（履歴は残す）';
      const undo = button(tools, '↶ 元に戻す（30秒）', undoEraseDraft);
      undo.id = 'skr-undo-erase'; undo.style.gridColumn = '1 / -1';
      undo.style.display = erasedDraft === null ? 'none' : 'block';
      // One attachment entry point. iOS Safari provides Photo Library, Camera and Files.
      const attachmentInput=document.createElement('input');attachmentInput.type='file';attachmentInput.id='skr-attach-input';
      attachmentInput.accept='image/*,application/pdf,text/plain';attachmentInput.multiple=true;
      attachmentInput.className='skr-visually-hidden-file';compose.append(attachmentInput);
      attachmentInput.addEventListener('change',async()=>{
        const selected=[...(attachmentInput.files||[])].slice(0,4);attachmentInput.value='';
        if(!selected.length)return;
        if(selected.length>1&&!window.confirm(selected.length+'件のファイルを転送する？\n添付完了はiPadで確認してね。'))return;
        for(const file of selected)await sendChosenFile(file);
      });
      const attachmentButton=button(compose,'＋  写真・ファイルを添付',()=>attachmentInput.click());
      attachmentButton.id='skr-attach-button';
      const quickProgress=document.createElement('div');quickProgress.id='skr-file-progress-quick';quickProgress.setAttribute('role','status');
      quickProgress.textContent=fileTransferStage==='まだファイルを選択していないよ。'?'':fileTransferStage;
      quickProgress.dataset.error=String(fileTransferFailed);compose.append(quickProgress);
      const count = document.createElement('div');
      count.id = 'skr-draft-count'; count.className = 'skr-draft-count';
      count.textContent = typing.value.length + ' / ' + MAX_TEXT + ' 文字';
      compose.append(count);
      const sendButton=button(compose,'↗  iPadへ送信',requestRemoteSend,true);
      sendButton.id='skr-remote-send';refreshSendButton();
      const confirmPosted=button(compose,'✓  送信済みを確認してクリア',confirmPostedAndClear);
      confirmPosted.id='skr-confirm-posted';refreshSendButton();
      const hint=p('iPadを更新して入力欄が空に見えても、iPhoneに保存した文章は送信直前に再同期するよ。応答が止まったときは二重送信せず、接続の回復を待ってね。',compose);
      hint.className='skr-draft-hint';
      const confirmLabel=document.createElement('label');confirmLabel.className='skr-choice';
      const check=document.createElement('input');check.type='checkbox';check.checked=!!settings.confirm;
      check.addEventListener('change',()=>{settings.confirm=check.checked;saveSettings();});
      confirmLabel.append(check,document.createTextNode(' 送信前に確認する'));compose.append(confirmLabel);
      const conversation=document.createElement('section');conversation.className='skr-card skr-reply-wrap';panel.append(conversation);
      const ct=document.createElement('h3');ct.textContent='02 / 返信は同じ会話で確認';conversation.append(ct);
      const chatOpen=button(conversation,'↗  iPadと同じChatGPT会話を開く',()=>{
        if(receiverChatUrl){window.open(receiverChatUrl,'_blank','noopener,noreferrer');}
        else {probePeer();updateStatus('iPadに会話リンクを問い合わせたよ。少し待ってからもう一度押してね。');}
      },true);chatOpen.id='skr-open-chat';
      const chatHint=p('iPadから現在の会話リンクを受け取ると、ChatGPTの返信全文をiPhoneで開けるよ。',conversation);chatHint.id='skr-chat-link-hint';
      const more=details(panel,'⚙  接続・詳細設定');
      const mediaSettings=details(more,'写真の画質設定');
      const photoLabel=document.createElement('label');photoLabel.textContent='送信する写真の画質';photoLabel.htmlFor='skr-photo-mode';mediaSettings.append(photoLabel);
      const modeSelect=document.createElement('select');modeSelect.id='skr-photo-mode';
      for(const [v,label] of [['auto','自動（おすすめ）'],['quality','高画質優先'],['small','容量節約'],['original','元画像のまま（制限あり）']]){
        const o=document.createElement('option');o.value=v;o.textContent=label;modeSelect.append(o);
      }
      modeSelect.value=['auto','quality','small','original'].includes(settings.photoMode)?settings.photoMode:'auto';
      modeSelect.addEventListener('change',()=>{
        settings.photoMode=modeSelect.value;saveSettings();
        updateStatus('写真画質を変更したよ：'+modeSelect.selectedOptions[0].textContent);
      });mediaSettings.append(modeSelect);
      p('ファイル転送は容量制限があるよ。大きい写真は画質設定に応じて圧縮するね。',mediaSettings);

      const label=document.createElement('label');label.textContent='iPadの接続コード';label.htmlFor='skr-room';more.append(label);
      const room=document.createElement('input');room.id='skr-room';room.value=pretty(code);room.placeholder='XXXX-XXXX-XXXX';
      room.autocapitalize='characters';room.autocomplete='off';room.spellcheck=false;room.setAttribute('autocorrect','off');room.setAttribute('enterkeyhint','done');
      more.append(room);
      const pasteButton=button(more,'クリップボードからコードを貼り付け',()=>pastePairInto(room));
      pasteButton.id='skr-paste-pair';
      const codePreview=document.createElement('div');codePreview.id='skr-pair-preview';codePreview.className='skr-pair-chars';
      more.append(codePreview);
      const codeFeedback=document.createElement('p');codeFeedback.className='skr-code-feedback';more.append(codeFeedback);
      const refreshCodePreview=()=>{
        const entered=cleanCode(room.value);
        paintPairCode(codePreview,entered);
        if(!entered){codeFeedback.textContent='12文字の接続コードを入れてね。数字と英字は色が違うよ。';return;}
        if(!isValidCode(entered)){codeFeedback.textContent=entered.length+' / 12文字。入力を確認してね。';return;}
        if(active&&code&&entered!==code){
          codeFeedback.textContent='現在の接続コードと違うよ。接続ボタンで切り替えてね。';
        }else {
          codeFeedback.textContent='12 / 12文字 ✓　数字はオレンジ、英字は水色。';
        }
      };
      room.addEventListener('input',refreshCodePreview);refreshCodePreview();
      button(more,active?'同じiPadへ再接続':'iPadへ接続',()=>startSend(room.value));
      button(more,'接続を再確認（反応が止まったら）',()=>{restartListenerIfStale(0);probePeer();});
      button(more,'iPadの応答を25秒確認（文章は送らない）',()=>{
        if(mode!=='send'||!active){updateStatus('先に接続コードを入力してiPadへの接続を開始してね。',true);return;}
        const started=now();
        updateStatus('iPadに確認信号を送るよ。下書きは送信しないよ。');
        probePeer();
        delay(()=>{
          if(mode!=='send'||!active)return;
          if(lastReceiverAckAt>=started)updateStatus('接続診断：iPadが直接応答したよ！');
          else if(relayPostAt>=started)updateStatus('接続診断：中継へ確認信号は送れたけど、iPadの応答が25秒以内になかったよ。');
          else updateStatus('接続診断：確認信号の中継送信も未確認。'+(relayError||'通信診断v2で中継の状態を確認してね。'),true);
        },25000);
      });
      button(more,'通信診断を表示',()=>{updateStatus('通信先照合：'+channelCheck()+'／中継投稿：'+(relayPostAt?'成功':'未確認')+'／中継受信：'+(relayPollAt?'成功':'未確認')+'／iPad応答：'+(lastReceiverAckAt?'あり':'未確認')+'／受信行数：'+pollMessageRows+(relayError?'／'+relayError:''));});
      button(more,'文章をもう一度同期',()=>sendDraft(true));
      button(more,'未送信の下書きを消去（iPadにも反映）',()=>{
        if(pendingSend){updateStatus('送信結果待ちだよ。');return;}
        if(typing.value&&!window.confirm('iPadとiPhoneの未送信下書きを消す？'))return;
        typing.value='';saveDraft('');sendDraft(true);
      });
      const focus=button(more,focusMode?'小窓に戻す':'専用入力画面',()=>switchFocus());focus.id='skr-focus-toggle';
      if(!STANDALONE){
        const auto=document.createElement('label');auto.className='skr-choice';
        const opt=document.createElement('input');opt.type='checkbox';opt.id='skr-autofocus';opt.checked=settings.autoFocus!==false;
        opt.addEventListener('change',()=>{settings.autoFocus=opt.checked;saveSettings();});
        auto.append(opt,document.createTextNode(' 次回から入力画面を自動表示'));more.append(auto);
      }
      button(more,'端末の役割を変更',changeRole);
      button(more,'この端末の接続記憶を消す',forgetPair);
    }
    const visuals = details(panel,'✦  表示・アニメーション');
    const tdesc=document.createElement('p');tdesc.textContent='見た目は両端末で別々に変更できるよ。内容や接続には影響しない。';visuals.append(tdesc);
    const themeGroup=document.createElement('div');themeGroup.className='skr-theme-grid';visuals.append(themeGroup);
    for(const [value,name] of [['aurora','オーロラ'],['lagoon','ラグーン'],['graphite','モノクロ']]) {
      const choice=button(themeGroup,name,()=>{settings.theme=value;saveSettings();applyAppearance();
        [...themeGroup.querySelectorAll('button')].forEach(x=>x.setAttribute('aria-pressed',String(x.dataset.themeChoice===safeTheme())));});
      choice.dataset.themeChoice=value;choice.setAttribute('aria-pressed',String(value===safeTheme()));
    }
    const motionLabel=document.createElement('label');motionLabel.textContent='動きの設定';motionLabel.htmlFor='skr-motion';visuals.append(motionLabel);
    const motionSelect=document.createElement('select');motionSelect.id='skr-motion';
    for(const [v,name] of [['system','端末の設定に合わせる'],['on','アニメーションあり'],['off','動きを減らす']]){
      const opt=document.createElement('option');opt.value=v;opt.textContent=name;motionSelect.append(opt);
    }
    motionSelect.value=settings.motion||'system';motionSelect.addEventListener('change',()=>{settings.motion=motionSelect.value;saveSettings();applyAppearance();});
    visuals.append(motionSelect);
    const small=document.createElement('small');small.textContent='v'+VERSION+'｜暗号化してntfy.shを経由。公開中継には一時保存と容量制限があるよ。機密情報は送らないでね。';panel.append(small);
    panel.scrollTop=0;
    applyAppearance();
    updateStatus(statusText,statusBad);
  }

  const css = document.createElement('style');
  css.textContent = `
    #skr-launcher{position:fixed;z-index:2147483646;right:12px;top:65px;width:46px;height:46px;border:0;border-radius:50%;background:#12617a;color:#fff;font-size:21px;box-shadow:0 3px 14px #0006}
    #skr-panel,#skr-panel *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',sans-serif;letter-spacing:normal;}
    #skr-panel{position:fixed;z-index:2147483647;right:12px;top:119px;width:min(365px,calc(100vw - 24px));max-height:72dvh;overflow:auto;overscroll-behavior:contain;padding:14px;border-radius:16px;background:#0c1d26;color:#edf7fa;border:1px solid #3d6170;box-shadow:0 6px 32px #001a2480;font-size:14px;line-height:1.5;text-align:left;}
    #skr-panel[hidden]{display:none!important}
    #skr-panel .skr-header{position:sticky;top:-14px;background:#0c1d26;z-index:3;display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 10px;padding:4px 0 9px;border-bottom:1px solid #31505a;}
    #skr-panel .skr-header strong{font-size:16px;color:#f5fbfd;font-weight:700}
    #skr-panel .skr-header button{border:0;background:transparent;color:#d9ecf1;font-size:28px;width:42px;min-height:42px;padding:0;flex:none}
    #skr-panel p{margin:7px 0;font-size:13px;line-height:1.45;color:#c0d3da}
    #skr-panel #skr-status{margin:7px 0 14px;border-radius:9px;background:#143a38;color:#b6f0dc;padding:10px 11px;font-size:13px;font-weight:600;border:1px solid #225c54;overflow-wrap:anywhere}
    #skr-panel #skr-status[data-error="true"]{background:#48242a;color:#ffd5db;border-color:#87414a}
    #skr-panel .skr-card{background:#132934;border:1px solid #31515d;border-radius:14px;padding:13px;margin:0 0 12px}
    #skr-panel .skr-card h3{margin:0 0 8px;font-size:16px;color:#f0fbfd}
    #skr-panel button{appearance:none;display:block;width:100%;min-height:44px;margin:9px 0 0;padding:10px 12px;background:#e6f0f4;color:#183744;border:1px solid #c4d8df;border-radius:10px;font-size:14px;line-height:1.3;font-weight:600;text-align:center;cursor:pointer}
    #skr-panel button.skr-primary{background:#087294;color:#fff;border-color:#1786a8;font-size:16px;min-height:54px}
    #skr-panel button:disabled{opacity:.48;cursor:default}
    #skr-panel input,#skr-panel textarea{appearance:auto;display:block;width:100%;font:16px/1.45 -apple-system,BlinkMacSystemFont,sans-serif!important;border:1px solid #90acb9!important;border-radius:10px!important;padding:11px!important;background:#fff!important;color:#182c35!important;-webkit-text-fill-color:#182c35!important;margin:5px 0!important}
    #skr-panel input::placeholder,#skr-panel textarea::placeholder{color:#78868d!important;-webkit-text-fill-color:#78868d!important}
    #skr-panel textarea{min-height:132px;max-height:36dvh;resize:vertical}
    #skr-panel label{display:block;font-size:13px;font-weight:600;color:#d5e7ed;margin:5px 0}
    #skr-panel .skr-tools{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:0 0 6px}
    #skr-panel .skr-tools button{min-height:44px;font-size:13px;margin:0;padding:9px 4px}
    #skr-panel #skr-erase-draft{background:#5d3036;color:#ffe5e5;border-color:#94525b}
    #skr-panel #skr-undo-erase{background:#284e46;color:#edfff7;border-color:#538a79}
    #skr-panel .skr-draft-count{text-align:right;color:#b9d5df;font-size:12px;padding:0 2px 3px}

    #skr-panel .skr-choice{display:flex;align-items:center;gap:8px;margin:9px 0 2px;font-size:13px;font-weight:500}
    #skr-panel .skr-choice input{width:20px;height:20px;flex:none;margin:0!important;accent-color:#27b1d1}
    #skr-panel .skr-card-title{display:flex;justify-content:space-between;gap:7px;align-items:center}
    #skr-panel .skr-card-title strong{font-size:16px;color:#f2fbfe}
    #skr-panel #skr-reply-time{font-size:11px;color:#9bbac6}
    #skr-panel #skr-remote-share-state{background:#263e48;color:#d0e4eb;font-weight:700;border-radius:8px;padding:8px;font-size:12px}
    #skr-panel #skr-remote-share-state[data-enabled="true"]{background:#145547;color:#b9f4db}
    #skr-panel #skr-remote-share-state[data-enabled="false"]{background:#5b3032;color:#ffe0df}
    #skr-panel #skr-reply{display:block;min-height:74px;max-height:150px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.6;color:#eaf7fa!important;-webkit-text-fill-color:#eaf7fa!important;background:#1b3441;padding:11px;border-radius:9px;border:1px solid #345665;user-select:text;margin-top:8px}
    #skr-panel #skr-share-toggle{background:#602b34;color:#ffe4e7;border:1px solid #a8525d;min-height:53px}
    #skr-panel #skr-share-toggle[data-enabled="true"]{background:#166b56;border-color:#30a687;color:#fff}
    #skr-panel #skr-share-status{color:#e4eff4}
    #skr-panel .skr-draft-hint{font-size:11px;color:#afd1db;line-height:1.45;margin:10px 0 3px}
    #skr-panel #skr-code{padding:12px;background:#1f3d4b;color:#fff;border-radius:8px;text-align:center;font-size:22px;letter-spacing:1.5px;font-weight:700;user-select:text}
    #skr-panel .skr-details{background:#152f3a;border:1px solid #345666;border-radius:11px;margin:10px 0;padding:0 11px 11px}
    #skr-panel .skr-details:not([open]){padding-bottom:0}
    #skr-panel .skr-details summary{cursor:pointer;padding:13px 4px;color:#e4f3f8;font-size:14px;font-weight:700}
    #skr-panel .skr-details label{margin-top:14px}
    #skr-panel #skr-received-files p{color:#eaf7fa}
    #skr-panel small{display:block;color:#96b3c0;font-size:11px;line-height:1.45;padding:12px 2px}
    html.skr-focus-mode #skr-launcher{display:none!important}
    html.skr-focus-mode #skr-panel{position:fixed!important;inset:0!important;top:0!important;left:0!important;right:0!important;bottom:0!important;width:100vw!important;max-width:none!important;height:100dvh!important;max-height:100dvh!important;z-index:2147483647!important;border:0!important;border-radius:0!important;padding:calc(env(safe-area-inset-top,0px) + 12px) max(15px,env(safe-area-inset-right,0px)) calc(env(safe-area-inset-bottom,0px) + 18px) max(15px,env(safe-area-inset-left,0px));box-shadow:none!important;overflow-y:auto!important;-webkit-overflow-scrolling:touch;}
    html.skr-focus-mode #skr-panel .skr-header{top:calc(-1 * (env(safe-area-inset-top,0px) + 12px));padding-top:8px}
    html.skr-focus-mode #skr-panel .skr-card{margin-bottom:12px}
    html.skr-focus-mode #skr-panel textarea{min-height:150px;max-height:36dvh}
    @media(min-width:600px){html.skr-focus-mode #skr-panel>.skr-card,html.skr-focus-mode #skr-panel>.skr-details,html.skr-focus-mode #skr-panel>#skr-status,html.skr-focus-mode #skr-panel>small{max-width:720px;margin-left:auto;margin-right:auto}}
  `;
  // v1.5 UI skin. Additive override: the reliable v1.4 transport and IDs remain intact.
  css.textContent += `
    #skr-launcher{background:linear-gradient(145deg,#30313f,#8a455d);border:1px solid #b27588;box-shadow:0 10px 26px #0007;font-size:22px}
    #skr-panel{--skr-ink:#f5f0ef;--skr-soft:#c7b9c2;--skr-accent:#c47087;--skr-border:#4f4653;--skr-pane:#1c202a;--skr-btn:#313b4a;
      color:var(--skr-ink);background:linear-gradient(170deg,#161b26 0%,#151821 48%,#1e1b27 100%);border:1px solid #554c5f;
      border-radius:22px;padding:18px;box-shadow:0 26px 90px #000b;font-size:14px;line-height:1.55;}
    #skr-panel .skr-header{position:sticky;top:-18px;background:#1b1d29;z-index:3;margin:0 0 15px;padding:9px 0 13px;border-bottom:1px solid #584654;}
    #skr-panel .skr-brand{display:flex;align-items:center;gap:11px;min-width:0}
    #skr-panel .skr-brand-icon{display:flex;align-items:center;justify-content:center;flex:none;width:43px;height:43px;border-radius:13px;
      background:linear-gradient(135deg,#8a435f,#3d344c);color:#ffeff4;font-size:23px;border:1px solid #95617b}
    #skr-panel .skr-brand-lines{display:flex;flex-direction:column;gap:1px;min-width:0}
    #skr-panel .skr-header strong{font-size:16px;color:#fff6f6;font-weight:750;letter-spacing:-.02em}
    #skr-panel .skr-brand-lines>span{font-size:9px;color:#b7a8bb;letter-spacing:.16em;font-weight:700}
    #skr-panel .skr-header button.skr-close{width:42px;min-width:42px;height:42px;min-height:42px;font-size:26px;color:#dccbda;
      border-radius:12px;background:#302937;border:1px solid #584558;margin:0;padding:0}
    #skr-panel .skr-connection-strip{display:flex;justify-content:space-between;align-items:center;gap:6px;margin:0 0 9px;font-size:12px}
    #skr-panel .skr-state-pill{display:inline-flex;align-items:center;padding:6px 12px;border-radius:999px;background:#3b3341;
      border:1px solid #6a4e65;color:#ecd9e3;font-size:12px;font-weight:750}
    #skr-panel .skr-state-pill[data-state="online"]{background:#173f38;border-color:#357f69;color:#baf4dd}
    #skr-panel .skr-state-pill[data-state="waiting"]{background:#4d3c27;border-color:#917044;color:#f5d8a4}
    #skr-panel .skr-mode-label{color:#ab9ba8;font-size:11px}
    #skr-panel #skr-status{background:#282c36;color:#d8dce5;border:1px solid #474856;padding:10px 12px;font-size:12px;line-height:1.55;
      margin:0 0 15px;font-weight:600;border-radius:12px;overflow-wrap:anywhere}
    #skr-panel #skr-status[data-error="true"]{background:#4c2934;color:#ffe3e7;border-color:#ae5d6b}
    #skr-panel .skr-card{background:linear-gradient(165deg,#242631,#212632);border:1px solid #555060;border-radius:19px;padding:16px;margin:0 0 13px;box-shadow:0 3px 15px #05060b20}
    #skr-panel .skr-compose{border-color:#765367;box-shadow:0 5px 26px #9d597117}
    #skr-panel label.skr-step-label{font-size:15px;font-weight:750;color:#ffedf4;margin:0 0 10px;letter-spacing:.01em}
    #skr-panel .skr-card-title strong,#skr-panel .skr-card h3{color:#fff1f4;font-size:15px;letter-spacing:-.01em}
    #skr-panel p{color:#c7bbc8;font-size:12px;line-height:1.6}
    #skr-panel input:not([type="checkbox"]):not([type="file"]),#skr-panel textarea{font:16px/1.6 -apple-system,BlinkMacSystemFont,sans-serif!important;
      color:#211c25!important;background:#fffafd!important;-webkit-text-fill-color:#211c25!important;border:1px solid #a99cac!important;
      border-radius:14px!important;padding:14px!important;box-shadow:inset 0 1px 4px #0001;margin:6px 0 10px!important}
    #skr-panel textarea::placeholder,#skr-panel input::placeholder{color:#8d8792!important;-webkit-text-fill-color:#8d8792!important}
    #skr-panel #skr-typing{min-height:182px;max-height:43dvh;resize:vertical}
    #skr-panel button{margin:8px 0 0;min-height:45px;border:1px solid #55616e;background:#e7e9f1;color:#222d3c;border-radius:13px;font-size:13px;font-weight:750;padding:11px 9px}
    #skr-panel button.skr-primary{min-height:58px;background:linear-gradient(100deg,#9b4868,#ac5977 68%,#8b4261);color:#fff;border:1px solid #d08da7;
      border-radius:14px;font-size:17px;box-shadow:0 4px 18px #8b426135}
    #skr-panel button.skr-primary:disabled{opacity:.5;box-shadow:none}
    #skr-panel button:focus-visible,#skr-panel summary:focus-visible,#skr-panel textarea:focus-visible{outline:3px solid #edabc3;outline-offset:2px}
    #skr-panel .skr-tools{gap:7px;margin-top:3px;grid-template-columns:repeat(3,minmax(0,1fr))}
    #skr-panel .skr-tools button{min-height:46px;font-size:12px;border-radius:11px;background:#353d4a;border:1px solid #606574;color:#f1edf6}
    #skr-panel #skr-erase-draft{background:#503344;color:#ffe5ee;border-color:#875a72}
    #skr-panel #skr-undo-erase{background:#274c47;border-color:#4f8e7f;color:#e1ffef}
    #skr-panel .skr-draft-count{color:#afaab9;margin-top:2px}
    #skr-panel #skr-reply{background:#161f2b;border-color:#52617a;color:#f2f2f9!important;-webkit-text-fill-color:#f2f2f9!important;
      min-height:92px;max-height:240px;border-radius:13px;padding:14px;line-height:1.7}
    #skr-panel #skr-remote-share-state{border:1px solid #656170;background:#393641;color:#e9e4f0;border-radius:10px;font-size:12px;padding:10px}
    #skr-panel #skr-remote-share-state[data-enabled="true"]{background:#20453c;color:#bbf4db;border-color:#3b8669}
    #skr-panel #skr-remote-share-state[data-enabled="false"]{background:#50313b;color:#ffe1e1;border-color:#99606b}
    #skr-panel #skr-share-toggle{border-radius:14px;background:#593040;color:#ffe9ee;border-color:#a2637a}
    #skr-panel #skr-share-toggle[data-enabled="true"]{background:#245544;color:#c8ffe5;border-color:#5b9d7d}
    #skr-panel .skr-draft-hint,#skr-panel .skr-reply-hint{font-size:11px;color:#b7adb8;line-height:1.55}
    #skr-panel #skr-code{background:#372c3d;border:1px solid #89617d;border-radius:14px;padding:15px;letter-spacing:2px;color:#fff3f5}
    #skr-panel .skr-details{background:#24222e;border-color:#555062;border-radius:13px;margin:10px 0;padding:0 12px 12px}
    #skr-panel .skr-details:not([open]){padding-bottom:0}
    #skr-panel .skr-details summary{color:#e8d7e4;padding:15px 5px;font-size:13px}
    #skr-panel #skr-remote-debug,#skr-panel #skr-diagnostic-summary{padding:10px;border-radius:10px;background:#1b2432;color:#e5ddeb}
    #skr-panel #skr-share-status{color:#e5dce8}
    #skr-panel small{color:#a698ac;font-size:10px;padding-top:16px}
    html.skr-focus-mode #skr-panel{padding:calc(env(safe-area-inset-top,0px) + 18px) max(14px,env(safe-area-inset-right,0px)) calc(env(safe-area-inset-bottom,0px) + 22px) max(14px,env(safe-area-inset-left,0px));}
    html.skr-focus-mode #skr-panel .skr-header{top:calc(-1 * (env(safe-area-inset-top,0px) + 18px));padding-top:8px;background:#1b1d29}
    html.skr-focus-mode #skr-panel textarea{min-height:188px;max-height:42dvh}
    @media (prefers-reduced-motion: no-preference) {#skr-panel button{transition:background .15s ease,transform .1s ease;}#skr-panel button:active{transform:scale(.992)}}
    @media(min-width:600px){html.skr-focus-mode #skr-panel>.skr-header,html.skr-focus-mode #skr-panel>.skr-connection-strip{max-width:720px;margin-left:auto;margin-right:auto}}
    #skr-panel .skr-quicknav{display:flex;gap:8px;position:sticky;top:70px;z-index:2;background:linear-gradient(170deg,#1b1d29,#25202c);border:1px solid #544558;padding:7px;border-radius:13px;margin:3px 0 14px}
    #skr-panel .skr-quicknav button{flex:1;min-height:39px;margin:0;padding:7px 4px;font-size:12px;color:#f5e9ef;background:#413344;border-color:#735469}
    #skr-panel #skr-photo-mode{display:block;width:100%;min-height:44px;margin:8px 0 10px;border-radius:11px;padding:10px 12px;background:#323647;color:#fff1f6;border:1px solid #715771;font:600 14px -apple-system,BlinkMacSystemFont,sans-serif}
    #skr-panel #skr-file-progress{border:1px solid #63708c;border-radius:12px;padding:12px;margin-top:12px;background:#202e40;color:#e5f4ff;font-size:12px;line-height:1.6;overflow-wrap:anywhere}
    #skr-panel #skr-file-progress[data-error="true"]{background:#542d3b;color:#ffe1e6;border-color:#aa576c}
    #skr-reply-picker-tip{position:fixed;z-index:2147483647;top:max(env(safe-area-inset-top,0px),12px);left:12px;right:12px;display:flex;align-items:center;justify-content:space-between;gap:12px;background:#302337;color:#fff2f7;border:2px solid #ed9cb4;padding:14px;border-radius:14px;box-shadow:0 8px 32px #0008;font:600 14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif}
    #skr-reply-picker-tip button{background:#e9dae4;color:#2b2430;border:0;border-radius:10px;padding:10px 14px;white-space:nowrap;font-weight:700}
    html.skr-focus-mode #skr-panel .skr-quicknav{top:75px}
    @media(prefers-reduced-motion:reduce){#skr-panel .skr-quicknav{scroll-behavior:auto}}

    /* v1.7: layered, responsive design. All style changes are scoped to the extension. */
    #skr-launcher {background:linear-gradient(145deg,#e39fc4,#7153bb);box-shadow:0 8px 26px #9b65c566;border:1px solid #f5cee7;transition:transform .22s ease,box-shadow .22s ease}
    #skr-launcher:active{transform:scale(.93)}
    #skr-panel[data-theme] {
      --ui-main:#151927;--ui-card:#24273b;--ui-layer:#302b40;--ui-border:#60576e;
      --ui-accent:#e0a6da;--ui-accent-soft:#ffaec6;--ui-glow:#d69ff16b;
      --ui-text:#fff2fa;--ui-muted:#c3bdd2;--ui-button:#eae4f5;
      color:var(--ui-text); background:
        radial-gradient(ellipse at 10% 0%,#9466af32 0%,transparent 42%),
        radial-gradient(ellipse at 99% 19%,#b6517950 0%,transparent 36%),
        linear-gradient(166deg,#191a2a 0%,#171928 46%,#191522 100%);
      border:1px solid var(--ui-border);box-shadow:0 22px 80px #04010de0, inset 0 1px #fff2;
      border-radius:23px;
    }
    #skr-panel[data-theme="lagoon"]{--ui-main:#0d2630;--ui-card:#173644;--ui-layer:#244653;--ui-border:#417582;--ui-accent:#96efdd;--ui-accent-soft:#76b8f4;--ui-glow:#60d4c760;--ui-text:#ebfff9;--ui-muted:#b0d5df;--ui-button:#e7fcff;
      background:radial-gradient(ellipse at 7% 0%,#149b9560,transparent 44%),radial-gradient(ellipse at 99% 19%,#4378bd50,transparent 40%),linear-gradient(165deg,#09232d,#0f2030 65%,#132132)}
    #skr-panel[data-theme="graphite"]{--ui-main:#191b22;--ui-card:#24262e;--ui-layer:#32353d;--ui-border:#636974;--ui-accent:#f0e8dc;--ui-accent-soft:#b6c5d8;--ui-glow:#adb6bc44;--ui-text:#fbfcfc;--ui-muted:#bfc3ca;--ui-button:#f2f2f2;
      background:linear-gradient(163deg,#25282f,#16181f 65%,#23252c)}
    #skr-panel[data-theme] .skr-header{background:linear-gradient(90deg,var(--ui-main),transparent);border-color:var(--ui-border);padding-bottom:15px;backdrop-filter:blur(20px)}
    #skr-panel[data-theme] .skr-header strong{color:var(--ui-text);font-size:17px}
    #skr-panel[data-theme] .skr-brand-lines>span{color:var(--ui-muted)}
    #skr-panel[data-theme] .skr-brand-icon{border:1px solid var(--ui-border);color:var(--ui-text);
      background:linear-gradient(145deg,var(--ui-layer),var(--ui-main));box-shadow:0 4px 22px var(--ui-glow)}
    #skr-panel .skr-header-actions{display:flex;align-items:center;gap:6px;margin-left:auto;flex-shrink:0}
    #skr-panel[data-theme] button.skr-theme-switch{display:inline-flex;align-items:center;justify-content:center;width:auto;min-height:35px;
      margin:0;background:var(--ui-layer);color:var(--ui-text);border:1px solid var(--ui-border);padding:5px 9px;font-size:10px;white-space:nowrap;border-radius:999px}
    #skr-panel[data-theme] button.skr-close{width:39px;min-width:39px;height:39px;min-height:39px;background:var(--ui-layer);color:var(--ui-text);border:1px solid var(--ui-border)}
    #skr-panel[data-theme] .skr-state-pill{color:var(--ui-text);background:var(--ui-layer);border-color:var(--ui-border)}
    #skr-panel[data-theme] .skr-state-pill[data-state="online"]{background:#204a41;color:#c7ffe6;border-color:#498c77}
    #skr-panel[data-theme] .skr-state-pill[data-state="waiting"]{background:#4c3b2c;color:#fce0ae;border-color:#9c7952}
    #skr-panel[data-theme] .skr-mode-label{color:var(--ui-muted)}
    #skr-panel[data-theme] #skr-status{background:color-mix(in srgb,var(--ui-layer) 80%,transparent);color:var(--ui-muted);border-color:var(--ui-border);font-weight:600}
    #skr-panel[data-theme] #skr-status[data-error="true"]{background:#522935;color:#ffe5ee;border-color:#b97082}
    #skr-panel[data-theme] .skr-card{background:color-mix(in srgb,var(--ui-card) 92%,transparent);border-color:var(--ui-border);
      box-shadow:inset 0 1px #fff2,0 12px 24px #0002;backdrop-filter:blur(12px);border-radius:20px}
    #skr-panel[data-theme] .skr-compose{border-color:var(--ui-accent);box-shadow:0 0 0 1px var(--ui-glow),0 12px 26px #0002}
    #skr-panel[data-theme] label.skr-step-label,#skr-panel[data-theme] .skr-card h3,#skr-panel[data-theme] .skr-card-title strong{color:var(--ui-text)}
    #skr-panel[data-theme] p{color:var(--ui-muted)}
    #skr-panel[data-theme] #skr-typing{border-color:#bfb4c5!important;background:#fffbff!important;box-shadow:0 2px 12px #0002;
      min-height:168px;line-height:1.68!important;resize:vertical}
    #skr-panel[data-theme] textarea:focus-visible{outline:2px solid var(--ui-accent)!important;outline-offset:3px}
    #skr-panel[data-theme] button.skr-primary{background:linear-gradient(110deg,var(--ui-accent) 0%,var(--ui-accent-soft) 95%);
      border:1px solid #ffffff5f;color:#241b31;box-shadow:0 7px 27px var(--ui-glow);font-weight:800}
    #skr-panel[data-theme] .skr-tools button{background:var(--ui-layer);border-color:var(--ui-border);color:var(--ui-text)}
    #skr-panel[data-theme] #skr-erase-draft{background:#683846;color:#fff0f3}
    #skr-panel[data-theme] #skr-undo-erase{background:#264e46;color:#e6fff5}
    #skr-panel[data-theme] #skr-reply{background:color-mix(in srgb,var(--ui-main) 85%,black);border-color:var(--ui-border);color:var(--ui-text)!important;
      -webkit-text-fill-color:var(--ui-text)!important;max-height:none;max-width:100%;white-space:pre-wrap;overflow-wrap:anywhere}
    #skr-panel[data-theme] .skr-details{background:color-mix(in srgb,var(--ui-card) 80%,transparent);border-color:var(--ui-border);border-radius:16px}
    #skr-panel[data-theme] .skr-details summary{color:var(--ui-text)}
    html.skr-focus-mode #skr-panel[data-theme] .skr-quicknav, #skr-panel[data-theme] .skr-quicknav{position:static!important;top:auto!important;z-index:1;background:var(--ui-main);border:1px solid var(--ui-border);box-shadow:inset 0 1px #fff1}
    #skr-panel[data-theme] .skr-quicknav button{background:var(--ui-layer);border-color:var(--ui-border);color:var(--ui-text)}
    #skr-panel[data-theme] #skr-photo-mode,#skr-panel[data-theme] #skr-motion{background:var(--ui-layer);color:var(--ui-text);border:1px solid var(--ui-border);border-radius:12px;padding:12px;width:100%;font-size:14px}
    #skr-panel .skr-theme-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}
    #skr-panel[data-theme] .skr-theme-grid button{background:var(--ui-layer);color:var(--ui-text);border:1px solid var(--ui-border);font-size:12px;padding:9px 2px}
    #skr-panel[data-theme] .skr-theme-grid button[aria-pressed="true"]{border-color:var(--ui-accent);box-shadow:inset 0 0 0 1px var(--ui-accent);color:var(--ui-accent)}
    #skr-panel[data-theme] #skr-file-progress{background:var(--ui-main);border-color:var(--ui-border);color:var(--ui-text)}
    #skr-panel[data-theme] .skr-header,#skr-panel[data-theme] .skr-card,#skr-panel[data-theme] .skr-details{contain:paint}
    html.skr-focus-mode #skr-panel[data-theme]{border:0;border-radius:0;box-shadow:none;max-height:100dvh;
      padding:calc(env(safe-area-inset-top,0px) + 18px) max(14px,env(safe-area-inset-right,0px)) calc(env(safe-area-inset-bottom,0px) + 40px) max(14px,env(safe-area-inset-left,0px))}
    html.skr-focus-mode #skr-panel[data-theme] .skr-header{background:var(--ui-main)}
    @keyframes skr-entrance{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
    @keyframes skr-breathe{0%,100%{box-shadow:0 0 0 0 var(--ui-glow)}50%{box-shadow:0 0 0 5px transparent}}
    @keyframes skr-shimmer{from{background-position:160% 0}to{background-position:-160% 0}}
    @media(prefers-reduced-motion:no-preference){
      #skr-panel:not([data-motion="off"]) .skr-card{animation:skr-entrance .45s ease-out both}
      #skr-panel:not([data-motion="off"]) .skr-state-pill[data-state="online"]{animation:skr-breathe 3s ease-in-out infinite}
      #skr-panel:not([data-motion="off"]) button.skr-primary{transition:filter .18s,transform .18s,box-shadow .18s;background-size:200% 100%}
      #skr-panel:not([data-motion="off"]) button.skr-primary:active{transform:scale(.98);filter:brightness(1.05)}
    }
    #skr-panel[data-motion="on"] .skr-card{animation:skr-entrance .45s ease-out both}
    #skr-panel[data-motion="on"] .skr-state-pill[data-state="online"]{animation:skr-breathe 3s ease-in-out infinite}
    #skr-panel[data-motion="off"] *,#skr-panel[data-motion="off"] *:before,#skr-panel[data-motion="off"] *:after{animation:none!important;transition:none!important;scroll-behavior:auto!important}
    @media(max-width:355px){#skr-panel .skr-header-actions{gap:3px}#skr-panel[data-theme] button.skr-theme-switch{font-size:9px;padding:5px}#skr-panel .skr-brand-lines>span{display:none}}
  `;

  css.textContent += `
    /* v1.9 connection code UI: per-glyph differentiation, readable on iPad/iPhone. */
    #skr-panel .skr-pair-chars{display:flex;justify-content:center;align-items:center;gap:clamp(3px,.75vw,9px);
      font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,monospace!important;font-variant-numeric:tabular-nums;
      letter-spacing:0!important;user-select:text;flex-wrap:nowrap;white-space:nowrap;overflow-x:auto}
    #skr-panel .skr-pair-group{display:inline-flex;gap:clamp(2px,.5vw,5px);white-space:nowrap}
    #skr-panel .skr-pair-digit{color:#ffcf8f!important;-webkit-text-fill-color:#ffcf8f!important;font-weight:900}
    #skr-panel .skr-pair-letter{color:#9aeeef!important;-webkit-text-fill-color:#9aeeef!important;font-weight:900}
    #skr-panel .skr-pair-separator{opacity:.58;font-weight:600;color:var(--ui-muted,#d1c0ce)!important}
    #skr-panel #skr-code{font-size:clamp(16px,2.4vw,27px);padding:16px 9px;letter-spacing:0!important;min-height:56px}
    #skr-panel #skr-pair-preview{background:#102632;border:1px solid var(--ui-border,#425967);padding:11px 6px;
      border-radius:12px;margin:10px 0 3px;min-height:46px;font-size:clamp(15px,3vw,23px)}
    #skr-panel .skr-pair-legend{font-weight:600;margin:9px 0!important;font-size:12px}
    #skr-panel .skr-pair-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    #skr-panel .skr-pair-actions button{margin:6px 0 0;font-size:12px;padding:11px 7px;min-width:0}
    #skr-panel .skr-code-feedback{font-size:12px;color:var(--ui-muted,#ced4dd)!important;margin:3px 0 10px!important}
    #skr-panel #skr-room{font-family:ui-monospace,SFMono-Regular,Menlo,monospace!important;letter-spacing:.07em;font-weight:750}
    #skr-panel #skr-paste-pair{background:var(--ui-layer,#334456);color:var(--ui-text,#fff);border-color:var(--ui-border,#596d80)}
    @media(max-width:500px){#skr-panel #skr-code{font-size:clamp(14px,4vw,23px)}}
  `;

  css.textContent += `
    #skr-panel .skr-photo-shortcuts{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:9px 0}
    #skr-panel .skr-photo-shortcuts button{background:var(--ui-layer,#283642);color:var(--ui-text,#fff);
      border:1px solid var(--ui-border,#506879);margin:0;padding:11px 5px;min-height:48px;font-size:13px}
    #skr-panel .skr-visually-hidden-file{position:absolute!important;width:1px!important;height:1px!important;
      padding:0!important;overflow:hidden!important;opacity:0!important;pointer-events:none!important;
      clip-path:inset(50%)!important;margin:0!important}
    #skr-panel #skr-file-progress-quick{font-size:12px;color:var(--ui-muted,#bcd0da);padding:3px 2px 8px;
      overflow-wrap:anywhere;min-height:20px}
    #skr-panel #skr-file-progress-quick[data-error="true"]{color:#fcaeae}
    #skr-panel .skr-reply-wrap{padding-top:13px;padding-bottom:14px}
    #skr-panel .skr-reply-wrap button.skr-primary{font-size:14px;min-height:44px}
  `;
  css.textContent += `
    #skr-panel #skr-attach-button{width:100%;margin:8px 0 3px;min-height:52px;
      background:var(--ui-layer,#2a4653);color:var(--ui-text,#f7fcff);
      border:1px solid var(--ui-border,#44798c);font-size:15px;font-weight:750}
    #skr-panel #skr-confirm-posted{width:100%;border-color:#8b7459;
      background:#3d3a32;color:#ffeaca;font-size:13px;min-height:44px}
    #skr-panel #skr-confirm-posted[hidden]{display:none!important}
    #skr-panel #skr-file-progress-quick:empty{display:none!important}
  `;
  document.documentElement.append(css);
  const launcher = document.createElement('button'); launcher.id = 'skr-launcher'; launcher.textContent = '⌨'; launcher.title = 'リモート入力';
  const panel = document.createElement('aside'); panel.id = 'skr-panel';
  document.body.append(launcher, panel);
  launcher.onclick = () => { panel.hidden = !panel.hidden; };
  if(STANDALONE){ prefs.role='send'; prefs.auto=true; }
  if(!sentText) sentText=restoreDraft();
  draw();
  if (focusMode) switchFocus(true);
  // Restore saved pairing and local draft (no server-side draft storage by this app).
  const incomingPairCode=shareablePairFragment();
  if (STANDALONE && !incomingPairCode) {
    const u=new URL(location.href); const incoming=new URLSearchParams(u.hash.replace(/^#/,'')); const shared=incoming.get('text') || incoming.get('url') || '';
    if(shared && shared.length<=MAX_TEXT){ sentText=shared;saveDraft(shared);history.replaceState(null,'',u.pathname); }
  }
  if (!STANDALONE && prefs.role === 'receive') {
    startReceive();
    if (prefs.auto) delay(() => allowReceive(true), 500);
  } else if (prefs.role === 'send' || STANDALONE) {
    mode = 'send'; code = prefs.senderCode; draw(); if(focusMode) switchFocus(true);
    if(incomingPairCode){
      const isNew=incomingPairCode!==code;
      const accepted=!isNew||window.confirm('iPadから共有された接続コードに切り替えて接続する？\n'+pretty(incomingPairCode)+'\n※ 自分のiPadから届いたコードだけ許可してね。');
      if(accepted){
        code=incomingPairCode;const field=el('#skr-room');
        if(field){field.value=pretty(code);field.dispatchEvent(new Event('input',{bubbles:true}));}
        delay(()=>startSend(code,false),500);
      }else if(prefs.auto&&isValidCode(code)) delay(()=>startSend(code,true),500);
    }else if (prefs.auto && isValidCode(code)) delay(() => startSend(code, true), 500);
  }
  window.addEventListener('pagehide', () => { if(mode==='send') saveDraft(el('#skr-typing')?.value || ''); disconnect(); });
  window.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')resumeAfterForeground();});
  window.addEventListener('pageshow',()=>{resumeAfterForeground();});
  window.addEventListener('online',()=>{resumeAfterForeground();});
})();
