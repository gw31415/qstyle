import{A as e,B as t,C as n,D as r,E as i,F as a,H as o,I as s,J as c,K as l,L as u,M as d,N as f,O as p,P as m,Q as h,R as g,S as _,T as v,U as y,V as b,W as x,Y as S,Z as C,_ as w,a as T,c as E,d as D,et as ee,f as O,g as k,h as A,i as te,it as j,j as M,k as ne,m as N,n as re,nt as P,o as ie,p as F,q as I,r as ae,rt as oe,s as se,t as ce,tt as le,u as ue,v as de,w as fe,x as pe,y as me}from"./q-D8NUa7-I.js";var he=class{},ge=class extends he{},_e=class extends Error{status;data;constructor(e,t){super(typeof t==`string`?t:void 0),this.status=e,this.data=t}},ve=e=>{if(e instanceof he||e instanceof _e)throw e},ye=!1;globalThis.qDynamicPlatform,globalThis.qRuntimeQrl;var be=``,xe=(e,...t)=>Se(ye,e,...t),Se=(e,t,...n)=>{let r=t instanceof Error?t:Error(t);return console.error(`%cQWIK ERROR`,be,r.message,...n,r.stack),e&&setTimeout(()=>{throw r},0),r},Ce=(e,t,n)=>{let r=n>>1,i=e.length-2>>1;for(;r<=i;){let n=r+(i-r>>1),a=e[n<<1];if(a===t)return n<<1;a<t?r=n+1:i=n-1}return r<<1^-1},L=(e,t,n,r,i=!1)=>{let a=Ce(e,t,r);a>=0?n==null&&!i?e.splice(a,2):e[a+1]=n:(n!=null||i)&&e.splice(a^-1,0,t,n)},we=(e,t,n)=>{let r=Ce(e,t,n),i=null;return r>=0?(i=e[r+1],e.splice(r,2),i):i},Te=(e,t,n)=>{let r=Ce(e,t,n);return r>=0?e[r+1]:null},Ee=(e,t,n)=>Ce(e,t,n)>=0,De=e=>Array.isArray(e),Oe=e=>typeof e==`string`,ke=`https://qwikdev-build-v2.qwik-8nx.pages.dev/docs/errors/#q`,Ae=(e,...t)=>`Code(Q${e}) ${ke}${e}`,R=(e,t=[])=>xe(Ae(e,...t),...t),je=`<sync>`,z={REFERENCE_CH:`~`,REFERENCE:126,ADVANCE_1_CH:`!`,ADVANCE_1:33,ADVANCE_2_CH:`"`,ADVANCE_2:34,ADVANCE_4_CH:`#`,ADVANCE_4:35,ADVANCE_8_CH:`$`,ADVANCE_8:36,ADVANCE_16_CH:`%`,ADVANCE_16:37,ADVANCE_32_CH:`&`,ADVANCE_32:38,ADVANCE_64_CH:`'`,ADVANCE_64:39,ADVANCE_128_CH:`(`,ADVANCE_128:40,ADVANCE_256_CH:`)`,ADVANCE_256:41,ADVANCE_512_CH:`*`,ADVANCE_512:42,ADVANCE_1024_CH:`+`,ADVANCE_1024:43,ADVANCE_2048_CH:`,`,ADVANCE_2048:44,ADVANCE_4096_CH:`-`,ADVANCE_4096:45,ADVANCE_8192_CH:`.`,ADVANCE_8192:46},B={OPEN:123,OPEN_CHAR:`{`,CLOSE:125,CLOSE_CHAR:`}`,SCOPED_STYLE:59,SCOPED_STYLE_CHAR:`;`,RENDER_FN:60,RENDER_FN_CHAR:`<`,RENDER_HASH_PREFIX:95,RENDER_HASH_PREFIX_CHAR:`_`,ID:61,ID_CHAR:`=`,PROPS:62,PROPS_CHAR:`>`,SLOT_PARENT:63,SLOT_PARENT_CHAR:`?`,KEY:64,KEY_CHAR:`@`,SEQ:91,SEQ_CHAR:`[`,DON_T_USE:92,DON_T_USE_CHAR:`\\`,CONTEXT:93,CONTEXT_CHAR:`]`,SEQ_IDX:94,SEQ_IDX_CHAR:`^`,BACK_REFS:96,BACK_REFS_CHAR:"`",SEPARATOR:124,SEPARATOR_CHAR:`|`,SLOT:126,SLOT_CHAR:`~`},Me=(e,t)=>{let n=parseInt(e,10)-1+t;return-(n*(n+1)/2+t+1)};function V(e){let t=``,n=e.length,r=0,i=r;for(;r<n;r++){let n=e.charCodeAt(r);if(n===60)t+=e.substring(i,r)+`&lt;`;else if(n===62)t+=e.substring(i,r)+`&gt;`;else if(n===38)t+=e.substring(i,r)+`&amp;`;else if(n===34)t+=e.substring(i,r)+`&quot;`;else if(n===39)t+=e.substring(i,r)+`&#39;`;else continue;i=r+1}return i===0?e:t+e.substring(i)}function Ne(e){let t=``,n=e.length,r=0,i=r;for(;r<n;r++){let n=e.charCodeAt(r);if(n>=z.ADVANCE_1&&n<=z.ADVANCE_8192)t+=e.substring(i,r)+`\\`+e.charAt(r);else continue;i=r+1}return i===0?e:t+e.substring(i)}function H(e){let t=encodeURI(e),n=``,r=t.length,i=0,a=i;for(;i<r;i++){let e=t.charCodeAt(i),r=null;if(e===59)r=`%3B`;else if(e===61)r=`%3D`;else if(e===63)r=`%3F`;else if(e===64)r=`%40`;else if(e===126)r=`%7E`;else continue;n+=t.substring(a,i)+r,a=i+1}return a===0?t:n+t.substring(a)}var Pe=`q:renderFn`,U=`q:slot`,Fe=`q:sparent`,Ie=`q:patch`,Le=`q:r`,Re=`q:style`,ze=`q:sstyle`,W=`q:ctx`,Be=`q:brefs`,Ve=0,He=`q:render`,Ue=`q:runtime`,We=`q:version`,Ge=`q:base`,Ke=`q:locale`,qe=`q:manifest-hash`,Je=`q:instance`,Ye=`q:prewarm`,G=`q:container`;``+G;var Xe=`q:template`,K=``,Ze=`q:id`,Qe=`q:key`,$e=`q:props`,et=`q:seq`,tt=`q:seqIdx`,nt=`qwik/backpatch`,rt=`q:p`,it=`q:ps`,q=`:`;q+``,q+``,q+``,q+``,q+``;var at=`:`,ot=`dangerouslySetInnerHTML`,st=100,J=e=>{try{return!!e&&typeof e==`object`&&typeof e.then==`function`}catch{return!1}},Y=(e,t)=>J(e)?e.then(t):t(e),ct=e=>{throw e};function lt(e,t=ct){let n=!1,r;try{r=e(),n=!0}catch(e){r=e}if(!J(r))return n?r:t(r);let i=st,a=async n=>{for(;J(n);)try{return await n,await e()}catch(e){if(J(e)){if(--i)n=e;else{n=Error(`Exceeded max retry count in retryOnPromise`);break}}else{n=e;break}}return t(n)};return n?r.catch(a):a(r)}function ut(e){return e===`class`}function dt(e){return Array.from(e).join(` `)}var ft=e=>e.charCodeAt(0)===113&&e.charCodeAt(1)===45&&(e.charCodeAt(3)===58||e.charCodeAt(3)===112&&e.charCodeAt(4)===58);function pt(e){return e.startsWith(`preventdefault:`)}var mt=new Set(`animationIterationCount.aspectRatio.borderImageOutset.borderImageSlice.borderImageWidth.boxFlex.boxFlexGroup.boxOrdinalGroup.columnCount.columns.flex.flexGrow.flexShrink.gridArea.gridRow.gridRowEnd.gridRowStart.gridColumn.gridColumnEnd.gridColumnStart.fontWeight.lineClamp.lineHeight.opacity.order.orphans.scale.tabSize.widows.zIndex.zoom.MozAnimationIterationCount.MozBoxFlex.msFlex.msFlexPositive.WebkitAnimationIterationCount.WebkitBoxFlex.WebkitBoxOrdinalGroup.WebkitColumnCount.WebkitColumns.WebkitFlex.WebkitFlexGrow.WebkitFlexShrink.WebkitLineClamp`.split(`.`)),ht=e=>mt.has(e),gt=e=>{if(!e)return``;if(Oe(e))return e.trim();let t=[];if(De(e))for(let n=0;n<e.length;n++){let r=e[n],i=gt(r);i&&t.push(i)}else for(let[n,r]of Object.entries(e))r&&t.push(n.trim());return t.join(` `)},_t=e=>e.replace(/([A-Z])/g,`-$1`).toLowerCase(),vt=e=>{if(e==null)return``;if(typeof e==`object`){if(De(e))throw R(0,[e,`style`]);{let t=[];for(let n in e)if(Object.prototype.hasOwnProperty.call(e,n)){let r=e[n];r!=null&&typeof r!=`function`&&(n.startsWith(`--`)?t.push(n+`:`+r):t.push(_t(n)+`:`+St(n,r)))}return t.join(`;`)}}return String(e)},yt=e=>e==null?null:String(e);function bt(e,t,n){if(ut(e)){let e=gt(t);t=n?n+(e.length?` `+e:e):e}else e===`style`?t=vt(t):xt(e)||typeof t==`number`?t=yt(t):t===!1||t==null?t=null:t===!0&&pt(e)&&(t=``);return t}function xt(e){return Ct(e)||[`spellcheck`,`draggable`,`contenteditable`].includes(e)}var St=(e,t)=>typeof t==`number`&&t!==0&&!ht(e)?t+`px`:t;function Ct(e){return e.startsWith(`aria-`)}var wt,Tt=e=>{let t=new Map,n=0;for(;n<e.length;){let r=e[n++],i=[],a,o=1;for(;a=e[n],typeof a==`number`;)a<0?o=-a/10:i.push({yn:e[a],En:o,Sn:1}),n++;t.set(r,i)}return t},Et=e=>{wt==null&&e&&(wt=``,Tt(e))},Dt=e=>{for(let t in e)if(Object.prototype.hasOwnProperty.call(e,t))return!1;return!0},Ot=e=>{let t=String(e[0]);for(let n=1;n<e.length;n++)t+=` `+e[n];return t},kt=(e,t)=>e.write(String(t)),At=(e,t)=>e.write(Ot(t)),jt=(e,t,n)=>e.write(String(t-n)),Mt=e=>({write:e,writeRootRef(e){return kt(this,e)},writeRootRefPath(e){return At(this,e)},writeRootRefDelta(e,t){return jt(this,e,t)}}),Nt=`<`,Pt=`>`,Ft=`</`,It=` `,Lt=`="`,Rt=`"`,zt=`[`,Bt=`]`,Vt=`)`,Ht=`,`;function Ut(e,t){let n=t?.mapper,r=e.symbolMapper?e.symbolMapper:(e,t,r)=>{if(n){let t=Gt(e),i=n[t];if(!i){if(t===je)return[t,``];if(globalThis.__qwik_reg_symbols?.has(t))return[e,`_`];console.error(`Cannot resolve symbol`,e,`in`,n,r)}return i}};return{isServer:!0,async importSymbol(e,t,n){let r=Gt(n),i=globalThis.__qwik_reg_symbols?.get(r);if(i)return i;throw R(6,[n])},raf:()=>(console.error(`server can not rerender`),Promise.resolve()),chunkForSymbol(e,t,i){return r(e,n,i)}}}async function Wt(e,t){let n=Ut(e,t);_(n)}var Gt=e=>{let t=e.lastIndexOf(`_`);return t>-1?e.slice(t+1):e},Kt=(e,t,n,r,i,a,o,s)=>{if(!r||o!==null&&!s)return;let c=i;o!==null&&i&&(typeof i==`object`||typeof i==`function`)&&(c=n.get(i)||i);let l=e.Xe(c);t.Rt(c),t.Rt(a),o!==null&&typeof o!=`string`&&t.Rt(o),r.push({rootObj:c,rootId:l,effect:a,prop:o})},qt=(e,t,n)=>{if(!t?.length)return;let r=[],i=new Map;for(let a=0;a<t.length;a++){let o=t[a],s=o.rootId===void 0?e.Xe(o.rootObj):o.rootId;if(s===void 0||s>=n)continue;let c=i.get(s);c||(c=new g(s,o.prop===null?new Set:new Map),i.set(s,c),r.push(c));let l=c.subscriptions;if(o.prop===null)l instanceof Set&&l.add(o.effect);else if(l instanceof Map){let e=l.get(o.prop);e||(e=new Set,l.set(o.prop,e)),e.add(o.effect)}}return r.length?r:void 0},Jt=(e,t)=>{if(t==null)return null;let n=`${e}${t}`.split(`/`),r=[];for(let e=0;e<n.length;e++){let t=n[e];t===`..`&&r.length>0?r.pop():r.push(t)}return r.join(`/`)},Yt=e=>e.ze,Xt=(e,t,n)=>{let{resolvedManifest:r}=e,i=Yt(e),a=Jt(i,r?.manifest?.preloader),o=r?.manifest.bundleGraphAsset;if(o&&=`/`+o,a&&o&&t!==!1){let r=e.resolvedManifest?.manifest.bundleGraph;Et(r);let s=[];t&&t.maxIdlePreloads&&s.push(`P:${t.maxIdlePreloads}`);let c=s.length?`,{${s.join(`,`)}}`:``,l={rel:`modulepreload`,href:a};n&&(l.nonce=n),e.openElement(`link`,null,l,null,null,null),e.closeElement(),e.openElement(`link`,null,{rel:`preload`,href:o,as:`fetch`,crossorigin:`anonymous`},null,null,null),e.closeElement();let u=`let b=fetch("${o}");import("${a}").then(({l})=>l(${JSON.stringify(i)},b${c}));`,d={type:`module`,async:!0,crossorigin:`anonymous`};n&&(d.nonce=n),e.writeScript(d,u)}let s=Jt(i,r?.manifest.core);if(s){let t={rel:`modulepreload`,href:s};n&&(t.nonce=n),e.openElement(`link`,null,t,null,null,null),e.closeElement()}},Zt=(e,t,n,r)=>{if(n.length===0||t===!1)return null;let{ssrPreloads:i}=$t(typeof t==`boolean`?void 0:t),a=i,o=Yt(e),s=[],{resolvedManifest:c}=e;if(a){let e=c?.manifest.preloader,t=c?.manifest.core;for(let r=0;r<n.length;r++){let i=n[r];if(i!==e&&i!==t&&(s.push(i),--a===0))break}}let l=Jt(o,c?.manifest.preloader),u=s.length?`${JSON.stringify(s)}.map((l,e)=>{e=document.createElement('link');e.rel='modulepreload';e.href=${JSON.stringify(o)}+l;document.head.appendChild(e)});`:``;if(l&&(u+=`window.addEventListener('load',f=>{f=_=>import("${l}").then(({p})=>p(${JSON.stringify(n)}));try{requestIdleCallback(f,{timeout:2000})}catch(e){setTimeout(f,200)}})`),u){let t={type:`module`,async:`true`,"q:type":`preload`};r&&(t.nonce=r),e.writeScript(t,u)}return null},Qt=(e,t,n)=>{if(t.preloader!==!1){let r=en(Array.from(e.serializationCtx.Ft));Zt(e,t.preloader,r,n)}};function $t(e){return{...tn,...e}}var en=e=>{let t=p(),n=e?.map(e=>{let n=e.gt,r=e.Et,i=t.chunkForSymbol(n,r,e.dev?.file);return i?i[1]:r}).filter(Boolean);return[...new Set(n)]},tn={ssrPreloads:7,maxIdlePreloads:25},nn='var e,t,n,r=document,o=window,s="w",i="wp",a="d",c="dp",l="e",p="ep",u="capture:",d="readystatechange",f=0,h=new Set,q=new Set([r]),b=new Map,g={},m=(e,t)=>Array.from(e.querySelectorAll(t)),v=e=>{const t=[];return q.forEach(n=>t.push(...m(n,e))),t},w=(e,t,n,r=!1,o=!1)=>e.addEventListener(t,n,{capture:r,passive:o}),y=e=>{H(e);const t=m(e,"[q\\\\:shadowroot]");for(let e=0;e<t.length;e++){const n=t[e].shadowRoot;n&&y(n)}},A=e=>e&&"function"==typeof e.then,E=async e=>{for(let t=0;t<e.length;t++)await e[t]()},S=e=>{if(e.length){const t=()=>E(e);n=n?n.then(t,t):t()}},C=e=>{if(void 0===e._qwikjson_){let t=(e===r.documentElement?r.body:e).lastElementChild;for(;t;){if("SCRIPT"===t.tagName&&"qwik/json"===t.getAttribute("type")){e._qwikjson_=JSON.parse(t.textContent.replace(/\\\\x3C(\\/?script)/gi,"<$1"));break}t=t.previousElementSibling}}},_=e=>{g[e]=1,I(d)},k=e=>{const t=e.getAttribute("q:instance");return"paused"===e.getAttribute("q:container")&&"loading"===r.readyState&&!g[t]&&new Promise(e=>{w(r,d,()=>{("loading"!==r.readyState||g[t])&&e()})})},$=(e,t)=>new CustomEvent(e,{detail:t}),I=(e,t)=>{r.dispatchEvent($(e,t))},N=e=>e.replace(/([A-Z-])/g,e=>"-"+e.toLowerCase()),R=e=>e.replace(/-./g,e=>e[1].toUpperCase()),T=e=>{const t=e.indexOf(":");return{scope:e.slice(0,t),eventName:R(e.slice(t+1))}},x=e=>2===e.length,B=e=>e.charAt(0),L=e=>!!e&&1===e.nodeType,U=(e,t,n)=>e.hasAttribute(n)&&(!!e._qDispatch?.[t]||e.hasAttribute("q-"+t)),j=(e,t,n,o,s,i,a,c=!0)=>{const l={qBase:n,symbol:i,element:t,reqTime:a};if(!s){const t=(r["qFuncs_"+e.getAttribute("q:instance")]||[])[+i];if(!t&&c){const e=Error("sym:"+i);I("qerror",{importError:"sync",error:e,...l}),console.error(e)}return t}const p=`${i}|${n}|${s}`,u=b.get(p);if(u)return u;const d=new URL(s,o).href,f=import(d);return C(e),f.then(e=>{const t=e[i];if(t)b.set(p,t),I("qsymbol",l);else{const e=Error(`${i} not in ${d}`);I("qerror",{importError:"no-symbol",error:e,...l}),console.error(e)}return t},e=>{I("qerror",{importError:"async",error:e,...l}),console.error(e)})},D=(e,t,n,o,s,i=!0)=>{let a=!1;s&&(i&&e.hasAttribute("preventdefault:"+s)&&t.preventDefault(),e.hasAttribute("stoppropagation:"+s)&&t.stopPropagation());const c=e._qDispatch?.[n];if(c){if("function"==typeof c){const n=()=>c(t,e);if(a)o.push(async()=>{const e=n();A(e)&&await e});else{const e=n();A(e)&&(a=!0,o.push(()=>e))}}else if(c.length)for(let n=0;n<c.length;n++){const r=c[n];if(r){const n=()=>r(t,e);if(a)o.push(async()=>{const e=n();A(e)&&await e});else{const e=n();A(e)&&(a=!0,o.push(()=>e))}}}return}const l=e.getAttribute("q-"+n);if(l){const n=e.closest("[q\\\\:container]:not([q\\\\:container=html]):not([q\\\\:container=text])"),s=n.getAttribute("q:base"),i=new URL(s,r.baseURI),c=l.split("|"),p=k(n);for(let r=0;r<c.length;r++){const l=c[r],u=performance.now(),[d,f,h]=l.split("#"),q=n=>{if(n&&e.isConnected){const r=t=>{I("qerror",{error:t,qBase:s,symbol:f,element:e,reqTime:u})};try{const o=n.call(h,t,e);if(A(o))return o.catch(r)}catch(e){return r(e)}}},b=(t=!0)=>j(n,e,s,i,d,f,u,t),g=p?void 0:b();if(p)a=!0,o.push(async()=>{await p,await q(d?await b():await b(!1)||await b())});else if(A(g))a=!0,o.push(()=>g.then(q));else if(a)a=!0,o.push(async()=>{await q(g||await b())});else{const e=q(g);A(e)&&(a=!0,o.push(()=>e))}}}},O=(e,t=l,n=!0)=>{const r=N(e.type),o=t+":"+r,s=u+r,i=[],a=[],c=[];let p=e.target;for(;p;)L(p)?(i.push(p),a.push(U(p,o,s)),p=p.parentElement):p=p.parentElement;for(let t=i.length-1;t>=0;t--)if(a[t]&&(D(i[t],e,o,c,r,n),e.cancelBubble))return void S(c);for(let t=0;t<i.length;t++)if(!a[t]&&(D(i[t],e,o,c,r,n),!e.bubbles||e.cancelBubble))return void S(c);S(c)},P=e=>O(e,p,!1),F=(e,t,n=!0)=>{const r=N(t.type),o=e+":"+r,s=v("[q-"+CSS.escape(o)+"]"),i=[];for(let e=0;e<s.length;e++){const a=s[e];D(a,t,o,i,r,n)}S(i)},J=e=>{F(a,e)},M=e=>{F(c,e,!1)},Z=e=>{F(s,e)},z=e=>{F(i,e,!1)},G=()=>{const n=r.readyState;if("interactive"==n||"complete"==n){if(t=1,q.forEach(y),h.has("d:qinit")){h.delete("d:qinit");const e=$("qinit"),t=v("[q-d\\\\:qinit]"),n=[];for(let r=0;r<t.length;r++){const o=t[r];D(o,e,"d:qinit",n),o.removeAttribute("q-d:qinit")}S(n)}if(h.has("d:qidle")&&(h.delete("d:qidle"),(o.requestIdleCallback??o.setTimeout).bind(o)(()=>{const e=$("qidle"),t=v("[q-d\\\\:qidle]"),n=[];for(let r=0;r<t.length;r++){const o=t[r];D(o,e,"d:qidle",n),o.removeAttribute("q-d:qidle")}S(n)})),h.has("e:qvisible")){e||(e=new IntersectionObserver(t=>{const n=[];for(let r=0;r<t.length;r++){const o=t[r];o.isIntersecting&&(e.unobserve(o.target),D(o.target,$("qvisible",o),"e:qvisible",n))}S(n)}));const t=v("[q-e\\\\:qvisible]:not([q\\\\:observed])");for(let n=0;n<t.length;n++){const r=t[n];e.observe(r),r.setAttribute("q:observed","true")}}}},H=(...e)=>{for(let n=0;n<e.length;n++){const r=e[n];if(r===f)_(e[++n]);else if("string"==typeof r){if(!h.has(r)){h.add(r);const{scope:e,eventName:n}=T(r),i=x(e),c=B(e);c===s?w(o,n,i?z:Z,!0,i):q.forEach(e=>w(e,n,c===a?i?M:J:i?P:O,!0,i)),1!==t||"e:qvisible"!==r&&"d:qinit"!==r&&"d:qidle"!==r||G()}}else q.has(r)||(h.forEach(e=>{const{scope:t,eventName:n}=T(e),o=x(t),i=B(t);i!==s&&w(r,n,i===a?o?M:J:o?P:O,!0,o)}),q.add(r))}},K=o._qwikEv;K?.roots||(Array.isArray(K)?H(...K):H("e:click","e:input"),o._qwikEv={events:h,roots:q,push:H},w(r,d,G),G())',rn=`//#region packages/qwik/src/qwikloader.ts
var doc = document;
var win = window;
var windowPrefix = "w";
var passiveWindowPrefix = "wp";
var documentPrefix = "d";
var passiveDocumentPrefix = "dp";
var elementPrefix = "e";
var passiveElementPrefix = "ep";
var capturePrefix = "capture:";
var readyStateChange = "readystatechange";
var QwikEvContainerReady = 0;
var events = /* @__PURE__ */ new Set();
var roots = /* @__PURE__ */ new Set([doc]);
var symbols = /* @__PURE__ */ new Map();
var readyContainers = {};
var observer;
var hasInitialized;
var queuedTasks;
var nativeQuerySelectorAll = (root, selector) => Array.from(root.querySelectorAll(selector));
var querySelectorAll = (query) => {
	const elements = [];
	roots.forEach((root) => elements.push(...nativeQuerySelectorAll(root, query)));
	return elements;
};
var addEventListener = (el, eventName, handler, capture = false, passive = false) => el.addEventListener(eventName, handler, {
	capture,
	passive
});
var findShadowRoots = (fragment) => {
	addEventOrRoot(fragment);
	const shadowRoots = nativeQuerySelectorAll(fragment, "[q\\\\:shadowroot]");
	for (let i = 0; i < shadowRoots.length; i++) {
		const shadowRoot = shadowRoots[i].shadowRoot;
		shadowRoot && findShadowRoots(shadowRoot);
	}
};
var isPromise = (promise) => promise && typeof promise.then === "function";
var runTasks = async (tasks) => {
	for (let i = 0; i < tasks.length; i++) await tasks[i]();
};
var queueTasks = (tasks) => {
	if (tasks.length) {
		const run = () => runTasks(tasks);
		queuedTasks = queuedTasks ? queuedTasks.then(run, run) : run();
	}
};
var resolveContainer = (containerEl) => {
	if (containerEl._qwikjson_ === void 0) {
		let script = (containerEl === doc.documentElement ? doc.body : containerEl).lastElementChild;
		while (script) {
			if (script.tagName === "SCRIPT" && script.getAttribute("type") === "qwik/json") {
				containerEl._qwikjson_ = JSON.parse(script.textContent.replace(/\\\\x3C(\\/?script)/gi, "<$1"));
				break;
			}
			script = script.previousElementSibling;
		}
	}
};
var markContainerReady = (hash) => {
	readyContainers[hash] = 1;
	emitEvent(readyStateChange);
};
var waitForContainerReady = (container) => {
	const hash = container.getAttribute("q:instance");
	return container.getAttribute("q:container") === "paused" && doc.readyState === "loading" && !readyContainers[hash] && new Promise((resolve) => {
		const ready = () => {
			if (doc.readyState !== "loading" || readyContainers[hash]) resolve();
		};
		addEventListener(doc, readyStateChange, ready);
	});
};
var createEvent = (eventName, detail) => new CustomEvent(eventName, { detail });
var emitEvent = (eventName, detail) => {
	doc.dispatchEvent(createEvent(eventName, detail));
};
var camelToKebab = (str) => str.replace(/([A-Z-])/g, (a) => "-" + a.toLowerCase());
var kebabToCamel = (eventName) => eventName.replace(/-./g, (a) => a[1].toUpperCase());
var parseKebabEvent = (event) => {
	const separatorIndex = event.indexOf(":");
	return {
		scope: event.slice(0, separatorIndex),
		eventName: kebabToCamel(event.slice(separatorIndex + 1))
	};
};
var isPassiveScope = (scope) => scope.length === 2;
var getRootScope = (scope) => scope.charAt(0);
var isElementNode = (node) => !!node && node.nodeType === 1;
var isCaptureHandlerElement = (element, scopedKebabName, captureAttribute) => element.hasAttribute(captureAttribute) && (!!element._qDispatch?.[scopedKebabName] || element.hasAttribute("q-" + scopedKebabName));
var resolveHandler = (container, element, qBase, base, chunk, symbol, reqTime, reportSyncError = true) => {
	const eventData = {
		qBase,
		symbol,
		element,
		reqTime
	};
	if (!chunk) {
		const handler = (doc["qFuncs_" + container.getAttribute("q:instance")] || [])[+symbol];
		if (!handler && reportSyncError) {
			const error = /* @__PURE__ */ new Error("sym:" + symbol);
			emitEvent("qerror", {
				importError: "sync",
				error,
				...eventData
			});
			console.error(error);
		}
		return handler;
	}
	const key = \`\${symbol}|\${qBase}|\${chunk}\`;
	const handler = symbols.get(key);
	if (handler) return handler;
	const href = new URL(chunk, base).href;
	const module = import(
				href
);
	resolveContainer(container);
	return module.then((module) => {
		const handler = module[symbol];
		if (!handler) {
			const error = /* @__PURE__ */ new Error(\`\${symbol} not in \${href}\`);
			emitEvent("qerror", {
				importError: "no-symbol",
				error,
				...eventData
			});
			console.error(error);
		} else {
			symbols.set(key, handler);
			emitEvent("qsymbol", eventData);
		}
		return handler;
	}, (error) => {
		emitEvent("qerror", {
			importError: "async",
			error,
			...eventData
		});
		console.error(error);
	});
};
/**
* Dispatch an event by invoking QRL handlers. If there are multiple handlers, they are awaited in
* order.
*/
var dispatch = (element, ev, scopedKebabName, tasks, kebabName, allowPreventDefault = true) => {
	let defer = false;
	if (kebabName) {
		if (allowPreventDefault && element.hasAttribute("preventdefault:" + kebabName)) ev.preventDefault();
		if (element.hasAttribute("stoppropagation:" + kebabName)) ev.stopPropagation();
	}
	const handlers = element._qDispatch?.[scopedKebabName];
	if (handlers) {
		if (typeof handlers === "function") {
			const run = () => handlers(ev, element);
			if (defer) tasks.push(async () => {
				const result = run();
				if (isPromise(result)) await result;
			});
			else {
				const result = run();
				if (isPromise(result)) {
					defer = true;
					tasks.push(() => result);
				}
			}
		} else if (handlers.length) for (let i = 0; i < handlers.length; i++) {
			const handler = handlers[i];
			if (handler) {
				const run = () => handler(ev, element);
				if (defer) tasks.push(async () => {
					const result = run();
					if (isPromise(result)) await result;
				});
				else {
					const result = run();
					if (isPromise(result)) {
						defer = true;
						tasks.push(() => result);
					}
				}
			}
		}
		return;
	}
	const attrValue = element.getAttribute("q-" + scopedKebabName);
	if (attrValue) {
		const container = element.closest("[q\\\\:container]:not([q\\\\:container=html]):not([q\\\\:container=text])");
		const qBase = container.getAttribute("q:base");
		const base = new URL(qBase, doc.baseURI);
		const qrls = attrValue.split("|");
		const waitForReady = waitForContainerReady(container);
		for (let i = 0; i < qrls.length; i++) {
			const qrl = qrls[i];
			const reqTime = performance.now();
			const [chunk, symbol, capturedIds] = qrl.split("#");
			const run = (handler) => {
				if (handler && element.isConnected) {
					const onError = (error) => {
						emitEvent("qerror", {
							error,
							qBase,
							symbol,
							element,
							reqTime
						});
					};
					try {
						const result = handler.call(capturedIds, ev, element);
						if (isPromise(result)) return result.catch(onError);
					} catch (error) {
						return onError(error);
					}
				}
			};
			const resolve = (reportSyncError = true) => resolveHandler(container, element, qBase, base, chunk, symbol, reqTime, reportSyncError);
			const handler = waitForReady ? void 0 : resolve();
			if (waitForReady) {
				defer = true;
				tasks.push(async () => {
					await waitForReady;
					await run(chunk ? await resolve() : await resolve(false) || await resolve());
				});
			} else if (isPromise(handler)) {
				defer = true;
				tasks.push(() => handler.then(run));
			} else if (defer) {
				defer = true;
				tasks.push(async () => {
					await run(handler || await resolve());
				});
			} else {
				const result = run(handler);
				if (isPromise(result)) {
					defer = true;
					tasks.push(() => result);
				}
			}
		}
	}
};
/**
* Event handler responsible for processing element events.
*
* If browser emits an event, the \`eventProcessor\` walks the DOM tree looking for corresponding
* \`(\${event.type})\`. If found the event's URL is parsed and \`import()\`ed.
*
* @param ev - Browser event.
*/
var processElementEvent = (ev, scope = elementPrefix, allowPreventDefault = true) => {
	const kebabName = camelToKebab(ev.type);
	const scopedKebabName = scope + ":" + kebabName;
	const captureAttribute = capturePrefix + kebabName;
	const elements = [];
	const captureHandlers = [];
	const tasks = [];
	let current = ev.target;
	while (current) if (isElementNode(current)) {
		elements.push(current);
		captureHandlers.push(isCaptureHandlerElement(current, scopedKebabName, captureAttribute));
		current = current.parentElement;
	} else current = current.parentElement;
	for (let i = elements.length - 1; i >= 0; i--) if (captureHandlers[i]) {
		dispatch(elements[i], ev, scopedKebabName, tasks, kebabName, allowPreventDefault);
		if (ev.cancelBubble) {
			queueTasks(tasks);
			return;
		}
	}
	for (let i = 0; i < elements.length; i++) if (!captureHandlers[i]) {
		dispatch(elements[i], ev, scopedKebabName, tasks, kebabName, allowPreventDefault);
		if (!ev.bubbles || ev.cancelBubble) {
			queueTasks(tasks);
			return;
		}
	}
	queueTasks(tasks);
};
var processPassiveElementEvent = (ev) => processElementEvent(ev, passiveElementPrefix, false);
var broadcast = (scope, ev, allowPreventDefault = true) => {
	const kebabName = camelToKebab(ev.type);
	const scopedKebabName = scope + ":" + kebabName;
	const elements = querySelectorAll("[q-" + CSS.escape(scopedKebabName) + "]");
	const tasks = [];
	for (let i = 0; i < elements.length; i++) {
		const el = elements[i];
		dispatch(el, ev, scopedKebabName, tasks, kebabName, allowPreventDefault);
	}
	queueTasks(tasks);
};
/**
* Event handler responsible for processing browser events.
*
* If browser emits an event, the \`eventProcessor\` walks the DOM tree looking for corresponding
* \`(\${event.type})\`. If found the event's URL is parsed and \`import()\`ed.
*
* @param ev - Browser event.
*/
var processDocumentEvent = (ev) => {
	broadcast(documentPrefix, ev);
};
var processPassiveDocumentEvent = (ev) => {
	broadcast(passiveDocumentPrefix, ev, false);
};
var processWindowEvent = (ev) => {
	broadcast(windowPrefix, ev);
};
var processPassiveWindowEvent = (ev) => {
	broadcast(passiveWindowPrefix, ev, false);
};
/**
* Called when the document is ready and whenever a container is added, so make this idempotent. For
* qidle and qinit we remove the attributes immediately, and for qvisible we add an attribute
*/
var processReadyStateChange = () => {
	const readyState = doc.readyState;
	if (readyState == "interactive" || readyState == "complete") {
		hasInitialized = 1;
		roots.forEach(findShadowRoots);
		if (events.has("d:qinit")) {
			events.delete("d:qinit");
			const ev = createEvent("qinit");
			const elements = querySelectorAll("[q-d\\\\:qinit]");
			const tasks = [];
			for (let i = 0; i < elements.length; i++) {
				const el = elements[i];
				dispatch(el, ev, "d:qinit", tasks);
				el.removeAttribute("q-d:qinit");
			}
			queueTasks(tasks);
		}
		if (events.has("d:qidle")) {
			events.delete("d:qidle");
			(win.requestIdleCallback ?? win.setTimeout).bind(win)(() => {
				const ev = createEvent("qidle");
				const elements = querySelectorAll("[q-d\\\\:qidle]");
				const tasks = [];
				for (let i = 0; i < elements.length; i++) {
					const el = elements[i];
					dispatch(el, ev, "d:qidle", tasks);
					el.removeAttribute("q-d:qidle");
				}
				queueTasks(tasks);
			});
		}
		if (events.has("e:qvisible")) {
			observer || (observer = new IntersectionObserver((entries) => {
				const tasks = [];
				for (let i = 0; i < entries.length; i++) {
					const entry = entries[i];
					if (entry.isIntersecting) {
						observer.unobserve(entry.target);
						dispatch(entry.target, createEvent("qvisible", entry), "e:qvisible", tasks);
					}
				}
				queueTasks(tasks);
			}));
			const elements = querySelectorAll("[q-e\\\\:qvisible]:not([q\\\\:observed])");
			for (let i = 0; i < elements.length; i++) {
				const el = elements[i];
				observer.observe(el);
				el.setAttribute("q:observed", "true");
			}
		}
	}
};
var addEventOrRoot = (...eventNames) => {
	for (let i = 0; i < eventNames.length; i++) {
		const eventNameOrRoot = eventNames[i];
		if (eventNameOrRoot === QwikEvContainerReady) markContainerReady(eventNames[++i]);
		else if (typeof eventNameOrRoot === "string") {
			if (!events.has(eventNameOrRoot)) {
				events.add(eventNameOrRoot);
				const { scope, eventName } = parseKebabEvent(eventNameOrRoot);
				const passive = isPassiveScope(scope);
				const rootScope = getRootScope(scope);
				if (rootScope === windowPrefix) addEventListener(win, eventName, passive ? processPassiveWindowEvent : processWindowEvent, true, passive);
				else roots.forEach((root) => addEventListener(root, eventName, rootScope === documentPrefix ? passive ? processPassiveDocumentEvent : processDocumentEvent : passive ? processPassiveElementEvent : processElementEvent, true, passive));
				if (hasInitialized === 1 && (eventNameOrRoot === "e:qvisible" || eventNameOrRoot === "d:qinit" || eventNameOrRoot === "d:qidle")) processReadyStateChange();
			}
		} else if (!roots.has(eventNameOrRoot)) {
			events.forEach((kebabEventName) => {
				const { scope, eventName } = parseKebabEvent(kebabEventName);
				const passive = isPassiveScope(scope);
				const rootScope = getRootScope(scope);
				if (rootScope !== windowPrefix) addEventListener(eventNameOrRoot, eventName, rootScope === documentPrefix ? passive ? processPassiveDocumentEvent : processDocumentEvent : passive ? processPassiveElementEvent : processElementEvent, true, passive);
			});
			roots.add(eventNameOrRoot);
		}
	}
};
var _qwikEv = win._qwikEv;
if (!_qwikEv?.roots) {
	if (Array.isArray(_qwikEv)) addEventOrRoot(..._qwikEv);
	else addEventOrRoot("e:click", "e:input");
	win._qwikEv = {
		events,
		roots,
		push: addEventOrRoot
	};
	addEventListener(doc, readyStateChange, processReadyStateChange);
	processReadyStateChange();
}
//#endregion`,an=`var t='script[type="qwik/backpatch"]';function e(e,n){const o=n||e.querySelector("[q\\\\:container]:not([q\\\\:container=html]):not([q\\\\:container=text])");if(o){const n=o.querySelectorAll(t),r=n[n.length-1];if(r){const t=JSON.parse(r.textContent||"[]"),n=e.createTreeWalker(o,NodeFilter.SHOW_ELEMENT);let c=n.currentNode,i=c.hasAttribute(":")?0:-1;for(let e=0;e<t.length;e+=3){const o=t[e],r=t[e+1];let l=t[e+2];for(;i<o&&(c=n.nextNode(),c);)c.hasAttribute(":")&&i++;const a=c;null==l||!1===l?a.removeAttribute(r):("boolean"==typeof l&&(l=""),a.setAttribute(r,l))}}}}var n=document.currentScript;if(n){const t=n.closest("[q\\\\:container]:not([q\\\\:container=html]):not([q\\\\:container=text])");t&&e(document,t)}`,on=`//#region packages/qwik/src/backpatch-executor-shared.ts
/**
* Shared backpatch executor logic that can be imported by both the inline script
* (backpatch-executor.ts) and test utilities.
*/
var BACKPATCH_DATA_SELECTOR = "script[type=\\"qwik/backpatch\\"]";
/**
* Execute backpatch operations on a document.
*
* @param doc - The document to execute backpatch on
* @param containerElement - Optional specific container element (if not provided, will search for
*   it)
*/
function executeBackpatch(doc, containerElement) {
	const container = containerElement || doc.querySelector("[q\\\\:container]:not([q\\\\:container=html]):not([q\\\\:container=text])");
	if (container) {
		const scripts = container.querySelectorAll(BACKPATCH_DATA_SELECTOR);
		const script = scripts[scripts.length - 1];
		if (script) {
			const data = JSON.parse(script.textContent || "[]");
			const walker = doc.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
			let currentNode = walker.currentNode;
			let currentNodeIdx = currentNode.hasAttribute(":") ? 0 : -1;
			for (let i = 0; i < data.length; i += 3) {
				const elementIdx = data[i];
				const attrName = data[i + 1];
				let value = data[i + 2];
				while (currentNodeIdx < elementIdx) {
					currentNode = walker.nextNode();
					if (!currentNode) break;
					if (currentNode.hasAttribute(":")) currentNodeIdx++;
				}
				const element = currentNode;
				if (value == null || value === false) element.removeAttribute(attrName);
				else {
					if (typeof value === "boolean") value = "";
					element.setAttribute(attrName, value);
				}
			}
		}
	}
}
//#endregion
//#region packages/qwik/src/backpatch-executor.ts
/**
* Qwik Backpatch Executor
*
* This script executes the backpatch operations by finding the backpatch data script within the
* same container and applying the patches to the DOM elements.
*
* This is the inline script version that auto-executes when loaded in the browser. The actual logic
* is in backpatch-executor-shared.ts for reusability.
*/
var executorScript = document.currentScript;
if (executorScript) {
	const container = executorScript.closest("[q\\\\:container]:not([q\\\\:container=html]):not([q\\\\:container=text])");
	if (container) executeBackpatch(document, container);
}
//#endregion`;function sn(e={}){return e.debug?rn:nn}globalThis.QWIK_PREFETCH_MINIFIED,globalThis.QWIK_PREFETCH_DEBUG;function cn(e={}){return e.debug?on:an}var ln=class{constructor(e,t,n,r,i,a){this.parentComponent=e,this.attributesIndex=n,this.cleanupQueue=r,this.vnodeData=i,this.currentFile=a,this.id=t,this.flags=1,this.attrs=this.attributesIndex>=0?this.vnodeData[this.attributesIndex]:v,this.parentComponent?.addChild(this)}parentComponent;attributesIndex;cleanupQueue;vnodeData;currentFile;__brand__=`SsrNode`;id;flags;dirty=0;children=null;attrs;localProps=null;get[S](){return this.getProp(Be)}setProp(e,t){this.attrs===v&&this.setEmptyArrayAsVNodeDataAttributes(),e.startsWith(q)?(this.localProps||={})[e]=t:this.attrs[e]=t,e==et&&t&&this.cleanupQueue.push(t)}setEmptyArrayAsVNodeDataAttributes(){if(this.attributesIndex>=0)this.vnodeData[this.attributesIndex]={},this.attrs=this.vnodeData[this.attributesIndex];else{let e=+(this.vnodeData.length>1);this.vnodeData.splice(e,0,{}),this.attributesIndex=e,this.attrs=this.vnodeData[this.attributesIndex]}}getProp(e){return e.startsWith(q)?this.localProps?this.localProps[e]??null:null:this.attrs[e]??null}removeProp(e){e.startsWith(q)?this.localProps&&delete this.localProps[e]:delete this.attrs[e]}addChild(e){this.children||=[],this.children.push(e)}setTreeNonUpdatable(){if(this.flags&1&&(this.flags&=-2,this.children))for(let e=0;e<this.children.length;e++)this.children[e].setTreeNonUpdatable()}toString(){return`<SSRNode id="${this.id}" />`}},un=class{constructor(e){this.me=e}me;__brand__=`DomRef`},dn=class{constructor(e){this.componentNode=e}componentNode;slots=[];projectionDepth=0;scopedStyleIds=new Set;projectionScopedStyle=null;projectionComponentFrame=null;distributeChildrenIntoSlots(e,t,n){if(this.projectionScopedStyle=t,this.projectionComponentFrame=n,y(e)){let t=this.getSlotName(e);L(this.slots,t,e,0)}else if(Array.isArray(e)&&e.length>0){let t=[];for(let n=0;n<e.length;n++){let r=e[n];if(y(r)){let e=this.getSlotName(r);e===K?t.push(r):this.updateSlot(e,r)}else t.push(r)}t.length>0&&L(this.slots,K,t,0)}else L(this.slots,K,e,0)}updateSlot(e,t){let n=Te(this.slots,e,0);n===null?n=t:Array.isArray(n)?n.push(t):n=[n,t],L(this.slots,e,n,0)}getSlotName(e){return e.props[U]?e.props[U]:K}hasSlot(e){return Ee(this.slots,e,0)}claimChildrenForSlot(e){return we(this.slots,e,0)}consumeChildrenForSlot(e,t){let n=this.claimChildrenForSlot(t);return this.componentNode.setProp(t,e.id),e.setProp(Fe,this.componentNode.id),n}},fn=(e,t)=>{let n=``;for(let r=0;r<e.length;r++){let i=e[r];if(typeof i==`string`)n+=i;else if(i.type===`root-ref-delta`){let e=t?t[i.localId]??i.localId:i.localId,r=t?t[i.localBaseId]??i.localBaseId:i.localBaseId;n+=String(e-r)}else{let e=i.type===`root-ref`?i.localId:i.localPath[0];if(n+=String(t?t[e]??e:e),i.type!==`root-ref-path`)continue;let r=i.localPath;for(let e=1;e<r.length;e++)n+=` `+r[e]}}return n},pn=class{buffer=[];write(e){this.buffer.push(e)}writeRootRef(e){kt(this,e)}writeRootRefPath(e){At(this,e)}writeRootRefDelta(e,t){jt(this,e,t)}clear(){this.buffer.length=0}toString(e){return this.buffer.join(``)}};function mn(e){switch(e){case`area`:case`base`:case`basefont`:case`bgsound`:case`br`:case`col`:case`embed`:case`frame`:case`hr`:case`img`:case`input`:case`keygen`:case`link`:case`meta`:case`param`:case`source`:case`track`:case`wbr`:return!0;default:return!1}}function hn(){if(typeof performance>`u`)return()=>0;let e=performance.now();return()=>(performance.now()-e)/1e6}function gn(e){let t=e.base;return typeof e.base==`function`&&(t=e.base(e)),typeof t==`string`?(t.endsWith(`/`)||(t+=`/`),t):`/build/`}var _n=2**53-1,vn=2**53-1-1,yn=2**53-1-2;function bn(e){let t=e.length,n=t>1?e[t-1]:0;n>=0?e.push(-1):e[t-1]=n-1}function xn(e,t){let n=e.length,r=n>1?e[n-1]:0;n>1&&r>=0&&(e[0]|=1),e.push(t),t==0&&(e[0]|=1)}function Sn(e,t){e.push(t,_n),e[0]|=2}function Cn(e){e.push(vn)}function wn(e){e.push({},yn),e[0]|=4}function Tn(e,t,n,r,i){t[0]|=8;let a=[-1],o=-1;for(let e=1;e<t.length;e++){let n=t[e];if(typeof n==`object`&&n)o=e,e++,t[e]!==yn&&(a[a.length-1]++,a.push(-1));else if(n===vn)a.pop();else if(n<0){let e=0-n;a[a.length-1]+=e}else a[a.length-1]++}let s=String(n);if(t[0]&3)for(let e=0;e<a.length;e++){let t=a[e];t>=0&&(s+=Dn(t))}return new ln(e,s,o,r,t,i)}var En=[];function Dn(e){for(;En.length<=e;){let e=En.length,t=``;do t=String.fromCharCode((t.length===0?65:97)+e%26)+t,e=Math.floor(e/26);while(e!==0);En.push(t)}return En[e]}var On=/^[A-Za-z][A-Za-z0-9._:-]*$/,kn=new Set([`script`,`style`,`textarea`,`title`,`iframe`,`noframes`,`noscript`,`xmp`,`template`,`svg`,`math`]);function An(e){return e.renderOptions||={},new Nn({tagName:e.tagName||`div`,writer:e.writer||new pn,streamHandler:e.streamHandler,locale:e.locale||``,timing:e.timing||{firstFlush:0,render:0,snapshot:0},buildBase:e.buildBase||`/build/`,resolvedManifest:e.resolvedManifest||{mapper:{},manifest:{manifestHash:`dev`,mapping:{}}},renderOptions:e.renderOptions})}var jn={flush(){},waitForPendingFlush(){},streamBlockStart(){},streamBlockEnd(){}},Mn={hidden:!0,"aria-hidden":!0},Nn=class extends te{tag;isHtml;writer;streamHandler;timing;size=0;resolvedManifest;symbolToChunkResolver;renderOptions;outOfOrderStreaming;I;serializationCtx;hasVNodeRefsForSerialization=!1;additionalHeadNodes=[];additionalBodyNodes=[];lastNode=null;currentComponentNode=null;styleIds=new Set;isBackpatchExecutorEmitted=!1;isOutOfOrderExecutorEmitted=!1;isErrorSwapExecutorEmitted=!1;backpatchMap=new Map;currentElementFrame=null;renderTimer;depthFirstElementCount=-1;vNodeDatas=[];vNodeDataOffset=0;componentStack=[];cleanupQueue=[];emitContainerDataFrame=null;Kt=Rn();t=!1;qlInclude;promiseAttributes=null;vnodeSegment=null;i=0;outOfOrderId=0;outOfOrderUsed=!1;outOfOrderPendingSegments=[];outOfOrderSegments=[];rootContainerReadyPromise=null;resolveRootContainerReady=null;renderQueue=Promise.resolve();emittedQwikEventNames=new Set;emittedSyncFnCount=0;rootContainerSerializedRootCount=0;emittedVNodeDataOwners=null;constructor(e){if(super(e.renderOptions.serverData??{},e.locale),this.symbolToChunkResolver=e=>{let t=e.lastIndexOf(`_`),n=this.resolvedManifest.mapper[t==-1?e:e.substring(t+1)];return n?n[1]:``},this.serializationCtx=this.serializationCtxFactory(ln,un,this.symbolToChunkResolver,e.writer),this.renderTimer=hn(),this.tag=e.tagName,this.isHtml=e.tagName===`html`,this.writer=e.writer,this.streamHandler=e.streamHandler,this.timing=e.timing,this.ze=e.buildBase,this.resolvedManifest=e.resolvedManifest,this.renderOptions=e.renderOptions,this.I=e.renderOptions.transformError,this.renderOptions.streaming?.outOfOrder===!0)throw Error('Out-of-order Suspense streaming requires `experimental: ["suspense"]` in the `qwikVite` plugin.');this.outOfOrderStreaming=!1,this.Ue=1e5;let t=this.renderOptions.qwikLoader;this.qlInclude=t?typeof t==`object`?t.include===`never`?2:0:t===`inline`?1:t===`never`?2:0:0,this.qlInclude===0&&(this.resolvedManifest?.manifest.qwikLoader||(this.qlInclude=1)),this.m()}ensureProjectionResolved(e){}handleError(e,t,n=`render`){N(this,e,t,n)}addBackpatchEntry(e,t,n){let r=parseInt(e,10),i={attrName:t,value:n},a=this.backpatchMap.get(r)||[];a.push(i),this.backpatchMap.set(r,a)}async render(e){this.openContainer(),await this.renderJSX(e,{currentStyleScoped:null,parentComponentFrame:this.getComponentFrame()}),await this.closeContainer()}async renderJSX(e,t){await T(this,e,t)}v(){return this.i===2}C(e){return e()}F(){}ar(){}nextOutOfOrderId(e=!0){return 0}emitOutOfOrderSegmentScripts(e){}async segment(e,t,n){throw Error('Out-of-order Suspense streaming requires `experimental: ["suspense"]` in the `qwikVite` plugin.')}hr(){let e=this;for(;e instanceof Pn;)e=e.Rn;return e}createSegmentContainer(e,t){let n=this.hr(),r=this.getOrCreateLastNode();this.Ct(r);let i={tagNesting:10,parent:null,elementName:`#segment`,depthFirstElementIdx:-1,vNodeData:[16],currentFile:null,refBase:r.id},a=new Pn({tagName:this.tag,writer:t,streamHandler:jn,locale:this.fn,timing:this.timing,buildBase:this.ze||`/build/`,resolvedManifest:this.resolvedManifest,renderOptions:this.renderOptions},n),o=a;return o.It=!0,o.yt=this.yt,a.serializationCtx.yt=this.yt,a.serializationCtx.St=this.serializationCtx.St.bind(this.serializationCtx),a.currentElementFrame=i,a.currentComponentNode=this.currentComponentNode,a.depthFirstElementCount=0,a.vNodeDatas=[i.vNodeData],a.componentStack=this.componentStack.slice(),a.vnodeSegment=e,a.styleIds=this.styleIds,a.emittedQwikEventNames=this.emittedQwikEventNames,a.qlInclude=2,a.Kt=this.Kt,o._didAddQwikLoader=!0,a}queueOutOfOrderSegment(e){}removeOutOfOrderSegment(e){let t=this.outOfOrderSegments;for(let n=0;n<t.length;n++)if(t[n]===e){t.splice(n,1);return}}setContext(e,t,n){let r=e,i=r.getProp(W);i??r.setProp(W,i=[]),L(i,t.id,n,0,!0),this.addRoot(r)}resolveContext(e,t){let n=e;for(;n;){let e=n.getProp(W);if(e!=null&&Ee(e,t.id,0))return Te(e,t.id,0);n=n.parentComponent}}getParentHost(e){return e.parentComponent}setHostProp(e,t,n){return e.setProp(t,n)}getHostProp(e,t){return e.getProp(t)}openContainer(){this.tag==`html`&&this.write(`<!DOCTYPE html>`);let e=this.renderOptions.containerAttributes||{},t=e[He];e[G]=`paused`,e[Ue]=`2`,e[We]=this.Ve??`dev`,e[He]=(t?t+`-`:``)+`ssr`,e[Ge]=this.ze||``,e[Ke]=this.fn,e[qe]=this.resolvedManifest.manifest.manifestHash,e[Je]=this.Kt;let n=this.renderOptions.statePrewarm;typeof n==`number`?e[Ye]=String(n):delete e[Ye],this.pn.containerAttributes=e,this.openElement(this.tag,null,e),this.isHtml||(this.emitContainerDataFrame=this.currentElementFrame)}closeContainer(){return this.closeElement()}qt=0;At=null;openElement(e,t,n,r=null,i=null,a=null,o=!0){if(!On.test(e))throw R(36,[JSON.stringify(e)]);let s=Fn(e,n)||Fn(e,r);kn.has(e)&&this.qt++,!s&&this.qlInclude===1&&this.qt===0&&this.size>30720&&e!==`body`&&this.emitQwikLoaderInline();let c;this.lastNode=null,!s&&this.currentElementFrame&&bn(this.currentElementFrame.vNodeData),this.createAndPushFrame(e,this.depthFirstElementCount++,a),this.isHtml&&e===`body`&&this.emitContainerDataFrame===null&&(this.emitContainerDataFrame=this.currentElementFrame),wn(this.currentElementFrame.vNodeData),this.write(Nt),this.write(e);let l=this.getOrCreateLastNode();return n&&(c=this.writeAttrs(e,n,!1,i,a,o)),this.write(` `+at),t!==null&&(this.write(Lt),this.write(V(t)),this.write(Rt)),r&&!Dt(r)&&(c=this.writeAttrs(e,r,!0,i,a,o)||c),this.write(Pt),l&&l.setTreeNonUpdatable(),c}closeElement(){if(this.currentElementFrame===this.emitContainerDataFrame){this.emitContainerDataFrame=null,this.onRenderDone();let e=hn();return Y(Y(this.emitContainerData(),()=>this._closeElement()),()=>{this.timing.snapshot=e()})}this._closeElement()}onRenderDone(){this.drainCleanupQueue(),this.timing.render=this.renderTimer()}drainCleanupQueue(){let e=this.cleanupQueue.pop();for(;e;){for(let t=0;t<e.length;t++){let n=e[t];In(n)&&n.$n()}e=this.cleanupQueue.pop()}}_closeElement(){let e=this.popFrame().elementName;mn(e)||(this.write(Ft),this.write(e),this.write(Pt)),this.lastNode=null,kn.has(e)&&this.qt--}openFragment(e){this.lastNode=null,Sn(this.currentElementFrame.vNodeData,e),this.getOrCreateLastNode()}closeFragment(){Cn(this.currentElementFrame.vNodeData),this.currentComponentNode&&this.currentComponentNode.setTreeNonUpdatable(),this.lastNode=null}openProjection(e){this.openFragment(e);let t=this.getComponentFrame();if(t){let e=this.getOrCreateLastNode();this.markVNodeRefForSerialization(e),this.vnodeSegment?this.markVNodeRefForSerialization(t.componentNode):this.addRoot(t.componentNode),t.projectionDepth++}}closeProjection(){let e=this.getComponentFrame();e&&e.projectionDepth--,this.closeFragment()}openComponent(e){this.openFragment(e),this.currentComponentNode=this.getOrCreateLastNode(),this.componentStack.push(new dn(this.currentComponentNode))}getComponentFrame(e=0){let t=this.componentStack.length-e-1;return t>=0?this.componentStack[t]:null}getParentComponentFrame(){let e=this.getComponentFrame()?.projectionDepth||0;return this.getComponentFrame(e)}async closeComponent(){let e=this.componentStack.pop();await this.emitUnclaimedProjectionForComponent(e),this.closeFragment(),this.currentComponentNode=this.currentComponentNode?.parentComponent||null}async emitUnclaimedProjectionForComponent(e){if(e.slots.length===0)return;this.openElement(Xe,null,Mn,null);let t=e.projectionScopedStyle;for(let n=0;n<e.slots.length;n+=2){let r=e.slots[n],i=e.slots[n+1];this.vnodeSegment&&this.markVNodeRefForSerialization(e.componentNode),this.openFragment({[Fe]:e.componentNode.id,[U]:r});let a=this.getOrCreateLastNode();a.vnodeData[0]|=16,e.componentNode.setProp(r,a.id),await this.renderJSX(i,{currentStyleScoped:t,parentComponentFrame:e.projectionComponentFrame}),this.closeFragment()}this.closeElement()}textNode(e){this.write(V(e)),xn(this.currentElementFrame.vNodeData,e.length),this.lastNode=null}htmlNode(e){this.write(e)}commentNode(e){this.write(`<!--`+e+`-->`)}addRoot(e){return this.t?this.serializationCtx.Xe(e):this.serializationCtx.Rt(e)}getOrCreateLastNode(){if(!this.lastNode){let e=this.currentElementFrame,t=e.depthFirstElementIdx+1,n=e.refBase??(this.vnodeSegment?Me(this.vnodeSegment,t):t+this.vNodeDataOffset);this.lastNode=Tn(this.currentComponentNode,e.vNodeData,n,this.cleanupQueue,e.currentFile)}return this.lastNode}addUnclaimedProjection(e,t,n){e.slots.push(t,n)}m(){let e=this.resolvedManifest.manifest.injections;if(e)for(let t=0;t<e.length;t++){let n=e[t],r=l(n.tag,null,n.attributes||{},null,0,null);n.location===`head`?this.additionalHeadNodes.push(r):this.additionalBodyNodes.push(r)}}er(e,t,n,r){if(r){let e=this.getComponentFrame(0);e.scopedStyleIds.add(t);let r=dt(e.scopedStyleIds);this.setHostProp(n,ze,r)}this.styleIds.has(t)||(this.styleIds.add(t),this.currentElementFrame?.elementName===`html`?this.additionalHeadNodes.push(u(`style`,null,{dangerouslySetInnerHTML:e,[Re]:t},null,0,t)):this._styleNode(t,e))}_styleNode(e,t){this.openElement(`style`,null,{[Re]:e}),this.write(t),this.closeElement()}ft(e){return this.isHtml&&this.currentElementFrame?.elementName===`html`?(this.additionalHeadNodes.push(e),!0):!1}emitContainerData(){return Y(Y(this.renderOptions.streaming?.inOrder?.strategy===`disabled`?void 0:this.streamHandler.flush(),()=>this.resolvePromiseAttributes()),()=>(this.i=1,Y(this.emitStateData(),()=>(this.t=!0,Y(this.emitRestStateData(),()=>this.emitOutOfOrderSegmentsAndData())))))}emitRestStateData(){this.emitVNodeData(),this.emitDelayedOutOfOrderSegmentVNodeData(),Qt(this,this.renderOptions,this.pn?.nonce),this.emitSyncFnsData(),this.emitPatchDataIfNeeded(),this.emitExecutorIfNeeded(),this.emitQwikLoaderAtBottomIfNeeded()}emitDelayedOutOfOrderSegmentVNodeData(){}emitOutOfOrderSegmentsAndData(){}emitVNodeData(e){this.hr().markVNodeDataOwnerEmitted(e),(e||this.serializationCtx.de.length||this.hasVNodeRefsForSerialization)&&this.emitVNodeDataScript(e,this.vNodeDatas.entries())}emitVNodeDataScript(e,t,n=!1){let r={type:`qwik/vnode`};n&&(r[Ie]=!0),this.openScript(r);let i=[],a=0;for(let[e,n]of t){let t=n[0];if(t&16&&(a=this.emitVNodeSeparators(a,e),t&8&&this.write(z.REFERENCE_CH),!(t&32)&&t&7)){let e=null,t=0;for(let r=1;r<n.length;r++){let a=n[r];typeof a==`object`&&a?(i.push(e),e=a):a===_n?(t++,this.write(B.OPEN_CHAR)):a===vn?(e&&=(this.writeFragmentAttrs(e),i.pop()),t--,this.write(B.CLOSE_CHAR)):a===yn?e&&!Dt(e)&&(this.write(B.SEPARATOR_CHAR),this.write(B.SEPARATOR_CHAR),this.writeFragmentAttrs(e),this.write(B.SEPARATOR_CHAR),this.write(B.SEPARATOR_CHAR),e=i.pop()):a>=0?this.write(Dn(a)):this.write(String(0-a))}for(;t-->0;)e&&=(this.writeFragmentAttrs(e),i.pop()),this.write(B.CLOSE_CHAR)}}this.closeScript(),n&&!e&&this.emitInlineScript(`document.qProcessVNodeDataPatch&&document.qProcessVNodeDataPatch(document.currentScript.previousElementSibling)`)}Ct(e){e&&(this.addRoot(e),this.markVNodeRefForSerialization(e))}markVNodeRefForSerialization(e){e&&(this.hasVNodeRefsForSerialization=!0,e.vnodeData[0]|=24)}markVNodeDataOwnerEmitted(e){}isVNodeDataOwnerEmitted(e){return this.emittedVNodeDataOwners?.has(e)===!0}getVNodeDataOwnerFromNodeId(e){let t=parseInt(e,10);if(t>=0)return{owner:void 0,localIndex:t};let n=-t-1,r=Math.floor((Math.sqrt(8*n+1)-1)/2),i=n-r*(r+1)/2,a=r-i;return{owner:String(a+1),localIndex:i}}writeFragmentAttrs(e){for(let t in e){let n=e[t],r=n,i,a=null;if(t===Ze&&typeof n==`number`)i=n,r=String(n);else if(typeof n!=`string`){if(i=this.addRoot(n),i===void 0){t===Pe&&(this.write(B.RENDER_FN_CHAR),this.write(B.RENDER_HASH_PREFIX_CHAR),this.write(Ne(H(n.ot))));continue}r=String(i)}switch(t){case ze:this.write(B.SCOPED_STYLE_CHAR);break;case Pe:this.write(B.RENDER_FN_CHAR);break;case Ze:this.write(B.ID_CHAR);break;case $e:this.write(B.PROPS_CHAR);break;case Qe:a=H,this.write(B.KEY_CHAR);break;case et:this.write(B.SEQ_CHAR);break;case tt:this.write(B.SEQ_IDX_CHAR);break;case Be:this.write(B.BACK_REFS_CHAR);break;case Fe:this.write(B.SLOT_PARENT_CHAR);break;case W:this.write(B.CONTEXT_CHAR);break;case U:a=H,this.write(B.SLOT_CHAR);break;default:a=encodeURI,this.write(B.SEPARATOR_CHAR),this.write(Ne(H(t))),this.write(B.SEPARATOR_CHAR)}let o=Ne(a?a(r):r);a&&o!==r?(this.write(B.SEPARATOR_CHAR),this.write(o),this.write(B.SEPARATOR_CHAR)):typeof i==`number`?this.writeRootRef(i):this.write(r)}}emitStateData(){if(!this.serializationCtx.de.length&&!this.serializationCtx.Ce.size)return;let e=this.stateScriptAttrs();return this.openScript(e),this.serializationCtx.ce(this.writer),Y(this.serializationCtx.Jt(),()=>{this.closeScript()})}stateScriptAttrs(){let e={type:`qwik/state`,[Je]:this.Kt},t=this.serializationCtx.Ce;return t.size>0&&(e[`q-d:qidle`]=de(null,`_res`,s,null,[...t])),e}emitSyncFnsData(e=!1){let t=this.serializationCtx.Ie,n=e?this.emittedSyncFnCount:0;if(t.length>n){let r={"q:func":`qwik/json`};if(this.renderOptions.serverData?.nonce&&(r.nonce=this.renderOptions.serverData.nonce),this.openScript(r),e){let e=Un.replace(`HASH`,this.Kt).slice(0,-1);this.write(`(${e}||(${e}=[])).push(`)}else this.write(Un.replace(`HASH`,this.Kt));e||this.write(zt),this.writeArray(t,Ht,e?n:0),e||this.write(Bt),e&&this.write(`)`),this.closeScript(),this.emittedSyncFnCount=t.length}}emitPatchDataIfNeeded(){if(this.backpatchMap.size===0)return;let e=[],t=[...this.backpatchMap.entries()].sort(([e],[t])=>Number(e)-Number(t));for(let n=0;n<t.length;n++){let[r,i]=t[n];for(let t=0;t<i.length;t++){let n=i[t];e.push(r,n.attrName,a(n.value)?n.value.untrackedValue:n.value)}}this.backpatchMap.clear(),this.isBackpatchExecutorEmitted=!0;let n={type:nt};this.renderOptions.serverData?.nonce&&(n.nonce=this.renderOptions.serverData.nonce),this.writeScript(n,JSON.stringify(e).replaceAll(`<`,`\\u003C`))}emitBackpatchDataAndExecutorIfNeeded(){this.backpatchMap.size!==0&&(this.emitPatchDataIfNeeded(),this.emitExecutorIfNeeded())}emitExecutorIfNeeded(){if(!this.isBackpatchExecutorEmitted)return;this.isBackpatchExecutorEmitted=!1;let e={type:`text/javascript`};this.renderOptions.serverData?.nonce&&(e.nonce=this.renderOptions.serverData.nonce);let t=cn({debug:!1});this.writeScript(e,t)}emitOutOfOrderExecutorIfNeeded(){}emitErrorSwapExecutorIfNeeded(){}A(e){}emitInlineScript(e){let t={type:`text/javascript`};this.renderOptions.serverData?.nonce&&(t.nonce=this.renderOptions.serverData.nonce),this.writeScript(t,e)}writeScript(e,t){this.openScript(e),t&&this.write(t),this.closeScript()}openScript(e){this.write(`<script`),this.writeAttrs(`script`,e,!0,null,null,!0),this.write(Pt)}closeScript(){this.write(`<\/script>`)}emitPreloaderPre(){Xt(this,this.renderOptions.preloader,this.renderOptions.serverData?.nonce)}isStatic(){return this.serializationCtx.Ft.size===0}emitQwikLoaderAtTopIfNeeded(){if(this.qlInclude===0){this.qlInclude=2;let e=this.ze+this.resolvedManifest.manifest.qwikLoader,t={rel:`modulepreload`,href:e},n=this.renderOptions.serverData?.nonce;n&&(t.nonce=n),this.openElement(`link`,null,t),this.closeElement();let r={async:!0,type:`module`,src:e};n&&(r.nonce=n),this.writeScript(r)}}emitQwikLoaderInline(){this.qlInclude=2;let e=sn({debug:this.renderOptions.debug}),t={id:`qwikloader`,async:!0,type:`module`};this.renderOptions.serverData?.nonce&&(t.nonce=this.renderOptions.serverData.nonce),this.writeScript(t,e)}emitQwikLoaderAtBottomIfNeeded(){this.isStatic()||(this.qlInclude!==2&&this.emitQwikLoaderInline(),this.emitNewQwikEvents(!0))}emitNewQwikEvents(e=!1){let t=[];for(let e of this.serializationCtx.Lt)this.emittedQwikEventNames.has(e)||(this.emittedQwikEventNames.add(e),t.push(JSON.stringify(e)));e&&t.push(`${Ve}`,JSON.stringify(this.Kt)),this.emitQwikEvents(t)}emitQwikEvents(e){if(e.length>0){let t={},n=this.renderOptions.serverData?.nonce;n&&(t.nonce=n),this.openScript(t),this.write(`(window._qwikEv||(window._qwikEv=[])).push(`),this.writeArray(e,Ht),this.write(Vt),this.closeScript()}}emitVNodeSeparators(e,t){let n=t-e;for(;n!=0;)n>=8192?(this.write(z.ADVANCE_8192_CH),n-=8192):(n&4096&&this.write(z.ADVANCE_4096_CH),n&2048&&this.write(z.ADVANCE_2048_CH),n&1024&&this.write(z.ADVANCE_1024_CH),n&512&&this.write(z.ADVANCE_512_CH),n&256&&this.write(z.ADVANCE_256_CH),n&128&&this.write(z.ADVANCE_128_CH),n&64&&this.write(z.ADVANCE_64_CH),n&32&&this.write(z.ADVANCE_32_CH),n&16&&this.write(z.ADVANCE_16_CH),n&8&&this.write(z.ADVANCE_8_CH),n&4&&this.write(z.ADVANCE_4_CH),n&2&&this.write(z.ADVANCE_2_CH),n&1&&this.write(z.ADVANCE_1_CH),n=0);return t}createAndPushFrame(e,t,n){let r={tagNesting:10,parent:this.currentElementFrame,elementName:e,depthFirstElementIdx:t,vNodeData:[0],currentFile:null,refBase:null};this.currentElementFrame=r,this.vNodeDatas.push(r.vNodeData)}popFrame(){let e=this.currentElementFrame;return this.currentElementFrame=e.parent,e}write(e){this.size+=e.length,this.writer.write(e)}writeRootRef(e){this.size+=String(e).length,this.writer.writeRootRef(e)}writeRootRefPath(e){this.size+=String(e[0]).length,this.writer.writeRootRefPath(e);for(let t=1;t<e.length;t++)this.size+=1+String(e[t]).length}writeRootRefDelta(e,t){let n=e-t;this.size+=String(n).length,this.writer.writeRootRefDelta(e,t)}writeArray(e,t,n=0){for(let r=n;r<e.length;r++){let i=e[r];r>n&&this.write(t),this.write(i)}}writeAttrs(e,t,n,r,i,o){let s;for(let l in t){let u=t[l];if(Ln(l))continue;if(ft(l))u=k(this.serializationCtx,l,u,o);else if(l===`ref`){let e=this.getOrCreateLastNode();if(a(u)){u.Dt=new un(e);continue}if(typeof u==`function`){u(new un(e));continue}if(u==null)continue;throw R(15,[i])}else if(l===rt||l===it){let e=this.addRoot(u);if(e===void 0)continue;u=typeof e==`number`?[e]:String(e)}else if(a(u)){let e=this.getOrCreateLastNode(),t=new c({j:r,rt:n}),i=u;u=lt(()=>this.trackSignalValue(i,e,l,t))}if(J(u)){let e=this.getOrCreateLastNode();this.addPromiseAttribute(u),u.then(t=>{this.addBackpatchEntry(e.id,l,bt(l,t,r))});continue}if(l===ot){if(u&&=(s=String(u),l=G,`html`),e===`style`)continue}else pt(l)&&zn(this.serializationCtx,l);if(e===`textarea`&&l===`value`){if(u&&typeof u!=`string`)continue;s=V(u||``),l=G,u=`text`}let d=bt(l,u,r);if(d!=null&&d!==!1&&(this.write(It),this.write(l),d!==!0)){if(this.write(Lt),Array.isArray(d))this.writeEscapedChunks(d);else{let e=V(String(d));this.write(e)}this.write(Rt)}}return s}writeEscapedChunks(e){for(let t=0;t<e.length;t++){let n=e[t];typeof n==`string`?this.write(V(n)):typeof n==`number`?this.writeRootRef(n):`base`in n?this.writeRootRefDelta(n.id,n.base):this.writeRootRefPath(n.path)}}addPromiseAttribute(e){this.promiseAttributes||=[],this.promiseAttributes.push(e)}async resolvePromiseAttributes(){this.promiseAttributes&&=(await Promise.all(this.promiseAttributes),null)}},Pn=class extends Nn{constructor(e,t){super(e),this.Rn=t}Rn;dr=0;mr=null;P=null;subscriptionPatchRecords=[];pendingVNodeDataPatches=null;nextOutOfOrderId(e=!0){return this.Rn.nextOutOfOrderId(e)}A(e){(this.P||=[]).push(e)}emitErrorSwapExecutorIfNeeded(){this.Rn.emitErrorSwapExecutorIfNeeded()}Tn(e,t,n,r){Kt(this.Rn.serializationCtx,this.serializationCtx,this.Rn.yt,this.subscriptionPatchRecords,e,t,n,r)}async S(e,t){let n=this.Rn,r=n.v(),i=this.serializationCtx;try{let a=this.vr(n,i);this.Er(n,i);let o=this.Sr(n,r,i);if(r&&(a.newRootLocalIds.length>0||o!==void 0)&&(i.ke=n.serializationCtx.ue,await this.emitStatePatchData(e,a.newRootStart,a.newRootLocalIds,o),n.serializationCtx.Te=n.serializationCtx.de.length+ +!!n.serializationCtx.Pe,n.serializationCtx.ue+=i.ue),this.emitPendingVNodeDataPatches(),r){this.t=!0,this.emitVNodeData(e);let t=this.serializationCtx;this.serializationCtx=n.serializationCtx,this.emittedSyncFnCount=n.emittedSyncFnCount,this.emitSyncFnsData(!0),n.emittedSyncFnCount=this.emittedSyncFnCount,this.serializationCtx=t,this.emitNewQwikEvents()}this.emitPatchDataIfNeeded(),this.drainCleanupQueue();let s=a.rootIdMap;return r?this.dr=2:(this.mr=s,this.dr=1),{html:fn(t.htmlChunks,s),scripts:t.writer.toString(s)}}finally{this.dr!==1&&(i.Ne=void 0,n.removeOutOfOrderSegment(this)),n.serializationCtx.ce(n.writer)}}pr(){try{this.emitVNodeData(this.vnodeSegment),this.emitPendingVNodeDataPatches(),this.Rn.emitOutOfOrderSegmentScripts(this.writer.toString(this.mr)),this.dr=2,this.Rn.removeOutOfOrderSegment(this)}finally{this.serializationCtx.Ne=void 0}}markVNodeDataForSerialization(e,t=16){let n=e.vnodeData[0],r=n|t;r!==n&&(e.vnodeData[0]=r,this.queueLateVNodeDataPatch(e,r&~n))}queueLateVNodeDataPatch(e,t){if(!(t&24))return;let n=this.getVNodeDataOwnerFromNodeId(e.id);if(!this.hr().isVNodeDataOwnerEmitted(n.owner))return;let r=(this.pendingVNodeDataPatches||=new Map).get(n.owner);r||this.pendingVNodeDataPatches.set(n.owner,r=new Map),r.set(n.localIndex,e.vnodeData)}emitPendingVNodeDataPatches(){let e=this.pendingVNodeDataPatches;if(this.pendingVNodeDataPatches=null,e)for(let[t,n]of e){if(n.size===0)continue;let e=Array.from(n).sort((e,t)=>e[0]-t[0]);this.emitVNodeDataScript(t,e,!0)}}vr(e,t){let n=this.commitSegmentRoots(e,t);return t.Ne=(t,r,i)=>{this.commitSegmentRoot(e,t,r,i,n)},n}Sr(e,t,n){let r,i=t?this.collectSubscriptionPatches(e,e.rootContainerSerializedRootCount):void 0;return i&&(r=n.Rt(i)),r}commitSegmentRoots(e,t){let n={rootIdMap:[],newRootStart:e.v()?e.serializationCtx.Te:e.serializationCtx.de.length,newRootLocalIds:[]};this.promoteSharedSegmentRoots(e,t,n);let r=t.de,i=t.xe;for(let t=0;t<r.length;t++){let a=i[t];this.commitSegmentRoot(e,t,r[t],a,n)}return n}promoteSharedSegmentRoots(e,t,n){let r=t.de,i=t.xe;for(let t=0;t<i.length;t++){let a=i[t];this.isRootOrUsedByOtherLiveSegment(e,a)&&this.commitSegmentRoot(e,t,r[t],a,n)}}isRootOrUsedByOtherLiveSegment(e,t){if(e.serializationCtx.Xe(t)!==void 0)return!0;let n=e.outOfOrderSegments;for(let e=0;e<n.length;e++){let r=n[e];if(r!==this&&t===t&&r.serializationCtx.Xe(t)!==void 0)return!0}return!1}commitSegmentRoot(e,t,n,r,i){if(i.rootIdMap[t]!==void 0)return;let a=e.serializationCtx.Xe(r);a===void 0&&(a=e.serializationCtx.Fe(n,r),i.newRootLocalIds.push(t),this.seedCommittedRootForLiveSegments(e,r));let o=e.serializationCtx;i.rootIdMap[t]=e.v()&&a>=o.Re?a+ +!!o.Pe:a}seedCommittedRootForLiveSegments(e,t){let n=e.outOfOrderSegments;for(let e=0;e<n.length;e++){let r=n[e];r!==this&&r.dr===0&&r.serializationCtx.Rt(t)}}Er(e,t){for(let n of t.Lt)e.serializationCtx.Lt.add(n);for(let n of t.Ft)e.serializationCtx.Ft.add(n)}collectSubscriptionPatches(e,t){return qt(e.serializationCtx,this.subscriptionPatchRecords,t)}emitStatePatchData(e,t,n,r){let i=this.statePatchScriptAttrs(e);return this.openScript(i),this.serializationCtx.ce(this.writer),this.serializationCtx.we=this.markVNodeDataForSerialization.bind(this),Y(this.serializationCtx.je(t,n,r,0),()=>{this.closeScript()})}statePatchScriptAttrs(e){let t=this.stateScriptAttrs();return t[Ie]=!0,e&&(t[Le]=e),t}},Fn=(e,t)=>e===`style`&&t!=null?Object.prototype.hasOwnProperty.call(t,Re)||Object.prototype.hasOwnProperty.call(t,ze):!1;function In(e){return e&&typeof e==`object`&&typeof e.$n==`function`}function Ln(e){for(let t=0;t<e.length;t++){let n=e.charCodeAt(t);if(n===62||n===47||n===61||n===34||n===39||n===9||n===10||n===12||n===32)return!0}return!1}function Rn(){return(Math.random().toString(36)+`000000`).slice(2,8)}function zn(e,t){let n=`e`+t.substring(14);n&&e.Lt.add(n)}var Bn=class{constructor(e,t){this.opts=e,this.timing=t,this.inOrderStreaming=e.streaming?.inOrder??{strategy:`auto`,maximumInitialChunk:2e4,maximumChunk:1e4},this.nativeStream=e.stream,this.stream=this.setupStreamWriter()}opts;timing;bufferSize=0;buffer=``;firstWriteNotified=!1;onFirstWrite;networkFlushes=0;inOrderStreaming;streamBlockDepth=0;streamBlockBuffer=``;streamBlockBufferSize=0;nativeStream;firstFlushTimer=hn();pendingFlush;flushQueued=!1;stream;setupStreamWriter(){let e=this,t;switch(this.inOrderStreaming.strategy){case`disabled`:t=Mt(t=>{t!=null&&e.enqueue(t)});break;case`direct`:{let n=this.nativeStream;t=Mt(t=>{if(t!=null){if(e.notifyFirstWrite(),e.pendingFlush){let r=e.pendingFlush.then(()=>n.write(t));return e.trackPendingFlush(r)}return e.trackPendingFlush(n.write(t))}});break}default:case`auto`:{let n=this.inOrderStreaming.maximumChunk??0,r=this.inOrderStreaming.maximumInitialChunk??0;t=Mt(t=>{if(t!=null&&(e.enqueue(t),e.streamBlockDepth===0)){let t=e.networkFlushes===0?r:n;if(e.bufferSize>=t)return e.flush()}});break}}return t}enqueue(e){let t=e.length;this.streamBlockDepth>0?(this.streamBlockBuffer+=e,this.streamBlockBufferSize+=t):(this.bufferSize+=t,this.buffer+=e)}trackPendingFlush(e){if(!J(e))return;let t=Promise.resolve(e).finally(()=>{this.pendingFlush===t&&(this.pendingFlush=void 0)});return this.pendingFlush=t,t}notifyFirstWrite(){this.firstWriteNotified||(this.firstWriteNotified=!0,this.onFirstWrite?.())}flushBuffer(){this.notifyFirstWrite();let e=this.buffer;return this.buffer=``,this.bufferSize=0,this.networkFlushes++,this.networkFlushes===1&&(this.timing.firstFlush=this.firstFlushTimer()),this.trackPendingFlush(this.nativeStream.write(e))}flush(){if(!this.buffer)return this.waitForPendingFlush();if(this.pendingFlush){if(!this.flushQueued){this.flushQueued=!0;let e=this.pendingFlush.then(()=>(this.flushQueued=!1,this.pendingFlush=void 0,this.flush()));this.pendingFlush=e.finally(()=>{this.pendingFlush===e&&(this.pendingFlush=void 0)})}return this.pendingFlush}return this.flushBuffer()}waitForPendingFlush(){return this.pendingFlush}streamBlockStart(){this.streamBlockDepth++}streamBlockEnd(){if(this.streamBlockDepth--,this.streamBlockDepth===0&&this.streamBlockBuffer)return this.buffer+=this.streamBlockBuffer,this.bufferSize+=this.streamBlockBufferSize,this.streamBlockBuffer=``,this.streamBlockBufferSize=0,this.flush()}},Vn=async(e,t)=>{let n={firstFlush:0,render:0,snapshot:0},r=t.containerTagName??`html`,i=gn(t),a=Hn(t.manifest),o=typeof t.locale==`function`?t.locale(t):t.serverData?.locale||t.locale||t.containerAttributes?.locale||``,s=new Bn(t,n),c=An({tagName:r,locale:o,writer:s.stream,streamHandler:s,timing:n,buildBase:i,resolvedManifest:a,renderOptions:t}),l=t.onBeforeFirstFlush;return l&&(s.onFirstWrite=()=>l({errorBoundaryCaught:c.Nt===!0})),await Wt(t,a),await c.render(e),await c.l,await s.flush(),{flushes:s.networkFlushes,manifest:a?.manifest,size:c.size,isStatic:!1,timing:n,errorBoundaryCaught:c.Nt===!0}};function Hn(e){let t=E(),n=e?{...t,...e}:t;if(!n||`mapper`in n)return n;if(n.mapping){let e={};for(let t in n.mapping){let r=n.mapping[t];e[Gt(t)]=[t,r]}return{mapper:e,manifest:n,injections:n.injections||[]}}}var Un=`document["qFuncs_HASH"]=`;async function Wn(e){let t=Ut({manifest:e},Hn(e));_(t)}var Gn=e=>e.endsWith(`/`)?e:e+`/`,Kn=I(`s_4s4ZDCYhDOA`),qn;{let e=ne();e?qn=new e:console.warn(`
=====================
  Qwik Router Warning:
    AsyncLocalStorage is not available, continuing without it.
    This impacts concurrent async server calls, where they lose access to the ServerRequestEv object.
=====================

`)}var Jn=`qaction`,Yn=`qfunc`,Xn=`qdata`,Zn=`q:route`,Qn=C(`qr-s`),$n=C(`qr-lc`),er=C(`qr-c`),tr=C(`qr-ic`),nr=C(`qr-h`),rr=C(`qr-l`),ir=C(`qr-n`),ar=C(`qr-a`),or=C(`qr-p`),sr=C(`qr-hs`),cr=`@routeLoaderState`,lr=`@loaderPathsStore`,ur=`@routeLoaders`,dr=`@routeLoaderPromises`,fr=`@routeLoaderEvents`,pr=`@routeLoaderRootEvent`,mr=`__qwik_route_loader_value__`,hr=`X-Qwik-fullpath`,gr=e=>`${mr}${e}`,_r=e=>!!e&&typeof e==`object`&&Object.prototype.hasOwnProperty.call(e,`sharedMap`)&&Object.prototype.hasOwnProperty.call(e,`cookie`),vr=e=>typeof e==`function`&&e.__brand===`server_loader`,yr=(e,t)=>{let n=new URLSearchParams;for(let r=0;r<t.length;r++){let i=t[r],a=e.getAll(i);for(let e=0;e<a.length;e++)n.append(i,a[e])}return n.sort(),n.toString()?`?${n.toString()}`:``},br=e=>qn?.getStore()||[e,ce()].find(_r),xr=`@routeLoaderValues`;function Sr(e){let t=e.sharedMap.get(xr);return t||(t={},e.sharedMap.set(xr,t)),t}function Cr(e){let t=e.sharedMap.get(dr);return t||(t={},e.sharedMap.set(dr,t)),t}function wr(e){e.sharedMap.delete(cr),e.sharedMap.delete(xr),e.sharedMap.delete(dr),e.sharedMap.delete(fr),e.sharedMap.delete(pr),e.sharedMap.delete(ur)}function Tr(e,t){e.sharedMap.set(ur,t)}function Er(e){let t=e.sharedMap.get(lr);return t||(t={loaderPaths:{}},e.sharedMap.set(lr,t)),t}var Dr=(e,t,n)=>{if(t)for(let n in t)e.loaderPaths[n]=t[n]},Or=e=>{let t=[],n=new Map;for(let r=0;r<e.length;r++){let i=e[r];if(i)for(let e in i){let r=i[e];if(vr(r)){if(n.get(r.__id))continue;n.set(r.__id,r),t.push(r)}}}return t},kr=new Set,Ar=e=>kr.has(e),jr=(e,t)=>{ue(e,t)},Mr=(e,t)=>typeof t==`string`&&(e.__id===t||!1),Nr=(e,t)=>e.find(e=>Mr(e,t)),Pr=(e,t)=>{let n=t.sharedMap.get(pr);n||(n=t,t.sharedMap.set(pr,n));let r=new URL(n.url),i=Er(n).loaderPaths[e.__id]||n.url.pathname,a=e.__search?yr(r.searchParams,e.__search):n.url.search;if(i===n.url.pathname&&a===n.url.search)return n;let o=n.sharedMap.get(fr);o||(o=new Map,n.sharedMap.set(fr,o));let s=`${i}\n${a}`,c=o.get(s);if(!c){r.pathname=i,r.search=a;let e=new Request(r,n.request);c=Object.create(n,{originalUrl:{value:new URL(r),enumerable:!0},params:{value:n.params,enumerable:!0},pathname:{get:()=>r.pathname,enumerable:!0},query:{get:()=>r.searchParams,enumerable:!0},request:{value:e,enumerable:!0},url:{value:r,enumerable:!0}}),o.set(s,c)}return c},Fr=e=>{let t=200,n=new Headers;return Object.create(e,{headers:{value:n,enumerable:!0},status:{value:e=>(typeof e==`number`&&(t=e),t),enumerable:!0},error:{value:(e,n)=>(t=e,new _e(e,n)),enumerable:!0},redirect:{value:(e,r)=>(t=e,r&&n.set(`Location`,r),new ge),enumerable:!0},fail:{value:(e,n)=>(t=e,{failed:!0,...n}),enumerable:!0},cacheControl:{value:()=>{},enumerable:!0}})};async function Ir(e,t,n){let r={success:!0,data:n};if(t)for(let i=0;i<t.length;i++){if(r=await t[i].validate(e,n),!r.success)return r;n=r.data}return r}var Lr=async(e,t,n)=>{let r=n,i=await Ir(n,t,void 0);if(!i.success)return r.fail(i.status??500,i.error);let a=await e.call(r,r),o=typeof a==`function`?a():a;return ve(o),o},Rr=(e,t,n,r)=>{let i=Sr(r);if(e in i)return Promise.resolve(i[e]);let a=Cr(r),o=a[e];return o||(o=Lr(t,n,r).then(t=>(i[e]=t,t),t=>{throw delete a[e],t}),a[e]=o),o},zr=class{hash;qrl;validators;blockSSR;constructor(e,t,n,r){this.hash=e,this.qrl=t,this.validators=n,this.blockSSR=r}load(){let e=br();if(!e)throw Error(`Unable to determine the current RequestEvent.`);let t=Sr(e);if(this.hash in t)return t[this.hash];let n=this.blockSSR?e:Fr(e);return Rr(this.hash,this.qrl,this.validators,n)}[re](){return this.hash}};Kn.s(async e=>{let t=r[0],n=r[1],i=r[2];r[3];let a=r[4];r[5],r[6];let o=!!e.info&&typeof e.info==`object`&&`__v`in e.info;if(e.track(a.loaderPaths,n),e.track(a,`pagePathname`),e.track(a,`pageSearch`),o){let t=e.info.__v;return i.raw=void 0,t}return t.load()});var Br=(e,t,r)=>{let i=e.__id,a=r,o=gr(i),s=new zr(i,e.__qrl,e.__validators,e.__blockSSR),c=e.__search,l=n(Kn.w([s,i,{},o,t,c,a]),{serializationStrategy:e.__serializationStrategy});return fe(l),l},Vr=(e,t,n)=>(e.__cacheControl===`immutable`&&kr.add(e.__id),e.__serializationStrategy===`never`&&(t[gr(e.__id)]=i),t[e.__id]||=Br(e,n,t)),Hr=(e,t,n)=>{let r=Or(e);for(let e=0;e<r.length;e++)Vr(r[e],t,n);return r},Ur=(e,t)=>{let n=Pr(e,t);return Rr(e.__id,e.__qrl,e.__validators,e.__blockSSR?n:Fr(n))},Wr=async(e,t,n)=>{try{return{d:await Lr(e,t,n)}}catch(e){if(e instanceof ge){let e=n.headers.get(`Location`)||`/`;return n.headers.delete(`Location`),{r:e}}if(e instanceof _e)return{e};throw e}},Gr=e=>e==null?e:(Object.getOwnPropertyNames(e).forEach(t=>{let n=e[t];if(n&&typeof n==`object`&&!Object.isFrozen(n))try{Gr(n)}catch{return e}}),Object.freeze(e)),Kr=new WeakMap,qr=()=>import(`./q-ezOkRpEa.js`);function Jr(e,t){let n=e,r=[];n._L&&r.push(n._L);for(let e=0;e<t.length;e++){let i=t[e],a=n[i];if(!a&&n._M)for(let e=0;e<n._M.length;e++){let t=n._M[e];if(a=t[i],a){t._L&&r.push(t._L);break}}if(!a)return;n=a,n._L&&r.push(n._L)}return{node:n,layouts:r}}var Yr=e=>e.v?Array.isArray(e.v)?e.v:[...e.layouts,e.v]:void 0;function X(e,t,n,r,i,a,o,s,c=`/`){for(let e=0;e<t.length;e++){let l=t[e];if(l._L&&n.push(l._L),l._R&&o&&(o.push(...l._R),s))for(let e=0;e<l._R.length;e++){let t=l._R[e];s[t]=c}l._E&&(r.v=l._E,r.layouts=[...n]),l._4&&(i.v=l._4,i.layouts=[...n]),l._N&&(a.v=l._N)}if(e._L&&n.push(e._L),e._R&&o&&(o.push(...e._R),s))for(let t=0;t<e._R.length;t++){let n=e._R[t];s[n]=c}e._E&&(r.v=e._E,r.layouts=[...n]),e._4&&(i.v=e._4,i.layouts=[...n]),e._N&&(a.v=e._N)}function Xr(e,t,n,r,i){let a=e._W;if(a){let e=a._0,r=a._9;if(e||r){let i=e||``,o=r||``;if(n.length>i.length+o.length&&(!i||n.startsWith(i.toLowerCase()))&&(!o||n.endsWith(o.toLowerCase()))){let e=a._P,n=t.slice(i.length,o?t.length-o.length:void 0);return{next:a,routePart:`${i}[${e}]${o}`,done:!1,kind:1,paramName:e,paramValue:n}}}else{let e=a._P;return{next:a,routePart:`[${e}]`,done:!1,kind:1,paramName:e,paramValue:t}}}if(a=e._A,a){let e=a._P,t=r.slice(i).join(`/`);return{next:a,routePart:`[...${e}]`,done:!0,kind:2,paramName:e,paramValue:t}}}function Zr(e,t,n,r,i){let a=e[n];if(a)return{next:a,groups:[],routePart:t,done:!1,kind:0};if(e._M)for(let a=0;a<e._M.length;a++){let o=e._M[a],s=Zr(o,t,n,r,i);if(s)return s.groups.unshift(o),s}let o=Xr(e,t,n,r,i);if(o)return{...o,groups:[]}}function Qr(e,t){let n=t(e);if(n!==void 0)return{value:n,node:e,groups:[]};if(e._M)for(let n=0;n<e._M.length;n++){let r=e._M[n],i=Qr(r,t);if(i)return i.groups.unshift(r),i}}function $r(e){let t=Qr(e,e=>e._I||e._G!=null?e:void 0);return t?{target:t.node,groups:t.groups.filter(e=>e!==t.node)}:void 0}function ei(e,t,n){if(t._G!=null){let n=Jr(e,t._G.split(`/`).filter(e=>e.length>0));if(!n)return;let r=n.node,i=n.layouts;if(!r._I&&r._G==null){let e=$r(r);if(e){for(let t=0;t<e.groups.length;t++){let n=e.groups[t];n._L&&i.push(n._L)}r=e.target,r._L&&i.push(r._L)}}return ei(e,r,i)}let r=t._I;if(r)return Array.isArray(r)?r:[...n,r]}function ti(e){let t=Qr(e,e=>e._A);return t?{next:t.value,groups:t.groups}:void 0}function ni(e,t,n){let r=Qr(e,e=>e[n]);if(!r)return;let i=[...t];for(let e of r.groups)e._L&&i.push(e._L);return{v:r.value,layouts:i}}function ri(e={},t){let n=e,r={},i=[],a=[],o=[],s={},c={v:void 0,layouts:[]},l={v:void 0,layouts:[]},u={v:void 0},d=[];X(e,[],a,c,l,u,o,s),e._M&&d.push({node:e,depth:a.length});let f=!1,p=!0,m=t.split(`/`).filter(e=>e.length>0).map(decodeURIComponent),h,g=0,_=m.length;for(;!f&&g<_;g++){let e=m[g],t=e.toLowerCase(),v=Zr(n,e,t,m,g);if(!v){p=!1;break}let y=v.kind===1?ti(n):void 0;y&&(h={aNode:y.next,groups:y.groups,paramName:y.next._P,restValue:m.slice(g).join(`/`),routeParts:[...i],params:{...r},layouts:[...a],loaderPathsByHash:{...s},errorLoader:c.v,errorLayouts:c.layouts,notFoundLoader:l.v,notFoundLayouts:l.layouts,menuLoader:u.v}),v.paramName&&(r[v.paramName]=v.paramValue),i.push(v.routePart),f=v.done,n=v.next;let b=`/${m.slice(0,v.done?_:g+1).join(`/`)}/`;X(n,v.groups,a,c,l,u,o,s,b),n._M&&d.push({node:n,depth:a.length})}if(p&&!f&&g===_){if(!n._I&&n._G==null){let e=$r(n);e&&(X(e.target,e.groups,a,c,l,u,o,s,t),n=e.target)}if(!n._I&&n._G==null){let e=ti(n);if(e){let d=e.next,f=d._P;r[f]=``,i.push(`[...${f}]`),X(d,e.groups,a,c,l,u,o,s,t),n=d}}}let v=p&&(f||g>=_)?ei(e,n,a):void 0;if(!v&&h){let n=h,r={...n.params,[n.paramName]:n.restValue},i=[...n.routeParts,`[...${n.paramName}]`],a=[...n.layouts],o={...n.loaderPathsByHash},s={v:n.errorLoader,layouts:n.errorLayouts},d={v:n.notFoundLoader,layouts:n.notFoundLayouts},f={v:n.menuLoader},p=[];X(n.aNode,n.groups,a,s,d,f,p,o,t);let m=ei(e,n.aNode,a);if(m)return{loaders:m,params:r,routeParts:i,notFound:!1,routeBundleNames:n.aNode._B,loaderHashes:p.length>0?p:void 0,loaderPathsByHash:Object.keys(o).length>0?o:void 0,menuLoader:f.v,errorLoader:Yr(s)};c.v=s.v,c.layouts=s.layouts,l.v=d.v,l.layouts=d.layouts,u.v=f.v}if(!v){let e=e=>{for(let t=d.length-1;t>=0;t--){let n=ni(d[t].node,a.slice(0,d[t].depth),e);if(n)return n}};if(!l.v){let t=e(`_4`);t&&(l.v=t.v,l.layouts=t.layouts)}if(!c.v){let t=e(`_E`);t&&(c.v=t.v,c.layouts=t.layouts)}let t=l.v?l:c.v?c:null,n=t?.v??qr,o=t?t.layouts:a;return{loaders:Array.isArray(n)?n:[...o,n],params:r,routeParts:i,notFound:!0,routeBundleNames:void 0,loaderHashes:void 0,loaderPathsByHash:void 0,menuLoader:u.v,errorLoader:Yr(c)}}if(n._R){o.push(...n._R);let e=Gn(t);for(let t=0;t<n._R.length;t++){let r=n._R[t];s[r]=e}}return{loaders:v,params:r,routeParts:i,notFound:!1,routeBundleNames:n._B,loaderHashes:o.length>0?o:void 0,loaderPathsByHash:Object.keys(s).length>0?s:void 0,menuLoader:u.v,errorLoader:Yr(c)}}var ii=(e,t,n,r)=>{if(typeof e==`function`){let i=Kr.get(e);if(i)n(i);else{let i=e();typeof i.then==`function`?t.push(i.then(t=>{r!==!1&&Kr.set(e,t),n(t)})):i&&n(i)}}},ai=async(e,t,n)=>{let{loaders:r,params:i,routeParts:a,notFound:o,routeBundleNames:s,loaderHashes:c,loaderPathsByHash:l,menuLoader:u,errorLoader:d}=ri(e,n),f=`/`+a.join(`/`),p=Array(r.length),m=[];for(let e=0;e<r.length;e++){let n=r[e];ii(n,m,t=>p[e]=t,t)}let h;return ii(u,m,e=>h=e?.default,t),m.length>0&&await Promise.all(m),{$routeName$:f,$params$:i,$mods$:p,$menu$:Gr(h),$routeBundleNames$:s,$notFound$:o,$errorLoader$:d,$loaders$:c,$loaderPaths$:l}},oi=e=>e.pathname+e.search+e.hash,Z=(e,t)=>new URL(e,t.href),si=(e,t)=>e.origin===t.origin,ci=({pathname:e},{pathname:t})=>{let n=Math.abs(e.length-t.length);return n===0?e===t:n===1&&Gn(e)===Gn(t)},li=(e,t)=>e.search===t.search,Q=(e,t)=>li(e,t)&&ci(e,t),ui=(e,t)=>{let n=e.href;if(typeof n==`string`&&typeof e.target!=`string`&&!e.reload)try{let e=Z(n.trim(),t.url);if(si(e,Z(``,t.url)))return oi(e)}catch(e){console.error(e)}else if(e.reload)return oi(Z(``,t.url));return null},di=(e,t)=>e?!ci(Z(e,t.url),Z(``,t.url)):!1,fi=e=>e&&typeof e.then==`function`,pi=(e,t)=>{if(Array.isArray(t))for(let n of t){if(typeof n.key==`string`){let t=e.findIndex(e=>e.key===n.key);if(t>-1){e[t]=n;continue}}e.push(n)}},mi=(e,t)=>{typeof t.title==`string`&&(e.title=t.title),pi(e.meta,t.meta),pi(e.links,t.links),pi(e.styles,t.styles),pi(e.scripts,t.scripts),Object.assign(e.frontmatter,t.frontmatter)},hi=(e,t)=>({title:e?.title||``,meta:[...e?.meta||[]],links:[...e?.links||[]],styles:[...e?.styles||[]],scripts:[...e?.scripts||[]],frontmatter:{...e?.frontmatter},manifestHash:t||`dev`}),gi=(e,t,n,r,i,a)=>ie(r,()=>{let r=hi(a),o,s,c=[];for(let e=0;e<n.length;e++){let t=n[e];if(!t)continue;let i=e===n.length-1,a;if(t.routeConfig)a=t.routeConfig;else if(t.head){let e={head:void 0},n=t.head;if(typeof n==`function`){let e=t;a=t=>({head:n(t),eTag:e.eTag,cacheKey:e.cacheKey})}else{e.head=n;let r=t;r.eTag!==void 0&&(e.eTag=r.eTag),r.cacheKey!==void 0&&(e.cacheKey=r.cacheKey),a=e}}else{let e=t;(e.eTag!==void 0||e.cacheKey!==void 0)&&(a={eTag:e.eTag,cacheKey:e.cacheKey})}a&&(typeof a==`function`?c.unshift({fn:a,isLast:i}):(a.head&&mi(r,a.head),a.eTag!==void 0&&(o=a.eTag),a.cacheKey!==void 0&&(s=a.cacheKey)))}if(c.length){let n={head:r,status:i,withLocale:e=>e(),resolveValue:e,...t};for(let{fn:e}of c){let t=e(n);t.head&&mi(r,t.head),t.eTag!==void 0&&(o=t.eTag),t.cacheKey!==void 0&&(s=t.cacheKey)}}return{head:r,eTag:o,cacheKey:s}}),_i=(e,t,n,r,i,a)=>gi(n=>{let r=n.__id,i=t?.[r];if(i)return i.value;if(e?.action===r)return e.actionResult},n,r,i,e?.status??200,a).head,vi=I(`s_1sKEZ9Pg1ow`),yi=I(`s_2U5Z2Z8ryc0`),bi=I(`s_69B0DK0eZJc`),xi=I(`s_6Kjfa79mqlY`),Si=I(`s_6i0Jq5q8JFg`),Ci=I(`s_8j8Vrz2yUIM`),wi=I(`s_9CrWYOoCpgY`),Ti=I(`s_AAemwtuBjsE`),Ei=I(`s_BsYUaz9XhUs`),Di=I(`s_IN4dVpT0x74`),Oi=I(`s_JL6bChMwwyc`),ki=I(`s_QwONcWD5gIg`),Ai=I(`s_UwVx4NhHkSo`),ji=I(`s_VPmar9tb3t4`),Mi=I(`s_XpalYii770E`),Ni=I(`s_YuS5bpdQ360`),Pi=I(`s_aRL6GvFyews`),Fi=I(`s_aViHFxQ1a3s`),Ii=I(`s_cuYklZAOHrA`),Li=I(`s_h3qenoGeI6M`),Ri=I(`s_hoZr9O26Irg`),zi=I(`s_igI1pUsax0E`),Bi=I(`s_lcd4O9LHbbA`),Vi=I(`s_r3dkP9d2cF8`),Hi=I(`s_tXTLR4tzCy0`),Ui=I(`s_w03grD0Ag68`),Wi=I(`s_yw17chooOac`),Gi=I(`s_z274ws00irY`);async function Ki(e,t,n=.8,r,i=!0){}var qi=()=>D(sr).value,Ji=()=>D(nr),Yi=()=>D(rr),Xi=()=>D(ir);Ei.s(()=>{let e=r[0],t=r[1];return t(e)}),e(e=>{let n=D(or);t(Ei.w([e,n]))});var Zi=()=>pe(m(`qwikrouter`));Bi.s((e,t)=>{let n=r[0];navigator.connection?.saveData||t&&t.href&&Ki(new URL(t.href),!0,.8,n.manifestHash,!1)}),Ai.s(async(e,t)=>{let n=r[0];n?.(null,t)}),Gi.s((e,t)=>{let n=r[0];e.key===`Enter`&&n(null,t)}),Li.s((e,t)=>{let n=r[0],i=r[1],a=r[2],o=r[3];e.defaultPrevented&&t.href&&(t.setAttribute(`aria-pressed`,`true`),n(t.href,{forceReload:i,replaceState:a,scroll:o}).then(()=>{t.removeAttribute(`aria-pressed`)}))}),Ti.s((e,t)=>{Ki(new URL(t.href),!1,1)}),ji.s(e=>{let t=Xi(),n=Yi(),r=Ji(),i=e.href,{onClick$:a,prefetch:s,reload:c,replaceState:d,scroll:f,prefetchBundles:p=`visible`,prefetchData:m=s===`js`?`off`:`intent`,...h}=e,g=o(ui,{...h,reload:c},n);h.href=g||i;let _=s===!1,v=o(di,g,n),y=!!g&&v&&!_&&(p===`visible`||s===`js`||s===!0),b=!!g&&v&&!_&&(m===`visible`||s===!0),x=g&&m!==`off`&&v&&!_?Bi.w([r]):null,S=g?oe(e=>{e.metaKey||e.ctrlKey||e.shiftKey||e.altKey||e.preventDefault()},`event=>{if(!(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)){event.preventDefault();}}`):null,C=Ai.w([x]),w=Gi.w([C]),T=g?Li.w([t,c,d,f]):null,E=Ti;return l(`a`,{"q:link":!!g,...F(h),...P(h),"data-q-prefetch":y&&b?`bd`:y?`b`:b?`d`:null,"q-e:click":[S,E,a,T],"q-e:pointerenter":[h.onMouseOver$,m===`intent`?C:null],"q-e:focus":[h.onFocus$,m===`intent`?C:null],"q-e:pointerdown":[h.onPointerDown$,m===`commit`?C:null],"q-e:keydown":[h.onKeyDown$,m===`commit`?w:null]},null,u(O,null,null,null,3,`jO_0`),0,`jO_1`)});var Qi=ae(ji),$i=new WeakSet,ea,ta=()=>{$i=new WeakSet},na=e=>{let t=document.querySelectorAll(`a[q\\:link][data-q-prefetch]`),n=(t,n)=>{if($i.has(t)||($i.add(t),n?.unobserve(t),navigator.connection?.saveData||!t.href))return;let r;try{r=new URL(t.href)}catch{return}let i=new URL(location.href);if(!si(r,i)||!di(oi(r),{url:i}))return;let a=t.getAttribute(`data-q-prefetch`)||``;a.includes(`b`)&&r.pathname,a.includes(`d`)&&Ki(r,!0,.8,e,!1)};if(typeof IntersectionObserver>`u`)return t.forEach(e=>n(e)),()=>{};let r=new IntersectionObserver(e=>{for(let t of e)t.isIntersecting&&n(t.target,r)});return t.forEach(e=>r.observe(e)),()=>{r.disconnect()}},ra=e=>{ta(),ea?.(),ea=na(e)};Ri.s((e,t)=>{ra(t.closest(`[q\\:manifest-hash]`)?.getAttribute(`q:manifest-hash`)||void 0)});var ia=M(Ri),aa=`qrouterpopstate`,oa=e=>{let t=e;return e=>t!==e&&(t=e,!0)},sa=(e,t)=>{e.dispatchEvent(new CustomEvent(aa,{detail:{href:t}}))};zi.s((e,t)=>{if(!window._qRouterSPA&&!window._qRouterInitPopstate){let e=oa(location.pathname+location.search),t=e=>{e&&window.scrollTo(e.x,e.y)},n=()=>{let e=document.documentElement;return{x:e.scrollLeft,y:e.scrollTop,w:Math.max(e.scrollWidth,e.clientWidth),h:Math.max(e.scrollHeight,e.clientHeight)}},r=e=>{let t=history.state||{};t._qRouterScroll=e||n(),history.replaceState(t,``)};if(r(),window._qRouterInitPopstate=()=>{if(!window._qRouterSPA){if(window._qRouterScrollEnabled=!1,clearTimeout(window._qRouterScrollDebounce),e(location.pathname+location.search))sa(document,location.href);else if(history.scrollRestoration===`manual`){let e=history.state?._qRouterScroll;t(e),window._qRouterScrollEnabled=!0}}},!window._qRouterHistoryPatch){window._qRouterHistoryPatch=!0;let e=history.pushState,t=history.replaceState,r=e=>(e==null?e={}:e?.constructor!==Object&&(e={_data:e}),e._qRouterScroll=e._qRouterScroll||n(),e);history.pushState=(t,n,i)=>(t=r(t),e.call(history,t,n,i)),history.replaceState=(e,n,i)=>(e=r(e),t.call(history,e,n,i))}window._qRouterInitAnchors=e=>{if(window._qRouterSPA||e.defaultPrevented)return;let t=e.target.closest(`a[href]`);if(t&&!t.hasAttribute(`preventdefault:click`)){let i=t.getAttribute(`href`),a=new URL(location.href),o=new URL(i,a),s=o.origin===a.origin,c=o.pathname+o.search===a.pathname+a.search;if(s&&c){if(e.preventDefault(),o.href!==a.href&&history.pushState(null,``,o),!o.hash)o.href.endsWith(`#`)?window.scrollTo(0,0):(window._qRouterScrollEnabled=!1,clearTimeout(window._qRouterScrollDebounce),r({...n(),x:0,y:0}),location.reload());else{let e=o.hash.slice(1),t=document.getElementById(e);t&&t.scrollIntoView()}}}},window._qRouterInitVisibility=()=>{!window._qRouterSPA&&window._qRouterScrollEnabled&&document.visibilityState===`hidden`&&r()},window._qRouterInitScroll=()=>{!window._qRouterSPA&&window._qRouterScrollEnabled&&(clearTimeout(window._qRouterScrollDebounce),window._qRouterScrollDebounce=setTimeout(()=>{r(),window._qRouterScrollDebounce=void 0},200))},window._qRouterScrollEnabled=!0,window.addEventListener(`popstate`,window._qRouterInitPopstate),window.addEventListener(`scroll`,window._qRouterInitScroll,{passive:!0}),document.addEventListener(`click`,window._qRouterInitAnchors),window.navigation||document.addEventListener(`visibilitychange`,window._qRouterInitVisibility,{passive:!0})}});var ca=M(zi),la={},$={navCount:0};Oi.s(()=>r[0]),Fi.s(async()=>{console.warn(`QwikRouterMockProvider: goto not provided`)}),Hi.s(async({track:e})=>{let t=r[0],n=r[1],i=e(t);if(!i?.resolve)return;let a=n?.[i.id];if(a){let e=await a(i.data);i.resolve(e)}});var ua=e=>{let t=e.url??`http://localhost/`,r=new URL(t),i=A({url:r,params:e.params??{},isNavigating:!1,prevUrl:void 0},{deep:!1}),a=e.loaders?.reduce((e,{loader:t,data:n})=>(e[t.__id]=n,e),{}),o=A({},{deep:!1});for(let[e,t]of Object.entries(a??{}))o[e]||=n(Oi.w([t]));let s=e.goto??Fi,c=A(hi,{deep:!1}),l=A({headings:void 0,menu:void 0},{deep:!1}),u=b(),d=b(),f=b({status:200,message:``});w(er,l),w(tr,u),w(nr,c),w(sr,f),w(rr,i),w(ir,s),w(Qn,o),w(ar,d);let p=e.actions?.reduce((e,{action:t,handler:n})=>(e[t.__id]=n,e),{});se(Hi.w([d,p]))};Di.s(e=>(ua(e),u(O,null,null,null,3,`5y_1`))),bi.s(e=>{}),Ci.s(async(e,t)=>{let n=r[0];r[1];let i=r[2],a=r[3],o=r[4],{type:s=`link`,forceReload:c=e===void 0,replaceState:l=!1,scroll:u=!0}=typeof t==`object`?t:{forceReload:t},d=a.value.dest,f=e===void 0?d:typeof e==`number`?e:Z(e,o.url);if(i.p&&!c&&typeof f!=`number`&&Q(f,d)&&f.href===d.href)return i.p;let p=++$.navCount;if($.currentTransition?.skipTransition(),la.$cbs$&&(c||typeof f==`number`||!Q(f,d)||!si(f,d))){let e=await Promise.all([...la.$cbs$.values()].map(e=>e(f)));if(p!==$.navCount||e.some(Boolean)){p===$.navCount&&s===`popstate`&&history.pushState(null,``,d);return}}if(typeof f!=`number`&&si(f,d)){if(!c&&Q(f,d)){if(f.href!==o.url.href){let e=new URL(f.href);a.value.dest=e,o.url=e}return}return o.isNavigating=!0,n.value=void 0,a.value={type:s,dest:f,forceReload:c,replaceState:l,scroll:u,historyUpdated:!1},i.p=new Promise(e=>{i.r=()=>{i.r=void 0,i.p=void 0,e()}}),i.p}}),Mi.s(async({track:e})=>{let t=r[0],n=r[1],i=r[2],a=r[3],o=r[4];r[5];let s=r[6],c=r[7],l=r[8],u=r[9],d=r[10],f=r[11],p=r[12],m=e(u),h=e(n),g=f.url,_=h?`form`:m.type,v=m.replaceState,y=$.navCount,b,x,S,C;b=new URL(m.dest,f.url),C=o.loadedRoute,x=o.response,S=x;let{$routeName$:w,$params$:T,$mods$:E,$menu$:D,$notFound$:O}=C,k=E;Dr(d,C.$loaderPaths$,b);let A=Hr(k,c,d);if(A.length>0)for(let e=0;e<A.length;e++){let t=A[e];Ar(t.__id)||c[t.__id].untrackedPending}if($.navCount!==y)return;s.value=O?{status:404,message:`Not Found`}:x?{status:x.status,message:x.statusMessage??`OK`}:S?{status:S.status,message:`OK`}:{status:200,message:`OK`};let te=k[k.length-1];m.dest.search&&Q(b,g)&&(b.search=m.dest.search);let j=!1,M=!1,ne=!1;Q(b,g)||(ee(f,`prevUrl`)&&(j=!0),p.prevUrl=g),p.url!==b&&(ee(f,`url`)&&(M=!0),p.url=b),p.params!==T&&(ee(f,`params`)&&(ne=!0),p.params=T);let N={type:_,dest:b};m.forceReload!==void 0&&(N.forceReload=m.forceReload),m.replaceState!==void 0&&(N.replaceState=m.replaceState),m.scroll!==void 0&&(N.scroll=m.scroll),m.historyUpdated!==void 0&&(N.historyUpdated=m.historyUpdated),u.untrackedValue=N,i.headings=te.headings,i.menu=D,a.untrackedValue=pe(k),t.value=S,l.value=pe({routeName:w,navType:_,prevUrl:g,replaceState:v,shouldForcePrevUrl:j,shouldForceUrl:M,shouldForceParams:ne,navCount:y})}),vi.s(({track:e})=>{let t=r[0],n=r[1],i=r[2],a=r[3],o=r[4],s=r[5],c=e(n);if(!c)return;let l=e(t),u;try{u=e(()=>_i(l,a,o,c,me(``),s))}catch(e){throw e}i.links=u.links,i.meta=u.meta,i.styles=u.styles,i.scripts=u.scripts,i.title=u.title,i.frontmatter=u.frontmatter}),Wi.s(({track:e})=>{r[0],r[1],r[2];let t=r[3];r[4],r[5],r[6],r[7],e(t)});var da=e=>{let t=Zi();if(!t?.params)throw Error(`Missing Qwik Router Env Data for help visit https://github.com/QwikDev/qwik/issues/6237`);let n=m(`url`);if(!n)throw Error(`Missing Qwik URL Env Data`);let r=m(`documentHead`),i=m(`containerAttributes`)?.[`q:manifest-hash`],a=new URL(n),o={url:a,params:t.params,isNavigating:!1,prevUrl:void 0},s=A(o,{deep:!1}),c={},l=A(t.routeLoaderCtx);l.manifestHash=i;let u={},d=t.loadedRoute.$mods$,f=Hr(d,u,l);for(let e of f)if(e.__id in t.loaderValues){let n=t.loaderValues[e.__id];jr(u[e.__id],n)}let p=b({type:`initial`,dest:a}),h=A(()=>hi(r,i)),g=A({headings:void 0,menu:void 0}),_=b(),v=b(),y=b({status:t.response.status,message:t.loadedRoute.$notFound$?`Not Found`:t.response.statusMessage??``}),x=t.response.action,S=x?t.response.actionResult:void 0,C=b(S?{id:x,data:t.response.formData,output:{result:S,status:t.response.status}}:void 0),T=b(x?{action:x,actionResult:S,status:t.response.status}:void 0),E=bi,D=Ci.w([C,i,c,p,s]);w(er,g),w(tr,_),w(nr,h),w(sr,y),w(rr,s),w(ir,D),w(Qn,u),w($n,l),w(ar,C),w(or,E),se(Mi.w([T,C,g,_,t,D,y,u,v,p,l,s,o]),{deferUpdates:!0}),se(vi.w([T,_,h,u,s,r]),{deferUpdates:!0}),se(Wi.w([_,D,i,v,c,e,p,s]),{deferUpdates:!1})};xi.s(e=>(da(e),u(O,null,null,null,3,`5y_0`)));var fa=ae(xi),pa=(e,t)=>{let n=t.detail?.href;if(n)return e(n,{type:`popstate`})};Pi.s((e,t,n)=>pa(n,e)),ki.s(()=>{if(!m(`containerAttributes`))throw Error(`PrefetchServiceWorker component must be rendered on the server.`);let e=D(tr),t=Xi(),n=e.value;if(n&&n.length>0){let e=n.length,r=null;for(let t=e-1;t>=0;t--)n[t].default&&(r=u(n[t].default,null,null,r,1,`Fn_0`));return u(h,null,null,[r,u(`script`,{"q-d:qinit":oe(()=>{((e,t)=>{if(!e._qcs){e._qcs=!0;let n=t.state?._qRouterScroll;n&&(t.scrollRestoration=`manual`,e.scrollTo(n.x,n.y)),document.dispatchEvent(new Event(`qcinit`))}})(window,history)},`()=>{((w,h)=>{if(!w._qcs){w._qcs=!0;const s=h.state?._qRouterScroll;if(s){h.scrollRestoration="manual";w.scrollTo(s.x,s.y);}document.dispatchEvent(new Event("qcinit"));}})(window,history);}`),"q-d:qrouterpopstate":Pi.m(),"q:p":t},{"q-d:qcinit":[ca,ia]},null,6,`Fn_1`)],1,`Fn_2`)}return le});var ma=ae(ki);Ni.s((e={})=>{throw r[0],r[1],r[2],r[3],Error(`Actions can not be invoked within the server during SSR.
Action.run() can only be called on the browser, for example when a user clicks a button, or submits a form.`)});var ha=d(async function(...e){r[0],r[1],r[2],r[3];let t=r[4];return e.length>0&&e[0]instanceof AbortSignal&&e.shift(),t.apply(br(this),e)},`w03grD0Ag68`);Ui.s(ha);var ga=e=>!e.reloadDocument,_a=`!p0.reloadDocument`,va=e=>e.spaReset?`true`:void 0,ya=`p0.spaReset?"true":undefined`;Vi.s(async(e,t)=>{let n=r[0],i=new FormData(t),a=new URLSearchParams;i.forEach((e,t)=>{typeof e==`string`&&a.append(t,e)}),await n(`?`+a.toString(),{type:`form`,forceReload:!0})}),Ii.s((e,t)=>{t.getAttribute(`data-spa-reset`)===`true`&&t.reset(),t.dispatchEvent(new CustomEvent(`submitcompleted`,{bubbles:!1,cancelable:!1,composed:!1,detail:{status:200}}))}),yi.s(e=>{let t=f(e,[`action`,`spaReset`,`reloadDocument`,`onSubmit$`]),n=Xi();return l(`form`,{action:`get`,"preventdefault:submit":j(ga,[e],_a),"data-spa-reset":j(va,[e],ya),...F(t),...P(t),"q-e:submit":[...Array.isArray(e.onSubmit$)?e.onSubmit$:[e.onSubmit$],Vi.w([n]),Ii]},null,u(O,null,null,null,3,`Q4_0`),0,`Q4_1`)}),Si.s(e=>{let t=r[0];if(!t.submitted)return t.submit(e)});var ba=e=>t=>{let{jsx:n,options:r}=e(t);return Vn(n,t.serverData.renderMode===`static`?{...r,streaming:{...r.streaming,outOfOrder:!1}}:r)};wi.s(e=>{let t=Ji();return e&&(t={...t,...e}),u(h,null,null,[t.title&&u(`title`,null,null,t.title,1,`r5_0`),t.meta.map(e=>l(`meta`,{...F(e)},P(e),null,0,`r5_1`)),t.links.map(e=>l(`link`,{...F(e)},P(e),null,0,`r5_2`)),t.styles.map(e=>{let t=e.props||e;return x(`style`,{...t,dangerouslySetInnerHTML:e.style||t.dangerouslySetInnerHTML,key:e.key})}),t.scripts.map(e=>{let t=e.props||e;return x(`script`,{...t,dangerouslySetInnerHTML:e.script||t.dangerouslySetInnerHTML,key:e.key})})],1,`r5_3`)});export{ve as A,Nr as C,he as D,Wn as E,ge as O,gi as S,Gn as T,Sr as _,qi as a,Ur as b,Jn as c,Zn as d,qn as f,Wr as g,Er as h,ba as i,_e as k,Xn as l,Pr as m,fa as n,Yi as o,wr as p,ma as r,hr as s,Qi as t,Yn as u,fi as v,Tr as w,Mr as x,ai as y};