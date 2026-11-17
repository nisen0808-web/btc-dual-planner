import {mountLiveQuoteBoard} from './live-quote-ui.js';

// Restore only the entered amount. The live comparison starts in USDT because
// the connected ordinary dual-investment public feeds are BTC/USDT products.
try{
 const saved=JSON.parse(localStorage.getItem('btc-live-quotes-v1')||'null')||JSON.parse(localStorage.getItem('btc-put-live-v3')||'{}');
 if(typeof saved.amount==='string'&&Number(saved.amount)>0)document.getElementById('scanAmount').value=saved.amount;
}catch{}
mountLiveQuoteBoard();
