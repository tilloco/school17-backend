const crypto=require('crypto');
const b=(o)=>Buffer.from(JSON.stringify(o)).toString('base64url');
function tok(g){const h=b({alg:'HS256',typ:'JWT'});const p=b({iss:'devkey',nbf:Math.floor(Date.now()/1000)-5,exp:Math.floor(Date.now()/1000)+60,video:g});return h+'.'+p+'.'+crypto.createHmac('sha256','devsecret-devsecret-devsecret-devsecret-12345').update(h+'.'+p).digest('base64url');}
(async()=>{const room='class-3546ffb5-5a88-4321-a67e-0501189df17e';
const r=await fetch('http://localhost:7880/twirp/livekit.RoomService/ListParticipants',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+tok({roomAdmin:true,room})},body:JSON.stringify({room})});
const j=await r.json();const ps=j.participants||[];
console.log(ps.length?ps.map(p=>p.state+' tracks='+(p.tracks||[]).map(t=>t.source+(t.muted?'(muted)':'')).join('+')).join(' | '):'NOBODY IN ROOM');})();
