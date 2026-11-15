import { createNodeServer } from "./app";
import { createCognitoAuth } from "../shared/auth";
import { readConfiguration } from "../shared/config";
import { startServer } from "../shared/runtime";

const config = readConfiguration();
const { authenticate } = createCognitoAuth(config);
startServer(createNodeServer({ authenticate, frontendOrigin: config.frontendOrigin }));
