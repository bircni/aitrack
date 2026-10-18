# aitrack pricing pack

Live rates for installed `aitrack` CLIs. Rebuilt daily from LiteLLM + models.dev
(Claude/Codex IO merged into `supplement.json`; Cursor natives stay first-party).

| File | Role |
|---|---|
| `manifest.json` | schema version, `updatedAt`, content hashes |
| `supplement.json` | Claude/Codex/Cursor rates apps resolve against |
| `litellm.json` | compact LiteLLM catalog snapshot |
| `models_dev.json` | compact models.dev catalog snapshot |

Fetch base: `https://raw.githubusercontent.com/bircni/aitrack/pricing/`
Cache dir: `~/.config/aitrack/pricing/` (24h TTL).
