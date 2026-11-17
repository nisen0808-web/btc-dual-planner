const decimal=/^(?:\d+(?:\.\d*)?|\.\d+)$/;
const grouped=/^\d{1,3}(?:,\d{3})+(?:\.\d*)?$/;
const text=value=>value==null?'':String(value);

export function rawAmount(value){
 const source=text(value).trim();
 if(!source)return '';
 return decimal.test(source)||grouped.test(source)?source.replaceAll(',',''):NaN;
}

export function formatAmountInput(value){
 const original=text(value),raw=rawAmount(original);
 if(typeof raw!=='string'||raw==='')return raw===''?'':original;
 const dot=raw.indexOf('.'),integer=dot<0?raw:raw.slice(0,dot),fraction=dot<0?'':raw.slice(dot);
 return integer.replace(/\B(?=(\d{3})+(?!\d))/g,',')+fraction;
}

const logical=(value,offset)=>text(value).slice(0,offset).replace(/[,\s]/g,'').length;
function physical(value,offset,afterComma=false){
 let count=0,index=0;
 while(index<value.length&&count<offset){if(value[index]!==',')count++;index++;}
 if(afterComma)while(value[index]===',')index++;
 return index;
}

export function mountAmountInput(element){
 if(!element||typeof element.addEventListener!=='function')return ()=>{};
 let composing=false,disposed=false,lastValue=text(element.value);
 function selection(){try{return Number.isInteger(element.selectionStart)&&Number.isInteger(element.selectionEnd)?{start:element.selectionStart,end:element.selectionEnd,direction:element.selectionDirection||'none'}:null;}catch{return null;}}
 function setSelection(start,end,direction){try{if(typeof element.setSelectionRange==='function')element.setSelectionRange(start,end,direction);}catch{}}
 function emitInput(){
  if(typeof element.dispatchEvent!=='function')return;
  const EventClass=element.ownerDocument?.defaultView?.Event||(typeof Event==='function'?Event:null);
  if(EventClass)element.dispatchEvent(new EventClass('input',{bubbles:true}));
 }
 function apply(editing=false){
  if(disposed||composing)return;
  const source=text(element.value),range=selection();
  let candidate=source;
  // Old separators may become temporarily uneven during a genuine keyboard
  // edit. Pasted/missing-type malformed groups remain invalid, e.g. "1,2".
  if(editing&&typeof rawAmount(lastValue)==='string'&&lastValue.includes(',')&&typeof rawAmount(source)!=='string'){
   const ungrouped=source.replaceAll(',','');if(decimal.test(ungrouped))candidate=ungrouped;
  }
  const formatted=formatAmountInput(candidate);
  if(formatted!==source){
   element.value=formatted;
   if(range)setSelection(physical(formatted,logical(source,range.start),source[range.start-1]===','),physical(formatted,logical(source,range.end),source[range.end-1]===','),range.direction);
  }
  lastValue=text(element.value);
 }
 function input(event){
  if(disposed||composing||event?.isComposing)return;
  const type=event?.inputType||'',keyboard=type==='insertText'&&/^[\d.]+$/.test(event?.data||'')||/^deleteContent(?:Backward|Forward)$/.test(type);
  apply(keyboard);
 }
 function beforeInput(event){
  if(disposed||composing||event?.isComposing)return;
  const range=selection(),value=text(element.value),type=event?.inputType;
  // The displayed price may have been recalculated since the last keystroke.
  lastValue=value;
  if(!range||range.start!==range.end||typeof rawAmount(value)!=='string')return;
  const backwards=type==='deleteContentBackward'&&value[range.start-1]===',',forwards=type==='deleteContentForward'&&value[range.start]===',';
  if(!backwards&&!forwards)return;
  const raw=rawAmount(value),at=logical(value,range.start),remove=backwards?at-1:at;
  if(remove<0||remove>=raw.length||!/^\d$/.test(raw[remove]))return;
  event.preventDefault?.();
  element.value=formatAmountInput(raw.slice(0,remove)+raw.slice(remove+1));
  const caret=physical(element.value,remove);setSelection(caret,caret,'none');lastValue=element.value;emitInput();
 }
 const start=()=>{if(!disposed)composing=true;};
 const end=()=>{if(disposed)return;composing=false;apply(true);emitInput();};
 apply();
 const listeners=[['beforeinput',beforeInput],['input',input],['compositionstart',start],['compositionend',end]];
 for(const [type,handler]of listeners)element.addEventListener(type,handler);
 return ()=>{disposed=true;for(const [type,handler]of listeners)if(typeof element.removeEventListener==='function')element.removeEventListener(type,handler);};
}
