import {
  createStartHandler,
  createServerEntry,
  defaultStreamHandler,
} from "@tanstack/react-start/server";

const fetch = createStartHandler(defaultStreamHandler);

export default createServerEntry({ fetch });
