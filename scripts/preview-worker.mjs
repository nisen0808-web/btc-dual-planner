import http from 'node:http';
import {stat} from 'node:fs/promises';
const bundle=new URL('../dist/server/index.js',import.meta.url);
http.createServer(async(req,res)=>{
 try{
  const stamp=(await stat(bundle)).mtimeMs;
  const worker=(await import(bundle.href+'?v='+stamp)).default;
  const response=await worker.fetch(new Request('http://127.0.0.1:8766'+req.url,{method:req.method,headers:req.headers}));
  res.writeHead(response.status,Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
 }catch(error){res.writeHead(500);res.end(String(error.message));}
}).listen(8766,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:8766/'));
