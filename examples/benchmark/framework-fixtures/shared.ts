import type { Server } from "node:http";
export const PAYLOAD='{"ok":true}';
export const HEADERS={"content-type":"application/json; charset=utf-8","content-length":String(Buffer.byteLength(PAYLOAD)),"cache-control":"no-store"};
export function telemetry(server:string){return {server,pid:process.pid,runtime:process.version,cpu:process.cpuUsage(),memory:process.memoryUsage(),resourceUsage:process.resourceUsage()};}
export function listen(server:Server,name:string){
 server.listen(Number(process.env.PORT??4500),"127.0.0.1",()=>console.log(JSON.stringify({server:name,pid:process.pid,port:(server.address() as any).port})));
 process.on("SIGTERM",()=>server.close(()=>process.exit(0)));
}
