import http from "node:http";import express from "express";import {PAYLOAD,HEADERS,telemetry,listen} from "./shared";
const app=express();app.disable("x-powered-by");app.disable("etag");
app.get("/ping",(_req,res)=>res.set(HEADERS).send(PAYLOAD));
app.get("/__telemetry",(_req,res)=>res.json(telemetry("express")));
listen(http.createServer(app),"express");
