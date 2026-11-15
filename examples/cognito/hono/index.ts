import { createHonoServer } from "./app";
import { createCognitoAuth } from "../shared/auth";
import { readConfiguration } from "../shared/config";
import { startServer } from "../shared/runtime";

const config = readConfiguration();
const { authenticate } = createCognitoAuth(config);
startServer(createHonoServer({ authenticate, frontendOrigin: config.frontendOrigin }));
