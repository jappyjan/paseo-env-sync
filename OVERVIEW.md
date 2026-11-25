Environment sync keeps the plugins and settings of several Paseo daemons in step. You describe what each machine should have with profiles: a Global profile every environment gets, plus sub-profiles such as Personal or Work that you assign to specific environments. Later profiles win, so a Work profile can add plugins or remove ones that Global installs.

## How it works

One daemon runs the plugin and acts as the hub. Every check (60 seconds by default) it lists the plugins on each configured environment with `paseo plugin ls --host`. When you install, remove, enable or disable a plugin on any environment, the change is recorded in the right profile and then applied to every environment that uses that profile.

- A plugin installed on an environment goes to that environment's most specific profile, or to the profile you choose for it.
- Removing a plugin either removes it from the profile that provides it, or only excludes it on that profile. You choose which in Settings.
- Plugins are installed from their registry, Git or npm source on each machine.

## Setup

Add each environment with a host Paseo can reach: `ssh://user@machine`, `host:port` or a pairing URL. The remote daemon must already be running. Settings (config.json values) are only written on the local machine and `ssh://` environments, because `paseo daemon config set` runs on the machine itself.

## Limits

Data that plugins store themselves and agent profiles are not synced. Plugins installed from a local folder only work on machines that have the same folder. State lives in `plugin-data/paseo-env-sync/state.json` in the hub's Paseo home.
