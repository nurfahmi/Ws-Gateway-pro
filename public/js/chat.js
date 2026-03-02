(function() {
  const socket = io();
  const $ = id => document.getElementById(id);
  const deviceFilter = $('deviceFilter'), chatList = $('chatList'), chatSearch = $('chatSearch');
  const waMain = $('waMain'), emptyState = $('emptyState'), fileInput = $('fileInput');
  const ctxMenu = $('ctxMenu'), emojiPicker = $('emojiPicker'), infoPanel = $('infoPanel');

  let allChats = [], activeJid = null, activeDevice = null, lastMsgId = 0, pendingFile = null;
  let newMsgCount = 0, ctxTarget = null;
  const unreadCounts = {}; // track unread per chat key
  const devices = window.__devices;

  // ─── Utilities ───
  const deviceColors = ['#25d366','#6366f1','#e11d48','#f59e0b','#06b6d4','#7c3aed','#128c7e','#075e54','#34b7f1','#00a884'];
  const deviceColorMap = {}; let colorIdx = 0;
  function getDeviceColor(sid) { if (!deviceColorMap[sid]) deviceColorMap[sid] = deviceColors[colorIdx++ % deviceColors.length]; return deviceColorMap[sid]; }
  const avatarColors = ['#25d366','#128c7e','#075e54','#34b7f1','#00a884','#7c3aed','#e11d48','#f59e0b','#06b6d4','#6366f1'];
  function getAvatarColor(s) { let h=0; for(let i=0;i<(s||'').length;i++) h=s.charCodeAt(i)+((h<<5)-h); return avatarColors[Math.abs(h)%avatarColors.length]; }
  function getInitials(n) { const p=(n||'?').split(' '); return p.length>1?(p[0][0]+p[1][0]).toUpperCase():n.substring(0,2).toUpperCase(); }
  function esc(s) { const d=document.createElement('div'); d.textContent=s||''; return d.innerHTML; }
  function formatTime(ds) { const d=new Date(ds),n=new Date(),diff=n-d; if(diff<86400000&&d.getDate()===n.getDate()) return d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); if(diff<172800000) return 'Yesterday'; if(diff<604800000) return d.toLocaleDateString([],{weekday:'short'}); return d.toLocaleDateString([],{day:'2-digit',month:'2-digit',year:'2-digit'}); }
  function fmtTime(ds) { return new Date(ds).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); }
  function fmtDate(ds) { const d=new Date(ds),n=new Date(),diff=n-d; if(diff<86400000&&d.getDate()===n.getDate()) return 'Today'; if(diff<172800000) return 'Yesterday'; return d.toLocaleDateString([],{weekday:'long',day:'numeric',month:'long',year:'numeric'}); }
  function statusIcon(s) {
    if(!s) return '';
    const isRead = s==='read'||s==='played'||s==='read_by_recipient';
    const isDelivered = s==='delivered'||s==='delivery_ack';
    const blue = '#53bdeb';
    // Single check (sent)
    const single = `<svg width="12" height="11" viewBox="0 0 12 11" class="wa-check"><path d="M11.071.653a.457.457 0 0 0-.304-.102.493.493 0 0 0-.381.178L4.19 8.17 1.866 5.672a.483.483 0 0 0-.358-.165.49.49 0 0 0-.359.165l-.344.369a.571.571 0 0 0 0 .754l3.005 3.222a.472.472 0 0 0 .714 0l.189-.211 6.674-7.926a.553.553 0 0 0 .087-.452.473.473 0 0 0-.2-.3z"/></svg>`;
    // Double check (delivered/read) — tightly overlapping like WhatsApp
    const double = `<svg width="16" height="11" viewBox="0 0 16 11" class="wa-check"><path d="M11.071.653a.457.457 0 0 0-.304-.102.493.493 0 0 0-.381.178L4.19 8.17 1.866 5.672a.483.483 0 0 0-.358-.165.49.49 0 0 0-.359.165l-.344.369a.571.571 0 0 0 0 .754l3.005 3.222a.472.472 0 0 0 .714 0l.189-.211 6.674-7.926a.553.553 0 0 0 .087-.452.473.473 0 0 0-.2-.3z"/><path d="M13.571.653a.457.457 0 0 0-.304-.102.493.493 0 0 0-.381.178L6.69 8.17l-.925-.99-.38.456 1.62 1.74a.472.472 0 0 0 .714 0l.189-.212 6.674-7.926a.553.553 0 0 0 .087-.452.473.473 0 0 0-.2-.3z"/></svg>`;
    if(isRead) return `<span class="wa-bubble-status read">${double}</span>`;
    if(isDelivered) return `<span class="wa-bubble-status">${double}</span>`;
    return `<span class="wa-bubble-status">${single}</span>`;
  }
  function isConnected(sid) { const d=devices.find(x=>x.sessionId===sid); return d&&d.status==='connected'; }
  function groupIcon(size) { return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`; }

  // ─── Notification Sound ───
  function playNotif() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.setValueAtTime(660, ctx.currentTime + 0.08);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.25);
    } catch(e) {}
  }

  // ─── Media HTML ───
  function mediaHtml(mt, content) {
    const icons = { image:'📷 Photo', video:'🎥 Video', audio:'🎵 Audio', ptt:'🎤 Voice', document:'📄', sticker:'🏷️ Sticker', location:'📍 Location', liveLocationMessage:'📍 Live Location', contactMessage:'👤 Contact', contactsArrayMessage:'👥 Contacts' };
    if(mt==='image') {
      let caption = content || '';
      // Handle legacy thumb:base64|caption format
      if(caption.startsWith('thumb:')) { const i=caption.indexOf('|'); caption=i>0?caption.substring(i+1):''; }
      let h = `<div class="wa-media-placeholder">📷 <span>Photo</span></div>`;
      if(caption) h += `<div class="wa-media-caption">${esc(caption)}</div>`;
      return h;
    }
    if(mt==='video') { let h=`<div class="wa-media-placeholder">🎥 <span>Video</span></div>`; if(content) h+=`<div class="wa-media-caption">${esc(content)}</div>`; return h; }
    if(mt==='audio'||mt==='ptt') return `<div class="wa-media-placeholder">${mt==='ptt'?'🎤':'🎵'} <span>${mt==='ptt'?'Voice message':'Audio'}</span></div>`;
    if(mt==='document') return `<div class="wa-media-placeholder">📄 <span>${esc(content)||'Document'}</span></div>`;
    if(icons[mt]) return `<div class="wa-media-placeholder">${icons[mt]}</div>`;
    return esc(content) || `[${mt}]`;
  }

  // ─── Bubble ───
  function makeBubble(msg) {
    const wrap = document.createElement('div');
    wrap.className = `wa-bubble-wrap ${msg.fromMe?'out':'in'}`;
    wrap.dataset.msgId = msg.id||'';
    wrap.dataset.messageId = msg.messageId||'';
    wrap.dataset.content = msg.content||'';
    wrap.dataset.type = msg.messageType||'text';
    wrap.innerHTML = `
      <div class="wa-bubble ${msg.fromMe?'out':'in'}">
        ${!msg.fromMe&&msg.pushName?`<div class="wa-bubble-sender" style="color:${getAvatarColor(msg.pushName)}">${esc(msg.pushName)}</div>`:''}
        <div class="wa-bubble-content">${mediaHtml(msg.messageType||'text',msg.content)}</div>
        <button class="wa-bubble-menu-btn" onclick="event.stopPropagation();window.__ctxBubble(event,this)">▾</button>
        <span class="wa-bubble-time">${fmtTime(msg.createdAt)} ${msg.fromMe?statusIcon(msg.status):''}</span>
      </div>`;
    return wrap;
  }

  // ─── Chat List ───
  async function loadChats() {
    const dev = deviceFilter.value;
    chatList.innerHTML = '<div class="wa-loading"><div class="wa-spinner"></div> Loading...</div>';
    try {
      const url = dev ? `/chat/api/chats?device=${encodeURIComponent(dev)}` : '/chat/api/chats';
      allChats = await (await fetch(url)).json();
      renderChats(allChats);
    } catch(e) { chatList.innerHTML = '<div class="wa-no-chats"><span>Failed to load</span></div>'; }
  }

  function renderChats(chats) {
    if(!chats.length) { chatList.innerHTML = '<div class="wa-no-chats"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span>No conversations found</span></div>'; return; }
    chatList.innerHTML = chats.map(c => {
      const active = activeJid===c.remoteJid&&activeDevice===c.sessionId;
      const dl = c.phoneNumber?`${esc(c.deviceName)} · ${esc(c.phoneNumber)}`:esc(c.deviceName);
      return `<div class="wa-chat-item ${active?'active':''}" data-jid="${c.remoteJid}" data-device="${c.sessionId}" onclick="window.__open('${c.sessionId}','${c.remoteJid}')">
        <div class="wa-avatar" style="background:${getAvatarColor(c.remoteJid)}">${c.isGroup?groupIcon(24):getInitials(c.name)}</div>
        <div class="wa-chat-info">
          <div class="wa-chat-name-row"><span class="wa-chat-name">${esc(c.name)}</span><span class="wa-device-label" style="background:${getDeviceColor(c.sessionId)}">${dl}</span></div>
          <div class="wa-chat-preview">${esc(c.lastMessage)}</div>
        </div>
        <div class="wa-chat-meta">
          <span class="wa-chat-time">${formatTime(c.time)}</span>
          ${(unreadCounts[c.sessionId+'|'+c.remoteJid]||0)>0?`<span class="wa-chat-badge">${unreadCounts[c.sessionId+'|'+c.remoteJid]}</span>`:''}
        </div>
      </div>`;
    }).join('');
  }

  // ─── Open Chat ───
  window.__open = async function(dev, jid) {
    activeJid=jid; activeDevice=dev; lastMsgId=0; pendingFile=null; newMsgCount=0;
    unreadCounts[dev+'|'+jid] = 0; // mark as read
    closeEmojiPicker(); closeInfoPanel();
    const chat = allChats.find(c=>c.remoteJid===jid&&c.sessionId===dev);
    document.querySelectorAll('.wa-chat-item').forEach(el=>el.classList.toggle('active',el.dataset.jid===jid&&el.dataset.device===dev));

    // Mobile: hide sidebar
    document.querySelector('.wa-sidebar')?.classList.add('hidden-mobile');

    const name = chat?chat.name:jid.split('@')[0];
    const isGroup = jid.includes('@g.us');
    const color = getAvatarColor(jid);
    const dl = chat?(chat.phoneNumber?`${chat.deviceName} · ${chat.phoneNumber}`:chat.deviceName):dev;
    const conn = isConnected(dev);
    const onlineDot = conn?'<span class="wa-online-dot"></span>':'';

    waMain.innerHTML = `
      <div class="wa-main-header" onclick="window.__toggleInfo()">
        <button class="wa-back-btn" onclick="event.stopPropagation();window.__backToList()">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
        </button>
        <div class="wa-avatar" style="background:${color};width:40px;height:40px;font-size:15px">${isGroup?groupIcon(20):getInitials(name)}</div>
        <div class="wa-chat-info">
          <div class="wa-chat-name-row"><span class="wa-chat-name">${esc(name)}</span><span class="wa-device-label" style="background:${getDeviceColor(dev)}">${esc(dl)}</span></div>
          <div class="wa-chat-preview">${onlineDot}${isGroup?'Group':conn?'online':jid.split('@')[0]}</div>
        </div>
        <div class="wa-header-actions">
          <button class="wa-header-btn" onclick="event.stopPropagation();window.__searchMsg()" title="Search messages">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          </button>
        </div>
      </div>
      <div class="wa-messages-area" id="msgArea"><div class="wa-loading"><div class="wa-spinner"></div> Loading...</div></div>
      <button class="wa-scroll-btn" id="scrollBtn" onclick="window.__scrollBottom()">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>
        <span class="wa-scroll-badge" id="scrollBadge" style="display:none">0</span>
      </button>
      <div id="previewBar"></div>
      ${conn&&deviceFilter.value?`
        <div class="wa-input-area">
          <button class="wa-btn wa-emoji-btn" onclick="window.__toggleEmoji()" title="Emoji">😊</button>
          <button class="wa-btn wa-attach-btn" id="attachBtn" title="Attach file">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
          </button>
          <div class="wa-input-wrap"><textarea class="wa-msg-input" id="msgInput" placeholder="Type a message" rows="1"></textarea></div>
          <button class="wa-btn wa-send-btn" id="sendBtn">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </button>
        </div>
      `:!deviceFilter.value?'<div class="wa-not-connected">Select a device to send messages.</div>':'<div class="wa-not-connected">⚠ Device not connected. Read-only mode.</div>'}
    `;

    // Bind events
    const input=$('msgInput'), sendBtn=$('sendBtn'), attachBtn=$('attachBtn');
    if(input) {
      input.addEventListener('input',()=>{input.style.height='auto';input.style.height=Math.min(input.scrollHeight,120)+'px';});
      input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();doSend();}});
      input.focus();
    }
    if(sendBtn) sendBtn.addEventListener('click',doSend);
    if(attachBtn) attachBtn.addEventListener('click',()=>fileInput.click());

    // Scroll tracking
    const msgArea=$('msgArea');
    if(msgArea) {
      msgArea.addEventListener('scroll',()=>{
        const sb=$('scrollBtn');
        if(!sb) return;
        const atBottom = msgArea.scrollTop+msgArea.clientHeight>=msgArea.scrollHeight-80;
        sb.classList.toggle('show',!atBottom);
        if(atBottom) { newMsgCount=0; const b=$('scrollBadge'); if(b) b.style.display='none'; }
      });
    }
    await loadMessages(dev,jid,1,true);
  };

  window.__backToList = function() { document.querySelector('.wa-sidebar')?.classList.remove('hidden-mobile'); };
  window.__scrollBottom = function() { const m=$('msgArea'); if(m) m.scrollTop=m.scrollHeight; newMsgCount=0; const b=$('scrollBadge'); if(b) b.style.display='none'; };

  // ─── Load Messages ───
  async function loadMessages(dev,jid,page,scroll) {
    try {
      const r=await fetch(`/chat/api/messages?device=${encodeURIComponent(dev)}&jid=${encodeURIComponent(jid)}&page=${page}`);
      if(!r.ok){$('msgArea').innerHTML='<div class="wa-no-chats"><span>Failed to load</span></div>';return;}
      const data=await r.json();
      const msgArea=$('msgArea');
      if(!data.messages||!data.messages.length){if(page===1)msgArea.innerHTML='<div class="wa-no-chats"><span>No messages yet</span></div>';return;}
      if(page===1) msgArea.innerHTML='';
      if(data.hasMore){const d=document.createElement('div');d.className='wa-load-more';d.innerHTML=`<button onclick="window.__more(${page+1})">↑ Load older</button>`;msgArea.prepend(d);}
      let lastDate=null; const frag=document.createDocumentFragment();
      data.messages.forEach(msg=>{
        const md=fmtDate(msg.createdAt);
        if(md!==lastDate){lastDate=md;const dv=document.createElement('div');dv.className='wa-date-divider';dv.innerHTML=`<span>${md}</span>`;frag.appendChild(dv);}
        frag.appendChild(makeBubble(msg));
      });
      msgArea.appendChild(frag);
      if(scroll) msgArea.scrollTop=msgArea.scrollHeight;
      if(data.messages.length){const mx=Math.max(...data.messages.map(m=>m.id));if(mx>lastMsgId)lastMsgId=mx;}
    }catch(e){console.error('loadMessages error:',e);}
  }
  window.__more = async function(p){const b=document.querySelector('.wa-load-more');if(b)b.remove();await loadMessages(activeDevice,activeJid,p,false);};

  // ─── Send Text ───
  async function doSend() {
    const input=$('msgInput'),sendBtn=$('sendBtn');
    if(!input||!activeDevice||!activeJid) return;
    if(pendingFile){await doSendMedia();return;}
    const text=input.value.trim(); if(!text) return;
    input.disabled=true; sendBtn.disabled=true; input.value=''; input.style.height='auto';
    const msgArea=$('msgArea');
    const wrap=document.createElement('div');
    wrap.className='wa-bubble-wrap out';
    wrap.innerHTML=`<div class="wa-bubble out"><div class="wa-bubble-content">${esc(text)}</div><span class="wa-bubble-time">${fmtTime(new Date().toISOString())} ${statusIcon('server_ack')}</span></div>`;
    msgArea.appendChild(wrap); msgArea.scrollTop=msgArea.scrollHeight;
    try {
      const r=await fetch('/chat/api/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({device:activeDevice,jid:activeJid,text})});
      const d=await r.json();
      if(d.success){const st=wrap.querySelector('.wa-bubble-status');if(st)st.outerHTML=statusIcon('delivered');}
      else{wrap.querySelector('.wa-bubble').style.opacity='0.5';const st=wrap.querySelector('.wa-bubble-status');if(st)st.outerHTML='<span class="wa-bubble-status" style="color:#e11d48">✗</span>';}
    }catch(e){wrap.querySelector('.wa-bubble').style.opacity='0.5';const st=wrap.querySelector('.wa-bubble-status');if(st)st.outerHTML='<span class="wa-bubble-status" style="color:#e11d48">✗</span>';}
    input.disabled=false;sendBtn.disabled=false;input.focus();loadChats();
  }

  // ─── Send Media ───
  async function doSendMedia() {
    const input=$('msgInput'),sendBtn=$('sendBtn');
    if(!pendingFile||!activeDevice||!activeJid) return;
    const caption=input?input.value.trim():'';
    input.disabled=true; sendBtn.disabled=true; input.value=''; input.style.height='auto';
    const msgArea=$('msgArea');
    const wrap=document.createElement('div'); wrap.className='wa-bubble-wrap out';
    const isImg=pendingFile.type.startsWith('image/'), isVid=pendingFile.type.startsWith('video/');
    const icon=isImg?'📷 Photo':isVid?'🎥 Video':'📄 '+pendingFile.name;
    wrap.innerHTML=`<div class="wa-bubble out"><div class="wa-bubble-content"><div class="wa-media-placeholder">${icon}</div>${caption?`<div class="wa-media-caption">${esc(caption)}</div>`:''}</div><span class="wa-bubble-time">${fmtTime(new Date().toISOString())} ${statusIcon('server_ack')}</span></div>`;
    msgArea.appendChild(wrap); msgArea.scrollTop=msgArea.scrollHeight;
    const fd=new FormData();
    fd.append('file',pendingFile); fd.append('device',activeDevice); fd.append('jid',activeJid);
    if(caption) fd.append('caption',caption);
    clearPreview();
    try {
      const r=await fetch('/chat/api/send-media',{method:'POST',body:fd});
      const d=await r.json();
      if(d.success){const st=wrap.querySelector('.wa-bubble-status');if(st)st.outerHTML=statusIcon('delivered');}
      else{wrap.querySelector('.wa-bubble').style.opacity='0.5';const st=wrap.querySelector('.wa-bubble-status');if(st)st.outerHTML='<span class="wa-bubble-status" style="color:#e11d48">✗</span>';}
    }catch(e){wrap.querySelector('.wa-bubble').style.opacity='0.5';const st=wrap.querySelector('.wa-bubble-status');if(st)st.outerHTML='<span class="wa-bubble-status" style="color:#e11d48">✗</span>';}
    input.disabled=false;sendBtn.disabled=false;input.focus();loadChats();
  }

  // ─── File Attach ───
  fileInput.addEventListener('change',()=>{
    const f=fileInput.files[0]; if(!f) return;
    pendingFile=f; fileInput.value='';
    const bar=$('previewBar'); if(!bar) return;
    const isImg=f.type.startsWith('image/');
    bar.innerHTML=`<div class="wa-preview-bar">${isImg?`<img class="wa-preview-img" src="${URL.createObjectURL(f)}">`:''}
      <span class="wa-preview-name">${isImg?'📷':'📄'} ${esc(f.name)} (${(f.size/1024).toFixed(0)} KB)</span>
      <button class="wa-preview-remove" onclick="window.__clearPreview()">✕</button></div>`;
    const input=$('msgInput'); if(input){input.placeholder='Add a caption...';input.focus();}
  });
  function clearPreview(){pendingFile=null;const b=$('previewBar');if(b)b.innerHTML='';const i=$('msgInput');if(i)i.placeholder='Type a message';}
  window.__clearPreview=clearPreview;

  // ─── Emoji Picker ───
  const emojis = {
    '😀':1,'😂':1,'🥹':1,'😊':1,'😍':1,'🥰':1,'😘':1,'😜':1,'🤔':1,'😎':1,'🥳':1,'😢':1,'😡':1,'🤮':1,'😱':1,'🤗':1,
    '👍':2,'👎':2,'👋':2,'🤝':2,'🙏':2,'💪':2,'👏':2,'✌️':2,'🤞':2,'👌':2,'🤙':2,'🫶':2,'❤️':2,'💕':2,'💔':2,'🔥':2,
    '⭐':3,'✨':3,'🎉':3,'🎊':3,'🎁':3,'🏆':3,'💰':3,'📱':3,'💻':3,'🏠':3,'🚗':3,'✈️':3,'🌙':3,'☀️':3,'🌧️':3,'🌈':3,
    '✅':4,'❌':4,'⚠️':4,'💯':4,'🔴':4,'🟢':4,'🔵':4,'⏰':4,'📌':4,'🔗':4,'📝':4,'💡':4,'🎯':4,'🛡️':4,'⚡':4,'🆗':4
  };
  function buildEmojiGrid(filter) {
    const grid = emojiPicker.querySelector('.wa-emoji-grid');
    if(!grid) return;
    grid.innerHTML = Object.keys(emojis).filter(e=>!filter||e.includes(filter)).map(e=>`<button class="wa-emoji-item" onclick="window.__addEmoji('${e}')">${e}</button>`).join('');
  }
  window.__toggleEmoji = function() { emojiPicker.classList.toggle('show'); if(emojiPicker.classList.contains('show')) buildEmojiGrid(); };
  function closeEmojiPicker() { emojiPicker.classList.remove('show'); }
  window.__addEmoji = function(e) { const i=$('msgInput'); if(i){i.value+=e;i.focus();} };

  // ─── Context Menu ───
  window.__ctxBubble = function(e, btn) {
    e.preventDefault();
    const wrap = btn.closest('.wa-bubble-wrap');
    ctxTarget = { content: wrap.dataset.content, type: wrap.dataset.type, el: wrap };
    ctxMenu.style.top = e.clientY+'px'; ctxMenu.style.left = Math.min(e.clientX, window.innerWidth-200)+'px';
    ctxMenu.classList.add('show');
  };

  window.__ctxCopy = function() {
    if(ctxTarget?.content) navigator.clipboard.writeText(ctxTarget.content).catch(()=>{});
    ctxMenu.classList.remove('show');
  };

  document.addEventListener('click',()=>{ ctxMenu.classList.remove('show'); closeEmojiPicker(); });
  document.addEventListener('contextmenu', e => {
    const wrap = e.target.closest('.wa-bubble-wrap');
    if(wrap) { e.preventDefault(); window.__ctxBubble(e, wrap); }
  });

  // ─── Contact Info Panel ───
  window.__toggleInfo = function() { infoPanel.classList.toggle('open'); if(infoPanel.classList.contains('open')) buildInfoPanel(); };
  function closeInfoPanel() { infoPanel.classList.remove('open'); }
  window.__closeInfo = closeInfoPanel;

  function buildInfoPanel() {
    const chat=allChats.find(c=>c.remoteJid===activeJid&&c.sessionId===activeDevice);
    const name=chat?chat.name:activeJid?.split('@')[0]||'Unknown';
    const isGroup=activeJid?.includes('@g.us');
    const color=getAvatarColor(activeJid);
    const conn=isConnected(activeDevice);
    const body=infoPanel.querySelector('.wa-info-body');
    if(!body) return;
    body.innerHTML=`
      <div class="wa-info-avatar" style="background:${color}">${isGroup?groupIcon(64):getInitials(name)}</div>
      <div class="wa-info-name">${esc(name)}</div>
      <div class="wa-info-jid">${esc(activeJid)}</div>
      <div class="wa-info-section">
        <h4>About</h4>
        <div class="wa-info-row">${isGroup?'Group chat':'Personal chat'}</div>
        <div class="wa-info-row"><span>Device:</span> ${esc(chat?.deviceName||activeDevice)}</div>
        <div class="wa-info-row"><span>Status:</span> ${conn?'🟢 Online':'🔴 Offline'}</div>
        ${chat?.phoneNumber?`<div class="wa-info-row"><span>Phone:</span> ${esc(chat.phoneNumber)}</div>`:''}
        <div class="wa-info-row"><span>Total Messages:</span> ${chat?.totalMessages||0}</div>
      </div>`;
  }

  // ─── Search Messages ───
  window.__searchMsg = function() {
    const header = document.querySelector('.wa-main-header');
    if(!header) return;
    const existing = document.querySelector('.wa-msg-search-bar');
    if(existing) { existing.remove(); return; }
    const bar = document.createElement('div');
    bar.className = 'wa-msg-search-bar';
    bar.style.cssText = 'padding:8px 16px;background:var(--wa-header-bg);border-bottom:1px solid var(--wa-border);display:flex;gap:8px;';
    bar.innerHTML = `<input type="text" style="flex:1;padding:6px 12px;border:1px solid var(--wa-border);border-radius:8px;background:var(--wa-search-bg);color:var(--wa-text);font-size:13px;outline:none;" placeholder="Search in conversation..." id="msgSearchInput">
      <button style="background:none;border:none;color:var(--wa-text-secondary);cursor:pointer;font-size:18px;" onclick="this.parentElement.remove()">✕</button>`;
    header.after(bar);
    const inp = $('msgSearchInput');
    inp.focus();
    inp.addEventListener('input', () => {
      const q = inp.value.toLowerCase();
      document.querySelectorAll('.wa-bubble-wrap').forEach(el => {
        el.style.display = (!q || (el.dataset.content||'').toLowerCase().includes(q)) ? '' : 'none';
      });
    });
  };

  // ─── Device Filter & Search ───
  deviceFilter.addEventListener('change',()=>{activeJid=null;activeDevice=null;waMain.innerHTML=emptyState.outerHTML;loadChats();});
  chatSearch.addEventListener('input',()=>{
    const q=chatSearch.value.trim().toLowerCase();
    if(!q) { renderChats(allChats); return; }
    renderChats(allChats.filter(c=>c.name.toLowerCase().includes(q)||c.remoteJid.toLowerCase().includes(q)||(c.lastMessage||'').toLowerCase().includes(q)||(c.deviceName||'').toLowerCase().includes(q)||(c.phoneNumber||'').toLowerCase().includes(q)));
  });
  chatSearch.addEventListener('search',()=>{ if(!chatSearch.value) renderChats(allChats); });

  // ─── Socket.IO Real-time ───
  const mediaLabels = { image:'📷 Photo', video:'🎥 Video', audio:'🎵 Audio', ptt:'🎤 Voice message', document:'📄', sticker:'🏷️ Sticker' };
  function chatPreview(msg) {
    let p = msg.content || '';
    if(p.startsWith('thumb:')) { const i=p.indexOf('|'); p=i>0?p.substring(i+1):''; }
    const mt = msg.messageType;
    if(mt && mt!=='text' && mediaLabels[mt]) {
      p = mt==='document' ? `📄 ${p||'Document'}` : (p ? `${mediaLabels[mt]} · ${p}` : mediaLabels[mt]);
    } else if(mt && mt!=='text' && !p) { p = `[${mt}]`; }
    return p;
  }

  socket.on('new-message', msg => {
    // Skip if device filter is set and this message is from a different device
    const filterDev = deviceFilter.value;
    if(filterDev && msg.sessionId !== filterDev) return;

    const preview = msg.fromMe ? `You: ${chatPreview(msg)}` : chatPreview(msg);

    const chatIdx=allChats.findIndex(c=>c.sessionId===msg.sessionId&&c.remoteJid===msg.remoteJid);
    if(chatIdx>=0){
      allChats[chatIdx].lastMessage=preview;
      allChats[chatIdx].time=msg.createdAt; allChats[chatIdx].totalMessages++;
      const [item]=allChats.splice(chatIdx,1); allChats.unshift(item);
    } else {
      // Get proper device info from the devices list
      const dev = devices.find(d=>d.sessionId===msg.sessionId);
      allChats.unshift({
        sessionId:msg.sessionId, remoteJid:msg.remoteJid,
        name:msg.pushName||msg.remoteJid?.split('@')[0]||'Unknown',
        deviceName:dev?.name||msg.sessionId,
        phoneNumber:dev?.phoneNumber||null,
        lastMessage:preview,
        messageType:msg.messageType, time:msg.createdAt,
        totalMessages:1, isGroup:msg.remoteJid?.includes('@g.us')||false
      });
    }

    // Re-render chat list (respect search filter)
    if(!chatSearch.value) renderChats(allChats);
    else {
      const q=chatSearch.value.toLowerCase();
      renderChats(allChats.filter(c=>c.name.toLowerCase().includes(q)||c.remoteJid.toLowerCase().includes(q)||(c.lastMessage||'').toLowerCase().includes(q)||(c.deviceName||'').toLowerCase().includes(q)||(c.phoneNumber||'').toLowerCase().includes(q)));
    }

    // Append to active chat (skip own sent messages — already shown optimistically)
    if(activeDevice===msg.sessionId&&activeJid===msg.remoteJid&&msg.id>lastMsgId){
      lastMsgId=msg.id;
      if(msg.fromMe) return; // already added by optimistic UI
      const msgArea=$('msgArea'); if(!msgArea) return;
      const atBottom=msgArea.scrollTop+msgArea.clientHeight>=msgArea.scrollHeight-50;
      msgArea.appendChild(makeBubble(msg));
      if(atBottom) msgArea.scrollTop=msgArea.scrollHeight;
      else { newMsgCount++; const b=$('scrollBadge'); if(b){b.style.display='flex';b.textContent=newMsgCount;} }
    } else if(!msg.fromMe) {
      // Not active chat — increment unread
      const key = msg.sessionId+'|'+msg.remoteJid;
      unreadCounts[key] = (unreadCounts[key]||0) + 1;
    }

    // Sound for incoming
    if(!msg.fromMe && !document.hidden) playNotif();
  });

  // ─── Socket: message status updates (delivered/read) ───
  socket.on('message-status', data => {
    if(activeDevice===data.sessionId && activeJid===data.remoteJid) {
      const msgArea=$('msgArea'); if(!msgArea) return;
      const bubbles = msgArea.querySelectorAll('.wa-bubble-wrap.out');
      bubbles.forEach(b => {
        const mid = b.dataset.messageId;
        if(mid === data.messageId) {
          const timeEl = b.querySelector('.wa-bubble-time');
          if(timeEl) {
            const existingStatus = timeEl.querySelector('.wa-bubble-status');
            if(existingStatus) existingStatus.outerHTML = statusIcon(data.status);
            else timeEl.insertAdjacentHTML('beforeend', statusIcon(data.status));
          }
        }
      });
    }
  });

  // ─── Init ───
  loadChats();
})();
