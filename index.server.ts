import type { PluginServerContext } from "@getpaseo/plugin/server";
import { Engine } from "./server/engine";
import { getOverview, importFromEnv, saveConfig, syncNow, testHost } from "./shared/model";

export default function contribute(server: PluginServerContext) {
  const engine = new Engine();
  const ready = engine.start();

  server.handle(getOverview, async () => (await ready, engine.overview()));
  server.handle(saveConfig, async ({ config, apply }) => (await ready, engine.saveConfig(config, apply)));
  server.handle(syncNow, async ({ envId, dryRun }) => (await ready, engine.syncNow(envId, dryRun)));
  server.handle(testHost, ({ host }) => engine.testHost(host));
  server.handle(importFromEnv, async ({ envId, profileId }) => (await ready, engine.importFrom(envId, profileId)));

  return () => engine.stop();
}
