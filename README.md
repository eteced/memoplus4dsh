# memoplus4dsh

Unified memory plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

One coherent entity-time fused memory graph for everything an agent needs to remember — schedules, lessons learned, user preferences and facts, events from conversations — instead of scattered per-day markdown files.

**Status: early development.** See [docs/design.md](docs/design.md) for the architecture.

## Install

```sh
# from this repository
scripts/install.sh          # adds the plugin to your dsh profile
```

## Uninstall

```sh
scripts/uninstall.sh        # removes the plugin; memory data is kept unless --purge
```

## Development

```sh
npm install
npm run build
npm test
```

## License

Modified MIT — see [LICENSE.md](LICENSE.md).
