import http from "node:http";import {H3,toNodeHandler} from "h3/node";import {PAYLOAD,HEADERS,telemetry,listen} from "./shared";
const app=new H3();app.get("/ping",()=>new Response(PAYLOAD,{headers:HEADERS}));app.get("/__telemetry",()=>telemetry("h3"));
listen(http.createServer(toNodeHandler(app)),"h3");
