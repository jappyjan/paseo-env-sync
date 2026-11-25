import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { EnvSyncScreen } from "./client/screen";

function EnvSyncItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="RefreshCcw"
      active={currentScreen?.screenId === "env-sync"}
      onPress={() => openScreen({ screenId: "env-sync" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "env-sync", title: "Environment sync", Component: EnvSyncScreen });
  client.addSidebarFooterItem({ id: "env-sync", title: "Environment sync", Component: EnvSyncItem });
  client.addCommandCenterItem({
    id: "open-env-sync",
    title: "Open environment sync",
    icon: "RefreshCcw",
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "env-sync" });
    },
  });
  return () => {};
}
