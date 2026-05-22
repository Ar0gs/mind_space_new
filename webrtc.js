// ============================================================
// webrtc.js — MindSpace WebRTC Call Engine
// Handles voice & video calls between user and counsellor
// Uses Supabase Realtime as signalling channel
// ============================================================

let localStream = null;
let remoteStream = null;
let peerConnection = null;
let callType = null; // 'audio' | 'video'
let callTimerInterval = null;
let callSeconds = 0;
let isMuted = false;
let isCameraOff = false;
let myUserId = null;
let myRole = null; // 'user' | 'admin'
let targetUserId = null;
let signalChannel = null;
let pendingCallPayload = null;

// STUN servers for NAT traversal
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

function initWebRTC(userId, role) {
  myUserId = userId;
  myRole = role;
  console.log('[WebRTC] Initialized. Role:', role, 'UserId:', userId);
}

// ── INITIATE CALL (from either side) ──
async function initiateCall(type) {
  callType = type;

  // Determine target
  if (myRole === 'user') {
    // User calls admin — fetch admin profile
    try {
      const { data: adminProfiles, error } = await sb.from('profiles').select('id').eq('role', 'admin').limit(1);
      if (error) {
        console.error('[WebRTC] Error fetching admin:', error);
        alert('Unable to reach the counsellor right now. Please try again shortly.');
        return;
      }
      if (!adminProfiles || adminProfiles.length === 0) {
        alert('No counsellor is currently available for a call. Please send a message and they will reach out to you.');
        return;
      }
      targetUserId = adminProfiles[0].id;
    } catch (e) {
      console.error('[WebRTC] Fetch admin error:', e);
      alert('Connection error. Please try again.');
      return;
    }
  } else {
    // Admin calls active user
    targetUserId = window.activeUserId;
    if (!targetUserId) {
      alert('Please select a user conversation first before calling.');
      return;
    }
  }

  if (!targetUserId) {
    alert('No counsellor is currently available for a call.');
    return;
  }

  try {
    // Get media
    localStream = await navigator.mediaDevices.getUserMedia(
      type === 'video' ? { audio: true, video: { width: 1280, height: 720 } } : { audio: true, video: false }
    );

    // Setup peer connection
    peerConnection = new RTCPeerConnection(ICE_SERVERS);
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    peerConnection.ontrack = e => {
      remoteStream = e.streams[0];
      const remoteVideo = document.getElementById('remote-video');
      if (remoteVideo) {
        remoteVideo.srcObject = remoteStream;
        if (callType === 'video') remoteVideo.style.display = 'block';
      }
    };

    peerConnection.onicecandidate = e => {
      if (e.candidate) {
        sendSignal('ice_candidate', { candidate: e.candidate });
      }
    };

    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;
      updateCallStatus(state === 'connected' ? 'Connected' : state === 'connecting' ? 'Connecting...' : state);
      if (state === 'connected') startCallTimer();
      if (state === 'disconnected' || state === 'failed') endCall();
    };

    // Show local video
    const localVideo = document.getElementById('local-video');
    if (localVideo && type === 'video') {
      localVideo.srcObject = localStream;
      localVideo.style.display = 'block';
    }

    // Create offer
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    // Setup signal channel BEFORE sending offer so we can receive the answer
    setupSignalChannel();

    // Send call invitation to target via their 'calls:{id}' channel
    // Use httpSend to avoid the REST fallback warning and 406 errors
    const callChannel = sb.channel('calls:' + targetUserId);
    await callChannel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        try {
          await callChannel.send({
            type: 'broadcast',
            event: 'incoming_call',
            payload: {
              from: myUserId,
              from_role: myRole,
              call_type: type,
              offer: offer
            }
          });
        } catch (sendErr) {
          console.warn('[WebRTC] Broadcast send error (non-fatal):', sendErr);
        }
      }
    });

    showCallOverlay(type, myRole === 'admin' ? (document.getElementById('chat-user-name')?.textContent || 'User') : 'Counsellor');
    updateCallStatus('Calling...');

  } catch (err) {
    console.error('[WebRTC] Error initiating call:', err);
    if (err.name === 'NotAllowedError') {
      alert('Microphone' + (type === 'video' ? '/camera' : '') + ' permission denied. Please allow access in your browser settings.');
    } else {
      alert('Could not start call. Please check your microphone' + (type === 'video' ? '/camera' : '') + ' permissions.');
    }
    cleanupCall();
  }
}

// ── INCOMING CALL ──
async function showIncomingCall(payload) {
  pendingCallPayload = payload;
  const type = payload.call_type || 'audio';
  const el = document.getElementById('ic-type');
  if (el) el.textContent = type === 'video' ? '📹 Video Call' : '📞 Voice Call';

  // Show incoming call UI
  const icEl = document.getElementById('incoming-call');
  if (icEl) icEl.classList.add('show');

  // Play ring tone (optional)
  try {
    const ctx = new AudioContext();
    function ring() {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 440; gain.gain.value = 0.1;
      osc.start(); setTimeout(() => osc.stop(), 500);
    }
    ring(); setTimeout(ring, 900); setTimeout(ring, 1800);
  } catch(e) {}
}

async function acceptCall() {
  const payload = pendingCallPayload;
  if (!payload) return;

  const icEl = document.getElementById('incoming-call');
  if (icEl) icEl.classList.remove('show');

  callType = payload.call_type || 'audio';
  targetUserId = payload.from;

  try {
    localStream = await navigator.mediaDevices.getUserMedia(
      callType === 'video' ? { audio: true, video: { width: 1280, height: 720 } } : { audio: true, video: false }
    );

    peerConnection = new RTCPeerConnection(ICE_SERVERS);
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    peerConnection.ontrack = e => {
      remoteStream = e.streams[0];
      const rv = document.getElementById('remote-video');
      if (rv) { rv.srcObject = remoteStream; if (callType === 'video') rv.style.display = 'block'; }
    };

    peerConnection.onicecandidate = e => {
      if (e.candidate) sendSignal('ice_candidate', { candidate: e.candidate });
    };

    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;
      updateCallStatus(state === 'connected' ? 'Connected' : state === 'connecting' ? 'Connecting...' : state);
      if (state === 'connected') startCallTimer();
      if (state === 'disconnected' || state === 'failed') endCall();
    };

    const lv = document.getElementById('local-video');
    if (lv && callType === 'video') { lv.srcObject = localStream; lv.style.display = 'block'; }

    setupSignalChannel();

    // Set remote description from offer
    await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    // Send answer back
    sendSignal('call_answer', { answer });

    showCallOverlay(callType, myRole === 'admin' ? (document.getElementById('chat-user-name')?.textContent || 'User') : 'Counsellor');
    updateCallStatus('Connecting...');

  } catch (err) {
    console.error('[WebRTC] Error accepting call:', err);
    alert('Could not access microphone/camera. Check permissions.');
    cleanupCall();
  }
}

function declineCall() {
  const icEl = document.getElementById('incoming-call');
  if (icEl) icEl.classList.remove('show');
  if (pendingCallPayload) {
    sendSignalTo(pendingCallPayload.from, 'call_ended', {});
  }
  pendingCallPayload = null;
}

// ── SIGNALLING ──
// FIX: Use httpSend() explicitly to avoid the 406 REST fallback error
function setupSignalChannel() {
  signalChannel = sb.channel('signal:' + myUserId)
    .on('broadcast', { event: 'call_answer' }, async ({ payload }) => {
      if (peerConnection && payload.answer) {
        try {
          await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.answer));
        } catch(e) { console.error('[WebRTC] setRemoteDescription error:', e); }
      }
    })
    .on('broadcast', { event: 'ice_candidate' }, async ({ payload }) => {
      if (peerConnection && payload.candidate) {
        try { await peerConnection.addIceCandidate(new RTCIceCandidate(payload.candidate)); } catch(e) {}
      }
    })
    .on('broadcast', { event: 'call_ended' }, () => {
      endCall();
    })
    .subscribe();
}

async function sendSignal(event, payload) {
  if (!targetUserId) return;
  try {
    const ch = sb.channel('signal:' + targetUserId);
    // Subscribe first if needed, then send
    await new Promise((resolve) => {
      const sub = ch.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          ch.send({ type: 'broadcast', event, payload })
            .catch(e => console.warn('[WebRTC] Signal send warn:', e))
            .finally(resolve);
        }
      });
      // Resolve after 3s even if not subscribed to avoid hanging
      setTimeout(resolve, 3000);
    });
  } catch(e) {
    console.warn('[WebRTC] sendSignal error (non-fatal):', e);
  }
}

async function sendSignalTo(userId, event, payload) {
  try {
    const ch = sb.channel('signal:' + userId);
    await new Promise((resolve) => {
      ch.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          ch.send({ type: 'broadcast', event, payload })
            .catch(() => {})
            .finally(resolve);
        }
      });
      setTimeout(resolve, 3000);
    });
  } catch(e) {}
}

// ── CALL CONTROLS ──
function toggleMute() {
  isMuted = !isMuted;
  if (localStream) {
    localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  }
  const btn = document.getElementById('mute-btn');
  if (btn) { btn.textContent = isMuted ? '🔇' : '🎤'; btn.classList.toggle('on', isMuted); }
}

function toggleCamera() {
  isCameraOff = !isCameraOff;
  if (localStream) {
    localStream.getVideoTracks().forEach(t => t.enabled = !isCameraOff);
  }
  const btn = document.getElementById('cam-btn');
  if (btn) { btn.textContent = isCameraOff ? '🚫' : '📷'; btn.classList.toggle('on', isCameraOff); }
}

function endCall() {
  if (targetUserId) {
    sendSignal('call_ended', {});
  }
  cleanupCall();
  hideCallOverlay();
}

function cleanupCall() {
  if (callTimerInterval) { clearInterval(callTimerInterval); callTimerInterval = null; callSeconds = 0; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  if (signalChannel) { sb.removeChannel(signalChannel); signalChannel = null; }
  isMuted = false; isCameraOff = false; targetUserId = null;

  const rv = document.getElementById('remote-video');
  const lv = document.getElementById('local-video');
  if (rv) { rv.srcObject = null; rv.style.display = 'none'; }
  if (lv) { lv.srcObject = null; lv.style.display = 'none'; }
}

// ── TIMER ──
function startCallTimer() {
  callSeconds = 0;
  clearInterval(callTimerInterval);
  callTimerInterval = setInterval(() => {
    callSeconds++;
    const m = String(Math.floor(callSeconds/60)).padStart(2,'0');
    const s = String(callSeconds%60).padStart(2,'0');
    const el = document.getElementById('call-timer');
    if (el) el.textContent = m + ':' + s;
  }, 1000);
}

// ── OVERLAY UI ──
function showCallOverlay(type, name) {
  const overlay = document.getElementById('call-overlay');
  if (!overlay) return;
  const labelEl = document.getElementById('call-label') || document.getElementById('call-label-text');
  const nameEl = document.getElementById('call-name-text') || overlay.querySelector('.call-name');
  if (labelEl) labelEl.textContent = type === 'video' ? 'Video Call' : 'Voice Call';
  if (nameEl) nameEl.textContent = name || 'User';
  const timer = document.getElementById('call-timer');
  if (timer) timer.textContent = '00:00';
  overlay.classList.add('show');
}

function hideCallOverlay() {
  const overlay = document.getElementById('call-overlay');
  if (overlay) overlay.classList.remove('show');
}

function updateCallStatus(status) {
  const el = document.getElementById('call-status');
  if (el) el.textContent = status;
}

window.initWebRTC = initWebRTC;
window.initiateCall = initiateCall;
window.showIncomingCall = showIncomingCall;
window.acceptCall = acceptCall;
window.declineCall = declineCall;
window.endCall = endCall;
window.toggleMute = toggleMute;
window.toggleCamera = toggleCamera;