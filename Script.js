/* ============================================================
   FAMILLE JOSEPH — WebRTC Audio via PeerJS
   Architecture:
   - PeerJS connects to public PeerJS cloud server for signaling
   - Each participant gets a PeerID = "FJ-" + roomCode + "-" + randomId
   - Host (creator) has PeerID "FJ-HOST-" + roomCode
   - Joiners discover host by connecting to that known PeerID
   - Host broadcasts new joiner info to all; mesh connections form
   ============================================================ */

// ── STATE ──
let myName = '';
let myPeerId = '';
let roomCode = '';
let isHost = false;
let peer = null;           // PeerJS instance
let localStream = null;
let connections = {};      // peerId → DataConnection (for chat/presence)
let audioCalls = {};       // peerId → MediaConnection
let participants = {};     // peerId → { name, muted, speaking, self }
let isMuted = false;
let isSpeakerOn = true;
let handRaised = false;
let durationTimer = null;
let callStart = null;
let audioCtx = null;
let analyserInterval = null;
let audioElements = {};    // peerId → <audio>

// ── UTILS ──
function rndId(n){ return Math.random().toString(36).substring(2,2+n).toUpperCase(); }
function genCode(){ const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s=''; for(let i=0;i<6;i++) s+=c[Math.floor(Math.random()*c.length)]; return s; }
function toast(msg, dur=3000){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),dur); }
function setStatus(txt, state='idle'){
  document.getElementById('status-text').textContent=txt;
  const dot=document.getElementById('status-dot');
  dot.className='status-dot '+(state==='ok'?'green':state==='wait'?'yellow':'');
}
function showPanel(id){
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  const el=document.getElementById(id);
  if(el) el.classList.add('active');
}
function closeModal(id){ document.getElementById(id).classList.add('hidden'); }
function goToApp(mode){
  document.getElementById('app').scrollIntoView({behavior:'smooth'});
  if(mode==='join') setTimeout(()=>{ if(myName) showPanel('panel-join'); },600);
}

// ── STEP 1: NAME ──
function saveName(){
  const v=document.getElementById('inp-name').value.trim();
  if(!v){ toast('⚠️ Entrez votre nom'); return; }
  myName=v;
  document.getElementById('greet-name').textContent=myName.split(' ')[0];
  showPanel('panel-lobby');
  setStatus('Prêt — Créez ou rejoignez un appel','idle');

  // Check URL for auto-join
  const urlCode=new URLSearchParams(location.search).get('room');
  if(urlCode){ document.getElementById('inp-code').value=urlCode.toUpperCase(); showPanel('panel-join'); toast('🔗 Code détecté: '+urlCode.toUpperCase()); }
}
function showJoinPanel(){ showPanel('panel-join'); }

// ── STEP 2: MICROPHONE ──
async function getMic(){
  try{
    localStream=await navigator.mediaDevices.getUserMedia({audio:true,video:false});
    return true;
  }catch(e){
    document.getElementById('mic-modal').classList.remove('hidden');
    return false;
  }
}
async function requestMicAccess(){
  document.getElementById('mic-modal').classList.add('hidden');
  const ok=await getMic();
  if(ok){ toast('🎙️ Microphone autorisé !'); }
}

// ── CREATE ROOM ──
async function createRoom(){
  if(!await getMic()) return;
  isHost=true;
  roomCode=genCode();
  myPeerId='FJ-HOST-'+roomCode;
  initPeer(myPeerId);
}

// ── JOIN ROOM ──
async function joinRoom(){
  const code=document.getElementById('inp-code').value.trim().toUpperCase();
  if(code.length<4){ toast('⚠️ Code invalide'); return; }
  if(!await getMic()) return;
  isHost=false;
  roomCode=code;
  myPeerId='FJ-'+roomCode+'-'+rndId(6);
  initPeer(myPeerId);
}

// ── INIT PEER ──
function initPeer(id){
  setStatus('Connexion au serveur...','wait');
  showBadge('connecting');

  peer=new Peer(id,{
    host:'0.peerjs.com', port:443, path:'/', secure:true,
    config:{ iceServers:[
      {urls:'stun:stun.l.google.com:19302'},
      {urls:'stun:stun1.l.google.com:19302'}
    ]}
  });

  peer.on('open', peerId=>{
    setStatus('Connecté au réseau','ok');
    if(isHost){
      enterRoom();
    } else {
      // Connect to host
      setStatus('Connexion à la réunion...','wait');
      connectToHost();
    }
  });

  peer.on('connection', conn=>{ handleDataConn(conn); });
  peer.on('call', call=>{
    call.answer(localStream);
    handleAudioCall(call);
  });

  peer.on('error', err=>{
    console.error('PeerJS error:',err);
    if(err.type==='unavailable-id'){
      // Host ID taken — reconnect with random
      peer.destroy();
      myPeerId='FJ-'+roomCode+'-'+rndId(6);
      isHost=false;
      initPeer(myPeerId);
    } else if(err.type==='peer-unavailable'){
      toast('❌ Réunion introuvable. Vérifiez le code.');
      setStatus('Code incorrect ou réunion terminée','idle');
    } else {
      toast('⚠️ Erreur réseau: '+err.type);
      setStatus('Erreur: '+err.type,'idle');
    }
  });
}

// ── CONNECT TO HOST ──
function connectToHost(){
  const hostId='FJ-HOST-'+roomCode;
  const conn=peer.connect(hostId,{metadata:{name:myName,id:myPeerId}});
  conn.on('open',()=>{
    handleDataConn(conn);
    // Send join request
    send(conn,{type:'join',name:myName,id:myPeerId});
    // Call host for audio
    const call=peer.call(hostId,localStream,{metadata:{name:myName,id:myPeerId}});
    handleAudioCall(call);
    enterRoom();
  });
  conn.on('error',e=>{ toast('❌ Impossible de rejoindre. Vérifiez le code.'); setStatus('Erreur de connexion','idle'); });
}

// ── HANDLE DATA CONNECTION ──
function handleDataConn(conn){
  const peerId=conn.peer;
  connections[peerId]=conn;

  conn.on('data', data=>handleMessage(data, peerId));
  conn.on('close',()=>{
    const pname=participants[peerId]?.name||'Un membre';
    delete connections[peerId];
    delete participants[peerId];
    renderParticipants();
    sysChat(pname+' a quitté la réunion');
    toast('👋 '+pname+' a quitté');
  });
  conn.on('error', e=>console.warn('DataConn error:',e));
}

// ── HANDLE AUDIO CALL ──
function handleAudioCall(call){
  const peerId=call.peer;
  audioCalls[peerId]=call;

  call.on('stream', remoteStream=>{
    if(!audioElements[peerId]){
      const audio=document.createElement('audio');
      audio.autoplay=true;
      audio.srcObject=remoteStream;
      document.body.appendChild(audio);
      audioElements[peerId]=audio;
    }
  });
  call.on('close',()=>{ if(audioElements[peerId]){ audioElements[peerId].remove(); delete audioElements[peerId]; } });
  call.on('error',e=>console.warn('Call error:',e));
}

// ── HANDLE MESSAGE ──
function handleMessage(msg, fromPeerId){
  if(msg.type==='join'){
    // A new person joined via host
    if(!participants[msg.id]){
      participants[msg.id]={name:msg.name,muted:false,speaking:false};
      renderParticipants();
      sysChat(msg.name+' a rejoint la réunion');
      toast('✅ '+msg.name+' a rejoint');
      // If I'm host, broadcast this to everyone else
      if(isHost){
        broadcast({type:'newmember',name:msg.name,id:msg.id}, fromPeerId);
        // Send them the current participant list
        send(connections[fromPeerId],{type:'roster',participants:getParticipantList()});
        // Call new member for audio mesh
        const call=peer.call(msg.id,localStream,{metadata:{name:myName,id:myPeerId}});
        if(call) handleAudioCall(call);
      }
    }
  } else if(msg.type==='newmember'){
    if(!participants[msg.id]){
      participants[msg.id]={name:msg.name,muted:false,speaking:false};
      renderParticipants();
      sysChat(msg.name+' a rejoint');
    }
  } else if(msg.type==='roster'){
    msg.participants.forEach(p=>{
      if(p.id!==myPeerId&&!participants[p.id]){
        participants[p.id]={name:p.name,muted:p.muted,speaking:false};
      }
    });
    renderParticipants();
  } else if(msg.type==='mute'){
    if(participants[msg.id]){ participants[msg.id].muted=msg.muted; renderParticipants(); }
  } else if(msg.type==='speaking'){
    if(participants[msg.id]){ participants[msg.id].speaking=msg.speaking; renderParticipants(); }
  } else if(msg.type==='chat'){
    addChat(msg.name,msg.text);
    if(isHost) broadcast(msg, fromPeerId);
  } else if(msg.type==='hand'){
    sysChat('✋ '+msg.name+' lève la main');
    if(isHost) broadcast(msg, fromPeerId);
  } else if(msg.type==='leave'){
    const pname=participants[fromPeerId]?.name||msg.name||'Un membre';
    delete participants[fromPeerId];
    renderParticipants();
    sysChat(pname+' a quitté la réunion');
  }
}

// ── MESSAGING HELPERS ──
function send(conn,msg){ try{ conn.send(msg); }catch(e){} }
function broadcast(msg, exceptId=null){
  Object.entries(connections).forEach(([pid,conn])=>{ if(pid!==exceptId) send(conn,msg); });
}
function getParticipantList(){
  return Object.entries(participants).map(([id,p])=>({id,name:p.name,muted:p.muted}));
}

// ── ENTER ROOM ──
function enterRoom(){
  showPanel(null);
  document.getElementById('room-panel').style.display='flex';
  document.getElementById('room-panel').style.flexDirection='column';
  document.getElementById('room-code-display').textContent=roomCode;
  document.getElementById('share-code-display').textContent=roomCode;
  showBadge('live');
  document.getElementById('hdr-pcount').style.display='block';

  participants[myPeerId]={name:myName,muted:false,speaking:false,self:true};
  renderParticipants();

  startAudioAnalysis();
  callStart=Date.now();
  durationTimer=setInterval(updateDuration,1000);

  sysChat('✝ Bienvenue dans la réunion Famille Joseph · Code: '+roomCode);
  setStatus('En direct · Code: '+roomCode,'ok');
  toast('✅ Réunion démarrée ! Code: '+roomCode, 4000);
}

// ── RENDER ──
function renderParticipants(){
  const grid=document.getElementById('participants-grid');
  const count=Object.keys(participants).length;
  grid.innerHTML='';
  document.getElementById('part-count').textContent=count;
  document.getElementById('hdr-num').textContent=count;
  document.getElementById('info-pcount').textContent=count;

  for(const [id,p] of Object.entries(participants)){
    const init=p.name.split(' ').map(w=>w[0]).join('').substring(0,2).toUpperCase();
    const tile=document.createElement('div');
    tile.className='ptile'+(p.speaking?' speaking':'')+(p.muted?' muted-tile':'');
    tile.innerHTML=`
      <div class="pavatar">${init}</div>
      <div class="pname">${p.name}${p.self?' (Vous)':''}</div>
      <div class="pstatus">${p.speaking?'🎙️ parle...':p.muted?'silencieux':'🎧 écoute'}</div>
      ${p.muted?'<div class="pmute-icon">🔇</div>':''}
    `;
    grid.appendChild(tile);
  }
}

// ── AUDIO ANALYSIS (speaking detection) ──
function startAudioAnalysis(){
  if(!localStream) return;
  try{
    audioCtx=new AudioContext();
    const src=audioCtx.createMediaStreamSource(localStream);
    const analyser=audioCtx.createAnalyser();
    analyser.fftSize=512;
    src.connect(analyser);
    const data=new Uint8Array(analyser.frequencyBinCount);
    let wasSpeaking=false;

    analyserInterval=setInterval(()=>{
      if(isMuted){ if(wasSpeaking){ wasSpeaking=false; updateSpeaking(false); } return; }
      analyser.getByteFrequencyData(data);
      const avg=data.reduce((a,b)=>a+b,0)/data.length;
      const speaking=avg>10;
      if(speaking!==wasSpeaking){ wasSpeaking=speaking; updateSpeaking(speaking); }
    },200);
  }catch(e){ console.warn('AudioContext error:',e); }
}
function updateSpeaking(v){
  if(participants[myPeerId]) participants[myPeerId].speaking=v;
  renderParticipants();
  broadcast({type:'speaking',id:myPeerId,speaking:v});
}

// ── CONTROLS ──
function toggleMute(){
  isMuted=!isMuted;
  if(localStream) localStream.getAudioTracks().forEach(t=>t.enabled=!isMuted);
  document.getElementById('ci-mute').textContent=isMuted?'🔇':'🎙️';
  document.getElementById('cl-mute').textContent=isMuted?'Activer micro':'Couper micro';
  document.getElementById('cbtn-mute').className='cbtn'+(isMuted?' red':'');
  if(participants[myPeerId]) participants[myPeerId].muted=isMuted;
  renderParticipants();
  broadcast({type:'mute',id:myPeerId,muted:isMuted});
  toast(isMuted?'🔇 Micro coupé':'🎙️ Micro activé');
}
function toggleSpeaker(){
  isSpeakerOn=!isSpeakerOn;
  Object.values(audioElements).forEach(a=>a.muted=!isSpeakerOn);
  document.getElementById('cbtn-spk').className='cbtn'+(isSpeakerOn?'':' red');
  toast(isSpeakerOn?'🔊 Haut-parleur activé':'🔈 Son coupé');
}
function raiseHand(){
  handRaised=!handRaised;
  document.getElementById('ci-hand').textContent=handRaised?'🙌':'✋';
  document.getElementById('cbtn-hand').className='cbtn'+(handRaised?' active':'');
  if(handRaised){ broadcast({type:'hand',id:myPeerId,name:myName}); toast('✋ Main levée — tout le monde peut vous voir'); }
  else toast('Main baissée');
}
function leaveRoom(){
  broadcast({type:'leave',id:myPeerId,name:myName});
  cleanup();
  document.getElementById('room-panel').style.display='none';
  showBadge(null);
  document.getElementById('hdr-pcount').style.display='none';
  participants={};
  showPanel('panel-lobby');
  toast('👋 Vous avez quitté la réunion');
  setStatus('Prêt — Créez ou rejoignez un appel','idle');
}
function cleanup(){
  if(localStream) localStream.getTracks().forEach(t=>t.stop()); localStream=null;
  if(peer){ peer.destroy(); peer=null; }
  if(durationTimer){ clearInterval(durationTimer); durationTimer=null; }
  if(analyserInterval){ clearInterval(analyserInterval); analyserInterval=null; }
  if(audioCtx){ audioCtx.close(); audioCtx=null; }
  Object.values(audioElements).forEach(a=>a.remove()); audioElements={};
  connections={}; audioCalls={};
  isMuted=false; handRaised=false;
  document.getElementById('ci-mute').textContent='🎙️';
  document.getElementById('cl-mute').textContent='Couper micro';
  document.getElementById('cbtn-mute').className='cbtn';
}

// ── SHARE ──
function getShareLink(){ return location.origin+location.pathname+'?room='+roomCode; }
function shareWhatsApp(){
  const txt=`✝ *Famille Joseph* — Réunion Audio\n\nRejoignez notre appel maintenant !\n\n🔗 Lien: ${getShareLink()}\n📌 Code: *${roomCode}*\n\nÀ tout de suite 🙏`;
  window.open('https://wa.me/?text='+encodeURIComponent(txt),'_blank');
}
function shareFacebook(){
  const txt=`✝ Famille Joseph — Réunion Audio en direct ! Code: ${roomCode} | Lien: ${getShareLink()}`;
  window.open('https://www.facebook.com/sharer/sharer.php?u='+encodeURIComponent(getShareLink())+'&quote='+encodeURIComponent(txt),'_blank');
}
function copyLink(){
  const link=getShareLink();
  navigator.clipboard.writeText(link).then(()=>toast('📋 Lien copié !')).catch(()=>{
    prompt('Copiez ce lien:',link);
  });
}
function showShareSheet(){ document.getElementById('share-modal').classList.remove('hidden'); }

// ── CHAT ──
function sendChat(){
  const inp=document.getElementById('chat-inp');
  const txt=inp.value.trim();
  if(!txt) return;
  addChat(myName,txt);
  broadcast({type:'chat',id:myPeerId,name:myName,text:txt});
  inp.value='';
}
function addChat(name,text){
  const box=document.getElementById('chat-msgs');
  const d=document.createElement('div');
  d.className='cmsg';
  d.innerHTML=`<span class="cname">${esc(name)}: </span><span class="ctext">${esc(text)}</span>`;
  box.appendChild(d);
  box.scrollTop=box.scrollHeight;
}
function sysChat(txt){
  const box=document.getElementById('chat-msgs');
  const d=document.createElement('div');
  d.className='cmsg sys';
  d.innerHTML=`<span class="ctext">— ${txt}</span>`;
  box.appendChild(d);
  box.scrollTop=box.scrollHeight;
}
function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── DURATION ──
function updateDuration(){
  const s=Math.floor((Date.now()-callStart)/1000);
  const m=String(Math.floor(s/60)).padStart(2,'0');
  const sec=String(s%60).padStart(2,'0');
  document.getElementById('call-dur').textContent=m+':'+sec;
}

// ── BADGE ──
function showBadge(type){
  document.getElementById('badge-connecting').classList.add('hidden');
  document.getElementById('badge-live').classList.add('hidden');
  if(type==='connecting') document.getElementById('badge-connecting').classList.remove('hidden');
  if(type==='live') document.getElementById('badge-live').classList.remove('hidden');
}

// ── AUTO JOIN FROM URL ──
window.addEventListener('DOMContentLoaded',()=>{
  const urlCode=new URLSearchParams(location.search).get('room');
  if(urlCode){
    document.getElementById('inp-code').value=urlCode.toUpperCase();
    toast('🔗 Code de réunion détecté: '+urlCode.toUpperCase(),4000);
  }
});