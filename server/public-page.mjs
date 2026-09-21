import https from 'node:https';
import { lookup } from 'node:dns/promises';
export function publicIPv4(ip) {
 const p=ip.split('.').map(Number);if(p.length!==4||p.some(n=>!Number.isInteger(n)||n<0||n>255))return false;
 const [a,b,c]=p;return !(a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0||b===2))||(a===100&&b>=64&&b<=127)||(a===198&&(b===18||b===19||(b===51&&c===100)))||(a===203&&b===0&&c===113));
}
export async function publicPage(value, redirects=0) {
 const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443'))throw new Error('Only public HTTPS pages are supported.');
 const addresses=await Promise.race([lookup(url.hostname,{family:4,all:true}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('DNS timeout.')),4000);timer.unref();})]);
 if(!addresses.length||addresses.some(a=>!publicIPv4(a.address)))throw new Error('Private or reserved network destinations are not allowed.');
 const response=await new Promise((resolve,reject)=>{
 const request=https.get(url,{headers:{'User-Agent':'RecruiterFinder/1.0 (public contact research)','Accept':'text/html,application/rss+xml,application/xml','Accept-Encoding':'identity'},lookup:(_host,opts,cb)=>opts.all?cb(null,[{address:addresses[0].address,family:4}]):cb(null,addresses[0].address,4)},res=>{
   const chunks=[];let size=0;
   res.on('data',chunk=>{size+=chunk.length;if(size>1500000){request.destroy(new Error('Page exceeds size limit.'));return;}chunks.push(chunk);});
   res.on('end',()=>{clearTimeout(timer);resolve({status:res.statusCode,location:res.headers.location,type:res.headers['content-type']||'',text:Buffer.concat(chunks).toString('utf8')});});res.on('error',reject);
 });
 const timer=setTimeout(()=>request.destroy(new Error('Page request timed out.')),8000);request.on('error',e=>{clearTimeout(timer);reject(e);});
 });
 if([301,302,303,307,308].includes(response.status)&&response.location){if(redirects>=2)throw new Error('Too many redirects.');return publicPage(new URL(response.location,url).href,redirects+1);}
 // Cloudflare answers a flagged client with 403/429/503 and a "Just a moment" JavaScript challenge; name it rather than report a bare status.
 if(response.status!==200)throw new Error(/just a moment|challenge-error-text|challenge-form|cf-chl|verify you are human|enable javascript and cookies/i.test(response.text)?'Blocked by the site’s bot check (Cloudflare challenge, HTTP '+response.status+').':'Page unavailable ('+response.status+').');
 if(!/text\/html|application\/(?:xhtml\+xml|rss\+xml|xml)|text\/xml/i.test(response.type))throw new Error('Only HTML pages and search feeds are supported; document skipped.');
 return response.text;
}
