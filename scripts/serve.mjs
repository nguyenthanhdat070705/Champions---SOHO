import { startApplicationServer } from "../server/application.js";

startApplicationServer({
  defaultHost: "127.0.0.1",
  defaultPort: 4173,
  label: "SOHO preview",
});
