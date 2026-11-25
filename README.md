# paseo-env-sync

A [Paseo](https://paseo.sh) plugin that keeps plugins and settings in sync across several Paseo daemons using profiles.

- **Global** profile: every environment gets it.
- **Sub-profiles** (e.g. Personal, Work): assigned per environment, applied after Global; later profiles win and can exclude plugins.
- Install, remove, enable or disable a plugin on any environment and the change is recorded in the right profile and applied everywhere that profile is used.
- Offline environments back off (up to 15 minutes between attempts). Changes made on them while they were away are recorded when they return, then pending profile changes are applied.

Run it on one always-on daemon (the hub). It reaches the other daemons with `paseo --host`.

## Install

```bash
paseo plugin add git:jappyjan/paseo-env-sync
```

Open **Environment sync** from the sidebar or the Command Center.

## Environments

| Host form | Plugins | config.json settings |
| --- | --- | --- |
| `local` | yes | yes |
| `ssh://user@machine` | yes | yes (runs `paseo daemon config set` over ssh) |
| `host:port`, pairing URL | yes | no |

## State

`$PASEO_HOME/plugin-data/paseo-env-sync/state.json` on the hub. Override with `PASEO_ENV_SYNC_STATE`; override the CLI path with `PASEO_ENV_SYNC_CLI`.

## Develop

```bash
npm install
npm run typecheck
paseo plugin install "$PWD"
paseo plugin reload paseo-env-sync
```

## License

MIT
