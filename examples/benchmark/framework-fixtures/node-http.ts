import http from "node:http";import {PAYLOAD,HEADERS,telemetry,listen} from "./shared";
listen(http.createServer((req,res)=>{
 if(req.url==="/ping"){res.writeHead(200,HEADERS);res.end(PAYLOAD);}
 else if(req.url==="/__telemetry"){const body=JSON.stringify(telemetry("node-http"));res.writeHead(200,{"content-type":"application/json","content-length":Buffer.byteLength(body)});res.end(body);}
 else{res.writeHead(404);res.end();}
}),"node-http");
