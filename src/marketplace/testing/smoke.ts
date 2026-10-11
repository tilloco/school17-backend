// FAQAT TEST: ikki brauzer (Edge/Chrome headless, soxta kamera/mikrofon) o'rtasida haqiqiy WebRTC (peer-to-peer)
// orqali video qo'ng'iroq oqimini tekshirish uchun mock "signalizatsiya" va sahifa. Bu SFU emas va
// production'da ulanmaydi (faqat smoke test o'zining test ilovasiga qo'shadi).
import { Controller, ForbiddenException, Get, Header, Inject, Module, Post, Query, Body } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';
import { CALL_PROVIDER } from '../calls/call-provider';
import { MockCallProvider } from '../calls/mock-provider';
import { ClockService } from '../common/clock';

const rooms = new Map<string, { n: number; from: string; msg: any }[]>();

function machineJs(): string {
  const src = readFileSync(join(__dirname, '..', '..', '..', '..', 'shared', 'call-machine.ts'), 'utf8');
  const out = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText;
  return `const exports = {}; ${out}; const Machine = exports;`;
}

const PAGE = (machine: string) => `<!doctype html><meta charset="utf-8"><title>smoke</title>
<video id="remote" autoplay playsinline muted></video><video id="local" autoplay playsinline muted></video>
<script>
${machine}
const q = new URLSearchParams(location.hash.slice(1));
const API = location.origin, BOOKING = q.get('booking'), AUTH = q.get('auth');
const log = []; const L = (m) => log.push(Date.now() + ' ' + m);
let ctx = Machine.initialContext(), tokenInfo = null, pc = null, localStream = null, lastN = 0, polling = null, hb = null, me = null;
const api = (path, method, body) => fetch(API + path, { method: method || 'GET', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + AUTH }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
let sigChain = Promise.resolve(); const sig = (msg) => (sigChain = sigChain.then(() => fetch(API + '/__smoke/signal?token=' + encodeURIComponent(tokenInfo.token), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: me, msg }) })).catch(() => {}));
function dispatch(ev) { const s = Machine.reduce(ctx, ev); ctx = s.ctx; s.effects.forEach(run); }
function run(e) {
  L('effect ' + e.type);
  if (e.type === 'connect') connect();
  if (e.type === 'tryReconnect' && Date.now() - (window.__lastTry || 0) > 6000) { window.__lastTry = Date.now(); connect(true); }
  if (e.type === 'scheduleReconnect') setTimeout(() => dispatch({ type: 'RECONNECT_TICK', now: Date.now() }), 300);
  if (e.type === 'presence') api('/calls/' + BOOKING + '/presence', 'POST', { event: e.event });
  if (e.type === 'setCameraPublishing' && localStream) localStream.getVideoTracks().forEach((t) => (t.enabled = e.on));
  if (e.type === 'setMicPublishing' && localStream) localStream.getAudioTracks().forEach((t) => (t.enabled = e.on));
  if (e.type === 'startHeartbeat') { clearInterval(hb); hb = setInterval(async () => { window.__heartbeat(); const q = await sample(); if (q) dispatch({ type: "QUALITY", sample: q }); }, 700); }
  if (e.type === 'stopHeartbeat') clearInterval(hb);
  if (e.type === 'disconnect') { try { pc && pc.close(); } catch (x) {} pc = null; clearInterval(polling); }
  if (e.type === 'reportQuality') api('/calls/' + BOOKING + '/presence', 'POST', { event: 'heartbeat', quality: { tier: e.tier, reconnects: e.reconnects, joinMs: e.joinMs || 0 } });
}
async function sample() {
  if (!pc) return null;
  const r = await pc.getStats(); let rtt, lost = 0, recv = 0;
  r.forEach((x) => { if (x.type === 'candidate-pair' && x.state === 'succeeded' && x.currentRoundTripTime != null) rtt = x.currentRoundTripTime * 1000; if (x.type === 'inbound-rtp') { lost += x.packetsLost || 0; recv += x.packetsReceived || 0; } });
  return { rttMs: rtt, lossPct: recv + lost ? (lost * 100) / (recv + lost) : 0 };
}
window.__heartbeat = () => api('/calls/' + BOOKING + '/presence', 'POST', { event: 'heartbeat' });
function newPc() {
  pc = new RTCPeerConnection({ iceServers: [] });
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  const myPc = pc; pc.onicecandidate = (e) => { if (e.candidate && myPc === pc) sig({ type: 'ice', c: e.candidate, id: currentId }); };
  pc.ontrack = (e) => { document.getElementById('remote').srcObject = e.streams[0]; };
  return pc;
}
let chain = Promise.resolve(), pendingIce = [], currentId = null, seq = 0;
function enqueue(from, m) { L('rx ' + m.type + (m.id ? ' ' + m.id : '') + ' from ' + from.slice(-4)); chain = chain.then(() => onSignal(from, m)).catch((e) => L('signal error ' + e.message)); }
async function flushIce() { while (pendingIce.length && pc && pc.remoteDescription) { try { await pc.addIceCandidate(pendingIce.shift()); } catch (x) {} } }
async function onSignal(from, m) {
  if (from === me) return;
  if (m.type === 'hello' || m.type === 'hello-reply') {
    if (m.type === 'hello') sig({ type: 'hello-reply' });
    // identity'i katta bo'lgan tomon offer yuboradi
    if (me > from && (m.type === 'hello' || !pc)) { pendingIce = []; currentId = me + ':' + (++seq); newPc(); const o = await pc.createOffer(); await pc.setLocalDescription(o); sig({ type: 'offer', sdp: o, id: currentId }); }
  } else if (m.type === 'offer') {
    pendingIce = []; currentId = m.id; newPc(); await pc.setRemoteDescription(m.sdp); const a = await pc.createAnswer(); await pc.setLocalDescription(a); sig({ type: 'answer', sdp: a, id: m.id }); await flushIce();
  } else if (m.type === 'answer') { if (pc && m.id === currentId && pc.signalingState === 'have-local-offer') { await pc.setRemoteDescription(m.sdp); await flushIce(); } }
  else if (m.type === 'ice') { if (m.id !== currentId) return; if (pc && pc.remoteDescription) { try { await pc.addIceCandidate(m.c); } catch (x) {} } else pendingIce.push(m.c); }
}
async function connect(isRetry) {
  try {
    L('connect start');
    if (!localStream) { localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }); document.getElementById('local').srcObject = localStream; }
    if (!tokenInfo || isRetry) { const t = await api('/calls/' + BOOKING + '/token', 'POST'); if (t.status !== 200) return dispatch({ type: 'FATAL', message: 'token ' + t.status }); tokenInfo = t.body; me = tokenInfo.identity; }
    L('token ok'); clearInterval(polling); try { pc && pc.close(); } catch (x) {} pc = null;
    polling = setInterval(async () => {
      const r = await fetch(API + '/__smoke/signal?token=' + encodeURIComponent(tokenInfo.token) + '&after=' + lastN);
      if (!r.ok) return; const j = await r.json();
      for (const m of j) { lastN = m.n; enqueue(m.from, m.msg); }
    }, 150);
    sig({ type: 'hello' });
    const wait = setInterval(() => {
      const v = document.getElementById('remote');
      if (v.videoWidth > 0 && v.readyState >= 2) {
        clearInterval(wait);
        dispatch({ type: ctx.state === 'reconnecting' ? 'RECONNECTED' : 'CONNECTED', now: Date.now() });
      }
    }, 100);
  } catch (e) { L('connect error ' + e.message); dispatch({ type: 'FATAL', message: String(e.message) }); }
}
window.__start = () => { dispatch({ type: 'ENTER_LOBBY' }); dispatch({ type: 'JOIN', now: Date.now() }); };
window.__drop = () => { try { pc.close(); } catch (x) {} pc = null; document.getElementById('remote').srcObject = null; dispatch({ type: 'CONNECTION_LOST', now: Date.now() }); };
window.__leave = () => dispatch({ type: 'LEAVE' });
window.__state = () => ({ pcs: pc ? [pc.connectionState, pc.iceConnectionState, pc.signalingState] : null, cur: currentId, pend: pendingIce.length, state: ctx.state, joinMs: ctx.joinMs, reconnects: ctx.reconnects, banner: ctx.banner, remoteW: document.getElementById('remote').videoWidth, log });
</script>`;

@Controller('__smoke')
export class SmokeController {
  constructor(@Inject(CALL_PROVIDER) private provider: MockCallProvider, private clock: ClockService) {}

  @Get('page') @Header('content-type', 'text/html; charset=utf-8')
  page() {
    return PAGE(machineJs());
  }

  private room(token: string) {
    const c = this.provider.verifyToken(token, this.clock.now());
    if (!c) throw new ForbiddenException('bad token');
    return c.room;
  }

  @Post('signal')
  post(@Query('token') token: string, @Body() body: { from: string; msg: any }) {
    const room = this.room(token);
    const list = rooms.get(room) ?? [];
    list.push({ n: list.length + 1, from: body.from, msg: body.msg });
    rooms.set(room, list);
    return { ok: true };
  }

  @Get('signal')
  get(@Query('token') token: string, @Query('after') after = '0') {
    const room = this.room(token);
    return (rooms.get(room) ?? []).filter((m) => m.n > Number(after));
  }
}

@Module({ controllers: [SmokeController] })
export class SmokeModule {}
