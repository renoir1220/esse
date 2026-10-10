`legacy-modification-receipts.json` contains four authentic completed modification
records written through the MCP SDK by unmodified historical Plugin runtimes:

- `996ea8acdab576f8cec2f77605b27b61679b6473`: omitted `referenceImagePaths`.
- `03fbd5fd3aa3ad0b48b375b518203900995e271f`: explicit empty `referenceImagePaths`.
- Each commit covers both `imageIds` and the deprecated `jobIds` selector.

The generator uses local valid PNGs and Agent callbacks. Any Provider call throws;
no remote generation is performed. Stored fingerprints are never synthesized or
rewritten. Only temporary absolute filesystem paths become `$FIXTURE_ROOT/`.
The JSON includes the original request, persisted record, and actual image bytes.

Regenerate from clean historical worktrees with installed Plugin dependencies:

```sh
npx tsx test/legacy-receipt-runtime.ts /path/to/996ea8a /path/to/03fbd5f
```

Normal tests load these records offline, so shallow CI checkouts need no historical
source download. For an actual old-runtime-write → new-runtime-replay check using
the same data directory, run:

```sh
ESSE_LEGACY_PLUGIN_CHECKOUTS='["/path/to/996ea8a","/path/to/03fbd5f"]' npx tsx --test test/upgrade-receipts.test.ts
```

The helper checks historical HEADs and verifies their `plugins/codex/src` files are
unmodified. Both modes require successful original-key replays, reject changes to
nonempty attachments, target, model and instructions, and verify unchanged jobs,
backups, persisted records and image bytes with zero Provider calls.
