import test from 'node:test';
import assert from 'node:assert/strict';
import {rawAmount,formatAmountInput,mountAmountInput} from './web/amount-input.js';

class Field{
 constructor(value=''){this.value=value;this.selectionStart=this.selectionEnd=value.length;this.selectionDirection='none';this.listeners=new Map();}
 addEventListener(type,fn){const list=this.listeners.get(type)||[];list.push(fn);this.listeners.set(type,list);}
 removeEventListener(type,fn){this.listeners.set(type,(this.listeners.get(type)||[]).filter(f=>f!==fn));}
 setSelectionRange(start,end,direction='none'){this.selectionStart=start;this.selectionEnd=end;this.selectionDirection=direction;}
 dispatchEvent(event){for(const fn of this.listeners.get(event.type)||[])fn(event);return true;}
 send(type,properties={}){const e={type,...properties,preventDefault(){this.defaultPrevented=true;}};this.dispatchEvent(e);return e;}
}

test('raw amounts preserve exact decimal strings and reject malformed grouping or signs',()=>{
 for(const [value,raw]of [['1234567.8900','1234567.8900'],['1,234,567.8900','1234567.8900'],['80,000','80000'],['0.0000','0.0000'],['123.','123.'],['.5','.5'],['900719925474099312345.000000000001','900719925474099312345.000000000001']])assert.equal(rawAmount(value),raw);
 assert.equal(rawAmount(null),'');assert.equal(rawAmount(undefined),'');assert.equal(rawAmount(''),'');assert.equal(rawAmount(10000),'10000');
 for(const value of ['1,2','12,34','1234,567','1,,234','-1234','+1234','1e3','0x10','1.2.3','abc','1,234.0,0','.',Infinity])assert.ok(Number.isNaN(rawAmount(value)),String(value));
});
test('formatting adds separators while retaining all fractional digits and invalid text',()=>{
 for(const [value,formatted]of [['1234567.8900','1,234,567.8900'],['1234.','1,234.'],['0.0000','0.0000'],['.5','.5'],['80,000','80,000'],['0001234.00','0,001,234.00'],['900719925474099312345.000000000001','900,719,925,474,099,312,345.000000000001']])assert.equal(formatAmountInput(value),formatted);
 for(const value of ['1,2','-1234','abc','1e3'])assert.equal(formatAmountInput(value),value);
});
test('normal keyboard typing crosses groups continuously and paste remains strict',()=>{
 const f=new Field();mountAmountInput(f);
 for(const digit of '123456789'){const at=f.selectionStart;f.value=f.value.slice(0,at)+digit+f.value.slice(at);f.setSelectionRange(at+1,at+1);f.send('input',{inputType:'insertText',data:digit});}
 assert.equal(f.value,'123,456,789');assert.equal(f.selectionStart,f.value.length);
 f.value='1,2';f.setSelectionRange(3,3);f.send('input',{inputType:'insertFromPaste',data:'1,2'});assert.equal(f.value,'1,2');assert.ok(Number.isNaN(rawAmount(f.value)));
 f.value='80,000';f.setSelectionRange(6,6);f.send('input',{inputType:'insertFromPaste',data:'80,000'});assert.equal(f.value,'80,000');
});
test('caret and selection stay beside the same digits and decimal point',()=>{
 const f=new Field('12345.6700');f.setSelectionRange(2,8,'backward');mountAmountInput(f);assert.equal(f.value,'12,345.6700');assert.equal(f.selectionStart,2);assert.equal(f.selectionEnd,9);assert.equal(f.selectionDirection,'backward');
 f.value='1,2345.6700';f.setSelectionRange(6,6);f.send('input',{inputType:'insertText',data:'5'});assert.equal(f.value,'12,345.6700');assert.equal(f.selectionStart,6);
});
test('typing after a calculated target price reuses its displayed grouping',()=>{
 const field=new Field();
 mountAmountInput(field);
 field.value='84,000';
 field.setSelectionRange(6,6);
 field.send('beforeinput',{inputType:'insertText',data:'9'});
 field.value+='9';
 field.setSelectionRange(7,7);
 field.send('input',{inputType:'insertText',data:'9'});
 assert.equal(field.value,'840,009');
});
test('deleting at a comma boundary deletes an adjacent digit instead of trapping the caret',()=>{
 const f=new Field('1,234');mountAmountInput(f);f.setSelectionRange(2,2);const e=f.send('beforeinput',{inputType:'deleteContentBackward'});assert.equal(e.defaultPrevented,true);assert.equal(f.value,'234');assert.equal(f.selectionStart,0);
 f.value='12,345';f.setSelectionRange(2,2);f.send('beforeinput',{inputType:'deleteContentForward'});assert.equal(f.value,'1,245');assert.equal(f.selectionStart,3);
});
test('replacing and deleting a selected middle range reflows only old keyboard separators',()=>{
 const f=new Field('12,345,678');mountAmountInput(f);
 // Select 345, then replace it with 9 as a normal input edit.
 f.setSelectionRange(3,6);f.value=f.value.slice(0,3)+'9'+f.value.slice(6);f.setSelectionRange(4,4);f.send('input',{inputType:'insertText',data:'9'});
 assert.equal(f.value,'129,678');assert.equal(f.selectionStart,3);
 f.setSelectionRange(1,4);f.value=f.value.slice(0,1)+f.value.slice(4);f.setSelectionRange(1,1);f.send('input',{inputType:'deleteContentBackward'});
 assert.equal(f.value,'1,678');assert.equal(f.selectionStart,1);
});
test('composition is not reformatted until completion and the final input reaches later listeners',()=>{
 const f=new Field('1234');mountAmountInput(f);let observed=[];f.addEventListener('input',e=>{if(!e.isComposing)observed.push(f.value);});
 f.send('compositionstart');f.value='1,2345';f.setSelectionRange(6,6);f.send('input',{inputType:'insertCompositionText',isComposing:true,data:'5'});assert.equal(f.value,'1,2345');assert.deepEqual(observed,[]);
 f.send('compositionend');assert.equal(f.value,'12,345');assert.deepEqual(observed,['12,345']);
});
test('cleanup stops formatting and tolerates a test stub without removal support',()=>{
 const f=new Field('1234'),cleanup=mountAmountInput(f);cleanup();f.value='12345';f.send('input',{inputType:'insertText',data:'5'});assert.equal(f.value,'12345');
 const stub=new Field('1234');stub.removeEventListener=undefined;const stop=mountAmountInput(stub);assert.equal(stub.value,'1,234');assert.doesNotThrow(stop);
});
