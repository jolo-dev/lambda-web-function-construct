import {createAdaptorServer} from "@hono/node-server";import {Hono} from "hono";import {PAYLOAD,HEADERS,telemetry,listen} from "./shared";
const app=new Hono();app.get("/ping",c=>c.body(PAYLOAD,200,HEADERS));app.get("/__telemetry",c=>c.json(telemetry("hono")));
listen(createAdaptorServer({fetch:app.fetch}),"hono");
